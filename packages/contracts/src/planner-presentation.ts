import type { ScheduleCalculationMetadataV1 } from "./calculation.js";
import {
  PLANNER_VIEW_NORMALIZATION_VERSION,
  PLANNER_VIEW_PROJECTION_VERSION,
  type PlannerPresentationV1,
  validatePlannerPresentationV1,
} from "./planner-view.js";
import type { EngineScheduleResultV1 } from "./result.js";
import {
  type ActivityInputV1,
  type EngineProjectInputV1,
  MAX_WORK_MINUTES,
  type WbsNodeV1,
} from "./schedule.js";

/** A caller assertion, not authentication. Wrappers must independently verify source and hashes. */
export interface PlannerNativeSnapshotV1 {
  organizationId: string;
  projectId: string;
  scheduleRevision: number;
  inputHashSha256: string;
  inputState: "saved" | "unsaved";
  /** The configured real engine's current compatibility declaration, not a binary attestation. */
  currentEngineVersion: string | null;
  /** Native repository order, never the UUID-sorted canonical export. */
  input: EngineProjectInputV1;
}

/** Only construct after coherent current authorization, source, input/result hash and engine checks. */
export interface PlannerVerifiedCalculationV1 {
  verification: "caller-verified-current-engine";
  organizationId: string;
  projectId: string;
  metadata: ScheduleCalculationMetadataV1;
  result: EngineScheduleResultV1;
}

export interface PlannerPresentationSelectionV1 {
  projectionVersion: 1;
  normalizationVersion: 1;
  /** SHA-256 of the view canonical hash preimage, checked by caller; null for transient/Native. */
  configHashSha256: string | null;
  presentation: PlannerPresentationV1;
}

export interface PlannerActivityRowV1 {
  kind: "activity";
  activityId: string;
  nativeIndex: number;
  /** One-based visible activity ordinal, excluding group headers. */
  displayOrdinal: number;
  groupKey: string | null;
}

export interface PlannerWbsGroupRowV1 {
  kind: "group";
  key: string;
  wbsId: string;
  wbsCode: string;
  wbsName: string;
  activityCount: number;
}

export type PlannerVisualRowV1 = PlannerActivityRowV1 | PlannerWbsGroupRowV1;
export interface PlannerProjectionBindingV1 {
  organizationId: string;
  projectId: string;
  scheduleRevision: number;
  inputHashSha256: string;
  inputState: "saved" | "unsaved";
  projectionVersion: 1;
  normalizationVersion: 1;
  configHashSha256: string | null;
  /** Present only when the selected predicate/sort consumes a calculation. */
  calculation?: {
    calculationId: string;
    resultHashSha256: string;
    engineContractVersion: 1;
    engineVersion: string;
  };
}

export type PlannerProjectionUnavailableReasonV1 =
  | "source_invalid"
  | "presentation_invalid"
  | "version_unsupported"
  | "input_unsaved"
  | "calculation_missing"
  | "calculation_stale"
  | "calculation_invalid"
  | "engine_unsupported"
  | "reference_stale";

export type PlannerProjectionV1 =
  | {
      available: true;
      rows: PlannerVisualRowV1[];
      sourceActivityCount: number;
      visibleActivityCount: number;
      visualRowCount: number;
      groupCount: number;
      binding: PlannerProjectionBindingV1;
    }
  | {
      available: false;
      error: "view_result_required" | "view_reference_stale" | "view_invalid";
      reason: PlannerProjectionUnavailableReasonV1;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const ENGINE = /^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,127}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

// These inputs are already verified boundary data, not arbitrary live objects. Fail closed
// on ordinary exotic/accessor/cyclic data without invoking getters or serialization hooks.
// Proxies cannot be authenticated or made side-effect-free by a JavaScript type/shape check.
function inertData(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (typeof value === "string") return value.isWellFormed();
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 32 || seen.has(value)) return false;
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    return false;
  seen.add(value);
  if (array && Object.keys(value).length !== value.length) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) return false;
    if (
      array &&
      (!/^(0|[1-9]\d*)$/.test(key) ||
        !Number.isSafeInteger(Number(key)) ||
        Number(key) >= value.length ||
        Number(key) >= 4294967295)
    )
      return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
    if (!inertData(descriptor.value, depth + 1, seen)) return false;
  }
  seen.delete(value);
  return true;
}

function unavailable(reason: PlannerProjectionUnavailableReasonV1): PlannerProjectionV1 {
  return {
    available: false,
    error:
      reason === "reference_stale"
        ? "view_reference_stale"
        : ["source_invalid", "presentation_invalid", "version_unsupported"].includes(reason)
          ? "view_invalid"
          : "view_result_required",
    reason,
  };
}

interface InstantKey {
  seconds: number;
  nanos: number;
}

/** Exact Gregorian/RFC3339 ordering key, not schedule arithmetic or timestamp rewriting. */
function instantKey(value: string): InstantKey | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return null;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const hour = Number(match[4]),
    minute = Number(match[5]),
    second = Number(match[6]);
  const offsetHour = Number(match[10] ?? 0),
    offsetMinute = Number(match[11] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (days[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return null;
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const epochDays = era * 146097 + dayOfEra - 719468;
  const offset = (offsetHour * 60 + offsetMinute) * 60 * (match[9] === "-" ? -1 : 1);
  return {
    seconds: epochDays * 86400 + hour * 3600 + minute * 60 + second - offset,
    nanos: Number((match[7] ?? "").padEnd(9, "0")),
  };
}

function compare<T extends number | string>(left: T, right: T): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceValid(snapshot: PlannerNativeSnapshotV1): boolean {
  const input = snapshot.input;
  return (
    typeof snapshot.organizationId === "string" &&
    UUID.test(snapshot.organizationId) &&
    typeof snapshot.projectId === "string" &&
    UUID.test(snapshot.projectId) &&
    Number.isSafeInteger(snapshot.scheduleRevision) &&
    snapshot.scheduleRevision >= 1 &&
    typeof snapshot.inputHashSha256 === "string" &&
    HASH.test(snapshot.inputHashSha256) &&
    (snapshot.currentEngineVersion === null ||
      (typeof snapshot.currentEngineVersion === "string" &&
        ENGINE.test(snapshot.currentEngineVersion))) &&
    (snapshot.inputState === "saved" || snapshot.inputState === "unsaved") &&
    input?.schemaVersion === 1 &&
    input.project?.id === snapshot.projectId &&
    Array.isArray(input.activities) &&
    Array.isArray(input.wbs)
  );
}

function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function validRowResult(result: EngineScheduleResultV1, ids: Set<string>): boolean {
  if (
    !fields(result, [
      "schemaVersion",
      "projectFinish",
      "lateProjectFinish",
      "controllingFinishActivity",
      "controllingPath",
      "activities",
      "constraintViolations",
    ]) ||
    result.schemaVersion !== 1 ||
    typeof result.activities !== "object" ||
    result.activities === null ||
    Array.isArray(result.activities) ||
    Object.keys(result.activities).length !== ids.size
  )
    return false;
  if (
    (result.controllingFinishActivity !== null && !ids.has(result.controllingFinishActivity)) ||
    !Array.isArray(result.controllingPath) ||
    result.controllingPath.some((id) => !ids.has(id)) ||
    !Array.isArray(result.constraintViolations)
  )
    return false;
  for (const id of ids) {
    const row = result.activities[id];
    if (
      !row ||
      !fields(row, [
        "earlyStart",
        "earlyFinish",
        "lateStart",
        "lateFinish",
        "totalFloatMinutes",
        "freeFloatMinutes",
        "critical",
        "drivingCauses",
      ]) ||
      typeof row.critical !== "boolean" ||
      !Number.isSafeInteger(row.totalFloatMinutes) ||
      !Number.isSafeInteger(row.freeFloatMinutes) ||
      !Array.isArray(row.drivingCauses) ||
      ![row.earlyStart, row.earlyFinish, row.lateStart, row.lateFinish].every(
        (date) => typeof date === "string" && instantKey(date) !== null,
      )
    )
      return false;
    for (const cause of row.drivingCauses) {
      if (
        !fields(
          cause,
          ["kind"],
          ["predecessorId", "relationshipType", "lagMinutes", "constraintType", "instant"],
        ) ||
        typeof cause.kind !== "string" ||
        (cause.predecessorId !== undefined && !ids.has(cause.predecessorId)) ||
        (cause.relationshipType !== undefined &&
          !["FS", "SS", "FF", "SF"].includes(cause.relationshipType)) ||
        (cause.lagMinutes !== undefined && !Number.isSafeInteger(cause.lagMinutes)) ||
        (cause.constraintType !== undefined && typeof cause.constraintType !== "string") ||
        (cause.instant !== undefined &&
          (typeof cause.instant !== "string" || instantKey(cause.instant) === null))
      )
        return false;
    }
  }
  return (
    result.constraintViolations.every(
      (row) =>
        fields(row, ["activityId", "constraintType", "constraintInstant", "actualInstant"]) &&
        ids.has(row.activityId) &&
        typeof row.constraintType === "string" &&
        typeof row.constraintInstant === "string" &&
        instantKey(row.constraintInstant) !== null &&
        typeof row.actualInstant === "string" &&
        instantKey(row.actualInstant) !== null,
    ) &&
    typeof result.projectFinish === "string" &&
    instantKey(result.projectFinish) !== null &&
    typeof result.lateProjectFinish === "string" &&
    instantKey(result.lateProjectFinish) !== null
  );
}

/**
 * Pure projection of a native ordered snapshot. Result declarations are checked for
 * consistency, but this function cannot establish authorization, coherent SQL reads,
 * matching content hashes, or that a result came from a real Rust binary. The caller
 * must do those checks before constructing PlannerVerifiedCalculationV1. No result
 * is calculated, persisted, mutated, or inferred here; unavailability is never an
 * empty-success or an implicit fallback. Use returned rows for both grid and Gantt.
 */
export function projectPlannerPresentationV1(
  snapshot: PlannerNativeSnapshotV1,
  calculation: PlannerVerifiedCalculationV1 | null,
  selection: PlannerPresentationSelectionV1,
): PlannerProjectionV1 {
  try {
    if (!inertData(snapshot) || !sourceValid(snapshot)) return unavailable("source_invalid");
    if (!inertData(selection)) return unavailable("presentation_invalid");
    if (
      selection.projectionVersion !== PLANNER_VIEW_PROJECTION_VERSION ||
      selection.normalizationVersion !== PLANNER_VIEW_NORMALIZATION_VERSION
    )
      return unavailable("version_unsupported");
    if (
      selection.configHashSha256 !== null &&
      (typeof selection.configHashSha256 !== "string" || !HASH.test(selection.configHashSha256))
    )
      return unavailable("presentation_invalid");
    const validated = validatePlannerPresentationV1(selection.presentation);
    if (!validated.valid) return unavailable("presentation_invalid");
    const presentation = validated.normalizedPresentation;
    const wbs = new Map<string, { node: WbsNodeV1; nativeIndex: number }>();
    for (const [nativeIndex, node] of snapshot.input.wbs.entries()) {
      if (
        !node ||
        typeof node.id !== "string" ||
        !UUID.test(node.id) ||
        typeof node.code !== "string" ||
        typeof node.name !== "string" ||
        wbs.has(node.id.toLowerCase())
      )
        return unavailable("source_invalid");
      wbs.set(node.id.toLowerCase(), { node, nativeIndex });
    }
    if (presentation.wbsId !== null && !wbs.has(presentation.wbsId))
      return unavailable("reference_stale");
    const ids = new Set<string>();
    const normalizedIds = new Set<string>();
    const indexed: { activity: ActivityInputV1; nativeIndex: number }[] = [];
    for (const [nativeIndex, activity] of snapshot.input.activities.entries()) {
      if (
        !activity ||
        typeof activity.id !== "string" ||
        !UUID.test(activity.id) ||
        normalizedIds.has(activity.id.toLowerCase()) ||
        typeof activity.wbsId !== "string" ||
        !wbs.has(activity.wbsId.toLowerCase()) ||
        typeof activity.name !== "string" ||
        !["TASK", "START_MILESTONE", "FINISH_MILESTONE"].includes(activity.kind) ||
        !Number.isSafeInteger(activity.durationMinutes) ||
        activity.durationMinutes < 0 ||
        activity.durationMinutes > MAX_WORK_MINUTES ||
        (activity.kind !== "TASK" && activity.durationMinutes !== 0)
      )
        return unavailable("source_invalid");
      ids.add(activity.id);
      normalizedIds.add(activity.id.toLowerCase());
      indexed.push({ activity, nativeIndex });
    }
    const needsCalculation =
      presentation.critical !== "all" ||
      presentation.sort.field === "earlyStart" ||
      presentation.sort.field === "totalFloatMinutes";
    const resultRows = new Map<
      string,
      { critical: boolean; totalFloatMinutes: number; earlyStart: string }
    >();
    const binding: PlannerProjectionBindingV1 = {
      organizationId: snapshot.organizationId,
      projectId: snapshot.projectId,
      scheduleRevision: snapshot.scheduleRevision,
      inputHashSha256: snapshot.inputHashSha256,
      inputState: snapshot.inputState,
      projectionVersion: 1,
      normalizationVersion: 1,
      configHashSha256: selection.configHashSha256,
    };
    if (needsCalculation) {
      if (snapshot.inputState !== "saved") return unavailable("input_unsaved");
      if (calculation === null) return unavailable("calculation_missing");
      if (!inertData(calculation) || calculation.verification !== "caller-verified-current-engine")
        return unavailable("calculation_invalid");
      const metadata = calculation.metadata;
      if (
        snapshot.currentEngineVersion === null ||
        metadata?.schemaVersion !== 1 ||
        metadata.engineContractVersion !== 1 ||
        calculation.result?.schemaVersion !== 1 ||
        typeof metadata.engineVersion !== "string" ||
        !ENGINE.test(metadata.engineVersion) ||
        metadata.engineVersion !== snapshot.currentEngineVersion
      )
        return unavailable("engine_unsupported");
      if (
        calculation.organizationId !== snapshot.organizationId ||
        calculation.projectId !== snapshot.projectId ||
        metadata.projectRevision !== snapshot.scheduleRevision ||
        metadata.inputHashSha256 !== snapshot.inputHashSha256
      )
        return unavailable("calculation_stale");
      if (
        typeof metadata.calculationId !== "string" ||
        !UUID.test(metadata.calculationId) ||
        !fields(metadata, [
          "schemaVersion",
          "calculationId",
          "projectRevision",
          "inputHashSha256",
          "resultHashSha256",
          "engineContractVersion",
          "engineVersion",
          "calculatedAt",
        ]) ||
        typeof metadata.resultHashSha256 !== "string" ||
        !HASH.test(metadata.resultHashSha256) ||
        typeof metadata.calculatedAt !== "string" ||
        instantKey(metadata.calculatedAt) === null ||
        !validRowResult(calculation.result, ids)
      )
        return unavailable("calculation_invalid");
      for (const id of ids) {
        const row = calculation.result.activities[id];
        if (!row) return unavailable("calculation_invalid");
        resultRows.set(id, row);
      }
      binding.calculation = {
        calculationId: metadata.calculationId,
        resultHashSha256: metadata.resultHashSha256,
        engineContractVersion: 1,
        engineVersion: metadata.engineVersion,
      };
    }
    const search = presentation.search.toLowerCase();
    const visible = indexed.filter(
      ({ activity }) =>
        (search === "" ||
          activity.name.toLowerCase().includes(search) ||
          activity.id.toLowerCase().includes(search)) &&
        (presentation.kind === "all" || activity.kind === presentation.kind) &&
        (presentation.wbsId === null || activity.wbsId.toLowerCase() === presentation.wbsId) &&
        (presentation.critical === "all" ||
          resultRows.get(activity.id)?.critical === (presentation.critical === "critical")),
    );
    const dateKeys = new Map<string, InstantKey>();
    if (presentation.sort.field === "earlyStart") {
      for (const { activity } of visible) {
        const date = resultRows.get(activity.id)?.earlyStart;
        const key = date === undefined ? null : instantKey(date);
        if (key === null) return unavailable("calculation_invalid");
        dateKeys.set(activity.id, key);
      }
    }
    if (presentation.sort.field !== "native") {
      visible.sort((left, right) => {
        let primary = 0;
        switch (presentation.sort.field) {
          case "name":
            primary = compare(left.activity.name.toLowerCase(), right.activity.name.toLowerCase());
            break;
          case "durationMinutes":
            primary = compare(left.activity.durationMinutes, right.activity.durationMinutes);
            break;
          case "totalFloatMinutes": {
            const a = resultRows.get(left.activity.id),
              b = resultRows.get(right.activity.id);
            if (!a || !b) throw new Error("Missing verified row");
            primary = compare(a.totalFloatMinutes, b.totalFloatMinutes);
            break;
          }
          case "earlyStart": {
            const a = dateKeys.get(left.activity.id),
              b = dateKeys.get(right.activity.id);
            if (a && b) primary = compare(a.seconds, b.seconds) || compare(a.nanos, b.nanos);
            break;
          }
        }
        return (
          primary * (presentation.sort.direction === "desc" ? -1 : 1) ||
          compare(left.nativeIndex, right.nativeIndex) ||
          compare(left.activity.id, right.activity.id)
        );
      });
    }
    const rows: PlannerVisualRowV1[] = [];
    let ordinal = 0,
      groupCount = 0;
    const append = (entry: (typeof visible)[number], groupKey: string | null) =>
      rows.push({
        kind: "activity",
        activityId: entry.activity.id,
        nativeIndex: entry.nativeIndex,
        displayOrdinal: ++ordinal,
        groupKey,
      });
    if (presentation.groupBy === "none") {
      for (const entry of visible) append(entry, null);
    } else {
      const groups = new Map<string, typeof visible>();
      for (const entry of visible) {
        const id = entry.activity.wbsId.toLowerCase();
        const group = groups.get(id);
        if (group) group.push(entry);
        else groups.set(id, [entry]);
      }
      // Map iteration retains native WBS array order; activity sort is retained within each group.
      for (const [id, { node }] of wbs) {
        const group = groups.get(id);
        if (!group) continue;
        const key = `group:wbs:${id}`;
        rows.push({
          kind: "group",
          key,
          wbsId: node.id,
          wbsCode: node.code,
          wbsName: node.name,
          activityCount: group.length,
        });
        groupCount++;
        for (const entry of group) append(entry, key);
      }
    }
    return {
      available: true,
      rows,
      sourceActivityCount: indexed.length,
      visibleActivityCount: visible.length,
      visualRowCount: rows.length,
      groupCount,
      binding,
    };
  } catch {
    // Invalid boundary data cannot leak raw exceptions or return a partial successful projection.
    return unavailable("source_invalid");
  }
}
