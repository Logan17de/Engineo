/** Inert, private presentation configuration. This is not an engine input or a saved-view API. */
export const PLANNER_VIEW_SCHEMA_VERSION = 1 as const;
export const PLANNER_VIEW_PROJECTION_VERSION = 1 as const;
export const PLANNER_VIEW_NORMALIZATION_VERSION = 1 as const;
export const PLANNER_VIEW_MAX_BYTES = 8 * 1024;
export const PLANNER_VIEW_MAX_DEPTH = 8;
export const PLANNER_VIEW_MAX_DIAGNOSTICS = 20;
export const PLANNER_VIEW_MAX_DIAGNOSTIC_TEXT_LENGTH = 256;
export const PLANNER_VIEW_MAX_NAME_LENGTH = 120;
export const PLANNER_VIEW_MAX_NAME_BYTES = 512;
export const PLANNER_VIEW_MAX_SEARCH_LENGTH = 256;
export const PLANNER_VIEW_MAX_SEARCH_BYTES = 1024;

export interface PlannerPresentationV1 {
  search: string;
  kind: "all" | "TASK" | "START_MILESTONE" | "FINISH_MILESTONE";
  wbsId: string | null;
  critical: "all" | "critical" | "noncritical";
  sort: {
    field: "native" | "name" | "durationMinutes" | "earlyStart" | "totalFloatMinutes";
    direction: "asc" | "desc";
  };
  groupBy: "none" | "wbs";
}

export interface PlannerViewConfigurationV1 {
  schemaVersion: 1;
  kind: "engineo-planner-view";
  name: string;
  visibility: "private";
  presentation: PlannerPresentationV1;
}

/** Both containers are frozen. Native order always comes from the native snapshot. */
export const NATIVE_PLANNER_PRESENTATION_V1: PlannerPresentationV1 = Object.freeze({
  search: "",
  kind: "all",
  wbsId: null,
  critical: "all",
  sort: Object.freeze({ field: "native", direction: "asc" }),
  groupBy: "none",
});

export type PlannerViewIssueCodeV1 =
  | "INVALID_JSON"
  | "INVALID_UTF8"
  | "DUPLICATE_JSON_KEY"
  | "UNSAFE_PROPERTY"
  | "UNKNOWN_PROPERTY"
  | "MISSING_PROPERTY"
  | "INVALID_VALUE"
  | "UNSUPPORTED_VERSION"
  | "MAX_DEPTH_EXCEEDED"
  | "TRANSPORT_TOO_LARGE";

export interface PlannerViewIssueV1 {
  code: PlannerViewIssueCodeV1;
  path: string;
  message: string;
}

export interface PlannerViewDiagnosticsV1 {
  issues: PlannerViewIssueV1[];
  totalCount: number;
  truncated: boolean;
}

export type PlannerPresentationValidationV1 =
  | {
      valid: true;
      normalizedPresentation: PlannerPresentationV1;
      diagnostics: PlannerViewDiagnosticsV1;
    }
  | { valid: false; diagnostics: PlannerViewDiagnosticsV1 };

export type PlannerViewConfigurationValidationV1 =
  | {
      valid: true;
      normalizedConfiguration: PlannerViewConfigurationV1;
      /** Compact fixed-order configuration JSON, without a newline. */
      canonicalConfiguration: string;
      /** Hash these UTF-8 bytes in the caller's runtime; this module performs no hashing. */
      hashPreimage: string;
      diagnostics: PlannerViewDiagnosticsV1;
    }
  | { valid: false; diagnostics: PlannerViewDiagnosticsV1 };

export class PlannerViewConfigurationError extends Error {
  readonly code: PlannerViewIssueCodeV1;

  constructor(public readonly diagnostics: PlannerViewDiagnosticsV1) {
    super(diagnostics.issues[0]?.message ?? "Invalid Planner view configuration.");
    this.name = "PlannerViewConfigurationError";
    this.code = diagnostics.issues[0]?.code ?? "INVALID_VALUE";
  }
}

function diagnosticText(value: string): string {
  if (value.length <= PLANNER_VIEW_MAX_DIAGNOSTIC_TEXT_LENGTH) return value;
  let prefix = value.slice(0, PLANNER_VIEW_MAX_DIAGNOSTIC_TEXT_LENGTH - 3);
  if (!prefix.isWellFormed()) prefix = prefix.slice(0, -1);
  return `${prefix}...`;
}

class Diagnostics {
  readonly issues: PlannerViewIssueV1[] = [];
  totalCount = 0;

  add(code: PlannerViewIssueCodeV1, path: string, message: string): void {
    this.totalCount++;
    if (this.issues.length < PLANNER_VIEW_MAX_DIAGNOSTICS)
      this.issues.push({ code, path: diagnosticText(path), message: diagnosticText(message) });
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
  throw new PlannerViewConfigurationError(diagnostics.result());
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function originalByteLength(value: Uint8Array): number {
  // The intrinsic reads the internal view length, not a subclass/own byteLength getter.
  const getter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    "byteLength",
  )?.get;
  if (!getter) fail("INVALID_VALUE", "", "UTF-8 byte array could not be inspected safely.");
  try {
    return getter.call(value) as number;
  } catch {
    return fail("INVALID_VALUE", "", "UTF-8 byte array could not be inspected safely.");
  }
}

function childPath(parent: string, key: string): string {
  return /^[A-Za-z][A-Za-z0-9]*$/.test(key)
    ? `${parent ? `${parent}.` : ""}${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function unsafeKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

/**
 * A separate bounded lexer preserves original numeric spelling and decoded keys.
 * It never delegates object parsing to JSON.parse, invokes user code, or resolves resources.
 */
function parseJson(source: string): unknown {
  let offset = 0;
  const whitespace = (): void => {
    while (offset < source.length && /[\t\n\r ]/.test(source[offset] ?? "")) offset++;
  };
  const invalid = (path: string): never =>
    fail("INVALID_JSON", path, `Malformed JSON at character ${offset}.`);
  const string = (path: string): string => {
    offset++;
    let result = "";
    while (offset < source.length) {
      const char = source[offset++];
      if (char === '"') {
        if (!result.isWellFormed()) return invalid(path);
        return result;
      }
      if (char === "\\") {
        const escaped = source[offset++];
        if (escaped === "u") {
          const hex = source.slice(offset, offset + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return invalid(path);
          result += String.fromCharCode(Number.parseInt(hex, 16));
          offset += 4;
        } else {
          switch (escaped) {
            case '"':
            case "\\":
            case "/":
              result += escaped;
              break;
            case "b":
              result += "\b";
              break;
            case "f":
              result += "\f";
              break;
            case "n":
              result += "\n";
              break;
            case "r":
              result += "\r";
              break;
            case "t":
              result += "\t";
              break;
            default:
              return invalid(path);
          }
        }
      } else {
        if (char === undefined || char.charCodeAt(0) < 0x20) return invalid(path);
        result += char;
      }
    }
    return invalid(path);
  };
  const value = (depth: number, path: string): unknown => {
    whitespace();
    const char = source[offset];
    if (char === "{" || char === "[") {
      if (depth > PLANNER_VIEW_MAX_DEPTH)
        fail("MAX_DEPTH_EXCEEDED", path, "JSON nesting exceeds 8 containers.");
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
          if (unsafeKey(key))
            fail("UNSAFE_PROPERTY", nextPath, "Prototype-related properties are not allowed.");
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
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(offset));
    if (!match) return invalid(path);
    const token = match[0];
    offset += token.length;
    // V1 has only an integer version field. No exponent, fraction, negative zero or rounding.
    if (!/^-?(?:0|[1-9]\d*)$/.test(token) || token === "-0") return invalid(path);
    const number = Number(token);
    if (!Number.isSafeInteger(number)) return invalid(path);
    return number;
  };
  const result = value(1, "");
  whitespace();
  if (offset !== source.length) invalid("");
  return result;
}

/** Inspect data descriptors only: getters, setters and nonplain containers are never accepted. */
function record(
  value: unknown,
  path: string,
  fields: readonly string[],
  diagnostics: Diagnostics,
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    diagnostics.add("INVALID_VALUE", path, "Expected a plain object.");
    return null;
  }
  let descriptors: ReturnType<typeof Object.getOwnPropertyDescriptors>;
  try {
    if (Array.isArray(value)) {
      diagnostics.add("INVALID_VALUE", path, "Expected a plain object.");
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      diagnostics.add("INVALID_VALUE", path, "Expected a plain object.");
      return null;
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    diagnostics.add("INVALID_VALUE", path, "Object properties could not be inspected safely.");
    return null;
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      diagnostics.add("UNKNOWN_PROPERTY", path, "Symbol properties are not allowed.");
      continue;
    }
    const nextPath = childPath(path, key);
    const descriptor = descriptors[key];
    if (unsafeKey(key)) {
      diagnostics.add("UNSAFE_PROPERTY", nextPath, "Prototype-related properties are not allowed.");
      continue;
    }
    if (!fields.includes(key))
      diagnostics.add("UNKNOWN_PROPERTY", nextPath, "Unknown property is not allowed.");
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
      diagnostics.add("INVALID_VALUE", nextPath, "Expected an enumerable data property.");
      continue;
    }
    result[key] = descriptor.value;
  }
  for (const field of fields) {
    if (!Object.hasOwn(result, field))
      diagnostics.add("MISSING_PROPERTY", childPath(path, field), "Required property is missing.");
  }
  return result;
}

function enumeration<T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
  diagnostics: Diagnostics,
): T | null {
  if (typeof value === "string" && values.includes(value as T)) return value as T;
  diagnostics.add("INVALID_VALUE", path, "Unsupported value.");
  return null;
}

/**
 * Normalization v1 uses ECMAScript trim, with no NFC/case folding or interior rewriting.
 * Name rejects every C0/C1 control. Search allows literal HT/LF/CR as ordinary whitespace,
 * trims them at the edges, preserves them inside the string, and rejects other C0/C1 controls.
 * Bounds apply to the original field before trimming as well as the normalized result.
 */
function text(
  value: unknown,
  path: string,
  maxLength: number,
  maxBytes: number,
  search: boolean,
  diagnostics: Diagnostics,
): string | null {
  if (typeof value !== "string" || !value.isWellFormed()) {
    diagnostics.add("INVALID_VALUE", path, "Expected a well-formed Unicode string.");
    return null;
  }
  if (value.length > maxLength || byteLength(value) > maxBytes) {
    diagnostics.add("INVALID_VALUE", path, "String exceeds its length or UTF-8 byte limit.");
    return null;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    const ordinaryWhitespace = search && (code === 9 || code === 10 || code === 13);
    if (!ordinaryWhitespace && (code < 0x20 || (code >= 0x7f && code <= 0x9f))) {
      diagnostics.add("INVALID_VALUE", path, "Control characters are not allowed.");
      return null;
    }
  }
  const result = value.trim();
  if (!search && (result.length === 0 || result.toLowerCase() === "native")) {
    diagnostics.add(
      "INVALID_VALUE",
      path,
      "Name is empty or reserved for the built-in Native view.",
    );
    return null;
  }
  return result;
}

function presentation(
  value: unknown,
  path: string,
  diagnostics: Diagnostics,
): PlannerPresentationV1 | null {
  const source = record(
    value,
    path,
    ["search", "kind", "wbsId", "critical", "sort", "groupBy"],
    diagnostics,
  );
  if (!source) return null;
  const search = text(
    source.search,
    childPath(path, "search"),
    PLANNER_VIEW_MAX_SEARCH_LENGTH,
    PLANNER_VIEW_MAX_SEARCH_BYTES,
    true,
    diagnostics,
  );
  const kind = enumeration(
    source.kind,
    childPath(path, "kind"),
    ["all", "TASK", "START_MILESTONE", "FINISH_MILESTONE"],
    diagnostics,
  );
  let wbsId: string | null = null;
  if (source.wbsId !== null) {
    if (
      typeof source.wbsId === "string" &&
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        source.wbsId,
      )
    )
      wbsId = source.wbsId.toLowerCase();
    else diagnostics.add("INVALID_VALUE", childPath(path, "wbsId"), "Expected a UUID or null.");
  }
  const critical = enumeration(
    source.critical,
    childPath(path, "critical"),
    ["all", "critical", "noncritical"],
    diagnostics,
  );
  const sort = record(source.sort, childPath(path, "sort"), ["field", "direction"], diagnostics);
  let field: PlannerPresentationV1["sort"]["field"] | null = null;
  let direction: PlannerPresentationV1["sort"]["direction"] | null = null;
  if (sort) {
    field = enumeration(
      sort.field,
      childPath(childPath(path, "sort"), "field"),
      ["native", "name", "durationMinutes", "earlyStart", "totalFloatMinutes"],
      diagnostics,
    );
    direction = enumeration(
      sort.direction,
      childPath(childPath(path, "sort"), "direction"),
      ["asc", "desc"],
      diagnostics,
    );
    if (field === "native" && direction === "desc")
      diagnostics.add(
        "INVALID_VALUE",
        childPath(childPath(path, "sort"), "direction"),
        "Native sorting supports ascending direction only.",
      );
  }
  const groupBy = enumeration(
    source.groupBy,
    childPath(path, "groupBy"),
    ["none", "wbs"],
    diagnostics,
  );
  if (
    search === null ||
    kind === null ||
    critical === null ||
    field === null ||
    direction === null ||
    groupBy === null
  )
    return null;
  return { search, kind, wbsId, critical, sort: { field, direction }, groupBy };
}

export function validatePlannerPresentationV1(value: unknown): PlannerPresentationValidationV1 {
  const diagnostics = new Diagnostics();
  const normalizedPresentation = presentation(value, "", diagnostics);
  if (diagnostics.totalCount > 0 || !normalizedPresentation)
    return { valid: false, diagnostics: diagnostics.result() };
  return { valid: true, normalizedPresentation, diagnostics: diagnostics.result() };
}

function hashPreimage(configuration: PlannerViewConfigurationV1): string {
  return JSON.stringify({
    kind: "engineo-planner-view-v1-canonical",
    projectionVersion: PLANNER_VIEW_PROJECTION_VERSION,
    normalizationVersion: PLANNER_VIEW_NORMALIZATION_VERSION,
    configuration,
  });
}

/** Shape/normalization only. This does not validate WBS scope, ownership or calculation availability. */
export function validatePlannerViewConfigurationV1(
  value: unknown,
): PlannerViewConfigurationValidationV1 {
  const diagnostics = new Diagnostics();
  const source = record(
    value,
    "",
    ["schemaVersion", "kind", "name", "visibility", "presentation"],
    diagnostics,
  );
  if (!source) return { valid: false, diagnostics: diagnostics.result() };
  if (source.schemaVersion !== PLANNER_VIEW_SCHEMA_VERSION)
    diagnostics.add(
      "UNSUPPORTED_VERSION",
      "schemaVersion",
      "Unsupported Planner view schema version.",
    );
  enumeration(source.kind, "kind", ["engineo-planner-view"], diagnostics);
  const name = text(
    source.name,
    "name",
    PLANNER_VIEW_MAX_NAME_LENGTH,
    PLANNER_VIEW_MAX_NAME_BYTES,
    false,
    diagnostics,
  );
  enumeration(source.visibility, "visibility", ["private"], diagnostics);
  const normalizedPresentation = presentation(source.presentation, "presentation", diagnostics);
  if (diagnostics.totalCount > 0 || name === null || !normalizedPresentation)
    return { valid: false, diagnostics: diagnostics.result() };
  const normalizedConfiguration: PlannerViewConfigurationV1 = {
    schemaVersion: PLANNER_VIEW_SCHEMA_VERSION,
    kind: "engineo-planner-view",
    name,
    visibility: "private",
    presentation: normalizedPresentation,
  };
  const canonicalConfiguration = JSON.stringify(normalizedConfiguration);
  if (byteLength(canonicalConfiguration) > PLANNER_VIEW_MAX_BYTES) {
    diagnostics.add("TRANSPORT_TOO_LARGE", "", "Configuration exceeds the 8 KiB UTF-8 limit.");
    return { valid: false, diagnostics: diagnostics.result() };
  }
  return {
    valid: true,
    normalizedConfiguration,
    canonicalConfiguration,
    hashPreimage: hashPreimage(normalizedConfiguration),
    diagnostics: diagnostics.result(),
  };
}

/** Strict original UTF-8 transport parser. The byte limit includes whitespace and JSON escapes. */
export function parsePlannerViewConfigurationV1(
  source: string | Uint8Array,
): PlannerViewConfigurationValidationV1 {
  try {
    let decoded: string;
    if (typeof source === "string") {
      if (source.length > PLANNER_VIEW_MAX_BYTES)
        fail("TRANSPORT_TOO_LARGE", "", "Configuration exceeds the 8 KiB UTF-8 limit.");
      if (!source.isWellFormed()) fail("INVALID_JSON", "", "JSON contains invalid Unicode.");
      if (byteLength(source) > PLANNER_VIEW_MAX_BYTES)
        fail("TRANSPORT_TOO_LARGE", "", "Configuration exceeds the 8 KiB UTF-8 limit.");
      decoded = source;
    } else if (ArrayBuffer.isView(source) && source instanceof Uint8Array) {
      if (originalByteLength(source) > PLANNER_VIEW_MAX_BYTES)
        fail("TRANSPORT_TOO_LARGE", "", "Configuration exceeds the 8 KiB UTF-8 limit.");
      try {
        // Preserve a leading BOM so it is rejected by the JSON grammar, rather than removed.
        decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source);
      } catch {
        fail("INVALID_UTF8", "", "Configuration contains malformed UTF-8.");
      }
    } else {
      fail("INVALID_VALUE", "", "Expected a JSON string or UTF-8 byte array.");
    }
    return validatePlannerViewConfigurationV1(parseJson(decoded));
  } catch (error) {
    if (error instanceof PlannerViewConfigurationError)
      return { valid: false, diagnostics: error.diagnostics };
    throw error;
  }
}

export function serializePlannerViewConfigurationV1(
  configuration: PlannerViewConfigurationV1,
): string {
  const result = validatePlannerViewConfigurationV1(configuration);
  if (!result.valid) throw new PlannerViewConfigurationError(result.diagnostics);
  return result.canonicalConfiguration;
}

/** Versions are protocol constants outside user-authored configuration, never injected into it. */
export function serializePlannerViewHashPreimageV1(
  configuration: PlannerViewConfigurationV1,
): string {
  const result = validatePlannerViewConfigurationV1(configuration);
  if (!result.valid) throw new PlannerViewConfigurationError(result.diagnostics);
  return result.hashPreimage;
}
