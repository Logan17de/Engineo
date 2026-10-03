import { randomUUID } from "node:crypto";
import {
  type PlannerViewConfigurationV1,
  type PlannerViewPlanRequestV1,
  type PlannerViewPlanV1,
  type PlannerViewApplyRequestV1,
  type PlannerViewReceiptV1,
  type PlannerViewReviewV1,
  PlannerViewOperationsError,
  calculatePlannerViewReviewDigestV1,
  parsePlannerViewReceiptV1,
  plannerViewOperationWindowV1,
  plannerViewReviewTimesV1,
  serializePlannerViewReceiptV1,
  serializePlannerViewReviewV1,
  validatePlannerViewPlanRequestV1,
  validatePlannerViewApplyRequestV1,
  verifyPlannerViewReviewBindingV1,
  verifyPlannerViewReviewDigestV1,
  verifyPlannerViewReviewTimeV1,
  parsePlannerViewConfigurationV1,
  PlannerViewConfigurationError,
  projectPlannerPresentationV1,
  validatePlannerViewConfigurationV1,
} from "@engineo/contracts";
import type { Database, DatabaseExecutor } from "../db/client.js";
import type { TenantContext } from "../db/tenant-context.js";
import type { ScheduleRunner } from "../scheduler/runner.js";
import { appendAuditEvent } from "../security/audit.js";
import type { SessionPrincipal } from "../security/session.js";
import { assertLiveViewSession, authorizePrivateView } from "./planner-view-access.js";
import {
  assertViewNotCancelled,
  PlannerViewError,
  safeViewDiagnostics,
} from "./planner-view-errors.js";
import { readProtectedPlannerViewSource, viewHash, viewInstant } from "./planner-view-source.js";

// The presentation and schedule serializers are intentionally separate.
function normalized(configuration: unknown) {
  const value = validatePlannerViewConfigurationV1(configuration);
  if (!value.valid)
    throw new PlannerViewError("view_invalid", 422, safeViewDiagnostics(value.diagnostics));
  return { ...value, configHashSha256: viewHash(value.hashPreimage) };
}

export interface PlannerViewRead {
  schemaVersion: 1;
  viewId: string;
  viewRevision: number;
  configuration: PlannerViewConfigurationV1;
  configHashSha256: string;
  createdAt: string;
  updatedAt: string;
}

async function ownViewRow(
  sql: DatabaseExecutor,
  context: TenantContext,
  projectId: string,
  actorId: string,
  viewId: string,
  mutation = false,
) {
  const rows = mutation
    ? await sql`SELECT * FROM project_planner_views WHERE organization_id=${context.organizationId}
      AND project_id=${projectId} AND owner_user_id=${actorId} AND id=${viewId} FOR UPDATE`
    : await sql`SELECT * FROM project_planner_views WHERE organization_id=${context.organizationId}
      AND project_id=${projectId} AND owner_user_id=${actorId} AND id=${viewId} FOR SHARE`;
  return rows[0];
}
type ViewRow = NonNullable<Awaited<ReturnType<typeof ownViewRow>>>;
function viewValue(row: ViewRow | undefined): PlannerViewRead {
  if (!row) throw new PlannerViewError("view_not_found", 404);
  try {
    const parsed = parsePlannerViewConfigurationV1(String(row.config_json));
    if (!parsed.valid) throw new Error("Invalid stored configuration");
    const value = normalized(parsed.normalizedConfiguration);
    if (
      Number(row.protocol_version) !== 1 ||
      Number(row.projection_version) !== 1 ||
      Number(row.normalization_version) !== 1 ||
      value.canonicalConfiguration !== row.config_json ||
      value.configHashSha256 !== row.config_hash_sha256 ||
      Number(row.byte_count) !== Buffer.byteLength(value.canonicalConfiguration, "utf8") ||
      !Number.isSafeInteger(Number(row.view_revision)) ||
      Number(row.view_revision) < 1
    )
      throw new Error("Invalid private record");
    return {
      schemaVersion: 1,
      viewId: String(row.id),
      viewRevision: Number(row.view_revision),
      configuration: value.normalizedConfiguration,
      configHashSha256: value.configHashSha256,
      createdAt: viewInstant(row.created_at),
      updatedAt: viewInstant(row.updated_at),
    };
  } catch {
    throw new PlannerViewError("view_integrity_error", 503);
  }
}

function assertReference(
  configuration: PlannerViewConfigurationV1,
  wbs: readonly { id: string }[],
): void {
  const id = configuration.presentation.wbsId;
  if (id !== null && !wbs.some((node) => node.id === id))
    throw new PlannerViewError("view_reference_stale", 409);
}
function needsResult(configuration: PlannerViewConfigurationV1): boolean {
  return (
    configuration.presentation.critical !== "all" ||
    ["earlyStart", "totalFloatMinutes"].includes(configuration.presentation.sort.field)
  );
}

/** Every request charges bounded shared state in a separate authorized transaction.
 * Failed validation/projection cannot roll back its abuse charge. Apply's accepted
 * write charge, view/audit/receipt and reservations are instead one atomic unit. */
export class PlannerViewRepository {
  constructor(
    private readonly db: Database,
    private readonly runner?: ScheduleRunner,
    private readonly requestPreAdmitted = false,
  ) {}

  private async operation<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof PlannerViewError) throw error;
      if (
        error instanceof PlannerViewConfigurationError ||
        error instanceof PlannerViewOperationsError
      )
        throw new PlannerViewError("view_invalid", 422, safeViewDiagnostics(error.diagnostics));
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code === "P0002") throw new PlannerViewError("view_capacity", 429);
      if (code === "P0003") throw new PlannerViewError("view_integrity_error", 503);
      if (code === "P0004") throw new PlannerViewError("view_rate_limit", 429);
      if (code === "55P03" || code === "57014" || code === "40001" || code === "40P01")
        throw new PlannerViewError("view_unavailable", 503);
      throw error;
    }
  }

  async admitRequest(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    signal?: AbortSignal,
  ) {
    await this.operation(async () =>
      this.db.begin(async (sql) => {
        await authorizePrivateView(sql, context, projectId, principal, false, signal);
        await sql`SELECT engineo_planner_view_charge_rate(${context.organizationId}::uuid,
        ${projectId}::uuid,${principal.userId}::uuid,'read')`;
        await assertLiveViewSession(sql, principal, signal);
      }),
    );
  }

  private async admit(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    signal?: AbortSignal,
  ) {
    // Only the encapsulated route instance uses this optimization. Every actual
    // operation still reauthorizes live identity/scope in its own transaction.
    if (!this.requestPreAdmitted) await this.admitRequest(context, projectId, principal, signal);
  }

  async maintain(): Promise<{
    removedOperations: number;
    removedRateRows: number;
    batchLimit: 64;
  }> {
    return this.operation(async () => {
      const rows = await this.db.begin(
        async (sql) => sql`SELECT * FROM engineo_planner_view_maintain(64)`,
      );
      return {
        removedOperations: Number(rows[0]?.removed_operations ?? 0),
        removedRateRows: Number(rows[0]?.removed_rate_rows ?? 0),
        batchLimit: 64,
      };
    });
  }

  async capabilities(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    signal?: AbortSignal,
  ) {
    return this.operation(async () => {
      await this.admit(context, projectId, principal, signal);
      return await this.db.begin(async (sql) => {
        await authorizePrivateView(sql, context, projectId, principal, false, signal);
        const rows = await sql`WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS now_at)
          SELECT (now_at AT TIME ZONE 'UTC')::date::text AS window,
            date_trunc('day',now_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 day' AS closes_at FROM stamp`;
        await assertLiveViewSession(sql, principal, signal);
        return {
          schemaVersion: 1,
          protocolVersion: 1,
          projectionVersion: 1,
          normalizationVersion: 1,
          visibility: ["private"],
          actions: ["create", "update", "delete"],
          capabilities: ["project.read", "view.private.write"],
          builtIn: { id: "native", immutable: true },
          operationWindowId: String(rows[0]?.window),
          operationWindowClosesAt: viewInstant(rows[0]?.closes_at),
          operationReplayUntil: new Date(
            new Date(viewInstant(rows[0]?.closes_at)).getTime() + 86400000,
          ).toISOString(),
          limits: {
            configurationBytes: 8192,
            bodyBytes: 65536,
            depth: 8,
            pageSize: 50,
            reviewTtlSeconds: 900,
            projectionBytes: 4194304,
            actorProjectViews: 20,
            projectViews: 128,
            projectConfigBytes: 1048576,
            globalConfigBytes: 67108864,
            projectTotalBytes: 4194304,
            globalTotalBytes: 134217728,
            actorReadsPerMinute: 120,
            projectReadsPerMinute: 600,
            actorWritesPerHour: 60,
            projectWritesPerHour: 300,
            lifetimeAuditEvents: 100000,
            maintenanceBatch: 64,
          },
        };
      });
    });
  }

  async read(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    viewId: string,
    signal?: AbortSignal,
  ) {
    return this.operation(async () => {
      await this.admit(context, projectId, principal, signal);
      return await this.db.begin(async (sql) => {
        await authorizePrivateView(sql, context, projectId, principal, false, signal);
        const response = viewValue(
          await ownViewRow(sql, context, projectId, principal.userId, viewId),
        );
        await assertLiveViewSession(sql, principal, signal);
        return response;
      });
    });
  }

  async list(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    cursor: string | null = null,
    limit = 50,
    signal?: AbortSignal,
  ) {
    return this.operation(async () => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
        throw new PlannerViewError("view_invalid", 422);
      await this.admit(context, projectId, principal, signal);
      return await this.db.begin(async (sql) => {
        await authorizePrivateView(sql, context, projectId, principal, false, signal);
        const cursorView =
          cursor === null
            ? null
            : viewValue(await ownViewRow(sql, context, projectId, principal.userId, cursor));
        const rows =
          cursorView === null
            ? await sql`SELECT * FROM project_planner_views WHERE organization_id=${context.organizationId}
            AND project_id=${projectId} AND owner_user_id=${principal.userId}
            ORDER BY ((config_json::jsonb)->>'name') COLLATE "C",id LIMIT ${limit + 1}`
            : await sql`SELECT * FROM project_planner_views WHERE organization_id=${context.organizationId}
            AND project_id=${projectId} AND owner_user_id=${principal.userId}
            AND (((config_json::jsonb)->>'name') COLLATE "C",id) > (${cursorView.configuration.name} COLLATE "C",${cursorView.viewId}::uuid)
            ORDER BY ((config_json::jsonb)->>'name') COLLATE "C",id LIMIT ${limit + 1}`;
        const values = rows.slice(0, limit).map(viewValue);
        const last = values.at(-1);
        await assertLiveViewSession(sql, principal, signal);
        return {
          schemaVersion: 1,
          builtIn: { id: "native", immutable: true },
          views: values.map((value) => ({
            viewId: value.viewId,
            viewRevision: value.viewRevision,
            name: value.configuration.name,
            configHashSha256: value.configHashSha256,
            updatedAt: value.updatedAt,
          })),
          // Opaque UUID cursor never puts configuration/name text in logged URLs.
          nextCursor: rows.length > limit && last ? last.viewId : null,
        };
      });
    });
  }

  async validate(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    configuration: unknown,
    signal?: AbortSignal,
  ) {
    return this.operation(async () => {
      await this.admit(context, projectId, principal, signal);
      const candidate = normalized(configuration);
      return await this.db.begin(async (sql) => {
        await authorizePrivateView(sql, context, projectId, principal, false, signal);
        const source = await readProtectedPlannerViewSource(sql, context, projectId, null, signal);
        assertReference(candidate.normalizedConfiguration, source.snapshot.input.wbs);
        await assertLiveViewSession(sql, principal, signal);
        return {
          schemaVersion: 1,
          valid: true,
          normalizedConfiguration: candidate.normalizedConfiguration,
          configHashSha256: candidate.configHashSha256,
          observedScheduleRevision: source.snapshot.scheduleRevision,
          activationAvailable: !needsResult(candidate.normalizedConfiguration),
          calculationChecked: false,
          diagnostics: candidate.diagnostics,
        };
      });
    });
  }

  async projection(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    configuration: unknown,
    expectedScheduleRevision: number | null,
    signal?: AbortSignal,
    viewId?: string,
  ) {
    return this.operation(async () => {
      // Auth and shared admission precede the compatibility-only engine probe.
      await this.admit(context, projectId, principal, signal);
      const candidate =
        viewId === undefined
          ? normalized(configuration)
          : await this.db.begin(async (sql) => {
              await authorizePrivateView(sql, context, projectId, principal, false, signal);
              const saved = viewValue(
                await ownViewRow(sql, context, projectId, principal.userId, viewId),
              );
              await assertLiveViewSession(sql, principal, signal);
              return normalized(saved.configuration);
            });
      let engineVersion: string | null;
      try {
        engineVersion = needsResult(candidate.normalizedConfiguration)
          ? ((await this.runner?.getEngineVersion()) ?? null)
          : null;
      } catch {
        throw new PlannerViewError("view_result_required", 409);
      }
      assertViewNotCancelled(signal);
      return await this.db.begin(async (sql) => {
        await authorizePrivateView(sql, context, projectId, principal, false, signal);
        const saved =
          viewId === undefined
            ? null
            : viewValue(await ownViewRow(sql, context, projectId, principal.userId, viewId));
        const value = saved ? normalized(saved.configuration) : candidate;
        if (!value) throw new PlannerViewError("view_invalid", 422);
        const source = await readProtectedPlannerViewSource(
          sql,
          context,
          projectId,
          needsResult(value.normalizedConfiguration) ? engineVersion : null,
          signal,
        );
        if (
          expectedScheduleRevision !== null &&
          expectedScheduleRevision !== source.snapshot.scheduleRevision
        )
          throw new PlannerViewError("view_schedule_revision_conflict", 409);
        const response = projectPlannerPresentationV1(source.snapshot, source.calculation, {
          projectionVersion: 1,
          normalizationVersion: 1,
          configHashSha256: value.configHashSha256,
          presentation: value.normalizedConfiguration.presentation,
        });
        if (!response.available)
          throw new PlannerViewError(response.error, response.error === "view_invalid" ? 503 : 409);
        if (Buffer.byteLength(JSON.stringify(response), "utf8") > 4194304)
          throw new PlannerViewError("view_projection_too_large", 422);
        await assertLiveViewSession(sql, principal, signal);
        return response;
      });
    });
  }

  async plan(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    request: PlannerViewPlanRequestV1,
    signal?: AbortSignal,
  ): Promise<PlannerViewPlanV1> {
    return this.operation(async () => {
      await this.admit(context, projectId, principal, signal);
      const checked = validatePlannerViewPlanRequestV1(request);
      if (!checked.valid)
        throw new PlannerViewError("view_invalid", 422, safeViewDiagnostics(checked.diagnostics));
      request = checked.value;
      return await this.db.begin(async (sql) => {
        const sessionExpiry = await authorizePrivateView(
          sql,
          context,
          projectId,
          principal,
          true,
          signal,
        );
        const source = await readProtectedPlannerViewSource(sql, context, projectId, null, signal);
        if (source.snapshot.scheduleRevision !== request.expectedScheduleRevision)
          throw new PlannerViewError("view_schedule_revision_conflict", 409);
        const base =
          request.action === "create"
            ? null
            : viewValue(
                await ownViewRow(sql, context, projectId, principal.userId, request.viewId),
              );
        if (
          base &&
          request.action !== "create" &&
          base.viewRevision !== request.expectedViewRevision
        )
          throw new PlannerViewError("view_revision_conflict", 409);
        const desired = request.action === "delete" ? null : normalized(request.configuration);
        if (desired) assertReference(desired.normalizedConfiguration, source.snapshot.input.wbs);
        const now = await serverNow(sql);
        const times = plannerViewReviewTimesV1({
          now,
          sessionExpiresAt: sessionExpiry.toISOString(),
        });
        if (request.operationWindowId !== times.operationWindowId)
          throwWindow(request.operationWindowId, now);
        const review: PlannerViewReviewV1 = {
          schemaVersion: 1,
          kind: "engineo-planner-view-review",
          protocolVersion: 1,
          projectionVersion: 1,
          normalizationVersion: 1,
          action: request.action,
          viewId: base?.viewId ?? null,
          actorId: principal.userId,
          sessionId: principal.sessionId,
          organizationId: context.organizationId,
          projectId,
          expectedViewRevision: base?.viewRevision ?? 0,
          expectedScheduleRevision: source.snapshot.scheduleRevision,
          baseConfigHash: base?.configHashSha256 ?? null,
          desiredConfigHash: desired?.configHashSha256 ?? null,
          baseConfiguration: base?.configuration ?? null,
          desiredConfiguration: desired?.normalizedConfiguration ?? null,
          operationId: request.operationId,
          ...times,
        };
        await assertLiveViewSession(sql, principal, signal);
        assertReviewLive(review, await serverNow(sql), sessionExpiry);
        return { review, reviewedDigest: calculatePlannerViewReviewDigestV1(review, viewHash) };
      });
    });
  }

  async apply(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    request: PlannerViewApplyRequestV1,
    signal?: AbortSignal,
  ): Promise<PlannerViewReceiptV1> {
    return this.operation(async () => {
      await this.admit(context, projectId, principal, signal);
      const checked = validatePlannerViewApplyRequestV1(request);
      if (!checked.valid)
        throw new PlannerViewError("view_invalid", 422, safeViewDiagnostics(checked.diagnostics));
      request = checked.value;
      const review = request.review;
      const digest = verifyPlannerViewReviewDigestV1(review, request.reviewedDigest, viewHash);
      if (!digest.valid) throw new PlannerViewError(digest.reason, 409);
      const binding = verifyPlannerViewReviewBindingV1(review, {
        actorId: principal.userId,
        sessionId: principal.sessionId,
        organizationId: context.organizationId,
        projectId,
      });
      if (!binding.valid) throw new PlannerViewError(binding.reason, 409);
      const requestHash = viewHash(
        JSON.stringify({
          review: serializePlannerViewReviewV1(review),
          reviewedDigest: request.reviewedDigest,
        }),
      );
      return await this.db.begin(async (sql) => {
        const sessionExpiry = await authorizePrivateView(
          sql,
          context,
          projectId,
          principal,
          true,
          signal,
        );
        // Never take an exclusive project/schedule lock for a personal view.
        await sql`SELECT engineo_planner_view_lock_storage(${context.organizationId}::uuid,${projectId}::uuid)`;
        await assertLiveViewSession(sql, principal, signal);
        const row =
          review.viewId === null
            ? undefined
            : await ownViewRow(sql, context, projectId, principal.userId, review.viewId, true);
        const operations =
          await sql`SELECT * FROM planner_view_operations WHERE organization_id=${context.organizationId}
          AND project_id=${projectId} AND actor_id=${principal.userId} AND operation_window_id=${review.operationWindowId}::date
          AND operation_id=${review.operationId}::uuid FOR UPDATE`;
        assertViewNotCancelled(signal);
        const existing = operations[0];
        const now = await serverNow(sql);
        if (existing) {
          if (now >= viewInstant(existing.keep_until))
            throw new PlannerViewError("view_operation_expired", 410);
          if (
            existing.creator_session_id !== principal.sessionId ||
            existing.request_hash_sha256 !== requestHash
          )
            throw new PlannerViewError("view_idempotency_conflict", 409);
          // Historical exact replay intentionally precedes all current base/time checks.
          const receipt = receiptValue(existing);
          await assertLiveViewSession(sql, principal, signal);
          return receipt;
        }
        if (review.operationWindowId !== now.slice(0, 10))
          throwWindow(review.operationWindowId, now);
        assertReviewLive(review, now, sessionExpiry);
        const base = review.action === "create" ? null : viewValue(row);
        const source = await readProtectedPlannerViewSource(sql, context, projectId, null, signal);
        if (source.snapshot.scheduleRevision !== review.expectedScheduleRevision)
          throw new PlannerViewError("view_schedule_revision_conflict", 409);
        if (
          base &&
          (base.viewRevision !== review.expectedViewRevision ||
            base.configHashSha256 !== review.baseConfigHash ||
            JSON.stringify(base.configuration) !== JSON.stringify(review.baseConfiguration))
        )
          throw new PlannerViewError("view_revision_conflict", 409);
        const desired =
          review.desiredConfiguration === null ? null : normalized(review.desiredConfiguration);
        if (desired) assertReference(desired.normalizedConfiguration, source.snapshot.input.wbs);
        // Exact replay was resolved above. Indexed bounded probes enforce a
        // trailing-hour accepted-write ceiling even across UTC bucket boundaries.
        const hourlyCutoff = new Date(
          new Date(await serverNow(sql)).getTime() - 3600000,
        ).toISOString();
        const hourly = await sql`SELECT
          (SELECT count(*)::int FROM (SELECT 1 FROM planner_view_operations
            WHERE organization_id=${context.organizationId} AND project_id=${projectId}
              AND actor_id=${principal.userId} AND recorded_at > ${hourlyCutoff}::timestamptz
            LIMIT 60) actor_recent) AS actor_count,
          (SELECT count(*)::int FROM (SELECT 1 FROM planner_view_operations
            WHERE organization_id=${context.organizationId} AND project_id=${projectId}
              AND recorded_at > ${hourlyCutoff}::timestamptz
            LIMIT 300) project_recent) AS project_count`;
        assertViewNotCancelled(signal);
        if (Number(hourly[0]?.actor_count) >= 60 || Number(hourly[0]?.project_count) >= 300)
          throw new PlannerViewError("view_rate_limit", 429);
        await sql`SELECT engineo_planner_view_charge_rate(${context.organizationId}::uuid,${projectId}::uuid,
          ${principal.userId}::uuid,'write')`;
        const viewId = base?.viewId ?? randomUUID();
        const noOp =
          review.action === "update" && base?.configHashSha256 === desired?.configHashSha256;
        const outcome = review.action === "delete" ? "deleted" : noOp ? "no_op" : "applied";
        const newRevision =
          review.action === "delete" ? null : (base?.viewRevision ?? 0) + (noOp ? 0 : 1);
        if (newRevision !== null && !Number.isSafeInteger(newRevision))
          throw new PlannerViewError("view_revision_exhausted", 409);
        const stamp = await serverNow(sql);
        if (review.action === "create" && desired) {
          await sql`INSERT INTO project_planner_views(organization_id,project_id,id,owner_user_id,view_revision,
            protocol_version,projection_version,normalization_version,config_json,config_hash_sha256,created_at,updated_at)
            VALUES(${context.organizationId},${projectId},${viewId},${principal.userId},1,1,1,1,
              ${desired.canonicalConfiguration},${desired.configHashSha256},${stamp},${stamp})`;
        } else if (review.action === "delete" && base) {
          const removed =
            await sql`DELETE FROM project_planner_views WHERE organization_id=${context.organizationId}
            AND project_id=${projectId} AND owner_user_id=${principal.userId} AND id=${viewId}
            AND view_revision=${base.viewRevision} RETURNING id`;
          if (removed.length !== 1) throw new PlannerViewError("view_revision_conflict", 409);
        } else if (!noOp && base && desired) {
          const changed = await sql`UPDATE project_planner_views SET view_revision=${newRevision},
            config_json=${desired.canonicalConfiguration},config_hash_sha256=${desired.configHashSha256},updated_at=${stamp}
            WHERE organization_id=${context.organizationId} AND project_id=${projectId} AND owner_user_id=${principal.userId}
              AND id=${viewId} AND view_revision=${base.viewRevision} RETURNING id`;
          if (changed.length !== 1) throw new PlannerViewError("view_revision_conflict", 409);
        }
        await assertLiveViewSession(sql, principal, signal);
        assertReviewLive(review, await serverNow(sql), sessionExpiry);
        const auditId = await appendAuditEvent(sql, {
          organizationId: context.organizationId,
          actorType: "user",
          actorId: principal.userId,
          action: "view.apply",
          resourceType: "project",
          resourceId: projectId,
          source: "api",
          correlationId: context.correlationId,
          payload: {
            schemaVersion: 1,
            kind: "engineo-planner-view-change",
            action: noOp ? "no_op" : review.action,
            viewId,
            oldViewRevision: base?.viewRevision ?? 0,
            newViewRevision: newRevision,
            baseConfigHash: review.baseConfigHash,
            newConfigHash: review.desiredConfigHash,
            operationWindowId: review.operationWindowId,
            operationId: review.operationId,
            sessionId: principal.sessionId,
            observedScheduleRevision: source.snapshot.scheduleRevision,
          },
        });
        const recordedAt = await serverNow(sql);
        const receipt: PlannerViewReceiptV1 = {
          schemaVersion: 1,
          kind: "engineo-planner-view-receipt",
          protocolVersion: 1,
          projectionVersion: 1,
          normalizationVersion: 1,
          action: review.action,
          outcome,
          viewId,
          actorId: principal.userId,
          sessionId: principal.sessionId,
          organizationId: context.organizationId,
          projectId,
          previousViewRevision: base?.viewRevision ?? 0,
          committedViewRevision: newRevision,
          expectedScheduleRevision: source.snapshot.scheduleRevision,
          baseConfigHash: review.baseConfigHash,
          desiredConfigHash: review.desiredConfigHash,
          operationWindowId: review.operationWindowId,
          operationId: review.operationId,
          reviewedDigest: request.reviewedDigest,
          auditId,
          recordedAt,
        };
        const text = serializePlannerViewReceiptV1(receipt);
        const window = plannerViewOperationWindowV1(review.issuedAt);
        await sql`INSERT INTO planner_view_operations(organization_id,project_id,actor_id,operation_window_id,operation_id,
          creator_session_id,request_hash_sha256,reviewed_digest,operation,outcome,view_id,previous_view_revision,
          committed_view_revision,base_config_hash_sha256,committed_config_hash_sha256,observed_schedule_revision,
          audit_event_id,receipt_json,receipt_hash_sha256,recorded_at,keep_until)
          VALUES(${context.organizationId},${projectId},${principal.userId},${review.operationWindowId}::date,${review.operationId},
            ${principal.sessionId},${requestHash},${request.reviewedDigest},${review.action},${outcome},${viewId},
            ${receipt.previousViewRevision},${newRevision},${review.baseConfigHash},${review.desiredConfigHash},
            ${source.snapshot.scheduleRevision},${auditId},${text},${viewHash(text)},${recordedAt},${window.replayUntil})`;
        await assertLiveViewSession(sql, principal, signal);
        assertReviewLive(review, await serverNow(sql), sessionExpiry);
        return receipt;
      });
    });
  }

  async receipt(
    context: TenantContext,
    projectId: string,
    principal: SessionPrincipal,
    operationWindowId: string,
    operationId: string,
    signal?: AbortSignal,
  ) {
    return this.operation(async () => {
      await this.admit(context, projectId, principal, signal);
      return await this.db.begin(async (sql) => {
        await authorizePrivateView(sql, context, projectId, principal, false, signal);
        // Same serialization as apply makes a closed-window absent query definitive.
        await sql`SELECT engineo_planner_view_lock_storage(${context.organizationId}::uuid,${projectId}::uuid)`;
        const rows =
          await sql`SELECT * FROM planner_view_operations WHERE organization_id=${context.organizationId}
          AND project_id=${projectId} AND actor_id=${principal.userId} AND operation_window_id=${operationWindowId}::date
          AND operation_id=${operationId}::uuid FOR SHARE`;
        const now = await serverNow(sql);
        const window = plannerViewOperationWindowV1(`${operationWindowId}T00:00:00.000Z`);
        if (now >= window.replayUntil) throw new PlannerViewError("view_operation_expired", 410);
        if (operationWindowId > now.slice(0, 10)) throw new PlannerViewError("view_invalid", 422);
        const receipt = rows[0] ? receiptValue(rows[0]) : null;
        await assertLiveViewSession(sql, principal, signal);
        return {
          schemaVersion: 1,
          status: receipt ? "recorded" : "not_recorded",
          operationWindowId,
          operationId,
          windowClosed: now >= window.closesAt,
          absenceDefinitive: receipt === null && now >= window.closesAt,
          receipt,
        };
      });
    });
  }
}

async function serverNow(sql: DatabaseExecutor): Promise<string> {
  const rows = await sql`SELECT date_trunc('milliseconds',clock_timestamp()) AS stamp`;
  return viewInstant(rows[0]?.stamp);
}
function throwWindow(windowId: string, now: string): never {
  const window = plannerViewOperationWindowV1(`${windowId}T00:00:00.000Z`);
  if (now >= window.replayUntil) throw new PlannerViewError("view_operation_expired", 410);
  throw new PlannerViewError(
    windowId > now.slice(0, 10) ? "view_invalid" : "view_operation_window_closed",
    windowId > now.slice(0, 10) ? 422 : 409,
  );
}
function assertReviewLive(review: PlannerViewReviewV1, now: string, sessionExpiry: Date): void {
  const checked = verifyPlannerViewReviewTimeV1(review, {
    now,
    sessionExpiresAt: sessionExpiry.toISOString(),
  });
  if (!checked.valid)
    throw new PlannerViewError(checked.reason, checked.reason === "session_changed" ? 409 : 409);
}
function receiptValue(row: Record<string, unknown>): PlannerViewReceiptV1 {
  try {
    const checked = parsePlannerViewReceiptV1(String(row.receipt_json));
    if (!checked.valid) throw new Error("Invalid receipt");
    const value = checked.value;
    if (
      serializePlannerViewReceiptV1(value) !== row.receipt_json ||
      viewHash(String(row.receipt_json)) !== row.receipt_hash_sha256 ||
      value.organizationId !== row.organization_id ||
      value.projectId !== row.project_id ||
      value.actorId !== row.actor_id ||
      value.sessionId !== row.creator_session_id ||
      value.operationWindowId !== viewInstant(row.operation_window_id).slice(0, 10) ||
      value.operationId !== row.operation_id ||
      value.viewId !== row.view_id ||
      value.action !== row.operation ||
      value.outcome !== row.outcome ||
      value.previousViewRevision !== Number(row.previous_view_revision) ||
      value.committedViewRevision !==
        (row.committed_view_revision === null ? null : Number(row.committed_view_revision)) ||
      value.expectedScheduleRevision !== Number(row.observed_schedule_revision) ||
      value.baseConfigHash !== row.base_config_hash_sha256 ||
      value.desiredConfigHash !== row.committed_config_hash_sha256 ||
      value.reviewedDigest !== row.reviewed_digest ||
      value.auditId !== row.audit_event_id ||
      value.recordedAt !== viewInstant(row.recorded_at)
    )
      throw new Error("Receipt binding changed");
    return value;
  } catch {
    throw new PlannerViewError("view_integrity_error", 503);
  }
}
