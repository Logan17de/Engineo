import { createHash } from "node:crypto";
import {
  ENGINE_CONTRACT_VERSION,
  type PlannerNativeSnapshotV1,
  type PlannerVerifiedCalculationV1,
  serializeScheduleInputV1,
  serializeScheduleResultV1,
  validateScheduleInputV1,
} from "@engineo/contracts";
import type { DatabaseExecutor } from "../db/client.js";
import type { TenantContext } from "../db/tenant-context.js";
import { SCHEDULE_MAX_BYTES, validResult } from "../scheduler/runner.js";
import { assertViewNotCancelled, PlannerViewError } from "./planner-view-errors.js";
import { readPlannerSnapshot } from "./project-repository.js";

export const viewHash = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");
export const viewInstant = (value: unknown): string =>
  (value instanceof Date ? value : new Date(String(value))).toISOString();

/**
 * Caller MUST already hold live identity/membership locks and project FOR SHARE.
 * All native rows and the matching immutable calculation are read on this same
 * executor while schedule finalization is excluded. Never combine repositories'
 * independent transactions or accept client result flags as authentication.
 */
export async function readProtectedPlannerViewSource(
  sql: DatabaseExecutor,
  context: TenantContext,
  projectId: string,
  engineVersion: string | null,
  signal?: AbortSignal,
): Promise<{
  snapshot: PlannerNativeSnapshotV1;
  calculation: PlannerVerifiedCalculationV1 | null;
}> {
  try {
    if (engineVersion !== null && !/^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,127}$/.test(engineVersion))
      throw new Error("Unsupported engine declaration");
    // Date reconstruction must not hide unsupported native precision.
    const precision = await sql`SELECT project_id FROM project_schedule_settings
      WHERE organization_id=${context.organizationId} AND project_id=${projectId}
        AND (planned_start <> date_trunc('milliseconds',planned_start)
          OR data_date <> date_trunc('milliseconds',data_date)
          OR required_finish <> date_trunc('milliseconds',required_finish))`;
    const native = await readPlannerSnapshot(sql, context, projectId);
    assertViewNotCancelled(signal);
    if (
      !native ||
      precision.length ||
      !validateScheduleInputV1(native.input).valid ||
      native.input.activities.length > 10000 ||
      native.input.wbs.length > 10000 ||
      native.input.calendars.length > 100 ||
      native.input.relationships.length > 80000
    )
      throw new Error("Unsupported native snapshot");
    const canonical = serializeScheduleInputV1(native.input);
    if (Buffer.byteLength(canonical, "utf8") > SCHEDULE_MAX_BYTES)
      throw new Error("Unsupported source size");
    const inputHash = viewHash(canonical);
    const snapshot: PlannerNativeSnapshotV1 = {
      organizationId: context.organizationId,
      projectId,
      scheduleRevision: native.revision,
      inputHashSha256: inputHash,
      inputState: "saved",
      currentEngineVersion: engineVersion,
      input: native.input,
    };
    if (engineVersion === null) return { snapshot, calculation: null };
    const rows = await sql`SELECT id,project_revision,input_hash_sha256,result_hash_sha256,
      engine_contract_version,engine_version,calculated_at,input_canonical,result_json
      FROM schedule_calculations WHERE organization_id=${context.organizationId}
        AND project_id=${projectId} AND project_revision=${native.revision}
        AND input_hash_sha256=${inputHash} AND engine_contract_version=${ENGINE_CONTRACT_VERSION}
        AND engine_version=${engineVersion}`;
    assertViewNotCancelled(signal);
    if (rows.length === 0) return { snapshot, calculation: null };
    if (rows.length !== 1) throw new Error("Ambiguous calculation");
    const row = rows[0];
    if (!row) throw new Error("Missing calculation");
    const text = String(row.result_json);
    const result: unknown = JSON.parse(text);
    const activityMap =
      result !== null && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>).activities
        : null;
    // An empty source must not let primitive maps pass Object.keys(primitive).
    if (activityMap === null || typeof activityMap !== "object" || Array.isArray(activityMap))
      throw new Error("Invalid calculation activity map");
    if (
      String(row.input_canonical) !== canonical ||
      row.input_hash_sha256 !== inputHash ||
      Buffer.byteLength(text, "utf8") > SCHEDULE_MAX_BYTES ||
      viewHash(text) !== row.result_hash_sha256 ||
      !validResult(result, native.input) ||
      serializeScheduleResultV1(result) !== text ||
      Number(row.project_revision) !== native.revision ||
      Number(row.engine_contract_version) !== ENGINE_CONTRACT_VERSION ||
      row.engine_version !== engineVersion
    )
      throw new Error("Invalid calculation content binding");
    return {
      snapshot,
      calculation: {
        verification: "caller-verified-current-engine",
        organizationId: context.organizationId,
        projectId,
        metadata: {
          schemaVersion: 1,
          calculationId: String(row.id),
          projectRevision: native.revision,
          inputHashSha256: inputHash,
          resultHashSha256: String(row.result_hash_sha256),
          engineContractVersion: ENGINE_CONTRACT_VERSION,
          engineVersion,
          calculatedAt: viewInstant(row.calculated_at),
        },
        result,
      },
    };
  } catch (error) {
    if (error instanceof PlannerViewError) throw error;
    throw new PlannerViewError("view_integrity_error", 503);
  }
}
