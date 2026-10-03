import {
  type ActivityInputV1,
  type CalendarV1,
  type EngineProjectInputV1,
  MAX_WORK_MINUTES,
  type RelationshipInputV1,
  type WbsNodeV1,
  WEEKDAYS,
} from "./schedule.js";
import { serializeScheduleInputV1 } from "./serialization.js";
import {
  isRfc3339Instant,
  type ScheduleValidationCode,
  validateScheduleInputV1,
} from "./validation.js";

export const PROJECT_CONFIGURATION_VERSION = 1 as const;
export const PROJECT_CONFIGURATION_PROTOCOL_VERSION = 1 as const;
export const PROJECT_CONFIGURATION_NORMALIZATION_VERSION = 1 as const;
export const PROJECT_CONFIGURATION_MAX_BYTES = 1024 * 1024;
export const PROJECT_CONFIGURATION_MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const PROJECT_CONFIGURATION_MAX_DIFF_BYTES = 8 * 1024 * 1024;
export const PROJECT_CONFIGURATION_MAX_REVIEW_BYTES = 16 * 1024 * 1024;
export const PROJECT_CONFIGURATION_MAX_DEPTH = 32;
export const PROJECT_CONFIGURATION_MAX_DIAGNOSTICS = 100;
export const PROJECT_CONFIGURATION_MAX_DIAGNOSTIC_TEXT_LENGTH = 512;

export interface ProjectConfigurationV1 {
  schemaVersion: 1;
  kind: "engineo-project-configuration";
  scope: "schedule";
  input: EngineProjectInputV1;
}

export type ProjectConfigurationIssueCode =
  | ScheduleValidationCode
  | "INVALID_JSON"
  | "DUPLICATE_JSON_KEY"
  | "UNKNOWN_PROPERTY"
  | "MISSING_PROPERTY"
  | "INVALID_VALUE"
  | "MAX_DEPTH_EXCEEDED"
  | "TRANSPORT_TOO_LARGE"
  | "ARTIFACT_TOO_LARGE"
  | "DIFF_TOO_LARGE"
  | "INVALID_UUID"
  | "DUPLICATE_WBS_CODE"
  | "DUPLICATE_RELATIONSHIP"
  | "EXCESS_INSTANT_PRECISION";

export interface ProjectConfigurationIssue {
  code: ProjectConfigurationIssueCode;
  path: string;
  message: string;
}

export interface ProjectConfigurationDiagnosticsV1 {
  issues: ProjectConfigurationIssue[];
  totalCount: number;
  truncated: boolean;
}

/** Stable lower-case HTTP error codes, separate from pure validation issue codes. */
export type ProjectConfigurationApiErrorCodeV1 =
  | "unauthenticated"
  | "forbidden"
  | "csrf_validation_failed"
  | "origin_not_allowed"
  | "project_not_found"
  | "configuration_plan_not_found"
  | "session_intent_required"
  | "session_changed"
  | "revision_conflict"
  | "configuration_base_changed"
  | "configuration_idempotency_conflict"
  | "configuration_review_changed"
  | "configuration_expired"
  | "configuration_cancelled"
  | "configuration_not_terminal"
  | "configuration_interrupted"
  | "configuration_artifact_unavailable"
  | "configuration_invalid"
  | "configuration_id_conflict"
  | "configuration_capacity"
  | "configuration_rate_limit"
  | "configuration_integrity_error"
  | "temporarily_unavailable"
  | "internal_error";

export interface ProjectConfigurationApiErrorV1 {
  error: ProjectConfigurationApiErrorCodeV1;
  diagnostics?: ProjectConfigurationDiagnosticsV1;
  calculationChecked?: false;
}

export class ProjectConfigurationError extends Error {
  constructor(
    public readonly code: ProjectConfigurationIssueCode,
    public readonly diagnostics: ProjectConfigurationDiagnosticsV1,
  ) {
    super(diagnostics.issues[0]?.message ?? "Invalid project configuration.");
    this.name = "ProjectConfigurationError";
  }
}

export type ProjectConfigurationValidationV1 =
  | {
      valid: true;
      normalizedConfiguration: ProjectConfigurationV1;
      normalizedInput: EngineProjectInputV1;
      /** Exact unchanged schedule v1 serialization; hash these UTF-8 bytes. */
      canonicalInput: string;
      diagnostics: ProjectConfigurationDiagnosticsV1;
      calculationChecked: false;
    }
  | {
      valid: false;
      diagnostics: ProjectConfigurationDiagnosticsV1;
      calculationChecked: false;
    };

type Change<T, E extends string> =
  | { entity: E; key: string; operation: "create"; before: null; after: T }
  | { entity: E; key: string; operation: "update"; before: T; after: T }
  | { entity: E; key: string; operation: "delete"; before: T; after: null };
export type ProjectConfigurationChangeV1 =
  | Change<EngineProjectInputV1["project"], "project">
  | Change<EngineProjectInputV1["scheduleOptions"], "scheduleOptions">
  | Change<CalendarV1, "calendar">
  | Change<WbsNodeV1, "wbs">
  | Change<ActivityInputV1, "activity">
  | Change<RelationshipInputV1, "relationship">;

export interface ProjectConfigurationDiffV1 {
  changes: ProjectConfigurationChangeV1[];
  noOp: boolean;
  /** Complete deterministic JSON array, never a truncated diff. */
  serializedDiff: string;
}

export interface ProjectConfigurationPlanRequestV1 {
  planId: string;
  expectedRevision: number;
  configuration: ProjectConfigurationV1;
}
export interface ProjectConfigurationApplyRequestV1 {
  expectedRevision: number;
  reviewedDigest: string;
}
export interface ProjectConfigurationCancelRequestV1 {
  reviewedDigest: string;
}
export interface ProjectConfigurationReadV1 {
  schemaVersion: 1;
  revision: number;
  inputHashSha256: string;
  configuration: ProjectConfigurationV1;
}
export type ProjectConfigurationValidateResponseV1 =
  | {
      valid: true;
      normalizedConfiguration: ProjectConfigurationV1;
      desiredInputHashSha256: string;
      calculationChecked: false;
      diagnostics: ProjectConfigurationDiagnosticsV1;
    }
  | {
      valid: false;
      calculationChecked: false;
      diagnostics: ProjectConfigurationDiagnosticsV1;
    };
export interface ProjectConfigurationPlanV1 {
  schemaVersion: 1;
  protocolVersion: 1;
  normalizationVersion: 1;
  planId: string;
  organizationId: string;
  projectId: string;
  actorId: string;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  baseRevision: number;
  baseInputHashSha256: string;
  desiredInputHashSha256: string;
  configuration: ProjectConfigurationV1;
  changes: ProjectConfigurationChangeV1[];
  noOp: boolean;
  reviewedDigest: string;
}
interface ProjectConfigurationReceiptBaseV1 {
  schemaVersion: 1;
  planId: string;
  organizationId: string;
  projectId: string;
  previousRevision: number;
  baseInputHashSha256: string;
  reviewedDigest: string;
  provenanceAuditId: string;
  recordedAt: string;
}
export interface ProjectConfigurationAppliedReceiptV1 extends ProjectConfigurationReceiptBaseV1 {
  outcome: "applied" | "no_op";
  committedRevision: number;
  committedInputHashSha256: string;
  scheduleEditAuditId: string | null;
}
export interface ProjectConfigurationCancelledReceiptV1 extends ProjectConfigurationReceiptBaseV1 {
  outcome: "cancelled";
  committedRevision: null;
  committedInputHashSha256: null;
  scheduleEditAuditId: null;
}
export type ProjectConfigurationReceiptV1 =
  | ProjectConfigurationAppliedReceiptV1
  | ProjectConfigurationCancelledReceiptV1;
export type ProjectConfigurationPlanStatusV1 =
  | "pending"
  | "expired"
  | "cancelled"
  | "applied"
  | "no_op";
export interface ProjectConfigurationPlanReadV1 {
  plan: ProjectConfigurationPlanV1 | null;
  status: ProjectConfigurationPlanStatusV1;
  planId: string;
  artifactsAvailable: boolean;
  receipt: ProjectConfigurationReceiptV1 | null;
}

function diagnosticText(value: string): string {
  if (value.length <= PROJECT_CONFIGURATION_MAX_DIAGNOSTIC_TEXT_LENGTH) return value;
  let prefix = value.slice(0, PROJECT_CONFIGURATION_MAX_DIAGNOSTIC_TEXT_LENGTH - 3);
  if (!prefix.isWellFormed()) prefix = prefix.slice(0, -1);
  return `${prefix}...`;
}

class Diagnostics {
  readonly issues: ProjectConfigurationIssue[] = [];
  totalCount = 0;
  add(code: ProjectConfigurationIssueCode, path: string, message: string): void {
    this.totalCount++;
    if (this.issues.length < PROJECT_CONFIGURATION_MAX_DIAGNOSTICS)
      this.issues.push({ code, path: diagnosticText(path), message: diagnosticText(message) });
  }
  result(): ProjectConfigurationDiagnosticsV1 {
    return {
      issues: this.issues,
      totalCount: this.totalCount,
      truncated: this.totalCount > this.issues.length,
    };
  }
}
function fail(code: ProjectConfigurationIssueCode, path: string, message: string): never {
  throw new ProjectConfigurationError(code, {
    issues: [{ code, path: diagnosticText(path), message: diagnosticText(message) }],
    totalCount: 1,
    truncated: false,
  });
}
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function childPath(parent: string, key: string): string {
  // Bracket quoting makes a literal key distinguishable from a nested path.
  return /^[A-Za-z][A-Za-z0-9]*$/.test(key)
    ? `${parent ? `${parent}.` : ""}${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

// Number() can round a fractional JSON token to an integer, or underflow it to zero.
// Check the token's decimal integrality without constructing enormous powers/BigInts.
function isExactIntegerToken(token: string): boolean {
  const unsigned = token.startsWith("-") ? token.slice(1) : token;
  const [mantissa = "", exponent = "0"] = unsigned.toLowerCase().split("e");
  const [whole = "", fraction = ""] = mantissa.split(".");
  const digits = `${whole}${fraction}`;
  if (/^0+$/.test(digits)) return true;
  const decimalPlaces = fraction.length - Number(exponent);
  if (decimalPlaces <= 0) return true;
  if (decimalPlaces > digits.length) return false;
  return /^0+$/.test(digits.slice(-decimalPlaces));
}

/** Strict JSON parsing detects duplicate decoded keys before any schema processing. */
function parseJson(source: string, maxBytes: number): unknown {
  if (byteLength(source) > maxBytes)
    fail("TRANSPORT_TOO_LARGE", "", `JSON exceeds the ${maxBytes / (1024 * 1024)} MiB limit.`);
  if (!source.isWellFormed()) fail("INVALID_JSON", "", "JSON contains invalid Unicode.");
  let offset = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/.test(source[offset] ?? "!") && offset < source.length) offset++;
  };
  const invalid = (path: string): never =>
    fail("INVALID_JSON", path, `Malformed JSON at character ${offset}.`);
  const string = (path: string): string => {
    const start = offset++;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === "\\") offset++;
      else if (char === '"') {
        try {
          const result: unknown = JSON.parse(source.slice(start, offset));
          if (typeof result !== "string" || !result.isWellFormed()) return invalid(path);
          return result;
        } catch {
          return invalid(path);
        }
      }
    }
    return invalid(path);
  };
  const value = (depth: number, path: string): unknown => {
    whitespace();
    const char = source[offset];
    if (char === "{" || char === "[") {
      if (depth > PROJECT_CONFIGURATION_MAX_DEPTH)
        fail("MAX_DEPTH_EXCEEDED", path, "JSON nesting exceeds 32 containers.");
      offset++;
      whitespace();
      if (char === "{") {
        const result: Record<string, unknown> = Object.create(null);
        const keys = new Set<string>();
        if (source[offset] === "}") {
          offset++;
          return result;
        }
        while (offset < source.length) {
          if (source[offset] !== '"') return invalid(path);
          const key = string(path);
          const nextPath = childPath(path, key);
          if (keys.has(key))
            fail("DUPLICATE_JSON_KEY", nextPath, "JSON object contains a duplicate property.");
          keys.add(key);
          whitespace();
          if (source[offset++] !== ":") return invalid(nextPath);
          result[key] = value(depth + 1, nextPath);
          whitespace();
          const separator = source[offset++];
          if (separator === "}") return result;
          if (separator !== ",") return invalid(path);
          whitespace();
        }
        return invalid(path);
      }
      const result: unknown[] = [];
      if (source[offset] === "]") {
        offset++;
        return result;
      }
      while (offset < source.length) {
        result.push(value(depth + 1, `${path}[${result.length}]`));
        whitespace();
        const separator = source[offset++];
        if (separator === "]") return result;
        if (separator !== ",") return invalid(path);
        whitespace();
      }
      return invalid(path);
    }
    if (char === '"') return string(path);
    for (const [token, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(token, offset)) {
        offset += token.length;
        return result;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(offset));
    if (!number) return invalid(path);
    offset += number[0].length;
    const result = Number(number[0]);
    if (!Number.isFinite(result) || (Number.isInteger(result) && !isExactIntegerToken(number[0])))
      return invalid(path);
    return result;
  };
  const result = value(1, "");
  whitespace();
  if (offset !== source.length) invalid("");
  return result;
}

/** Strict configuration/request JSON retains the 1 MiB transport limit. */
export function parseConfigurationJsonV1(source: string): unknown {
  return parseJson(source, PROJECT_CONFIGURATION_MAX_BYTES);
}

/** Separate saved/server review artifact parser; does not relax mutation transport limits. */
export function parseProjectConfigurationReviewJsonV1(source: string): unknown {
  return parseJson(source, PROJECT_CONFIGURATION_MAX_REVIEW_BYTES);
}

type Rule =
  | { kind: "object"; properties: Record<string, Rule> }
  | { kind: "array"; item: Rule; max: number; min: number }
  | {
      kind: "string";
      min?: number;
      max?: number;
      nonblank?: boolean;
      uuid?: boolean;
      pattern?: RegExp;
    }
  | { kind: "integer"; min: number; max: number }
  | { kind: "enum"; values: readonly (string | number | boolean)[] }
  | { kind: "deferred" }
  | { kind: "nullable"; rule: Rule };
const object = (properties: Record<string, Rule>): Rule => ({ kind: "object", properties });
const array = (item: Rule, max: number, min = 0): Rule => ({ kind: "array", item, max, min });
const text: Rule = { kind: "string", min: 1, max: 500, nonblank: true };
const uuid: Rule = { kind: "string", uuid: true };
const instant: Rule = {
  kind: "string",
  max: 40,
  pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
};
const integer: Rule = { kind: "integer", min: 0, max: MAX_WORK_MINUTES };
const nullable = (rule: Rule): Rule => ({ kind: "nullable", rule });
const enumeration = (...values: (string | number | boolean)[]): Rule => ({ kind: "enum", values });
const interval = object({ start: { kind: "string" }, end: { kind: "string" } });
const inputRule = object({
  schemaVersion: enumeration(1),
  project: object({
    id: uuid,
    name: text,
    plannedStart: instant,
    dataDate: instant,
    requiredFinish: nullable(instant),
    defaultCalendarId: uuid,
  }),
  scheduleOptions: object({
    criticalFloatThresholdMinutes: integer,
    lagCalendarPolicy: enumeration("PREDECESSOR", "SUCCESSOR", "PROJECT"),
    projectFinishPolicy: enumeration("CALCULATED", "REQUIRED_FINISH"),
  }),
  calendars: array(
    object({
      id: uuid,
      name: text,
      timeZone: { kind: "string", min: 1, max: 100 },
      week: object(Object.fromEntries(WEEKDAYS.map((day) => [day, array(interval, 24)]))),
      exceptions: array(
        object({ date: { kind: "string" }, workingIntervals: array(interval, 24) }),
        3660,
      ),
    }),
    100,
    1,
  ),
  wbs: array(
    object({
      id: uuid,
      parentId: nullable(uuid),
      code: { ...text, max: 100 },
      name: text,
      sortOrder: integer,
    }),
    10_000,
    1,
  ),
  activities: array(
    object({
      id: uuid,
      wbsId: uuid,
      name: text,
      kind: enumeration("TASK", "START_MILESTONE", "FINISH_MILESTONE"),
      durationMinutes: integer,
      calendarId: uuid,
      constraints: array(
        object({
          type: enumeration(
            "START_ON_OR_AFTER",
            "START_ON_OR_BEFORE",
            "FINISH_ON_OR_AFTER",
            "FINISH_ON_OR_BEFORE",
          ),
          instant,
        }),
        16,
      ),
    }),
    10_000,
  ),
  relationships: array(
    object({
      predecessorId: uuid,
      successorId: uuid,
      type: enumeration("FS", "SS", "FF", "SF"),
      lagMinutes: { kind: "integer", min: -MAX_WORK_MINUTES, max: MAX_WORK_MINUTES },
    }),
    80_000,
  ),
});
const configurationRule = object({
  schemaVersion: enumeration(1),
  kind: enumeration("engineo-project-configuration"),
  scope: enumeration("schedule"),
  input: inputRule,
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateShape(value: unknown, rule: Rule, path: string, issues: Diagnostics): void {
  const invalid = (message: string) => issues.add("INVALID_VALUE", path, message);
  switch (rule.kind) {
    case "deferred":
      // Only review envelopes use this; their payload gets a discriminated full check below.
      return;
    case "nullable":
      if (value !== null) validateShape(value, rule.rule, path, issues);
      return;
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        invalid("Expected a JSON object.");
        return;
      }
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== null && prototype !== Object.prototype) {
        invalid("Expected an ordinary JSON object.");
        return;
      }
      const properties = Object.getOwnPropertyDescriptors(value);
      for (const key of Object.keys(properties)) {
        if (!Object.hasOwn(rule.properties, key))
          issues.add("UNKNOWN_PROPERTY", childPath(path, key), "Unknown property is rejected.");
      }
      if (Object.getOwnPropertySymbols(value).length) invalid("JSON cannot contain symbol keys.");
      for (const [key, childRule] of Object.entries(rule.properties)) {
        const descriptor = properties[key];
        const nextPath = childPath(path, key);
        if (!descriptor) issues.add("MISSING_PROPERTY", nextPath, "Required property is missing.");
        else if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
          issues.add("INVALID_VALUE", nextPath, "Expected an enumerable JSON value.");
        else validateShape(descriptor.value, childRule, nextPath, issues);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        invalid("Expected a JSON array.");
        return;
      }
      // Direct callers must not supply inherited normalization hooks or arrays
      // without ordinary array methods. Parsed JSON always has this prototype.
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        invalid("Expected an ordinary JSON array.");
        return;
      }
      if (value.length < rule.min || value.length > rule.max)
        invalid(`Expected between ${rule.min} and ${rule.max} array items.`);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Object.keys(descriptors)) {
        if (key !== "length" && !/^(0|[1-9]\d*)$/.test(key))
          issues.add(
            "UNKNOWN_PROPERTY",
            childPath(path, key),
            "JSON arrays cannot contain extra properties.",
          );
      }
      if (Object.getOwnPropertySymbols(value).length) invalid("JSON cannot contain symbol keys.");
      // Entity bounds also bound direct-object validation work; do not invoke getters.
      for (let index = 0; index < Math.min(value.length, rule.max); index++) {
        const descriptor = descriptors[index];
        const nextPath = `${path}[${index}]`;
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
          issues.add("INVALID_VALUE", nextPath, "Expected a dense array of ordinary JSON values.");
        else validateShape(descriptor.value, rule.item, nextPath, issues);
      }
      return;
    }
    case "string": {
      if (typeof value !== "string") {
        invalid("Expected a string.");
        return;
      }
      const length = [...value].length;
      if (
        !value.isWellFormed() ||
        value.includes("\u0000") ||
        (rule.min !== undefined && length < rule.min) ||
        (rule.max !== undefined && length > rule.max) ||
        (rule.nonblank && !/\S/u.test(value)) ||
        (rule.pattern !== undefined && !rule.pattern.test(value))
      )
        invalid("String is blank, too long, or contains unsupported Unicode/NUL.");
      if (rule.uuid && !UUID_PATTERN.test(value))
        issues.add("INVALID_UUID", path, "Native identifiers must be hyphenated UUIDs.");
      return;
    }
    case "integer":
      if (
        !Number.isSafeInteger(value) ||
        typeof value !== "number" ||
        value < rule.min ||
        value > rule.max
      )
        invalid(`Expected an integer between ${rule.min} and ${rule.max}.`);
      return;
    case "enum":
      if (!rule.values.some((allowed) => value === allowed))
        issues.add(
          path.endsWith("schemaVersion") ? "INVALID_SCHEMA_VERSION" : "INVALID_VALUE",
          path,
          "Unsupported version or value.",
        );
  }
}

/** Relationship identity intentionally includes lag: tuple changes are delete/create. */
export function relationshipConfigurationKeyV1(relationship: RelationshipInputV1): string {
  return JSON.stringify([
    relationship.predecessorId.toLowerCase(),
    relationship.successorId.toLowerCase(),
    relationship.type,
    relationship.lagMinutes,
  ]);
}

function normalizeNativeIds(input: EngineProjectInputV1): EngineProjectInputV1 {
  // Configuration normalization owns persistence-compatible object ordering.
  // Keep the existing durable schedule serializer unchanged. PostgreSQL JSONB
  // returns interval keys as end/start and constraint keys as type/instant.
  const interval = (value: { start: string; end: string }) => ({
    end: value.end,
    start: value.start,
  });
  return {
    schemaVersion: input.schemaVersion,
    project: {
      id: input.project.id.toLowerCase(),
      name: input.project.name,
      plannedStart: input.project.plannedStart,
      dataDate: input.project.dataDate,
      requiredFinish: input.project.requiredFinish,
      defaultCalendarId: input.project.defaultCalendarId.toLowerCase(),
    },
    scheduleOptions: {
      criticalFloatThresholdMinutes: input.scheduleOptions.criticalFloatThresholdMinutes,
      lagCalendarPolicy: input.scheduleOptions.lagCalendarPolicy,
      projectFinishPolicy: input.scheduleOptions.projectFinishPolicy,
    },
    calendars: input.calendars.map((calendar) => ({
      id: calendar.id.toLowerCase(),
      name: calendar.name,
      timeZone: calendar.timeZone,
      week: Object.fromEntries(
        WEEKDAYS.map((day) => [day, calendar.week[day].map(interval)]),
      ) as CalendarV1["week"],
      exceptions: calendar.exceptions.map((exception) => ({
        date: exception.date,
        workingIntervals: exception.workingIntervals.map(interval),
      })),
    })),
    wbs: input.wbs.map((node) => ({
      id: node.id.toLowerCase(),
      parentId: node.parentId?.toLowerCase() ?? null,
      code: node.code,
      name: node.name,
      sortOrder: node.sortOrder,
    })),
    activities: input.activities.map((activity) => ({
      id: activity.id.toLowerCase(),
      wbsId: activity.wbsId.toLowerCase(),
      name: activity.name,
      kind: activity.kind,
      durationMinutes: activity.durationMinutes,
      calendarId: activity.calendarId.toLowerCase(),
      constraints: activity.constraints.map((constraint) => ({
        type: constraint.type,
        instant: constraint.instant,
      })),
    })),
    relationships: input.relationships.map((relationship) => ({
      predecessorId: relationship.predecessorId.toLowerCase(),
      successorId: relationship.successorId.toLowerCase(),
      type: relationship.type,
      lagMinutes: relationship.lagMinutes,
    })),
  };
}

function normalizeProjectInstants(
  input: EngineProjectInputV1,
  issues: Diagnostics,
): EngineProjectInputV1 {
  const normalizeInstant = (value: string, path: string): string => {
    if (/\.\d{4,}(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      issues.add(
        "EXCESS_INSTANT_PRECISION",
        path,
        "Project instants support at most millisecond precision.",
      );
      return value;
    }
    // Shape and semantic validation have already proved this is a real instant.
    const normalized = new Date(value).toISOString();
    if (!/^\d{4}-/.test(normalized) || normalized.startsWith("0000-"))
      issues.add(
        "INVALID_INSTANT",
        path,
        "Project instants must normalize to a native year between 0001 and 9999.",
      );
    return normalized;
  };
  return {
    schemaVersion: input.schemaVersion,
    project: {
      id: input.project.id,
      name: input.project.name,
      plannedStart: normalizeInstant(input.project.plannedStart, "input.project.plannedStart"),
      dataDate: normalizeInstant(input.project.dataDate, "input.project.dataDate"),
      requiredFinish:
        input.project.requiredFinish === null
          ? null
          : normalizeInstant(input.project.requiredFinish, "input.project.requiredFinish"),
      defaultCalendarId: input.project.defaultCalendarId,
    },
    scheduleOptions: input.scheduleOptions,
    calendars: input.calendars,
    wbs: input.wbs,
    activities: input.activities,
    relationships: input.relationships,
  };
}

/** Does not perform tenant-ID availability checks or authoritative Rust calculation. */
export function validateProjectConfigurationV1(value: unknown): ProjectConfigurationValidationV1 {
  const issues = new Diagnostics();
  validateShape(value, configurationRule, "", issues);
  if (issues.totalCount)
    return { valid: false, diagnostics: issues.result(), calculationChecked: false };
  const configuration = value as ProjectConfigurationV1;
  // Lowercase identifiers before reference/duplicate validation (PostgreSQL UUID semantics).
  const input = normalizeNativeIds(configuration.input);
  for (const issue of validateScheduleInputV1(input).issues)
    issues.add(issue.code, `input.${issue.path}`, issue.message);
  const wbsCodes = new Set<string>();
  for (const [index, node] of input.wbs.entries()) {
    if (wbsCodes.has(node.code))
      issues.add(
        "DUPLICATE_WBS_CODE",
        `input.wbs[${index}].code`,
        "WBS codes must be unique in the project.",
      );
    wbsCodes.add(node.code);
  }
  const tuples = new Set<string>();
  for (const [index, relationship] of input.relationships.entries()) {
    const key = relationshipConfigurationKeyV1(relationship);
    if (tuples.has(key))
      issues.add(
        "DUPLICATE_RELATIONSHIP",
        `input.relationships[${index}]`,
        "Relationship tuples must be unique in the project.",
      );
    tuples.add(key);
  }
  if (issues.totalCount)
    return { valid: false, diagnostics: issues.result(), calculationChecked: false };
  const normalized = normalizeProjectInstants(input, issues);
  if (issues.totalCount)
    return { valid: false, diagnostics: issues.result(), calculationChecked: false };
  const canonicalInput = serializeScheduleInputV1(normalized);
  if (byteLength(canonicalInput) > PROJECT_CONFIGURATION_MAX_ARTIFACT_BYTES) {
    issues.add("ARTIFACT_TOO_LARGE", "input", "Canonical input exceeds the 4 MiB artifact limit.");
    return { valid: false, diagnostics: issues.result(), calculationChecked: false };
  }
  // Parse canonical bytes to detach all nested values from callers and establish property order.
  const normalizedInput = JSON.parse(canonicalInput) as EngineProjectInputV1;
  return {
    valid: true,
    normalizedConfiguration: {
      schemaVersion: 1,
      kind: "engineo-project-configuration",
      scope: "schedule",
      input: normalizedInput,
    },
    normalizedInput,
    canonicalInput,
    diagnostics: issues.result(),
    calculationChecked: false,
  };
}

export function parseProjectConfigurationV1(source: string): ProjectConfigurationValidationV1 {
  try {
    return validateProjectConfigurationV1(parseConfigurationJsonV1(source));
  } catch (error) {
    if (!(error instanceof ProjectConfigurationError)) throw error;
    return { valid: false, diagnostics: error.diagnostics, calculationChecked: false };
  }
}

/** Inputs must already be validated/normalized; canonical artifact bounds still fail closed. */
export function diffProjectConfigurationV1(
  base: EngineProjectInputV1,
  candidate: EngineProjectInputV1,
): ProjectConfigurationDiffV1 {
  const canonical = (input: EngineProjectInputV1, path: string): EngineProjectInputV1 => {
    const source = serializeScheduleInputV1(input);
    if (byteLength(source) > PROJECT_CONFIGURATION_MAX_ARTIFACT_BYTES)
      fail("ARTIFACT_TOO_LARGE", path, "Canonical input exceeds the 4 MiB artifact limit.");
    return JSON.parse(source) as EngineProjectInputV1;
  };
  const before = canonical(base, "base"),
    after = canonical(candidate, "candidate");
  const changes: ProjectConfigurationChangeV1[] = [];
  const singleton = <T, E extends "project" | "scheduleOptions">(
    entity: E,
    key: string,
    previous: T,
    next: T,
  ) => {
    if (JSON.stringify(previous) !== JSON.stringify(next))
      changes.push({
        entity,
        key,
        operation: "update",
        before: previous,
        after: next,
      } as ProjectConfigurationChangeV1);
  };
  singleton("project", before.project.id, before.project, after.project);
  singleton("scheduleOptions", "scheduleOptions", before.scheduleOptions, after.scheduleOptions);
  const collection = <T, E extends "calendar" | "wbs" | "activity" | "relationship">(
    entity: E,
    previous: T[],
    next: T[],
    keyOf: (value: T) => string,
  ) => {
    const keyed = (values: T[], path: string): Map<string, T> => {
      const result = new Map<string, T>();
      for (const value of values) {
        const key = keyOf(value);
        if (result.has(key))
          fail(
            entity === "relationship" ? "DUPLICATE_RELATIONSHIP" : "DUPLICATE_ID",
            path,
            "A complete diff requires unique entity identities.",
          );
        result.set(key, value);
      }
      return result;
    };
    const old = keyed(previous, `base.${entity}`);
    const desired = keyed(next, `candidate.${entity}`);
    for (const key of [...new Set([...old.keys(), ...desired.keys()])].sort()) {
      const oldValue = old.get(key),
        newValue = desired.get(key);
      if (oldValue === undefined)
        changes.push({
          entity,
          key,
          operation: "create",
          before: null,
          after: newValue,
        } as ProjectConfigurationChangeV1);
      else if (newValue === undefined)
        changes.push({
          entity,
          key,
          operation: "delete",
          before: oldValue,
          after: null,
        } as ProjectConfigurationChangeV1);
      else if (JSON.stringify(oldValue) !== JSON.stringify(newValue))
        changes.push({
          entity,
          key,
          operation: "update",
          before: oldValue,
          after: newValue,
        } as ProjectConfigurationChangeV1);
    }
  };
  collection("calendar", before.calendars, after.calendars, (value) => value.id);
  collection("wbs", before.wbs, after.wbs, (value) => value.id);
  collection("activity", before.activities, after.activities, (value) => value.id);
  collection(
    "relationship",
    before.relationships,
    after.relationships,
    relationshipConfigurationKeyV1,
  );
  const serializedDiff = `${JSON.stringify(changes, null, 2)}\n`;
  if (byteLength(serializedDiff) > PROJECT_CONFIGURATION_MAX_DIFF_BYTES)
    fail(
      "DIFF_TOO_LARGE",
      "changes",
      "Complete diff exceeds the 8 MiB limit; no applyable review can be issued.",
    );
  return { changes, noOp: changes.length === 0, serializedDiff };
}

/** Ordered review descriptor bytes shared by the server and application CLI. */
export function serializeProjectConfigurationReviewV1(
  plan: Omit<ProjectConfigurationPlanV1, "reviewedDigest"> | ProjectConfigurationPlanV1,
): string {
  return JSON.stringify({
    schemaVersion: plan.schemaVersion,
    protocolVersion: plan.protocolVersion,
    normalizationVersion: plan.normalizationVersion,
    planId: plan.planId,
    organizationId: plan.organizationId,
    projectId: plan.projectId,
    actorId: plan.actorId,
    sessionId: plan.sessionId,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    baseRevision: plan.baseRevision,
    baseInputHashSha256: plan.baseInputHashSha256,
    desiredInputHashSha256: plan.desiredInputHashSha256,
    configuration: plan.configuration,
    changes: plan.changes,
    noOp: plan.noOp,
  });
}

const nativeUuid: Rule = {
  kind: "string",
  uuid: true,
  pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
};
const sha256: Rule = { kind: "string", pattern: /^[0-9a-f]{64}$/ };
const canonicalInstant: Rule = {
  kind: "string",
  pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
};
const revision: Rule = { kind: "integer", min: 1, max: Number.MAX_SAFE_INTEGER - 1 };
const committedRevision: Rule = { kind: "integer", min: 1, max: Number.MAX_SAFE_INTEGER };
const deferred: Rule = { kind: "deferred" };
const changeRule = object({
  entity: enumeration("project", "scheduleOptions", "calendar", "wbs", "activity", "relationship"),
  key: { kind: "string", min: 1, max: 256 },
  operation: enumeration("create", "update", "delete"),
  before: deferred,
  after: deferred,
});
const planRule = object({
  schemaVersion: enumeration(1),
  protocolVersion: enumeration(1),
  normalizationVersion: enumeration(1),
  planId: nativeUuid,
  organizationId: nativeUuid,
  projectId: nativeUuid,
  actorId: nativeUuid,
  sessionId: nativeUuid,
  createdAt: canonicalInstant,
  expiresAt: canonicalInstant,
  baseRevision: revision,
  baseInputHashSha256: sha256,
  desiredInputHashSha256: sha256,
  configuration: configurationRule,
  // Two bounded schedules' complete create/delete changes plus two singletons.
  changes: array(changeRule, 200_202),
  noOp: enumeration(false, true),
  reviewedDigest: sha256,
});
const receiptRule = object({
  schemaVersion: enumeration(1),
  planId: nativeUuid,
  organizationId: nativeUuid,
  projectId: nativeUuid,
  previousRevision: revision,
  baseInputHashSha256: sha256,
  reviewedDigest: sha256,
  provenanceAuditId: nativeUuid,
  recordedAt: canonicalInstant,
  outcome: enumeration("applied", "no_op", "cancelled"),
  committedRevision: nullable(committedRevision),
  committedInputHashSha256: nullable(sha256),
  scheduleEditAuditId: nullable(nativeUuid),
});
const readRule = object({
  schemaVersion: enumeration(1),
  revision: committedRevision,
  inputHashSha256: sha256,
  configuration: configurationRule,
});
const planReadRule = object({
  plan: nullable(deferred),
  status: enumeration("pending", "expired", "cancelled", "applied", "no_op"),
  planId: nativeUuid,
  artifactsAvailable: enumeration(false, true),
  receipt: nullable(deferred),
});
function hasShape(value: unknown, rule: Rule): boolean {
  const issues = new Diagnostics();
  validateShape(value, rule, "", issues);
  return issues.totalCount === 0;
}
function validCanonicalInstant(value: string): boolean {
  return (
    !value.startsWith("0000-") && isRfc3339Instant(value) && new Date(value).toISOString() === value
  );
}
function sameJson(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}
function canonicalConfiguration(
  value: ProjectConfigurationV1,
): ReturnType<typeof validateProjectConfigurationV1> {
  const result = validateProjectConfigurationV1(value);
  if (result.valid && !sameJson(value, result.normalizedConfiguration))
    return {
      valid: false,
      diagnostics: { issues: [], totalCount: 0, truncated: false },
      calculationChecked: false,
    };
  return result;
}
function entityInputRule(entity: ProjectConfigurationChangeV1["entity"]): Rule {
  if (inputRule.kind !== "object") throw new Error("Invalid internal input rule.");
  const fields = inputRule.properties;
  const field =
    fields[
      {
        project: "project",
        scheduleOptions: "scheduleOptions",
        calendar: "calendars",
        wbs: "wbs",
        activity: "activities",
        relationship: "relationships",
      }[entity]
    ];
  if (!field) throw new Error("Invalid internal entity rule.");
  return field.kind === "array" ? field.item : field;
}
function validChangeValues(change: ProjectConfigurationChangeV1): boolean {
  const rule = entityInputRule(change.entity);
  const before = change.before,
    after = change.after;
  if (change.operation === "create")
    return before === null && after !== null && hasShape(after, rule);
  if (change.operation === "delete")
    return before !== null && after === null && hasShape(before, rule);
  return before !== null && after !== null && hasShape(before, rule) && hasShape(after, rule);
}

/** Structural/semantic consistency only; callers verify SHA-256 and known identities separately. */
export function validateProjectConfigurationPlanV1(
  value: unknown,
): value is ProjectConfigurationPlanV1 {
  try {
    if (!hasShape(value, planRule)) return false;
    const plan = value as ProjectConfigurationPlanV1;
    if (!validCanonicalInstant(plan.createdAt) || !validCanonicalInstant(plan.expiresAt))
      return false;
    const lifetime = Date.parse(plan.expiresAt) - Date.parse(plan.createdAt);
    if (lifetime <= 0 || lifetime > 15 * 60 * 1000) return false;
    const candidate = canonicalConfiguration(plan.configuration);
    if (!candidate.valid || candidate.normalizedInput.project.id !== plan.projectId) return false;
    if (
      plan.noOp !== (plan.changes.length === 0) ||
      plan.noOp !== (plan.baseInputHashSha256 === plan.desiredInputHashSha256)
    )
      return false;
    if (!plan.changes.every(validChangeValues)) return false;
    const input = candidate.normalizedInput;
    const proposedBase = JSON.parse(candidate.canonicalInput) as EngineProjectInputV1;
    const calendars = new Map(input.calendars.map((entity) => [entity.id, entity]));
    const wbs = new Map(input.wbs.map((entity) => [entity.id, entity]));
    const activities = new Map(input.activities.map((entity) => [entity.id, entity]));
    const relationships = new Map(
      input.relationships.map((entity) => [relationshipConfigurationKeyV1(entity), entity]),
    );
    const identities = new Set<string>();
    for (const change of plan.changes) {
      const identity = JSON.stringify([change.entity, change.key]);
      if (identities.has(identity)) return false;
      identities.add(identity);
      if (change.entity === "project") {
        if (
          change.operation !== "update" ||
          change.key !== plan.projectId ||
          change.before.id !== plan.projectId ||
          !sameJson(change.after, input.project)
        )
          return false;
        proposedBase.project = change.before;
      } else if (change.entity === "scheduleOptions") {
        if (
          change.operation !== "update" ||
          change.key !== "scheduleOptions" ||
          !sameJson(change.after, input.scheduleOptions)
        )
          return false;
        proposedBase.scheduleOptions = change.before;
      } else {
        const revert = <T>(
          entities: Map<string, T>,
          keyOf: (entity: T) => string,
          before: T | null,
          after: T | null,
        ): boolean => {
          if (
            (before !== null && keyOf(before) !== change.key) ||
            (after !== null && keyOf(after) !== change.key)
          )
            return false;
          if (change.operation === "delete") {
            if (entities.has(change.key) || before === null) return false;
            entities.set(change.key, before);
          } else {
            if (after === null || !sameJson(entities.get(change.key), after)) return false;
            if (change.operation === "create") entities.delete(change.key);
            else {
              if (before === null) return false;
              entities.set(change.key, before);
            }
          }
          return true;
        };
        switch (change.entity) {
          case "calendar":
            if (!revert(calendars, (entity) => entity.id, change.before, change.after))
              return false;
            break;
          case "wbs":
            if (!revert(wbs, (entity) => entity.id, change.before, change.after)) return false;
            break;
          case "activity":
            if (!revert(activities, (entity) => entity.id, change.before, change.after))
              return false;
            break;
          case "relationship":
            if (
              change.operation === "update" ||
              !revert(relationships, relationshipConfigurationKeyV1, change.before, change.after)
            )
              return false;
        }
      }
    }
    proposedBase.calendars = [...calendars.values()];
    proposedBase.wbs = [...wbs.values()];
    proposedBase.activities = [...activities.values()];
    proposedBase.relationships = [...relationships.values()];
    const base = validateProjectConfigurationV1({
      schemaVersion: 1,
      kind: "engineo-project-configuration",
      scope: "schedule",
      input: proposedBase,
    });
    if (!base.valid) return false;
    const diff = diffProjectConfigurationV1(base.normalizedInput, input);
    return diff.noOp === plan.noOp && sameJson(diff.changes, plan.changes);
  } catch {
    return false;
  }
}

/** Validates historical terminal evidence shape and outcome invariants, not authenticity. */
export function validateProjectConfigurationReceiptV1(
  value: unknown,
): value is ProjectConfigurationReceiptV1 {
  try {
    if (!hasShape(value, receiptRule)) return false;
    const receipt = value as ProjectConfigurationReceiptV1;
    if (!validCanonicalInstant(receipt.recordedAt)) return false;
    if (receipt.outcome === "cancelled")
      return (
        receipt.committedRevision === null &&
        receipt.committedInputHashSha256 === null &&
        receipt.scheduleEditAuditId === null
      );
    if (receipt.outcome === "no_op")
      return (
        receipt.committedRevision === receipt.previousRevision &&
        receipt.committedInputHashSha256 === receipt.baseInputHashSha256 &&
        receipt.scheduleEditAuditId === null
      );
    return (
      receipt.committedRevision === receipt.previousRevision + 1 &&
      receipt.committedInputHashSha256 !== null &&
      receipt.committedInputHashSha256 !== receipt.baseInputHashSha256 &&
      receipt.scheduleEditAuditId !== null &&
      receipt.scheduleEditAuditId !== receipt.provenanceAuditId
    );
  } catch {
    return false;
  }
}

export function validateProjectConfigurationReadV1(
  value: unknown,
): value is ProjectConfigurationReadV1 {
  try {
    return (
      hasShape(value, readRule) &&
      canonicalConfiguration((value as ProjectConfigurationReadV1).configuration).valid
    );
  } catch {
    return false;
  }
}

export function validateProjectConfigurationPlanReadV1(
  value: unknown,
): value is ProjectConfigurationPlanReadV1 {
  try {
    if (!hasShape(value, planReadRule)) return false;
    const read = value as ProjectConfigurationPlanReadV1;
    if (read.artifactsAvailable !== (read.plan !== null)) return false;
    if (
      read.plan !== null &&
      (!validateProjectConfigurationPlanV1(read.plan) || read.plan.planId !== read.planId)
    )
      return false;
    if (read.status === "pending" || read.status === "expired")
      return read.receipt === null && (read.status !== "pending" || read.plan !== null);
    if (
      !validateProjectConfigurationReceiptV1(read.receipt) ||
      read.receipt.outcome !== read.status ||
      read.receipt.planId !== read.planId
    )
      return false;
    if (read.plan === null) return true;
    const plan = read.plan,
      receipt = read.receipt;
    return (
      receipt.organizationId === plan.organizationId &&
      receipt.projectId === plan.projectId &&
      receipt.previousRevision === plan.baseRevision &&
      receipt.baseInputHashSha256 === plan.baseInputHashSha256 &&
      receipt.reviewedDigest === plan.reviewedDigest &&
      (receipt.outcome === "cancelled" ||
        (receipt.committedInputHashSha256 === plan.desiredInputHashSha256 &&
          plan.noOp === (receipt.outcome === "no_op")))
    );
  } catch {
    return false;
  }
}
