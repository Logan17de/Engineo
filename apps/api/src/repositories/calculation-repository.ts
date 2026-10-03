import { createHash, randomUUID } from "node:crypto";
import {
  ENGINE_CONTRACT_VERSION,
  type EngineScheduleResultV1,
  type ScheduleCalculationMetadataV1,
  serializeScheduleInputV1,
  serializeScheduleResultV1,
} from "@engineo/contracts";
import type { Database, DatabaseExecutor } from "../db/client.js";
import type { TenantContext } from "../db/tenant-context.js";
import { SCHEDULE_MAX_BYTES, ScheduleEngineError, validResult } from "../scheduler/runner.js";
import { appendAuditEvent } from "../security/audit.js";
import { authorizeProject, type Permission } from "../security/rbac.js";
import type { SessionPrincipal } from "../security/session.js";
import { PlannerNotFoundError, RevisionConflictError } from "./planner-repository.js";
import { type PlannerSnapshot, readPlannerSnapshot } from "./project-repository.js";

export interface StoredScheduleResult {
  revision: number;
  result: EngineScheduleResultV1 | null;
  calculation: ScheduleCalculationMetadataV1 | null;
}

export class CalculationAccessError extends Error {
  constructor(public readonly statusCode: 401 | 403) {
    super(statusCode === 401 ? "unauthenticated" : "forbidden");
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ScheduleEngineError("schedule_cancelled", 409, "Calculation was cancelled.");
}

function assertEngineVersion(engineVersion: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,127}$/.test(engineVersion))
    throw new ScheduleEngineError("schedule_invalid_output", 503, "Invalid engine identity.");
}

function canonicalInput(snapshot: PlannerSnapshot): string {
  const canonical = serializeScheduleInputV1(snapshot.input);
  if (
    Buffer.byteLength(canonical, "utf8") > SCHEDULE_MAX_BYTES ||
    Buffer.byteLength(JSON.stringify(snapshot.input), "utf8") > SCHEDULE_MAX_BYTES
  )
    throw new ScheduleEngineError(
      "schedule_too_large",
      422,
      "Schedule exceeds the calculation storage size.",
    );
  return canonical;
}

async function assertLiveSession(
  sql: DatabaseExecutor,
  principal: SessionPrincipal,
  signal?: AbortSignal,
): Promise<void> {
  const rows = await sql`SELECT id FROM auth_sessions
    WHERE id = ${principal.sessionId} AND user_id = ${principal.userId}
      AND revoked_at IS NULL AND expires_at > clock_timestamp()`;
  assertNotCancelled(signal);
  if (rows.length !== 1) throw new CalculationAccessError(401);
}

async function authorizedSnapshot(
  sql: DatabaseExecutor,
  context: TenantContext,
  projectId: string,
  principal: SessionPrincipal,
  permission: Permission,
  signal?: AbortSignal,
): Promise<PlannerSnapshot> {
  if (context.actorId !== principal.userId) throw new CalculationAccessError(403);
  // Locks are limited to short read/reuse/finalization transactions, never held
  // while Rust executes. SHARE excludes concurrent revocation and role updates.
  // Consistent order: session, organization membership, project, project member.
  const sessions = await sql`SELECT id FROM auth_sessions
    WHERE id = ${principal.sessionId} AND user_id = ${principal.userId} FOR SHARE`;
  assertNotCancelled(signal);
  if (sessions.length !== 1) throw new CalculationAccessError(401);
  await assertLiveSession(sql, principal, signal);
  const memberships = await sql`SELECT role FROM organization_memberships
    WHERE organization_id = ${context.organizationId} AND user_id = ${principal.userId} FOR SHARE`;
  assertNotCancelled(signal);
  if (memberships.length !== 1) throw new CalculationAccessError(403);
  // FOR UPDATE also serializes identical-key finalizers from separate API replicas.
  const projects =
    permission === "schedule.run"
      ? await sql`SELECT id FROM projects WHERE organization_id = ${context.organizationId}
        AND id = ${projectId} FOR UPDATE`
      : await sql`SELECT id FROM projects WHERE organization_id = ${context.organizationId}
        AND id = ${projectId} FOR SHARE`;
  assertNotCancelled(signal);
  if (projects.length !== 1) throw new PlannerNotFoundError("Project not found.");
  const projectMemberships =
    await sql`SELECT role FROM project_memberships WHERE organization_id = ${context.organizationId}
    AND project_id = ${projectId} AND user_id = ${principal.userId} FOR SHARE`;
  assertNotCancelled(signal);
  if (!["owner", "admin"].includes(String(memberships[0]?.role)) && projectMemberships.length !== 1)
    throw new CalculationAccessError(403);
  const decision = await authorizeProject(
    sql,
    principal.userId,
    context.organizationId,
    projectId,
    permission,
  );
  assertNotCancelled(signal);
  if (!decision.allowed) throw new CalculationAccessError(403);
  const snapshot = await readPlannerSnapshot(sql, context, projectId);
  assertNotCancelled(signal);
  if (!snapshot) throw new PlannerNotFoundError("Project not found.");
  // Expiry uses wall-clock time, including time spent waiting on project locks.
  await assertLiveSession(sql, principal, signal);
  return snapshot;
}

async function matchingRow(
  sql: DatabaseExecutor,
  context: TenantContext,
  projectId: string,
  revision: number,
  inputHash: string,
  engineVersion: string,
) {
  const rows = await sql`SELECT id, project_revision, input_hash_sha256, result_hash_sha256,
      engine_contract_version, engine_version, calculated_at, input_canonical, result_json
    FROM schedule_calculations WHERE organization_id = ${context.organizationId}
      AND project_id = ${projectId} AND project_revision = ${revision}
      AND input_hash_sha256 = ${inputHash} AND engine_contract_version = ${ENGINE_CONTRACT_VERSION}
      AND engine_version = ${engineVersion}`;
  return rows[0];
}

function storedResult(
  row: NonNullable<Awaited<ReturnType<typeof matchingRow>>>,
  snapshot: PlannerSnapshot,
): StoredScheduleResult {
  try {
    const canonical = canonicalInput(snapshot);
    const text = String(row.result_json);
    const result: unknown = JSON.parse(text);
    if (
      String(row.input_canonical) !== canonical ||
      hash(canonical) !== row.input_hash_sha256 ||
      Buffer.byteLength(text, "utf8") > SCHEDULE_MAX_BYTES ||
      hash(text) !== row.result_hash_sha256 ||
      !validResult(result, snapshot.input) ||
      serializeScheduleResultV1(result) !== text
    )
      throw new Error("Invalid stored result");
    return {
      revision: snapshot.revision,
      result,
      calculation: {
        schemaVersion: 1,
        calculationId: String(row.id),
        projectRevision: Number(row.project_revision),
        inputHashSha256: String(row.input_hash_sha256),
        resultHashSha256: String(row.result_hash_sha256),
        engineContractVersion: ENGINE_CONTRACT_VERSION,
        engineVersion: String(row.engine_version),
        calculatedAt: new Date(String(row.calculated_at)).toISOString(),
      },
    };
  } catch {
    throw new ScheduleEngineError(
      "schedule_invalid_output",
      503,
      "Stored calculation failed integrity validation.",
    );
  }
}

export class CalculationRepository {
  constructor(private readonly db: Database) {}

  async reuse(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    requestedSnapshot: PlannerSnapshot,
    engineVersion: string,
    signal?: AbortSignal,
  ): Promise<StoredScheduleResult | null> {
    assertNotCancelled(signal);
    assertEngineVersion(engineVersion);
    const canonical = canonicalInput(requestedSnapshot);
    return await this.db.begin(async (sql) => {
      const current = await authorizedSnapshot(
        sql,
        context,
        projectId,
        principal,
        "schedule.run",
        signal,
      );
      if (current.revision !== requestedSnapshot.revision || canonicalInput(current) !== canonical)
        throw new RevisionConflictError();
      const row = await matchingRow(
        sql,
        context,
        projectId,
        current.revision,
        hash(canonical),
        engineVersion,
      );
      assertNotCancelled(signal);
      const response = row ? storedResult(row, current) : null;
      await assertLiveSession(sql, principal, signal);
      return response;
    });
  }

  async current(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    engineVersion: string,
  ): Promise<StoredScheduleResult> {
    assertEngineVersion(engineVersion);
    return await this.db.begin(async (sql) => {
      const snapshot = await authorizedSnapshot(sql, context, projectId, principal, "project.read");
      const row = await matchingRow(
        sql,
        context,
        projectId,
        snapshot.revision,
        hash(canonicalInput(snapshot)),
        engineVersion,
      );
      const response = row
        ? storedResult(row, snapshot)
        : { revision: snapshot.revision, result: null, calculation: null };
      await assertLiveSession(sql, principal);
      return response;
    });
  }

  async finalize(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    calculatedSnapshot: PlannerSnapshot,
    result: EngineScheduleResultV1,
    engineVersion: string,
    signal?: AbortSignal,
  ): Promise<StoredScheduleResult> {
    assertNotCancelled(signal);
    assertEngineVersion(engineVersion);
    const canonical = canonicalInput(calculatedSnapshot);
    if (!validResult(result, calculatedSnapshot.input))
      throw new ScheduleEngineError(
        "schedule_invalid_output",
        503,
        "Calculation engine returned an invalid result.",
      );
    const resultJson = serializeScheduleResultV1(result);
    if (Buffer.byteLength(resultJson, "utf8") > SCHEDULE_MAX_BYTES)
      throw new ScheduleEngineError(
        "schedule_output_limit",
        503,
        "Calculation output exceeds the storage size.",
      );
    const inputHash = hash(canonical),
      resultHash = hash(resultJson);
    return await this.db.begin(async (sql) => {
      const current = await authorizedSnapshot(
        sql,
        context,
        projectId,
        principal,
        "schedule.run",
        signal,
      );
      if (current.revision !== calculatedSnapshot.revision || canonicalInput(current) !== canonical)
        throw new RevisionConflictError();
      const existing = await matchingRow(
        sql,
        context,
        projectId,
        current.revision,
        inputHash,
        engineVersion,
      );
      assertNotCancelled(signal);
      if (existing) {
        // The immutable run already has its atomic audit; retrying does not
        // invent another calculation. Fail closed if the declared engine drifts.
        if (existing.result_hash_sha256 !== resultHash)
          throw new ScheduleEngineError(
            "schedule_result_conflict",
            503,
            "Calculation result changed for the same engine and input.",
          );
        const response = storedResult(existing, current);
        await assertLiveSession(sql, principal, signal);
        return response;
      }
      const id = randomUUID();
      await assertLiveSession(sql, principal, signal);
      const auditId = await appendAuditEvent(sql, {
        organizationId: context.organizationId,
        actorType: "user",
        actorId: context.actorId,
        action: "schedule.run",
        resourceType: "project",
        resourceId: projectId,
        source: "api",
        correlationId: context.correlationId,
        payload: {
          calculationId: id,
          revision: current.revision,
          inputHash,
          resultHash,
          engineContractVersion: ENGINE_CONTRACT_VERSION,
          engineVersion,
          sessionId: principal.sessionId,
        },
      });
      assertNotCancelled(signal);
      await sql`INSERT INTO schedule_calculations (id, organization_id, project_id, project_revision,
        input_hash_sha256, result_hash_sha256, engine_contract_version, engine_version,
        input_canonical, result_json, audit_event_id)
        VALUES (${id}, ${context.organizationId}, ${projectId}, ${current.revision}, ${inputHash},
          ${resultHash}, ${ENGINE_CONTRACT_VERSION}, ${engineVersion}, ${canonical}, ${resultJson}, ${auditId})`;
      assertNotCancelled(signal);
      const row = await matchingRow(
        sql,
        context,
        projectId,
        current.revision,
        inputHash,
        engineVersion,
      );
      assertNotCancelled(signal);
      if (!row) throw new Error("Calculation was not stored");
      const response = storedResult(row, current);
      await assertLiveSession(sql, principal, signal);
      // Cancellation after COMMIT starts is best effort; committed runs are
      // safely discoverable through GET even if the response is lost.
      return response;
    });
  }
}
