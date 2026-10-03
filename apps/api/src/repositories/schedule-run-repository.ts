import { createHash, randomUUID } from "node:crypto";
import {
  type EngineProjectInputV1,
  type EngineScheduleResultV1,
  type ScheduleCalculationV1,
  serializeScheduleInputV1,
} from "@engineo/contracts";
import type { Database, DatabaseExecutor } from "../db/client.js";
import type { TenantContext } from "../db/tenant-context.js";
import { isValidScheduleResult, ScheduleEngineError } from "../scheduler/runner.js";
import { SCHEDULE_JSON_MAX_BYTES } from "../scheduler/size.js";
import { appendAuditEvent } from "../security/audit.js";
import {
  type OrganizationRole,
  type ProjectRole,
  projectAccessDecision,
} from "../security/rbac.js";
import type { PlannerSnapshot } from "./project-repository.js";

const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

function assertPersistenceSize(bytes: string): void {
  if (Buffer.byteLength(bytes, "utf8") > SCHEDULE_JSON_MAX_BYTES)
    throw new ScheduleEngineError(
      "schedule_too_large",
      422,
      "Schedule or its result exceeds the 32 MiB calculation limit.",
    );
}

// Run this before invoking Rust, then again at the persistence boundary. The
// exact canonical export bytes, including their newline, are stored and hashed.
export function serializeScheduleRunInput(input: EngineProjectInputV1): string {
  const bytes = serializeScheduleInputV1(input);
  assertPersistenceSize(bytes);
  return bytes;
}

export class ScheduleRunCommitError extends Error {
  constructor(
    public readonly code:
      | "unauthenticated"
      | "forbidden"
      | "revision_conflict"
      | "schedule_cancelled",
    public readonly statusCode: 401 | 403 | 409,
  ) {
    super(code);
  }
}

function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ScheduleRunCommitError("schedule_cancelled", 409);
}

export class ScheduleRunRepository {
  constructor(private readonly db: Database) {}

  async record(
    context: TenantContext,
    sessionId: string,
    snapshot: PlannerSnapshot,
    result: EngineScheduleResultV1,
    signal?: AbortSignal,
  ): Promise<ScheduleCalculationV1> {
    checkCancellation(signal);
    const actorId = context.actorId;
    if (!actorId || !isValidScheduleResult(result, snapshot.input)) {
      throw new Error("Invalid schedule result persistence boundary");
    }
    const inputBytes = serializeScheduleRunInput(snapshot.input);
    // Preserve the validated result serialization used by the audit hash.
    // jsonb would reorder object keys on reads and change JSON.stringify hashes.
    const resultBytes = JSON.stringify(result);
    assertPersistenceSize(resultBytes);
    const inputHash = hash(inputBytes);
    const resultHash = hash(resultBytes);
    const id = randomUUID();
    const projectId = snapshot.input.project.id;

    return await this.db.begin(async (sql) => {
      // These short commit-stage locks serialize revocation/access changes with
      // persistence. They are never held during the Rust calculation.
      const sessions = await sql`
        SELECT id FROM auth_sessions
        WHERE id = ${sessionId} AND user_id = ${actorId}
          AND revoked_at IS NULL AND expires_at > statement_timestamp()
        FOR SHARE
      `;
      if (sessions.length === 0) throw new ScheduleRunCommitError("unauthenticated", 401);
      const organizationRows = await sql<{ role: OrganizationRole }[]>`
        SELECT role FROM organization_memberships
        WHERE organization_id = ${context.organizationId} AND user_id = ${actorId}
        FOR SHARE
      `;
      const projectRows = await sql<{ role: ProjectRole }[]>`
        SELECT role FROM project_memberships
        WHERE organization_id = ${context.organizationId} AND project_id = ${projectId}
          AND user_id = ${actorId}
        FOR SHARE
      `;
      // An absent row cannot be locked. Never grant from a later unlocked read
      // that could observe a temporary regrant and lose it before commit.
      const decision = projectAccessDecision(
        organizationRows[0]?.role ?? null,
        projectRows[0]?.role ?? null,
        "schedule.run",
      );
      if (!decision.allowed) throw new ScheduleRunCommitError("forbidden", 403);
      const projects = await sql`
        SELECT revision FROM projects
        WHERE organization_id = ${context.organizationId} AND id = ${projectId}
        FOR UPDATE
      `;
      if (Number(projects[0]?.revision) !== snapshot.revision) {
        throw new ScheduleRunCommitError("revision_conflict", 409);
      }
      checkCancellation(signal);
      const rows = await sql`
        INSERT INTO schedule_runs (
          id, organization_id, project_id, revision, engine_contract_version,
          input_hash, result_hash, input_bytes, result_bytes, created_by
        ) VALUES (
          ${id}, ${context.organizationId}, ${projectId}, ${snapshot.revision}, 1,
          ${inputHash}, ${resultHash}, ${inputBytes}, ${resultBytes}, ${actorId}
        ) RETURNING completed_at
      `;
      await appendAuditEvent(sql, {
        organizationId: context.organizationId,
        actorType: "user",
        actorId,
        action: "schedule.run",
        resourceType: "project",
        resourceId: projectId,
        source: "api",
        correlationId: context.correlationId,
        payload: {
          runId: id,
          revision: snapshot.revision,
          inputHash,
          resultHash,
          engineContractVersion: 1,
        },
      });
      checkCancellation(signal);
      // A project/audit lock wait can cross the session deadline even though
      // revocation itself is serialized by the session share lock above.
      const stillActive = await sql`
        SELECT id FROM auth_sessions
        WHERE id = ${sessionId} AND expires_at > clock_timestamp() AND revoked_at IS NULL
      `;
      if (stillActive.length === 0) throw new ScheduleRunCommitError("unauthenticated", 401);
      checkCancellation(signal);
      return {
        id,
        revision: snapshot.revision,
        engineContractVersion: 1,
        inputHash,
        resultHash,
        completedAt: new Date(String(rows[0]?.completed_at)).toISOString(),
        result,
      };
    });
  }
}

// Called in the same repeatable-read transaction as the current input/revision.
export async function readLatestScheduleCalculation(
  db: DatabaseExecutor,
  context: TenantContext,
  input: EngineProjectInputV1,
  revision: number,
): Promise<ScheduleCalculationV1 | null> {
  const rows = await db`
    SELECT id, revision, engine_contract_version, input_hash, result_hash,
           input_bytes, result_bytes, completed_at
    FROM schedule_runs
    WHERE organization_id = ${context.organizationId} AND project_id = ${input.project.id}
      AND revision = ${revision}
    ORDER BY completed_at DESC, id DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const inputBytes = String(row.input_bytes);
  const resultBytes = String(row.result_bytes);
  if (
    row.engine_contract_version !== 1 ||
    hash(inputBytes) !== row.input_hash ||
    hash(serializeScheduleInputV1(input)) !== row.input_hash ||
    hash(resultBytes) !== row.result_hash
  )
    throw new Error("Stored schedule result integrity check failed");
  const result: unknown = JSON.parse(resultBytes);
  if (!isValidScheduleResult(result, input)) throw new Error("Invalid stored schedule result");
  return {
    id: String(row.id),
    revision: Number(row.revision),
    engineContractVersion: 1,
    inputHash: String(row.input_hash),
    resultHash: String(row.result_hash),
    completedAt: new Date(String(row.completed_at)).toISOString(),
    result,
  };
}
