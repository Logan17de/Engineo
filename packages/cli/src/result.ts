import {
  type EngineProjectInputV1,
  type EngineScheduleResultV1,
  isRfc3339Instant,
  type ScheduleCalculationMetadataV1,
  serializeScheduleResultV1,
} from "@engineo/contracts";
import { hash } from "./artifacts.js";
import { CliError, integrity } from "./errors.js";
import { exactKeys, revision, sha256Text, uuid } from "./json.js";

// Structural boundary validation mirrors the existing API Rust-runner check. No schedule mathematics.
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function instant(value: unknown): value is string {
  return typeof value === "string" && isRfc3339Instant(value);
}
function knownKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
export function validResult(
  value: unknown,
  input: EngineProjectInputV1,
): value is EngineScheduleResultV1 {
  if (
    !record(value) ||
    !knownKeys(value, [
      "schemaVersion",
      "projectFinish",
      "lateProjectFinish",
      "controllingFinishActivity",
      "controllingPath",
      "activities",
      "constraintViolations",
    ]) ||
    value.schemaVersion !== 1 ||
    !instant(value.projectFinish) ||
    !instant(value.lateProjectFinish) ||
    !record(value.activities) ||
    !Array.isArray(value.controllingPath) ||
    !Array.isArray(value.constraintViolations)
  )
    return false;
  const ids = new Set(input.activities.map((activity) => activity.id));
  if (
    Object.keys(value.activities).length !== ids.size ||
    (value.controllingFinishActivity !== null &&
      (typeof value.controllingFinishActivity !== "string" ||
        !ids.has(value.controllingFinishActivity))) ||
    value.controllingPath.some((id) => typeof id !== "string" || !ids.has(id))
  )
    return false;
  for (const id of ids) {
    const row = value.activities[id];
    if (
      !record(row) ||
      !knownKeys(row, [
        "earlyStart",
        "earlyFinish",
        "lateStart",
        "lateFinish",
        "critical",
        "totalFloatMinutes",
        "freeFloatMinutes",
        "drivingCauses",
      ]) ||
      !instant(row.earlyStart) ||
      !instant(row.earlyFinish) ||
      !instant(row.lateStart) ||
      !instant(row.lateFinish) ||
      typeof row.critical !== "boolean" ||
      !Number.isSafeInteger(row.totalFloatMinutes) ||
      !Number.isSafeInteger(row.freeFloatMinutes) ||
      !Array.isArray(row.drivingCauses)
    )
      return false;
    for (const cause of row.drivingCauses) {
      if (
        !record(cause) ||
        !knownKeys(cause, [
          "kind",
          "predecessorId",
          "relationshipType",
          "constraintType",
          "instant",
          "lagMinutes",
        ]) ||
        typeof cause.kind !== "string" ||
        (cause.predecessorId !== undefined &&
          (typeof cause.predecessorId !== "string" || !ids.has(cause.predecessorId))) ||
        (cause.relationshipType !== undefined &&
          (typeof cause.relationshipType !== "string" ||
            !["FS", "SS", "FF", "SF"].includes(cause.relationshipType))) ||
        (cause.constraintType !== undefined && typeof cause.constraintType !== "string") ||
        (cause.instant !== undefined && !instant(cause.instant)) ||
        (cause.lagMinutes !== undefined && !Number.isSafeInteger(cause.lagMinutes))
      )
        return false;
    }
  }
  return value.constraintViolations.every(
    (row) =>
      record(row) &&
      knownKeys(row, ["activityId", "constraintType", "constraintInstant", "actualInstant"]) &&
      typeof row.activityId === "string" &&
      ids.has(row.activityId) &&
      typeof row.constraintType === "string" &&
      instant(row.constraintInstant) &&
      instant(row.actualInstant),
  );
}

export interface CheckedResultV1 {
  revision: number;
  result: EngineScheduleResultV1 | null;
  calculation: ScheduleCalculationMetadataV1 | null;
}
export function checkResult(
  value: unknown,
  input: EngineProjectInputV1,
  expectedRevision: number,
  inputHash: string,
  requireResult: boolean,
): CheckedResultV1 {
  if (
    !record(value) ||
    !exactKeys(value, ["revision", "result", "calculation"]) ||
    !revision(value.revision)
  )
    integrity();
  if (value.revision !== expectedRevision)
    throw new CliError(
      "conflict",
      "revision_conflict",
      "Returned calculation belongs to a different project revision.",
    );
  if (value.result === null && value.calculation === null && !requireResult)
    return { revision: value.revision, result: null, calculation: null };
  if (
    !validResult(value.result, input) ||
    !record(value.calculation) ||
    !exactKeys(value.calculation, [
      "schemaVersion",
      "calculationId",
      "projectRevision",
      "inputHashSha256",
      "resultHashSha256",
      "engineContractVersion",
      "engineVersion",
      "calculatedAt",
    ]) ||
    value.calculation.schemaVersion !== 1 ||
    value.calculation.engineContractVersion !== 1 ||
    !uuid(value.calculation.calculationId) ||
    value.calculation.projectRevision !== expectedRevision ||
    value.calculation.inputHashSha256 !== inputHash ||
    !sha256Text(value.calculation.resultHashSha256) ||
    hash(serializeScheduleResultV1(value.result)) !== value.calculation.resultHashSha256 ||
    typeof value.calculation.engineVersion !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,127}$/.test(value.calculation.engineVersion) ||
    !instant(value.calculation.calculatedAt)
  )
    integrity();
  return value as unknown as CheckedResultV1;
}
