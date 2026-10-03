import {
  PLANNER_VIEW_MAX_DEPTH,
  PLANNER_VIEW_MAX_DIAGNOSTICS,
  PLANNER_VIEW_MAX_DIAGNOSTIC_TEXT_LENGTH,
  PLANNER_VIEW_NORMALIZATION_VERSION,
  PLANNER_VIEW_PROJECTION_VERSION,
  type PlannerViewConfigurationV1,
  type PlannerViewDiagnosticsV1,
  type PlannerViewIssueCodeV1,
  type PlannerViewIssueV1,
  validatePlannerViewConfigurationV1,
} from "./planner-view.js";

/** Private preference protocol only. A digest is consistency binding, never authorization. */
export const PLANNER_VIEW_PROTOCOL_VERSION = 1 as const;
export const PLANNER_VIEW_MAX_OPERATION_BYTES = 64 * 1024;
export const PLANNER_VIEW_MAX_RECEIPT_BYTES = 2 * 1024;
export const PLANNER_VIEW_MAX_REVIEW_AGE_MS = 15 * 60 * 1000;
export const PLANNER_VIEW_RECEIPT_RETENTION_AFTER_CLOSE_MS = 24 * 60 * 60 * 1000;

export type PlannerViewActionV1 = "create" | "update" | "delete";
interface PlannerViewOperationIdentityV1 {
  operationWindowId: string;
  operationId: string;
  expectedScheduleRevision: number;
}
export type PlannerViewPlanRequestV1 = PlannerViewOperationIdentityV1 &
  (
    | { action: "create"; configuration: PlannerViewConfigurationV1 }
    | {
        action: "update";
        viewId: string;
        expectedViewRevision: number;
        configuration: PlannerViewConfigurationV1;
      }
    | { action: "delete"; viewId: string; expectedViewRevision: number }
  );
export interface PlannerViewValidateRequestV1 {
  configuration: PlannerViewConfigurationV1;
}
export interface PlannerViewProjectionRequestV1 extends PlannerViewValidateRequestV1 {
  expectedScheduleRevision: number;
}
export interface PlannerViewReviewV1 extends PlannerViewOperationIdentityV1 {
  schemaVersion: 1;
  kind: "engineo-planner-view-review";
  protocolVersion: 1;
  projectionVersion: 1;
  normalizationVersion: 1;
  action: PlannerViewActionV1;
  /** Null on create. The server chooses a fresh view UUID only at commit. */
  viewId: string | null;
  actorId: string;
  sessionId: string;
  organizationId: string;
  projectId: string;
  expectedViewRevision: number;
  baseConfigHash: string | null;
  desiredConfigHash: string | null;
  baseConfiguration: PlannerViewConfigurationV1 | null;
  desiredConfiguration: PlannerViewConfigurationV1 | null;
  issuedAt: string;
  expiresAt: string;
}
export interface PlannerViewPlanV1 {
  review: PlannerViewReviewV1;
  reviewedDigest: string;
}
export interface PlannerViewApplyRequestV1 extends PlannerViewPlanV1 {}
export interface PlannerViewReceiptV1 {
  schemaVersion: 1;
  kind: "engineo-planner-view-receipt";
  protocolVersion: 1;
  projectionVersion: 1;
  normalizationVersion: 1;
  action: PlannerViewActionV1;
  outcome: "applied" | "no_op" | "deleted";
  viewId: string;
  actorId: string;
  sessionId: string;
  organizationId: string;
  projectId: string;
  previousViewRevision: number;
  committedViewRevision: number | null;
  expectedScheduleRevision: number;
  baseConfigHash: string | null;
  desiredConfigHash: string | null;
  operationWindowId: string;
  operationId: string;
  reviewedDigest: string;
  auditId: string;
  recordedAt: string;
}
export type PlannerViewOperationValidationV1<T> =
  | { valid: true; value: T; diagnostics: PlannerViewDiagnosticsV1 }
  | { valid: false; diagnostics: PlannerViewDiagnosticsV1 };
export class PlannerViewOperationsError extends Error {
  readonly code: PlannerViewIssueCodeV1;
  constructor(public readonly diagnostics: PlannerViewDiagnosticsV1) {
    super(diagnostics.issues[0]?.message ?? "Invalid Planner view operation.");
    this.name = "PlannerViewOperationsError";
    this.code = diagnostics.issues[0]?.code ?? "INVALID_VALUE";
  }
}

const UTC_DAY_MS = 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const uuidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const configurationPaths = new Set([
  "schemaVersion",
  "kind",
  "name",
  "visibility",
  "presentation",
  "presentation.search",
  "presentation.kind",
  "presentation.wbsId",
  "presentation.critical",
  "presentation.sort",
  "presentation.sort.field",
  "presentation.sort.direction",
  "presentation.groupBy",
]);
/** Only static contract vocabulary is allowed in diagnostics; no unknown keys or source values. */
const safeKeys = new Set([
  ...Array.from(configurationPaths, (path) => path.split(".").at(-1) as string),
  "action",
  "viewId",
  "actorId",
  "sessionId",
  "organizationId",
  "projectId",
  "protocolVersion",
  "projectionVersion",
  "normalizationVersion",
  "expectedViewRevision",
  "expectedScheduleRevision",
  "baseConfigHash",
  "desiredConfigHash",
  "baseConfiguration",
  "desiredConfiguration",
  "operationWindowId",
  "operationId",
  "issuedAt",
  "expiresAt",
  "review",
  "reviewedDigest",
  "configuration",
  "outcome",
  "previousViewRevision",
  "committedViewRevision",
  "auditId",
  "recordedAt",
]);
function clip(value: string): string {
  let result = value.slice(0, PLANNER_VIEW_MAX_DIAGNOSTIC_TEXT_LENGTH);
  if (!result.isWellFormed()) result = result.slice(0, -1);
  return result;
}
class Diagnostics {
  issues: PlannerViewIssueV1[] = [];
  totalCount = 0;
  add(code: PlannerViewIssueCodeV1, path: string, message: string): void {
    this.totalCount++;
    if (this.issues.length < PLANNER_VIEW_MAX_DIAGNOSTICS)
      this.issues.push({ code, path: clip(path), message: clip(message) });
  }
  result(): PlannerViewDiagnosticsV1 {
    return {
      issues: this.issues,
      totalCount: this.totalCount,
      truncated: this.totalCount > this.issues.length,
    };
  }
}
function fail(code: PlannerViewIssueCodeV1, path: string, message: string): never {
  const diagnostics = new Diagnostics();
  diagnostics.add(code, path, message);
  throw new PlannerViewOperationsError(diagnostics.result());
}
function childPath(path: string, key: string): string {
  return safeKeys.has(key) ? `${path ? `${path}.` : ""}${key}` : path;
}
function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}
function originalBytes(value: Uint8Array): number {
  const getter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    "byteLength",
  )?.get;
  try {
    if (!getter) return fail("INVALID_VALUE", "", "Could not inspect UTF-8 bytes safely.");
    return getter.call(value) as number;
  } catch {
    return fail("INVALID_VALUE", "", "Could not inspect UTF-8 bytes safely.");
  }
}
function decode(source: string | Uint8Array, limit: number): string {
  if (typeof source === "string") {
    if (source.length > limit || bytes(source) > limit)
      fail("TRANSPORT_TOO_LARGE", "", "JSON exceeds its UTF-8 byte limit.");
    if (!source.isWellFormed()) fail("INVALID_JSON", "", "JSON contains invalid Unicode.");
    return source;
  }
  if (!ArrayBuffer.isView(source) || !(source instanceof Uint8Array))
    fail("INVALID_VALUE", "", "Expected a JSON string or UTF-8 byte array.");
  if (originalBytes(source) > limit)
    fail("TRANSPORT_TOO_LARGE", "", "JSON exceeds its UTF-8 byte limit.");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source);
  } catch {
    return fail("INVALID_UTF8", "", "JSON contains malformed UTF-8.");
  }
}
/** Original-byte lexer: duplicate decoded keys and numeric spelling survive until rejection. */
function parseJson(source: string): unknown {
  let offset = 0;
  const whitespace = (): void => {
    while (/[\t\n\r ]/.test(source[offset] ?? "!")) offset++;
  };
  const invalid = (path: string): never => fail("INVALID_JSON", path, "Malformed JSON.");
  const string = (path: string): string => {
    offset++;
    let result = "";
    while (offset < source.length) {
      const character = source[offset++];
      if (character === '"') return result.isWellFormed() ? result : invalid(path);
      if (character !== "\\") {
        if (character === undefined || character.charCodeAt(0) < 32) return invalid(path);
        result += character;
        continue;
      }
      const escaped = source[offset++];
      if (escaped === "u") {
        const hex = source.slice(offset, offset + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return invalid(path);
        result += String.fromCharCode(Number.parseInt(hex, 16));
        offset += 4;
      } else {
        const escapes: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (escaped === undefined || !Object.hasOwn(escapes, escaped)) return invalid(path);
        result += escapes[escaped];
      }
    }
    return invalid(path);
  };
  const value = (depth: number, path: string): unknown => {
    whitespace();
    const character = source[offset];
    if (character === "{" || character === "[") {
      if (depth > PLANNER_VIEW_MAX_DEPTH)
        fail("MAX_DEPTH_EXCEEDED", path, "JSON nesting exceeds 8 containers.");
      offset++;
      whitespace();
      if (character === "{") {
        const result: Record<string, unknown> = Object.create(null);
        const keys = new Set<string>();
        if (source[offset] === "}") {
          offset++;
          return result;
        }
        while (offset < source.length) {
          if (source[offset] !== '"') return invalid(path);
          const key = string(path);
          const next = childPath(path, key);
          if (keys.has(key))
            fail("DUPLICATE_JSON_KEY", next, "JSON contains a duplicate property.");
          if (key === "__proto__" || key === "constructor" || key === "prototype")
            fail("UNSAFE_PROPERTY", path, "Prototype-related properties are not allowed.");
          keys.add(key);
          whitespace();
          if (source[offset++] !== ":") return invalid(next);
          result[key] = value(depth + 1, next);
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
        result.push(value(depth + 1, path));
        whitespace();
        const separator = source[offset++];
        if (separator === "]") return result;
        if (separator !== ",") return invalid(path);
        whitespace();
      }
      return invalid(path);
    }
    if (character === '"') return string(path);
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
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(offset));
    if (!match) return invalid(path);
    const token = match[0];
    offset += token.length;
    if (!/^-?(?:0|[1-9]\d*)$/.test(token) || token === "-0") return invalid(path);
    const result = Number(token);
    if (!Number.isSafeInteger(result)) return invalid(path);
    return result;
  };
  const result = value(1, "");
  whitespace();
  if (offset !== source.length) invalid("");
  return result;
}
/** Throws safe bounded diagnostics. Call before validating DTOs; JSON.parse is not equivalent. */
export function parsePlannerViewOperationsJsonV1(source: string | Uint8Array): unknown {
  return parseJson(decode(source, PLANNER_VIEW_MAX_OPERATION_BYTES));
}
function record(
  value: unknown,
  path: string,
  fields: readonly string[],
  d: Diagnostics,
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    d.add("INVALID_VALUE", path, "Expected a plain object.");
    return null;
  }
  let descriptors: ReturnType<typeof Object.getOwnPropertyDescriptors>;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) {
      d.add("INVALID_VALUE", path, "Expected a plain object.");
      return null;
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    d.add("INVALID_VALUE", path, "Object could not be inspected safely.");
    return null;
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !fields.includes(key)) {
      d.add(
        typeof key === "string" && ["__proto__", "constructor", "prototype"].includes(key)
          ? "UNSAFE_PROPERTY"
          : "UNKNOWN_PROPERTY",
        path,
        "Unsupported property is not allowed.",
      );
      continue;
    }
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
      d.add("INVALID_VALUE", childPath(path, key), "Expected an enumerable data property.");
      continue;
    }
    result[key] = descriptor.value;
  }
  for (const field of fields)
    if (!Object.hasOwn(result, field))
      d.add("MISSING_PROPERTY", childPath(path, field), "Required property is missing.");
  return result;
}
function uuid(value: unknown, path: string, d: Diagnostics): string | null {
  if (typeof value === "string" && uuidPattern.test(value)) return value.toLowerCase();
  d.add("INVALID_VALUE", path, "Expected a UUID.");
  return null;
}
function revision(value: unknown, path: string, d: Diagnostics, minimum = 0): number | null {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= minimum
  )
    return value;
  d.add(
    "INVALID_VALUE",
    path,
    minimum === 0
      ? "Expected a bounded nonnegative integer revision."
      : "Expected a bounded positive integer revision.",
  );
  return null;
}
function hash(value: unknown, path: string, d: Diagnostics): string | null {
  if (typeof value === "string" && hashPattern.test(value)) return value;
  d.add("INVALID_VALUE", path, "Expected a lowercase SHA-256 digest.");
  return null;
}
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function timestamp(value: unknown, path: string, d: Diagnostics): string | null {
  if (instant(value)) return value;
  d.add("INVALID_VALUE", path, "Expected a canonical UTC millisecond timestamp.");
  return null;
}
/** V1 timestamps stay in the four-digit-year shape throughout the complete receipt horizon. */
function supportedWindowId(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01")
    return false;
  const opensAt = `${value}T00:00:00.000Z`;
  if (!instant(opensAt)) return false;
  const replayUntil = new Date(
    Date.parse(opensAt) + UTC_DAY_MS + PLANNER_VIEW_RECEIPT_RETENTION_AFTER_CLOSE_MS,
  ).toISOString();
  return instant(replayUntil);
}
function windowId(value: unknown, path: string, d: Diagnostics): string | null {
  if (supportedWindowId(value)) return value;
  d.add("INVALID_VALUE", path, "Expected a supported UTC-day operation window.");
  return null;
}
function configuration(
  value: unknown,
  path: string,
  d: Diagnostics,
): PlannerViewConfigurationV1 | null {
  const result = validatePlannerViewConfigurationV1(value);
  if (result.valid) return result.normalizedConfiguration;
  for (const issue of result.diagnostics.issues)
    d.add(
      issue.code,
      configurationPaths.has(issue.path) ? `${path}.${issue.path}` : path,
      issue.message,
    );
  d.totalCount += result.diagnostics.totalCount - result.diagnostics.issues.length;
  return null;
}
function action(value: unknown, path: string, d: Diagnostics): PlannerViewActionV1 | null {
  if (value === "create" || value === "update" || value === "delete") return value;
  d.add("INVALID_VALUE", path, "Unsupported view action.");
  return null;
}
function result(
  value: null,
  d: Diagnostics,
): { valid: false; diagnostics: PlannerViewDiagnosticsV1 };
function result<T>(value: T | null, d: Diagnostics): PlannerViewOperationValidationV1<T>;
function result<T>(value: T | null, d: Diagnostics): PlannerViewOperationValidationV1<T> {
  return value !== null && d.totalCount === 0
    ? { valid: true, value, diagnostics: d.result() }
    : { valid: false, diagnostics: d.result() };
}
function parsed<T>(
  source: string | Uint8Array,
  validate: (value: unknown) => PlannerViewOperationValidationV1<T>,
  limit = PLANNER_VIEW_MAX_OPERATION_BYTES,
): PlannerViewOperationValidationV1<T> {
  try {
    return validate(parseJson(decode(source, limit)));
  } catch (error) {
    if (error instanceof PlannerViewOperationsError)
      return { valid: false, diagnostics: error.diagnostics };
    throw error;
  }
}
export function validatePlannerViewValidateRequestV1(
  value: unknown,
): PlannerViewOperationValidationV1<PlannerViewValidateRequestV1> {
  const d = new Diagnostics();
  const source = record(value, "", ["configuration"], d);
  const config = source && configuration(source.configuration, "configuration", d);
  return result(config ? { configuration: config } : null, d);
}
export function parsePlannerViewValidateRequestV1(
  source: string | Uint8Array,
): PlannerViewOperationValidationV1<PlannerViewValidateRequestV1> {
  return parsed(source, validatePlannerViewValidateRequestV1);
}
export function validatePlannerViewProjectionRequestV1(
  value: unknown,
): PlannerViewOperationValidationV1<PlannerViewProjectionRequestV1> {
  const d = new Diagnostics();
  const source = record(value, "", ["configuration", "expectedScheduleRevision"], d);
  if (!source) return result(null, d);
  const config = configuration(source.configuration, "configuration", d);
  const expectedScheduleRevision = revision(
    source.expectedScheduleRevision,
    "expectedScheduleRevision",
    d,
    1,
  );
  return result(
    config && expectedScheduleRevision !== null
      ? { configuration: config, expectedScheduleRevision }
      : null,
    d,
  );
}
export function parsePlannerViewProjectionRequestV1(
  source: string | Uint8Array,
): PlannerViewOperationValidationV1<PlannerViewProjectionRequestV1> {
  return parsed(source, validatePlannerViewProjectionRequestV1);
}
export function validatePlannerViewPlanRequestV1(
  value: unknown,
): PlannerViewOperationValidationV1<PlannerViewPlanRequestV1> {
  const d = new Diagnostics();
  // Inspect action without reading a getter and then enforce the action-specific closed shape.
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor =
      typeof value === "object" && value !== null
        ? Object.getOwnPropertyDescriptor(value, "action")
        : undefined;
  } catch {
    d.add("INVALID_VALUE", "", "Object could not be inspected safely.");
    return result(null, d);
  }
  const rawAction: unknown =
    descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  const fields = ["action", "operationWindowId", "operationId", "expectedScheduleRevision"];
  if (rawAction === "create" || rawAction === "update") fields.push("configuration");
  if (rawAction === "update" || rawAction === "delete")
    fields.push("viewId", "expectedViewRevision");
  const source = record(value, "", fields, d);
  if (!source) return result(null, d);
  const operation = action(source.action, "action", d);
  const operationWindowId = windowId(source.operationWindowId, "operationWindowId", d);
  const operationId = uuid(source.operationId, "operationId", d);
  const expectedScheduleRevision = revision(
    source.expectedScheduleRevision,
    "expectedScheduleRevision",
    d,
    1,
  );
  const config =
    operation === "create" || operation === "update"
      ? configuration(source.configuration, "configuration", d)
      : null;
  const viewId =
    operation === "update" || operation === "delete" ? uuid(source.viewId, "viewId", d) : null;
  const expectedViewRevision =
    operation === "update" || operation === "delete"
      ? revision(source.expectedViewRevision, "expectedViewRevision", d, 1)
      : null;
  if (!operation || !operationWindowId || !operationId || expectedScheduleRevision === null)
    return result(null, d);
  const identity = { operationWindowId, operationId, expectedScheduleRevision };
  if (operation === "create")
    return result(config ? { ...identity, action: operation, configuration: config } : null, d);
  if (!viewId || expectedViewRevision === null) return result(null, d);
  if (operation === "update")
    return result(
      config
        ? { ...identity, action: operation, viewId, expectedViewRevision, configuration: config }
        : null,
      d,
    );
  return result({ ...identity, action: operation, viewId, expectedViewRevision }, d);
}
export function parsePlannerViewPlanRequestV1(
  source: string | Uint8Array,
): PlannerViewOperationValidationV1<PlannerViewPlanRequestV1> {
  return parsed(source, validatePlannerViewPlanRequestV1);
}
const reviewFields = [
  "schemaVersion",
  "kind",
  "protocolVersion",
  "projectionVersion",
  "normalizationVersion",
  "action",
  "viewId",
  "actorId",
  "sessionId",
  "organizationId",
  "projectId",
  "expectedViewRevision",
  "expectedScheduleRevision",
  "baseConfigHash",
  "desiredConfigHash",
  "baseConfiguration",
  "desiredConfiguration",
  "operationWindowId",
  "operationId",
  "issuedAt",
  "expiresAt",
] as const;
function versions(
  source: Record<string, unknown>,
  kind: string,
  path: string,
  d: Diagnostics,
): void {
  for (const key of [
    "schemaVersion",
    "protocolVersion",
    "projectionVersion",
    "normalizationVersion",
  ])
    if (source[key] !== 1)
      d.add(
        "UNSUPPORTED_VERSION",
        childPath(path, key),
        "Unsupported Planner view protocol version.",
      );
  if (source.kind !== kind)
    d.add("INVALID_VALUE", childPath(path, "kind"), "Unsupported document kind.");
}
function review(value: unknown, path: string, d: Diagnostics): PlannerViewReviewV1 | null {
  const source = record(value, path, reviewFields, d);
  if (!source) return null;
  versions(source, "engineo-planner-view-review", path, d);
  const operation = action(source.action, childPath(path, "action"), d);
  const viewId = source.viewId === null ? null : uuid(source.viewId, childPath(path, "viewId"), d);
  const actorId = uuid(source.actorId, childPath(path, "actorId"), d);
  const sessionId = uuid(source.sessionId, childPath(path, "sessionId"), d);
  const organizationId = uuid(source.organizationId, childPath(path, "organizationId"), d);
  const projectId = uuid(source.projectId, childPath(path, "projectId"), d);
  const expectedViewRevision = revision(
    source.expectedViewRevision,
    childPath(path, "expectedViewRevision"),
    d,
  );
  const expectedScheduleRevision = revision(
    source.expectedScheduleRevision,
    childPath(path, "expectedScheduleRevision"),
    d,
    1,
  );
  const baseConfigHash =
    source.baseConfigHash === null
      ? null
      : hash(source.baseConfigHash, childPath(path, "baseConfigHash"), d);
  const desiredConfigHash =
    source.desiredConfigHash === null
      ? null
      : hash(source.desiredConfigHash, childPath(path, "desiredConfigHash"), d);
  const baseConfiguration =
    source.baseConfiguration === null
      ? null
      : configuration(source.baseConfiguration, childPath(path, "baseConfiguration"), d);
  const desiredConfiguration =
    source.desiredConfiguration === null
      ? null
      : configuration(source.desiredConfiguration, childPath(path, "desiredConfiguration"), d);
  const operationWindowId = windowId(
    source.operationWindowId,
    childPath(path, "operationWindowId"),
    d,
  );
  const operationId = uuid(source.operationId, childPath(path, "operationId"), d);
  const issuedAt = timestamp(source.issuedAt, childPath(path, "issuedAt"), d);
  const expiresAt = timestamp(source.expiresAt, childPath(path, "expiresAt"), d);
  if (
    operation === "create" &&
    (source.viewId !== null ||
      expectedViewRevision !== 0 ||
      source.baseConfigHash !== null ||
      source.baseConfiguration !== null)
  )
    d.add("INVALID_VALUE", path, "Create review must have no prior view or configuration.");
  if (
    (operation === "update" || operation === "delete") &&
    (!viewId || !expectedViewRevision || !baseConfigHash || !baseConfiguration)
  )
    d.add(
      "INVALID_VALUE",
      path,
      "Existing-view review requires its exact revision and base configuration.",
    );
  if (
    operation === "delete"
      ? source.desiredConfigHash !== null || source.desiredConfiguration !== null
      : !desiredConfigHash || !desiredConfiguration
  )
    d.add("INVALID_VALUE", path, "Desired configuration does not match the view action.");
  if (issuedAt && expiresAt && operationWindowId) {
    const issued = Date.parse(issuedAt);
    const expiry = Date.parse(expiresAt);
    const close = Date.parse(`${operationWindowId}T00:00:00.000Z`) + UTC_DAY_MS;
    if (
      issuedAt.slice(0, 10) !== operationWindowId ||
      expiry <= issued ||
      expiry > issued + PLANNER_VIEW_MAX_REVIEW_AGE_MS ||
      expiry > close
    )
      d.add("INVALID_VALUE", path, "Review times exceed the operation window or review lifetime.");
  }
  if (
    !operation ||
    !actorId ||
    !sessionId ||
    !organizationId ||
    !projectId ||
    expectedViewRevision === null ||
    expectedScheduleRevision === null ||
    !operationWindowId ||
    !operationId ||
    !issuedAt ||
    !expiresAt
  )
    return null;
  const normalized: PlannerViewReviewV1 = {
    schemaVersion: 1,
    kind: "engineo-planner-view-review",
    protocolVersion: 1,
    projectionVersion: PLANNER_VIEW_PROJECTION_VERSION,
    normalizationVersion: PLANNER_VIEW_NORMALIZATION_VERSION,
    action: operation,
    viewId,
    actorId,
    sessionId,
    organizationId,
    projectId,
    expectedViewRevision,
    expectedScheduleRevision,
    baseConfigHash,
    desiredConfigHash,
    baseConfiguration,
    desiredConfiguration,
    operationWindowId,
    operationId,
    issuedAt,
    expiresAt,
  };
  if (bytes(JSON.stringify(normalized)) > PLANNER_VIEW_MAX_OPERATION_BYTES)
    d.add("TRANSPORT_TOO_LARGE", path, "Review exceeds its UTF-8 byte limit.");
  return normalized;
}
export function validatePlannerViewReviewV1(
  value: unknown,
): PlannerViewOperationValidationV1<PlannerViewReviewV1> {
  const d = new Diagnostics();
  return result(review(value, "", d), d);
}
export function parsePlannerViewReviewV1(
  source: string | Uint8Array,
): PlannerViewOperationValidationV1<PlannerViewReviewV1> {
  return parsed(source, validatePlannerViewReviewV1);
}
export function validatePlannerViewApplyRequestV1(
  value: unknown,
): PlannerViewOperationValidationV1<PlannerViewApplyRequestV1> {
  const d = new Diagnostics();
  const source = record(value, "", ["review", "reviewedDigest"], d);
  if (!source) return result(null, d);
  const normalizedReview = review(source.review, "review", d);
  const reviewedDigest = hash(source.reviewedDigest, "reviewedDigest", d);
  return result(
    normalizedReview && reviewedDigest ? { review: normalizedReview, reviewedDigest } : null,
    d,
  );
}
export function parsePlannerViewApplyRequestV1(
  source: string | Uint8Array,
): PlannerViewOperationValidationV1<PlannerViewApplyRequestV1> {
  return parsed(source, validatePlannerViewApplyRequestV1);
}
export function serializePlannerViewReviewV1(value: PlannerViewReviewV1): string {
  const validated = validatePlannerViewReviewV1(value);
  if (!validated.valid) throw new PlannerViewOperationsError(validated.diagnostics);
  return JSON.stringify(validated.value);
}
export function serializePlannerViewReviewHashPreimageV1(value: PlannerViewReviewV1): string {
  return `{"kind":"engineo-planner-view-review-v1-canonical","review":${serializePlannerViewReviewV1(value)}}`;
}
/** SHA-256 of exact UTF-8 preimage, supplied by the Node/browser runtime. */
export type PlannerViewHashV1 = (preimage: string) => string;
export function calculatePlannerViewConfigurationHashV1(
  value: PlannerViewConfigurationV1,
  sha256: PlannerViewHashV1,
): string {
  const validated = validatePlannerViewConfigurationV1(value);
  if (!validated.valid) {
    const diagnostics = new Diagnostics();
    for (const issue of validated.diagnostics.issues)
      diagnostics.add(
        issue.code,
        configurationPaths.has(issue.path) ? issue.path : "",
        issue.message,
      );
    diagnostics.totalCount +=
      validated.diagnostics.totalCount - validated.diagnostics.issues.length;
    throw new PlannerViewOperationsError(diagnostics.result());
  }
  const digest = sha256(validated.hashPreimage);
  if (!hashPattern.test(digest))
    fail("INVALID_VALUE", "", "Hash callback did not return a lowercase SHA-256 digest.");
  return digest;
}
export function calculatePlannerViewReviewDigestV1(
  value: PlannerViewReviewV1,
  sha256: PlannerViewHashV1,
): string {
  const digest = sha256(serializePlannerViewReviewHashPreimageV1(value));
  if (!hashPattern.test(digest))
    fail("INVALID_VALUE", "", "Hash callback did not return a lowercase SHA-256 digest.");
  return digest;
}
export type PlannerViewReviewVerificationV1 =
  | { valid: true }
  | {
      valid: false;
      reason:
        | "view_review_changed"
        | "session_changed"
        | "view_review_expired"
        | "view_operation_window_closed"
        | "view_base_changed";
    };
/** Syntactic/hash consistency only; safe before a retained replay lookup. This grants no access. */
export function verifyPlannerViewReviewDigestV1(
  value: unknown,
  reviewedDigest: string,
  sha256: PlannerViewHashV1,
): PlannerViewReviewVerificationV1 {
  const validated = validatePlannerViewReviewV1(value);
  if (!validated.valid || !hashPattern.test(reviewedDigest))
    return { valid: false, reason: "view_review_changed" };
  const config = validated.value;
  if (
    (config.baseConfiguration &&
      calculatePlannerViewConfigurationHashV1(config.baseConfiguration, sha256) !==
        config.baseConfigHash) ||
    (config.desiredConfiguration &&
      calculatePlannerViewConfigurationHashV1(config.desiredConfiguration, sha256) !==
        config.desiredConfigHash) ||
    calculatePlannerViewReviewDigestV1(config, sha256) !== reviewedDigest
  )
    return { valid: false, reason: "view_review_changed" };
  return { valid: true };
}
export interface PlannerViewReviewBindingV1 {
  actorId: string;
  sessionId: string;
  organizationId: string;
  projectId: string;
}
/** Caller must independently authenticate and reauthorize project.read/private-view ownership. */
export function verifyPlannerViewReviewBindingV1(
  value: PlannerViewReviewV1,
  binding: PlannerViewReviewBindingV1,
): PlannerViewReviewVerificationV1 {
  const checked = validatePlannerViewReviewV1(value);
  if (!checked.valid) return { valid: false, reason: "view_review_changed" };
  for (const key of ["actorId", "sessionId", "organizationId", "projectId"] as const)
    if (!uuidPattern.test(binding[key]) || checked.value[key] !== binding[key].toLowerCase())
      return { valid: false, reason: "session_changed" };
  return { valid: true };
}
export interface PlannerViewReviewTimeContextV1 {
  now: string;
  sessionExpiresAt: string;
}
/** For NEW admission only. Exact retained replay still needs current live auth/session/scope. */
export function verifyPlannerViewReviewTimeV1(
  value: PlannerViewReviewV1,
  context: PlannerViewReviewTimeContextV1,
): PlannerViewReviewVerificationV1 {
  const checked = validatePlannerViewReviewV1(value);
  if (!checked.valid || !instant(context.now) || !instant(context.sessionExpiresAt))
    return { valid: false, reason: "view_review_changed" };
  const now = Date.parse(context.now);
  const issued = Date.parse(checked.value.issuedAt);
  const expiry = Date.parse(checked.value.expiresAt);
  const sessionExpiry = Date.parse(context.sessionExpiresAt);
  if (now >= sessionExpiry || expiry > sessionExpiry)
    return { valid: false, reason: "session_changed" };
  if (context.now.slice(0, 10) !== checked.value.operationWindowId)
    return { valid: false, reason: "view_operation_window_closed" };
  if (issued > now) return { valid: false, reason: "view_review_changed" };
  if (now >= expiry) return { valid: false, reason: "view_review_expired" };
  return { valid: true };
}
export interface PlannerViewReviewCurrentBaseV1 {
  viewId: string | null;
  viewRevision: number;
  scheduleRevision: number;
  configHash: string | null;
}
export function verifyPlannerViewReviewBaseV1(
  value: PlannerViewReviewV1,
  base: PlannerViewReviewCurrentBaseV1,
): PlannerViewReviewVerificationV1 {
  const checked = validatePlannerViewReviewV1(value);
  if (!checked.valid) return { valid: false, reason: "view_review_changed" };
  if (
    checked.value.viewId !== base.viewId ||
    checked.value.expectedViewRevision !== base.viewRevision ||
    checked.value.expectedScheduleRevision !== base.scheduleRevision ||
    checked.value.baseConfigHash !== base.configHash
  )
    return { valid: false, reason: "view_base_changed" };
  return { valid: true };
}
export function verifyPlannerViewReviewV1(
  value: PlannerViewReviewV1,
  reviewedDigest: string,
  context: PlannerViewReviewBindingV1 &
    PlannerViewReviewTimeContextV1 &
    PlannerViewReviewCurrentBaseV1,
  sha256: PlannerViewHashV1,
): PlannerViewReviewVerificationV1 {
  for (const check of [
    () => verifyPlannerViewReviewDigestV1(value, reviewedDigest, sha256),
    () => verifyPlannerViewReviewBindingV1(value, context),
    () => verifyPlannerViewReviewTimeV1(value, context),
    () => verifyPlannerViewReviewBaseV1(value, context),
  ]) {
    const verification = check();
    if (!verification.valid) return verification;
  }
  return { valid: true };
}
export interface PlannerViewOperationWindowV1 {
  operationWindowId: string;
  opensAt: string;
  closesAt: string;
  replayUntil: string;
}
export function plannerViewOperationWindowV1(now: string): PlannerViewOperationWindowV1 {
  if (!instant(now)) fail("INVALID_VALUE", "", "Expected a canonical server UTC timestamp.");
  const operationWindowId = now.slice(0, 10);
  if (!supportedWindowId(operationWindowId))
    fail("INVALID_VALUE", "", "Operation window exceeds the supported timestamp range.");
  const opensAt = `${operationWindowId}T00:00:00.000Z`;
  const close = Date.parse(opensAt) + UTC_DAY_MS;
  return {
    operationWindowId,
    opensAt,
    closesAt: new Date(close).toISOString(),
    replayUntil: new Date(close + PLANNER_VIEW_RECEIPT_RETENTION_AFTER_CLOSE_MS).toISOString(),
  };
}
/** Server constructs times; cap by 15 minutes, live session expiry and UTC-day close. */
export function plannerViewReviewTimesV1(context: PlannerViewReviewTimeContextV1): {
  operationWindowId: string;
  issuedAt: string;
  expiresAt: string;
} {
  if (!instant(context.now) || !instant(context.sessionExpiresAt))
    fail("INVALID_VALUE", "", "Expected canonical server/session timestamps.");
  const window = plannerViewOperationWindowV1(context.now);
  const issued = Date.parse(context.now);
  const expiry = Math.min(
    issued + PLANNER_VIEW_MAX_REVIEW_AGE_MS,
    Date.parse(context.sessionExpiresAt),
    Date.parse(window.closesAt),
  );
  if (expiry <= issued) fail("INVALID_VALUE", "", "Session must be live when issuing a review.");
  return {
    operationWindowId: window.operationWindowId,
    issuedAt: context.now,
    expiresAt: new Date(expiry).toISOString(),
  };
}
const receiptFields = [
  "schemaVersion",
  "kind",
  "protocolVersion",
  "projectionVersion",
  "normalizationVersion",
  "action",
  "outcome",
  "viewId",
  "actorId",
  "sessionId",
  "organizationId",
  "projectId",
  "previousViewRevision",
  "committedViewRevision",
  "expectedScheduleRevision",
  "baseConfigHash",
  "desiredConfigHash",
  "operationWindowId",
  "operationId",
  "reviewedDigest",
  "auditId",
  "recordedAt",
] as const;
export function validatePlannerViewReceiptV1(
  value: unknown,
): PlannerViewOperationValidationV1<PlannerViewReceiptV1> {
  const d = new Diagnostics();
  const source = record(value, "", receiptFields, d);
  if (!source) return result(null, d);
  versions(source, "engineo-planner-view-receipt", "", d);
  const operation = action(source.action, "action", d);
  const outcome =
    source.outcome === "applied" || source.outcome === "no_op" || source.outcome === "deleted"
      ? source.outcome
      : null;
  if (!outcome) d.add("INVALID_VALUE", "outcome", "Unsupported receipt outcome.");
  const viewId = uuid(source.viewId, "viewId", d);
  const actorId = uuid(source.actorId, "actorId", d);
  const sessionId = uuid(source.sessionId, "sessionId", d);
  const organizationId = uuid(source.organizationId, "organizationId", d);
  const projectId = uuid(source.projectId, "projectId", d);
  const previousViewRevision = revision(source.previousViewRevision, "previousViewRevision", d);
  const committedViewRevision =
    source.committedViewRevision === null
      ? null
      : revision(source.committedViewRevision, "committedViewRevision", d, 1);
  const expectedScheduleRevision = revision(
    source.expectedScheduleRevision,
    "expectedScheduleRevision",
    d,
    1,
  );
  const baseConfigHash =
    source.baseConfigHash === null ? null : hash(source.baseConfigHash, "baseConfigHash", d);
  const desiredConfigHash =
    source.desiredConfigHash === null
      ? null
      : hash(source.desiredConfigHash, "desiredConfigHash", d);
  const operationWindowId = windowId(source.operationWindowId, "operationWindowId", d);
  const operationId = uuid(source.operationId, "operationId", d);
  const reviewedDigest = hash(source.reviewedDigest, "reviewedDigest", d);
  const auditId = uuid(source.auditId, "auditId", d);
  const recordedAt = timestamp(source.recordedAt, "recordedAt", d);
  if (
    operation === "create" &&
    (previousViewRevision !== 0 ||
      committedViewRevision !== 1 ||
      source.baseConfigHash !== null ||
      !desiredConfigHash ||
      outcome !== "applied")
  )
    d.add("INVALID_VALUE", "", "Create receipt has inconsistent revisions or outcome.");
  if (
    operation === "update" &&
    (!previousViewRevision ||
      !baseConfigHash ||
      !desiredConfigHash ||
      (outcome !== "applied" && outcome !== "no_op") ||
      committedViewRevision !== previousViewRevision + (outcome === "no_op" ? 0 : 1) ||
      (outcome === "no_op") !== (baseConfigHash === desiredConfigHash))
  )
    d.add("INVALID_VALUE", "", "Update receipt has inconsistent revisions or outcome.");
  if (
    operation === "delete" &&
    (!previousViewRevision ||
      !baseConfigHash ||
      source.desiredConfigHash !== null ||
      source.committedViewRevision !== null ||
      outcome !== "deleted")
  )
    d.add("INVALID_VALUE", "", "Delete receipt has inconsistent revisions or outcome.");
  if (recordedAt && operationWindowId && recordedAt.slice(0, 10) !== operationWindowId)
    d.add("INVALID_VALUE", "recordedAt", "Receipt was not recorded in its operation window.");
  if (
    !operation ||
    !outcome ||
    !viewId ||
    !actorId ||
    !sessionId ||
    !organizationId ||
    !projectId ||
    previousViewRevision === null ||
    expectedScheduleRevision === null ||
    !operationWindowId ||
    !operationId ||
    !reviewedDigest ||
    !auditId ||
    !recordedAt
  )
    return result(null, d);
  const receipt: PlannerViewReceiptV1 = {
    schemaVersion: 1,
    kind: "engineo-planner-view-receipt",
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    action: operation,
    outcome,
    viewId,
    actorId,
    sessionId,
    organizationId,
    projectId,
    previousViewRevision,
    committedViewRevision,
    expectedScheduleRevision,
    baseConfigHash,
    desiredConfigHash,
    operationWindowId,
    operationId,
    reviewedDigest,
    auditId,
    recordedAt,
  };
  if (bytes(JSON.stringify(receipt)) > PLANNER_VIEW_MAX_RECEIPT_BYTES)
    d.add("TRANSPORT_TOO_LARGE", "", "Receipt exceeds the 2 KiB UTF-8 limit.");
  return result(receipt, d);
}
export function parsePlannerViewReceiptV1(
  source: string | Uint8Array,
): PlannerViewOperationValidationV1<PlannerViewReceiptV1> {
  return parsed(source, validatePlannerViewReceiptV1, PLANNER_VIEW_MAX_RECEIPT_BYTES);
}
export function serializePlannerViewReceiptV1(value: PlannerViewReceiptV1): string {
  const checked = validatePlannerViewReceiptV1(value);
  if (!checked.valid) throw new PlannerViewOperationsError(checked.diagnostics);
  return JSON.stringify(checked.value);
}
/** Historical receipt consistency only; independently verify the reviewed digest and live access. */
export function verifyPlannerViewReceiptBindingV1(
  value: unknown,
  reviewValue: PlannerViewReviewV1,
  reviewedDigest: string,
): boolean {
  const receipt = validatePlannerViewReceiptV1(value);
  const checkedReview = validatePlannerViewReviewV1(reviewValue);
  if (!receipt.valid || !checkedReview.valid || !hashPattern.test(reviewedDigest)) return false;
  const record = receipt.value;
  const bound = checkedReview.value;
  for (const key of [
    "actorId",
    "sessionId",
    "organizationId",
    "projectId",
    "action",
    "expectedScheduleRevision",
    "baseConfigHash",
    "desiredConfigHash",
    "operationWindowId",
    "operationId",
  ] as const)
    if (record[key] !== bound[key]) return false;
  return (
    record.reviewedDigest === reviewedDigest &&
    record.previousViewRevision === bound.expectedViewRevision &&
    (bound.viewId === null || record.viewId === bound.viewId) &&
    Date.parse(record.recordedAt) >= Date.parse(bound.issuedAt) &&
    Date.parse(record.recordedAt) < Date.parse(bound.expiresAt)
  );
}
