import { createHash } from "node:crypto";
import {
  diffProjectConfigurationV1,
  PROJECT_CONFIGURATION_MAX_ARTIFACT_BYTES,
  PROJECT_CONFIGURATION_NORMALIZATION_VERSION,
  PROJECT_CONFIGURATION_PROTOCOL_VERSION,
  PROJECT_CONFIGURATION_VERSION,
  type ProjectConfigurationApplyRequestV1,
  type ProjectConfigurationCancelRequestV1,
  type ProjectConfigurationDiagnosticsV1,
  ProjectConfigurationError,
  type ProjectConfigurationPlanReadV1,
  type ProjectConfigurationPlanRequestV1,
  type ProjectConfigurationPlanV1,
  type ProjectConfigurationReadV1,
  type ProjectConfigurationReceiptV1,
  type ProjectConfigurationV1,
  type ProjectConfigurationValidateResponseV1,
  serializeProjectConfigurationReviewV1,
  serializeScheduleInputV1,
  validateProjectConfigurationV1,
} from "@engineo/contracts";
import type { Database, DatabaseExecutor } from "../db/client.js";
import type { TenantContext } from "../db/tenant-context.js";
import { appendAuditEvent } from "../security/audit.js";
import { authorizeProject, type Permission } from "../security/rbac.js";
import type { SessionPrincipal } from "../security/session.js";
import {
  assertConfigurationNativeIds,
  ConfigurationNativeIdError,
  reconcileConfigurationSchedule,
} from "./configuration-reconcile.js";
import { type PlannerSnapshot, readPlannerSnapshot } from "./project-repository.js";

export class ConfigurationError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    public readonly diagnostics?: ProjectConfigurationDiagnosticsV1,
  ) {
    super(code);
  }
}

export const CONFIGURATION_PLAN_TTL_MINUTES = 15;
export const CONFIGURATION_ARTIFACT_RETENTION_HOURS = 24;
export const CONFIGURATION_MAINTENANCE_BATCH = 64;
export const CONFIGURATION_ACTOR_PENDING_LIMIT = 8;
export const CONFIGURATION_PROJECT_PENDING_LIMIT = 32;
export const CONFIGURATION_ACTOR_HOURLY_LIMIT = 60;
export const CONFIGURATION_GLOBAL_ARTIFACT_BYTES = 1_073_741_824;
export const CONFIGURATION_PROJECT_ARTIFACT_BYTES = 134_217_728;

const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const instant = (value: unknown): string =>
  (value instanceof Date ? value : new Date(String(value))).toISOString();
const config = (input: PlannerSnapshot["input"]): ProjectConfigurationV1 => ({
  schemaVersion: 1,
  kind: "engineo-project-configuration",
  scope: "schedule",
  input,
});

function notCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ConfigurationError("configuration_interrupted", 409);
}

async function assertLiveSession(
  sql: DatabaseExecutor,
  principal: SessionPrincipal,
  signal?: AbortSignal,
): Promise<void> {
  const rows = await sql`SELECT id FROM auth_sessions WHERE id = ${principal.sessionId}
    AND user_id = ${principal.userId} AND revoked_at IS NULL AND expires_at > clock_timestamp()`;
  notCancelled(signal);
  if (rows.length !== 1) throw new ConfigurationError("unauthenticated", 401);
}

// Do not share or weaken the existing Planner paths. This follows the reviewed
// durable-calculation order: session, organization member, project, project
// member, then scoped plan. Missing memberships are rejected before later locks.
async function authorizedProject(
  sql: DatabaseExecutor,
  context: TenantContext,
  projectId: string,
  principal: SessionPrincipal,
  permission: Permission,
  signal?: AbortSignal,
): Promise<void> {
  notCancelled(signal);
  if (context.actorId !== principal.userId) throw new ConfigurationError("forbidden", 403);
  const session = await sql`SELECT id FROM auth_sessions WHERE id = ${principal.sessionId}
    AND user_id = ${principal.userId} FOR SHARE`;
  notCancelled(signal);
  if (session.length !== 1) throw new ConfigurationError("unauthenticated", 401);
  await assertLiveSession(sql, principal, signal);
  const members = await sql`SELECT role FROM organization_memberships
    WHERE organization_id = ${context.organizationId} AND user_id = ${principal.userId} FOR SHARE`;
  notCancelled(signal);
  if (members.length !== 1) throw new ConfigurationError("forbidden", 403);
  const projects =
    permission === "project.write"
      ? await sql`SELECT id FROM projects WHERE organization_id = ${context.organizationId}
        AND id = ${projectId} FOR UPDATE`
      : await sql`SELECT id FROM projects WHERE organization_id = ${context.organizationId}
        AND id = ${projectId} FOR SHARE`;
  notCancelled(signal);
  if (projects.length !== 1) throw new ConfigurationError("project_not_found", 404);
  const projectMembers = await sql`SELECT role FROM project_memberships
    WHERE organization_id = ${context.organizationId} AND project_id = ${projectId}
      AND user_id = ${principal.userId} FOR SHARE`;
  notCancelled(signal);
  if (!["owner", "admin"].includes(String(members[0]?.role)) && projectMembers.length !== 1)
    throw new ConfigurationError("forbidden", 403);
  const decision = await authorizeProject(
    sql,
    principal.userId,
    context.organizationId,
    projectId,
    permission,
  );
  notCancelled(signal);
  if (!decision.allowed) throw new ConfigurationError("forbidden", 403);
  await assertLiveSession(sql, principal, signal);
}

async function currentSnapshot(
  sql: DatabaseExecutor,
  context: TenantContext,
  projectId: string,
  signal?: AbortSignal,
): Promise<PlannerSnapshot> {
  // Detect unsupported precision in native settings before JSON reconstruction.
  const settings = await sql`SELECT project_id FROM project_schedule_settings
    WHERE organization_id = ${context.organizationId} AND project_id = ${projectId}
      AND (planned_start <> date_trunc('milliseconds', planned_start)
        OR data_date <> date_trunc('milliseconds', data_date)
        OR required_finish <> date_trunc('milliseconds', required_finish))`;
  notCancelled(signal);
  if (settings.length) throw new ConfigurationError("configuration_integrity_error", 503);
  const snapshot = await readPlannerSnapshot(sql, context, projectId);
  notCancelled(signal);
  if (!snapshot) throw new ConfigurationError("project_not_found", 404);
  return snapshot;
}

function normalized(configuration: unknown) {
  const result = validateProjectConfigurationV1(configuration);
  if (!result.valid) throw new ConfigurationError("configuration_invalid", 422, result.diagnostics);
  return result;
}

function canonicalBase(snapshot: PlannerSnapshot): string {
  try {
    const result = normalized(config(snapshot.input));
    // Native persistence must already equal the normalization being reviewed.
    const canonical = serializeScheduleInputV1(snapshot.input);
    if (
      canonical !== result.canonicalInput ||
      Buffer.byteLength(canonical) > PROJECT_CONFIGURATION_MAX_ARTIFACT_BYTES
    )
      throw new Error("Invalid canonical base");
    return canonical;
  } catch {
    throw new ConfigurationError("configuration_integrity_error", 503);
  }
}

function requestHash(request: ProjectConfigurationPlanRequestV1, canonicalInput: string): string {
  return hash(
    JSON.stringify({
      protocolVersion: PROJECT_CONFIGURATION_PROTOCOL_VERSION,
      planId: request.planId.toLowerCase(),
      expectedRevision: request.expectedRevision,
      canonicalInput,
    }),
  );
}

async function planRow(
  sql: DatabaseExecutor,
  context: TenantContext,
  projectId: string,
  planId: string,
) {
  const rows = await sql`SELECT * FROM project_configuration_plans
    WHERE organization_id = ${context.organizationId} AND project_id = ${projectId}
      AND id = ${planId} FOR UPDATE`;
  return rows[0];
}
type PlanRow = NonNullable<Awaited<ReturnType<typeof planRow>>>;

function assertSupportedPlan(row: PlanRow): void {
  if (
    Number(row.protocol_version) !== PROJECT_CONFIGURATION_PROTOCOL_VERSION ||
    Number(row.configuration_version) !== PROJECT_CONFIGURATION_VERSION ||
    Number(row.normalization_version) !== PROJECT_CONFIGURATION_NORMALIZATION_VERSION
  )
    throw new ConfigurationError("configuration_integrity_error", 503);
}

function assertCreator(
  row: PlanRow | undefined,
  principal: SessionPrincipal,
  sessionRequired = true,
): asserts row is PlanRow {
  if (
    !row ||
    row.actor_id !== principal.userId ||
    (sessionRequired && row.session_id !== principal.sessionId)
  )
    throw new ConfigurationError("configuration_plan_not_found", 404);
  assertSupportedPlan(row);
}

async function outcomeRow(sql: DatabaseExecutor, row: PlanRow) {
  const rows = await sql`SELECT * FROM project_configuration_outcomes
    WHERE organization_id = ${String(row.organization_id)} AND project_id = ${String(row.project_id)}
      AND plan_id = ${String(row.id)}`;
  return rows[0];
}
type OutcomeRow = NonNullable<Awaited<ReturnType<typeof outcomeRow>>>;

function receiptValue(row: PlanRow, outcome: OutcomeRow): ProjectConfigurationReceiptV1 {
  try {
    assertSupportedPlan(row);
    const common = {
      schemaVersion: 1 as const,
      planId: String(row.id),
      organizationId: String(row.organization_id),
      projectId: String(row.project_id),
      previousRevision: Number(outcome.previous_revision),
      baseInputHashSha256: String(outcome.base_input_hash_sha256),
      reviewedDigest: String(outcome.reviewed_digest),
      provenanceAuditId: String(outcome.provenance_audit_id),
      recordedAt: instant(outcome.recorded_at),
    };
    let receipt: ProjectConfigurationReceiptV1;
    if (outcome.outcome === "cancelled") {
      receipt = {
        ...common,
        outcome: "cancelled",
        committedRevision: null,
        committedInputHashSha256: null,
        scheduleEditAuditId: null,
      };
    } else if (outcome.outcome === "applied" || outcome.outcome === "no_op") {
      receipt = {
        ...common,
        outcome: outcome.outcome,
        committedRevision: Number(outcome.committed_revision),
        committedInputHashSha256: String(outcome.committed_input_hash_sha256),
        scheduleEditAuditId:
          outcome.schedule_edit_audit_id === null ? null : String(outcome.schedule_edit_audit_id),
      };
    } else throw new Error("Unknown outcome");
    const bytes = JSON.stringify(receipt);
    if (
      bytes !== outcome.receipt_json ||
      hash(bytes) !== outcome.receipt_hash_sha256 ||
      common.previousRevision !== Number(row.base_revision) ||
      common.baseInputHashSha256 !== row.base_input_hash_sha256 ||
      common.reviewedDigest !== row.reviewed_digest ||
      (receipt.outcome !== "cancelled" &&
        receipt.committedInputHashSha256 !== row.desired_input_hash_sha256) ||
      (receipt.outcome === "no_op" &&
        (!row.no_op ||
          receipt.committedRevision !== common.previousRevision ||
          receipt.scheduleEditAuditId !== null)) ||
      (receipt.outcome === "applied" &&
        (row.no_op ||
          receipt.committedRevision !== common.previousRevision + 1 ||
          !receipt.scheduleEditAuditId)) ||
      (receipt.outcome === "cancelled" &&
        (outcome.committed_revision !== null ||
          outcome.committed_input_hash_sha256 !== null ||
          outcome.schedule_edit_audit_id !== null))
    )
      throw new Error("Invalid receipt");
    return receipt;
  } catch {
    throw new ConfigurationError("configuration_integrity_error", 503);
  }
}

function reviewWithoutDigest(
  row: PlanRow,
  configuration: ProjectConfigurationV1,
  changes: ProjectConfigurationPlanV1["changes"],
) {
  return {
    schemaVersion: PROJECT_CONFIGURATION_VERSION,
    protocolVersion: PROJECT_CONFIGURATION_PROTOCOL_VERSION,
    normalizationVersion: PROJECT_CONFIGURATION_NORMALIZATION_VERSION,
    planId: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    actorId: String(row.actor_id),
    sessionId: String(row.session_id),
    createdAt: instant(row.created_at),
    expiresAt: instant(row.expires_at),
    baseRevision: Number(row.base_revision),
    baseInputHashSha256: String(row.base_input_hash_sha256),
    desiredInputHashSha256: String(row.desired_input_hash_sha256),
    configuration,
    changes,
    noOp: Boolean(row.no_op),
  };
}

async function verifiedReview(
  sql: DatabaseExecutor,
  row: PlanRow,
): Promise<ProjectConfigurationPlanV1 | null> {
  const artifacts = await sql`SELECT * FROM project_configuration_artifacts
    WHERE organization_id = ${String(row.organization_id)} AND project_id = ${String(row.project_id)}
      AND plan_id = ${String(row.id)} FOR SHARE`;
  const artifact = artifacts[0];
  if (!artifact) return null;
  try {
    if (
      Number(row.protocol_version) !== PROJECT_CONFIGURATION_PROTOCOL_VERSION ||
      Number(row.configuration_version) !== PROJECT_CONFIGURATION_VERSION ||
      Number(row.normalization_version) !== PROJECT_CONFIGURATION_NORMALIZATION_VERSION ||
      instant(artifact.keep_until) !== instant(row.artifacts_keep_until)
    )
      throw new Error("Invalid versions");
    const baseCanonical = String(artifact.base_canonical),
      candidateCanonical = String(artifact.candidate_canonical);
    const base = normalized(config(JSON.parse(baseCanonical)));
    const candidate = normalized(config(JSON.parse(candidateCanonical)));
    if (
      base.canonicalInput !== baseCanonical ||
      candidate.canonicalInput !== candidateCanonical ||
      hash(baseCanonical) !== row.base_input_hash_sha256 ||
      hash(candidateCanonical) !== row.desired_input_hash_sha256 ||
      base.normalizedInput.project.id !== row.project_id ||
      candidate.normalizedInput.project.id !== row.project_id
    )
      throw new Error("Invalid stored input");
    const diff = diffProjectConfigurationV1(base.normalizedInput, candidate.normalizedInput);
    const review = reviewWithoutDigest(row, candidate.normalizedConfiguration, diff.changes);
    const reviewJson = serializeProjectConfigurationReviewV1(review);
    if (
      diff.serializedDiff !== artifact.diff_json ||
      diff.noOp !== row.no_op ||
      reviewJson !== artifact.review_json ||
      hash(reviewJson) !== row.reviewed_digest ||
      requestHash(
        {
          planId: String(row.id),
          expectedRevision: Number(row.base_revision),
          configuration: candidate.normalizedConfiguration,
        },
        candidateCanonical,
      ) !== row.request_hash_sha256
    )
      throw new Error("Invalid stored review");
    return { ...review, reviewedDigest: String(row.reviewed_digest) };
  } catch {
    throw new ConfigurationError("configuration_integrity_error", 503);
  }
}

async function readPlanValue(
  sql: DatabaseExecutor,
  row: PlanRow,
): Promise<ProjectConfigurationPlanReadV1> {
  const plan = await verifiedReview(sql, row);
  const outcome = await outcomeRow(sql, row);
  const receipt = outcome ? receiptValue(row, outcome) : null;
  const clock =
    await sql`SELECT expires_at > clock_timestamp() AS live FROM project_configuration_plans
    WHERE organization_id = ${String(row.organization_id)} AND project_id = ${String(row.project_id)} AND id = ${String(row.id)}`;
  return {
    planId: String(row.id),
    plan,
    artifactsAvailable: plan !== null,
    status: receipt?.outcome ?? (clock[0]?.live ? "pending" : "expired"),
    receipt,
  };
}

function checkReviewRequest(row: PlanRow, digest: string, revision?: number): void {
  if (digest !== row.reviewed_digest)
    throw new ConfigurationError("configuration_review_changed", 409);
  if (revision !== undefined && revision !== Number(row.base_revision))
    throw new ConfigurationError("revision_conflict", 409);
}

async function assertPlanLive(
  sql: DatabaseExecutor,
  row: PlanRow,
  signal?: AbortSignal,
): Promise<void> {
  const rows = await sql`SELECT id FROM project_configuration_plans
    WHERE organization_id = ${String(row.organization_id)} AND project_id = ${String(row.project_id)}
      AND id = ${String(row.id)} AND expires_at > clock_timestamp()`;
  notCancelled(signal);
  if (rows.length !== 1) throw new ConfigurationError("configuration_expired", 409);
}

async function terminal(
  sql: DatabaseExecutor,
  context: TenantContext,
  row: PlanRow,
  outcome: "applied" | "no_op" | "cancelled",
  committedRevision: number | null,
  committedHash: string | null,
  provenanceAuditId: string,
  scheduleEditAuditId: string | null,
): Promise<ProjectConfigurationReceiptV1> {
  const clock = await sql`SELECT date_trunc('milliseconds', clock_timestamp()) AS recorded_at`;
  const common = {
    schemaVersion: 1 as const,
    planId: String(row.id),
    organizationId: context.organizationId,
    projectId: String(row.project_id),
    previousRevision: Number(row.base_revision),
    baseInputHashSha256: String(row.base_input_hash_sha256),
    reviewedDigest: String(row.reviewed_digest),
    provenanceAuditId,
    recordedAt: instant(clock[0]?.recorded_at),
  };
  const receipt: ProjectConfigurationReceiptV1 =
    outcome === "cancelled"
      ? {
          ...common,
          outcome,
          committedRevision: null,
          committedInputHashSha256: null,
          scheduleEditAuditId: null,
        }
      : {
          ...common,
          outcome,
          committedRevision: committedRevision as number,
          committedInputHashSha256: committedHash as string,
          scheduleEditAuditId,
        };
  const text = JSON.stringify(receipt);
  await sql`INSERT INTO project_configuration_outcomes (organization_id, project_id, plan_id, outcome,
    previous_revision, committed_revision, base_input_hash_sha256, committed_input_hash_sha256, reviewed_digest,
    provenance_audit_id, schedule_edit_audit_id, recorded_at, receipt_json, receipt_hash_sha256)
    VALUES (${context.organizationId}, ${String(row.project_id)}, ${String(row.id)}, ${outcome}, ${Number(row.base_revision)},
      ${committedRevision}, ${String(row.base_input_hash_sha256)}, ${committedHash}, ${String(row.reviewed_digest)},
      ${provenanceAuditId}, ${scheduleEditAuditId}, ${common.recordedAt}, ${text}, ${hash(text)})`;
  return receipt;
}

export class ConfigurationRepository {
  constructor(private readonly db: Database) {}

  // Separate, short maintenance never acquires session/project/plan locks. Row
  // selection skips live readers; trigger reservations/release use one consistent
  // global-then-project counter order. Failure propagates, never disables bounds.
  async maintainArtifacts(): Promise<number> {
    return await this.db.begin(async (sql) => {
      const clock = await sql`SELECT clock_timestamp() AS cutoff`;
      const cutoff = instant(clock[0]?.cutoff);
      const rows = await sql`WITH expired AS (
        SELECT organization_id, project_id, plan_id FROM project_configuration_artifacts
        WHERE keep_until <= ${cutoff}::timestamptz ORDER BY keep_until, organization_id, project_id, plan_id
        FOR UPDATE SKIP LOCKED LIMIT ${CONFIGURATION_MAINTENANCE_BATCH}
      ) DELETE FROM project_configuration_artifacts a USING expired e
        WHERE a.organization_id = e.organization_id AND a.project_id = e.project_id AND a.plan_id = e.plan_id
        RETURNING a.plan_id`;
      return rows.length;
    });
  }

  private async operation<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ProjectConfigurationError)
        throw new ConfigurationError("configuration_invalid", 422, error.diagnostics);
      if (error instanceof ConfigurationNativeIdError)
        throw new ConfigurationError("configuration_id_conflict", 422);
      if (error && typeof error === "object" && "code" in error && error.code === "P0002")
        throw new ConfigurationError("configuration_capacity", 429);
      if (error && typeof error === "object" && "code" in error && error.code === "P0003")
        throw new ConfigurationError("configuration_integrity_error", 503);
      throw error;
    }
  }

  async read(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    signal?: AbortSignal,
  ): Promise<ProjectConfigurationReadV1> {
    return this.operation(async () => {
      await this.maintainArtifacts();
      return await this.db.begin(async (sql) => {
        await authorizedProject(sql, context, projectId, principal, "project.read", signal);
        const snapshot = await currentSnapshot(sql, context, projectId, signal);
        const canonical = canonicalBase(snapshot);
        const response = {
          schemaVersion: 1 as const,
          revision: snapshot.revision,
          inputHashSha256: hash(canonical),
          configuration: config(JSON.parse(canonical)),
        };
        await appendAuditEvent(sql, {
          organizationId: context.organizationId,
          actorType: "user",
          actorId: context.actorId,
          action: "project.export",
          resourceType: "project",
          resourceId: projectId,
          source: "api",
          correlationId: context.correlationId,
          payload: {
            revision: snapshot.revision,
            format: "engineo-project-configuration-v1",
            inputHash: response.inputHashSha256,
            sessionId: principal.sessionId,
          },
        });
        await assertLiveSession(sql, principal, signal);
        return response;
      });
    });
  }

  async validate(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    configuration: unknown,
    signal?: AbortSignal,
  ): Promise<ProjectConfigurationValidateResponseV1> {
    return this.operation(async () => {
      const candidate = normalized(configuration);
      await this.maintainArtifacts();
      return await this.db.begin(async (sql) => {
        await authorizedProject(sql, context, projectId, principal, "project.read", signal);
        if (candidate.normalizedInput.project.id !== projectId)
          throw new ConfigurationError("configuration_invalid", 422);
        await assertConfigurationNativeIds(sql, context, projectId, candidate.normalizedInput);
        await assertLiveSession(sql, principal, signal);
        return {
          valid: true,
          normalizedConfiguration: candidate.normalizedConfiguration,
          desiredInputHashSha256: hash(candidate.canonicalInput),
          calculationChecked: false,
          diagnostics: candidate.diagnostics,
        };
      });
    });
  }

  async plan(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    request: ProjectConfigurationPlanRequestV1,
    signal?: AbortSignal,
  ): Promise<ProjectConfigurationPlanReadV1> {
    return this.operation(async () => {
      const candidate = normalized(request.configuration);
      await this.maintainArtifacts();
      return await this.db.begin(async (sql) => {
        await authorizedProject(sql, context, projectId, principal, "project.write", signal);
        if (candidate.normalizedInput.project.id !== projectId)
          throw new ConfigurationError("configuration_invalid", 422);
        const existing = await planRow(sql, context, projectId, request.planId);
        notCancelled(signal);
        const sourceHash = requestHash(request, candidate.canonicalInput);
        if (existing) {
          if (
            existing.actor_id !== principal.userId ||
            existing.session_id !== principal.sessionId ||
            existing.request_hash_sha256 !== sourceHash
          )
            throw new ConfigurationError("configuration_idempotency_conflict", 409);
          assertSupportedPlan(existing);
          const response = await readPlanValue(sql, existing);
          await assertLiveSession(sql, principal, signal);
          return response;
        }
        const snapshot = await currentSnapshot(sql, context, projectId, signal);
        if (snapshot.revision !== request.expectedRevision)
          throw new ConfigurationError("revision_conflict", 409);
        await assertConfigurationNativeIds(sql, context, projectId, candidate.normalizedInput);
        notCancelled(signal);
        const baseCanonical = canonicalBase(snapshot);
        const diff = diffProjectConfigurationV1(snapshot.input, candidate.normalizedInput);
        const admissionClock = await sql`SELECT clock_timestamp() AS cutoff`;
        const admissionTime = new Date(instant(admissionClock[0]?.cutoff));
        const admissionCutoff = admissionTime.toISOString();
        const hourlyCutoff = new Date(admissionTime.getTime() - 60 * 60 * 1000).toISOString();
        const quotas = await sql`SELECT
          (SELECT count(*)::int FROM (
            SELECT 1 FROM project_configuration_plans
            WHERE organization_id = ${context.organizationId} AND project_id = ${projectId}
              AND actor_id = ${principal.userId} AND created_at > ${hourlyCutoff}::timestamptz
            LIMIT ${CONFIGURATION_ACTOR_HOURLY_LIMIT}
          ) recent_actor) AS hourly,
          (SELECT count(*)::int FROM (
            SELECT 1 FROM project_configuration_plans p
            WHERE p.organization_id = ${context.organizationId} AND p.project_id = ${projectId}
              AND p.actor_id = ${principal.userId} AND p.created_at > ${hourlyCutoff}::timestamptz
              AND p.expires_at > ${admissionCutoff}::timestamptz AND NOT EXISTS (
                SELECT 1 FROM project_configuration_outcomes o WHERE o.organization_id = p.organization_id
                  AND o.project_id = p.project_id AND o.plan_id = p.id)
            LIMIT ${CONFIGURATION_ACTOR_PENDING_LIMIT}
          ) pending_actor) AS actor_pending,
          (SELECT count(*)::int FROM (
            SELECT 1 FROM project_configuration_plans p
            WHERE p.organization_id = ${context.organizationId} AND p.project_id = ${projectId}
              AND p.created_at > ${hourlyCutoff}::timestamptz
              AND p.expires_at > ${admissionCutoff}::timestamptz AND NOT EXISTS (
                SELECT 1 FROM project_configuration_outcomes o WHERE o.organization_id = p.organization_id
                  AND o.project_id = p.project_id AND o.plan_id = p.id)
            LIMIT ${CONFIGURATION_PROJECT_PENDING_LIMIT}
          ) pending_project) AS project_pending`;
        notCancelled(signal);
        if (Number(quotas[0]?.hourly) >= CONFIGURATION_ACTOR_HOURLY_LIMIT)
          throw new ConfigurationError("configuration_rate_limit", 429);
        if (
          Number(quotas[0]?.actor_pending) >= CONFIGURATION_ACTOR_PENDING_LIMIT ||
          Number(quotas[0]?.project_pending) >= CONFIGURATION_PROJECT_PENDING_LIMIT
        )
          throw new ConfigurationError("configuration_capacity", 429);
        const times = await sql`WITH stamp AS MATERIALIZED (
          SELECT date_trunc('milliseconds', clock_timestamp()) AS created_at
        ) SELECT stamp.created_at,
          least(stamp.created_at + interval '15 minutes', date_trunc('milliseconds', s.expires_at)) AS expires_at
          FROM stamp JOIN auth_sessions s ON s.id = ${principal.sessionId} AND s.user_id = ${principal.userId}`;
        if (
          times.length !== 1 ||
          new Date(instant(times[0]?.expires_at)).getTime() <=
            new Date(instant(times[0]?.created_at)).getTime()
        )
          throw new ConfigurationError("unauthenticated", 401);
        const row = {
          id: request.planId.toLowerCase(),
          organization_id: context.organizationId,
          project_id: projectId,
          actor_id: principal.userId,
          session_id: principal.sessionId,
          base_revision: snapshot.revision,
          base_input_hash_sha256: hash(baseCanonical),
          desired_input_hash_sha256: hash(candidate.canonicalInput),
          no_op: diff.noOp,
          created_at: times[0]?.created_at,
          expires_at: times[0]?.expires_at,
        } as PlanRow;
        const reviewJson = serializeProjectConfigurationReviewV1(
          reviewWithoutDigest(row, candidate.normalizedConfiguration, diff.changes),
        );
        const digest = hash(reviewJson);
        await assertLiveSession(sql, principal, signal);
        const auditId = await appendAuditEvent(sql, {
          organizationId: context.organizationId,
          actorType: "user",
          actorId: context.actorId,
          action: "configuration.plan",
          resourceType: "project",
          resourceId: projectId,
          source: "api",
          correlationId: context.correlationId,
          payload: {
            planId: request.planId.toLowerCase(),
            revision: snapshot.revision,
            baseInputHash: String(row.base_input_hash_sha256),
            desiredInputHash: String(row.desired_input_hash_sha256),
            reviewedDigest: digest,
            sessionId: principal.sessionId,
            noOp: diff.noOp,
          },
        });
        notCancelled(signal);
        await sql`INSERT INTO project_configuration_plans (organization_id, project_id, id, actor_id, session_id,
          protocol_version, configuration_version, normalization_version, base_revision, base_input_hash_sha256,
          desired_input_hash_sha256, request_hash_sha256, reviewed_digest, no_op, created_at, expires_at, artifacts_keep_until, plan_audit_id)
          VALUES (${context.organizationId}, ${projectId}, ${request.planId}, ${principal.userId}, ${principal.sessionId},
            ${PROJECT_CONFIGURATION_PROTOCOL_VERSION}, ${PROJECT_CONFIGURATION_VERSION}, ${PROJECT_CONFIGURATION_NORMALIZATION_VERSION},
            ${snapshot.revision}, ${String(row.base_input_hash_sha256)}, ${String(row.desired_input_hash_sha256)}, ${sourceHash}, ${digest}, ${diff.noOp},
            ${instant(row.created_at)}, ${instant(row.expires_at)}, ${instant(row.created_at)}::timestamptz + interval '24 hours', ${auditId})`;
        notCancelled(signal);
        await sql`INSERT INTO project_configuration_artifacts (organization_id, project_id, plan_id, base_canonical,
          candidate_canonical, diff_json, review_json, keep_until) VALUES (${context.organizationId}, ${projectId}, ${request.planId},
          ${baseCanonical}, ${candidate.canonicalInput}, ${diff.serializedDiff}, ${reviewJson}, ${instant(row.created_at)}::timestamptz + interval '24 hours')`;
        notCancelled(signal);
        const saved = await planRow(sql, context, projectId, request.planId);
        assertCreator(saved, principal);
        await assertPlanLive(sql, saved, signal);
        const response = await readPlanValue(sql, saved);
        await assertLiveSession(sql, principal, signal);
        await assertPlanLive(sql, saved, signal);
        return response;
      });
    });
  }

  async getPlan(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    planId: string,
    signal?: AbortSignal,
  ): Promise<ProjectConfigurationPlanReadV1> {
    planId = planId.toLowerCase();
    return this.operation(async () => {
      await this.maintainArtifacts();
      return await this.db.begin(async (sql) => {
        await authorizedProject(sql, context, projectId, principal, "project.read", signal);
        const row = await planRow(sql, context, projectId, planId);
        notCancelled(signal);
        assertCreator(row, principal);
        const response = await readPlanValue(sql, row);
        await assertLiveSession(sql, principal, signal);
        return response;
      });
    });
  }

  async receipt(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    planId: string,
    signal?: AbortSignal,
  ): Promise<ProjectConfigurationReceiptV1> {
    planId = planId.toLowerCase();
    return this.operation(async () => {
      await this.maintainArtifacts();
      return await this.db.begin(async (sql) => {
        await authorizedProject(sql, context, projectId, principal, "project.read", signal);
        const row = await planRow(sql, context, projectId, planId);
        notCancelled(signal);
        assertCreator(row, principal, false);
        const outcome = await outcomeRow(sql, row);
        if (!outcome) throw new ConfigurationError("configuration_not_terminal", 409);
        const response = receiptValue(row, outcome);
        await assertLiveSession(sql, principal, signal);
        return response;
      });
    });
  }

  async apply(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    planId: string,
    request: ProjectConfigurationApplyRequestV1,
    signal?: AbortSignal,
  ): Promise<ProjectConfigurationReceiptV1> {
    planId = planId.toLowerCase();
    return this.operation(async () => {
      await this.maintainArtifacts();
      return await this.db.begin(async (sql) => {
        await authorizedProject(sql, context, projectId, principal, "project.write", signal);
        const row = await planRow(sql, context, projectId, planId);
        notCancelled(signal);
        assertCreator(row, principal);
        checkReviewRequest(row, request.reviewedDigest, request.expectedRevision);
        const existing = await outcomeRow(sql, row);
        notCancelled(signal);
        if (existing) {
          const response = receiptValue(row, existing);
          await assertLiveSession(sql, principal, signal);
          if (response.outcome === "cancelled")
            throw new ConfigurationError("configuration_cancelled", 409);
          return response;
        }
        await assertPlanLive(sql, row, signal);
        const snapshot = await currentSnapshot(sql, context, projectId, signal);
        const plan = await verifiedReview(sql, row);
        notCancelled(signal);
        if (!plan) throw new ConfigurationError("configuration_artifact_unavailable", 410);
        if (snapshot.revision !== plan.baseRevision)
          throw new ConfigurationError("revision_conflict", 409);
        if (hash(canonicalBase(snapshot)) !== plan.baseInputHashSha256)
          throw new ConfigurationError("configuration_base_changed", 409);
        const candidate = normalized(plan.configuration);
        await assertConfigurationNativeIds(sql, context, projectId, candidate.normalizedInput);
        notCancelled(signal);
        await assertLiveSession(sql, principal, signal);
        await assertPlanLive(sql, row, signal);
        let scheduleEditAuditId: string | null = null;
        let revision = snapshot.revision;
        if (!plan.noOp) {
          await reconcileConfigurationSchedule(sql, context, projectId, candidate.normalizedInput);
          notCancelled(signal);
          const changed =
            await sql`UPDATE projects SET revision = revision + 1, updated_at = clock_timestamp()
            WHERE organization_id = ${context.organizationId} AND id = ${projectId} AND revision = ${snapshot.revision} RETURNING revision`;
          notCancelled(signal);
          if (changed.length !== 1) throw new ConfigurationError("revision_conflict", 409);
          revision = Number(changed[0]?.revision);
          scheduleEditAuditId = await appendAuditEvent(sql, {
            organizationId: context.organizationId,
            actorType: "user",
            actorId: context.actorId,
            action: "project.schedule.edit",
            resourceType: "project",
            resourceId: projectId,
            source: "api",
            correlationId: context.correlationId,
            payload: {
              schemaVersion: 1,
              kind: "engineo-configuration-schedule-edit",
              operation: "configuration.apply",
              inputHashSerialization: "engineo-schedule-input-v1-canonical",
              planId,
              revision,
              previousRevision: snapshot.revision,
              baseInputHashSha256: plan.baseInputHashSha256,
              committedInputHashSha256: plan.desiredInputHashSha256,
              reviewedDigest: plan.reviewedDigest,
              sessionId: principal.sessionId,
            },
          });
          notCancelled(signal);
        }
        const persisted = await currentSnapshot(sql, context, projectId, signal);
        notCancelled(signal);
        if (
          !persisted ||
          persisted.revision !== revision ||
          canonicalBase(persisted) !== candidate.canonicalInput
        )
          throw new ConfigurationError("configuration_integrity_error", 503);
        await assertLiveSession(sql, principal, signal);
        await assertPlanLive(sql, row, signal);
        const provenanceAuditId = await appendAuditEvent(sql, {
          organizationId: context.organizationId,
          actorType: "user",
          actorId: context.actorId,
          action: "configuration.apply",
          resourceType: "project",
          resourceId: projectId,
          source: "api",
          correlationId: context.correlationId,
          payload: {
            planId,
            outcome: plan.noOp ? "no_op" : "applied",
            previousRevision: snapshot.revision,
            committedRevision: revision,
            baseInputHash: plan.baseInputHashSha256,
            committedInputHash: plan.desiredInputHashSha256,
            reviewedDigest: plan.reviewedDigest,
            scheduleEditAuditId,
            sessionId: principal.sessionId,
          },
        });
        notCancelled(signal);
        const response = await terminal(
          sql,
          context,
          row,
          plan.noOp ? "no_op" : "applied",
          revision,
          plan.desiredInputHashSha256,
          provenanceAuditId,
          scheduleEditAuditId,
        );
        await assertLiveSession(sql, principal, signal);
        await assertPlanLive(sql, row, signal);
        return response;
      });
    });
  }

  async cancel(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    planId: string,
    request: ProjectConfigurationCancelRequestV1,
    signal?: AbortSignal,
  ): Promise<ProjectConfigurationReceiptV1> {
    planId = planId.toLowerCase();
    return this.operation(async () => {
      await this.maintainArtifacts();
      return await this.db.begin(async (sql) => {
        await authorizedProject(sql, context, projectId, principal, "project.write", signal);
        const row = await planRow(sql, context, projectId, planId);
        notCancelled(signal);
        assertCreator(row, principal);
        checkReviewRequest(row, request.reviewedDigest);
        const existing = await outcomeRow(sql, row);
        notCancelled(signal);
        if (existing) {
          const response = receiptValue(row, existing);
          await assertLiveSession(sql, principal, signal);
          return response;
        }
        // Cancellation remains useful after expiry or review collection. It
        // creates a terminal tombstone without claiming a schedule commit.
        const auditId = await appendAuditEvent(sql, {
          organizationId: context.organizationId,
          actorType: "user",
          actorId: context.actorId,
          action: "configuration.cancel",
          resourceType: "project",
          resourceId: projectId,
          source: "api",
          correlationId: context.correlationId,
          payload: {
            planId,
            reviewedDigest: request.reviewedDigest,
            sessionId: principal.sessionId,
          },
        });
        notCancelled(signal);
        const response = await terminal(sql, context, row, "cancelled", null, null, auditId, null);
        await assertLiveSession(sql, principal, signal);
        return response;
      });
    });
  }
}
