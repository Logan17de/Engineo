import {
  NATIVE_PLANNER_PRESENTATION_V1,
  PLANNER_VIEW_MAX_DEPTH,
  PLANNER_VIEW_MAX_OPERATION_BYTES,
  PLANNER_VIEW_MAX_RECEIPT_BYTES,
  plannerViewOperationWindowV1,
  serializePlannerViewReviewHashPreimageV1,
  type PlannerProjectionBindingV1,
  type PlannerProjectionV1,
  type PlannerViewConfigurationV1,
  type PlannerViewDiagnosticsV1,
  type PlannerViewIssueCodeV1,
  type PlannerViewPlanRequestV1,
  type PlannerViewPlanV1,
  type PlannerViewReceiptV1,
  type PlannerVisualRowV1,
  validatePlannerViewApplyRequestV1,
  validatePlannerViewConfigurationV1,
  validatePlannerViewPlanRequestV1,
  validatePlannerViewReceiptV1,
  verifyPlannerViewReceiptBindingV1,
  verifyPlannerViewReviewBaseV1,
  verifyPlannerViewReviewBindingV1,
} from "@engineo/contracts";

/** Published protocol advertisement, not identity or authorization evidence. */
export const VIEW_CAPABILITY_LIMITS_V1 = Object.freeze({
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
} as const);

export interface ViewResponseBindingV1 {
  actorId: string;
  sessionId: string;
  organizationId: string;
  projectId: string;
}
export interface CheckedViewConfiguration {
  configuration: PlannerViewConfigurationV1;
  configHashSha256: string;
  diagnostics: PlannerViewDiagnosticsV1;
}
export interface ViewReadV1 {
  schemaVersion: 1;
  viewId: string;
  viewRevision: number;
  configuration: PlannerViewConfigurationV1;
  configHashSha256: string;
  createdAt: string;
  updatedAt: string;
}
export interface ViewListV1 {
  schemaVersion: 1;
  builtIn: { id: "native"; immutable: true };
  views: Array<{
    viewId: string;
    viewRevision: number;
    name: string;
    configHashSha256: string;
    updatedAt: string;
  }>;
  nextCursor: string | null;
}
export interface ViewCapabilitiesV1 {
  schemaVersion: 1;
  protocolVersion: 1;
  projectionVersion: 1;
  normalizationVersion: 1;
  visibility: ["private"];
  actions: ["create", "update", "delete"];
  capabilities: ["project.read", "view.private.write"];
  builtIn: { id: "native"; immutable: true };
  operationWindowId: string;
  operationWindowClosesAt: string;
  operationReplayUntil: string;
  limits: typeof VIEW_CAPABILITY_LIMITS_V1;
}
export interface ViewValidationV1 {
  schemaVersion: 1;
  valid: true;
  normalizedConfiguration: PlannerViewConfigurationV1;
  configHashSha256: string;
  observedScheduleRevision: number;
  activationAvailable: boolean;
  calculationChecked: false;
  diagnostics: PlannerViewDiagnosticsV1;
}
export interface ViewOperationStatusV1 {
  schemaVersion: 1;
  status: "recorded" | "not_recorded";
  operationWindowId: string;
  operationId: string;
  windowClosed: boolean;
  absenceDefinitive: boolean;
  receipt: PlannerViewReceiptV1 | null;
}
export interface SavedViewProjectionExpectedV1 {
  organizationId: string;
  projectId: string;
  scheduleRevision: number;
  inputHashSha256: string;
  configHashSha256: string;
}
export type AvailableViewProjectionV1 = Extract<PlannerProjectionV1, { available: true }>;

const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const UNSAFE = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_MESSAGE = "The saved-view response could not be verified. Reload before continuing.";

/** Never includes server values, unknown keys, parser offsets or underlying exception text. */
export class SavedViewProtocolError extends Error {
  readonly code = "view_response_invalid";
  readonly diagnostics: PlannerViewDiagnosticsV1;
  constructor(issue: PlannerViewIssueCodeV1 = "INVALID_VALUE") {
    super(SAFE_MESSAGE);
    this.name = "SavedViewProtocolError";
    this.diagnostics = {
      issues: [{ code: issue, path: "", message: SAFE_MESSAGE }],
      totalCount: 1,
      truncated: false,
    };
  }
}
function invalid(issue: PlannerViewIssueCodeV1 = "INVALID_VALUE"): never {
  throw new SavedViewProtocolError(issue);
}
function integer(value: unknown, minimum = 0): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= minimum
  );
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid();
  return value.toLowerCase();
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) invalid();
  return value;
}
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function timestamp(value: unknown): string {
  if (!instant(value)) invalid();
  return value;
}
function limitValue(limit: number): void {
  if (!integer(limit, 1) || limit > VIEW_CAPABILITY_LIMITS_V1.projectionBytes) invalid();
}

/** Original-byte parser: decoded duplicate keys and original integer spelling are checked.
 * It is browser-only and accepts no executable objects or resource references. */
export function parseSavedViewJson(
  source: string | Uint8Array,
  limit = PLANNER_VIEW_MAX_OPERATION_BYTES,
): unknown {
  limitValue(limit);
  let text: string;
  if (typeof source === "string") {
    if (source.length > limit || encoder.encode(source).byteLength > limit)
      invalid("TRANSPORT_TOO_LARGE");
    if (!source.isWellFormed()) invalid("INVALID_JSON");
    text = source;
  } else {
    try {
      if (!ArrayBuffer.isView(source) || !(source instanceof Uint8Array)) invalid();
      const byteLength = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(Uint8Array.prototype),
        "byteLength",
      )?.get;
      if (!byteLength) invalid();
      if (byteLength.call(source) > limit) invalid("TRANSPORT_TOO_LARGE");
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source);
    } catch (error) {
      if (error instanceof SavedViewProtocolError) throw error;
      invalid("INVALID_UTF8");
    }
  }
  let at = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/.test(text[at] ?? "!")) at++;
  };
  const jsonString = (): string => {
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '"') {
        let value: unknown;
        try {
          value = JSON.parse(text.slice(start, at));
        } catch {
          invalid("INVALID_JSON");
        }
        if (typeof value !== "string" || !value.isWellFormed()) invalid("INVALID_JSON");
        return value;
      }
      if (char === "\\") {
        const escaped = text[at++];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at, at + 4))) invalid("INVALID_JSON");
          at += 4;
        } else if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) invalid("INVALID_JSON");
      } else if (char === undefined || char.charCodeAt(0) < 32) invalid("INVALID_JSON");
    }
    return invalid("INVALID_JSON");
  };
  const value = (depth: number): unknown => {
    whitespace();
    const char = text[at];
    if (char === "{" || char === "[") {
      if (depth > PLANNER_VIEW_MAX_DEPTH) invalid("MAX_DEPTH_EXCEEDED");
      at++;
      whitespace();
      if (char === "{") {
        const result: Record<string, unknown> = Object.create(null);
        if (text[at] === "}") {
          at++;
          return result;
        }
        for (;;) {
          if (text[at] !== '"') invalid("INVALID_JSON");
          const key = jsonString();
          if (UNSAFE.has(key)) invalid("UNSAFE_PROPERTY");
          if (Object.hasOwn(result, key)) invalid("DUPLICATE_JSON_KEY");
          whitespace();
          if (text[at++] !== ":") invalid("INVALID_JSON");
          result[key] = value(depth + 1);
          whitespace();
          const separator = text[at++];
          if (separator === "}") return result;
          if (separator !== ",") invalid("INVALID_JSON");
          whitespace();
        }
      }
      const result: unknown[] = [];
      if (text[at] === "]") {
        at++;
        return result;
      }
      for (;;) {
        if (result.length >= 20_000) invalid("TRANSPORT_TOO_LARGE");
        result.push(value(depth + 1));
        whitespace();
        const separator = text[at++];
        if (separator === "]") return result;
        if (separator !== ",") invalid("INVALID_JSON");
        whitespace();
      }
    }
    if (char === '"') return jsonString();
    for (const [literal, result] of [
      ["null", null],
      ["true", true],
      ["false", false],
    ] as const) {
      if (text.startsWith(literal, at)) {
        at += literal.length;
        return result;
      }
    }
    const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at))?.[0];
    if (!token || !/^-?(?:0|[1-9]\d*)$/.test(token) || token === "-0") invalid("INVALID_JSON");
    at += token.length;
    const number = Number(token);
    if (!Number.isSafeInteger(number)) invalid("INVALID_JSON");
    return number;
  };
  const result = value(1);
  whitespace();
  if (at !== text.length) invalid("INVALID_JSON");
  return result;
}

/** Inspect descriptors before reading fields; never invoke input getters or toJSON hooks.
 * Proxy traps cannot be made side-effect-free, so raw JSON is the network boundary. */
function data(value: unknown, maximum = PLANNER_VIEW_MAX_OPERATION_BYTES): unknown {
  let remaining = maximum;
  const seen = new Set<object>();
  const charge = (bytes: number) => {
    remaining -= bytes;
    if (remaining < 0) invalid("TRANSPORT_TOO_LARGE");
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (item === null || typeof item === "boolean") {
      charge(item === null ? 4 : item ? 4 : 5);
      return item;
    }
    if (typeof item === "number") {
      if (!Number.isSafeInteger(item) || Object.is(item, -0)) invalid();
      charge(String(item).length);
      return item;
    }
    if (typeof item === "string") {
      if (item.length > maximum) invalid("TRANSPORT_TOO_LARGE");
      if (!item.isWellFormed()) invalid();
      charge(encoder.encode(JSON.stringify(item)).byteLength);
      return item;
    }
    if (typeof item !== "object" || depth > PLANNER_VIEW_MAX_DEPTH || seen.has(item)) invalid();
    seen.add(item);
    try {
      const isArray = Array.isArray(item);
      const prototype = Object.getPrototypeOf(item);
      if (
        isArray
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      )
        invalid();
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Reflect.ownKeys(descriptors);
      if (isArray) {
        const length: unknown = descriptors.length?.value;
        if (!integer(length) || length > 20_000 || keys.length !== length + 1) invalid();
        const copy: unknown[] = [];
        charge(2 + Math.max(0, length - 1));
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) invalid();
          copy.push(visit(descriptor.value, depth + 1));
        }
        return copy;
      }
      const copy: Record<string, unknown> = Object.create(null);
      charge(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        if (typeof key !== "string" || UNSAFE.has(key)) invalid();
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) invalid();
        if (!key.isWellFormed()) invalid();
        charge(encoder.encode(JSON.stringify(key)).byteLength + 1);
        copy[key] = visit(descriptor.value, depth + 1);
      }
      return copy;
    } catch (error) {
      if (error instanceof SavedViewProtocolError) throw error;
      return invalid();
    } finally {
      seen.delete(item);
    }
  };
  return visit(value, 1);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const source = value as Record<string, unknown>;
  const present = Reflect.ownKeys(source);
  if (present.length !== keys.length || keys.some((key) => !Object.hasOwn(source, key))) invalid();
  return source;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  return value;
}
function emptyDiagnostics(value: unknown): PlannerViewDiagnosticsV1 {
  const source = object(value, ["issues", "totalCount", "truncated"]);
  if (array(source.issues, 0).length !== 0 || source.totalCount !== 0 || source.truncated !== false)
    invalid();
  return { issues: [], totalCount: 0, truncated: false };
}
function builtIn(value: unknown): { id: "native"; immutable: true } {
  const source = object(value, ["id", "immutable"]);
  if (source.id !== "native" || source.immutable !== true) invalid();
  return { id: "native", immutable: true };
}
function operationWindow(value: unknown) {
  if (typeof value !== "string") invalid();
  try {
    const window = plannerViewOperationWindowV1(`${value}T00:00:00.000Z`);
    if (window.operationWindowId !== value) invalid();
    return window;
  } catch {
    return invalid();
  }
}
function binding(value: ViewResponseBindingV1): ViewResponseBindingV1 {
  const source = object(data(value), ["actorId", "sessionId", "organizationId", "projectId"]);
  return {
    actorId: identifier(source.actorId),
    sessionId: identifier(source.sessionId),
    organizationId: identifier(source.organizationId),
    projectId: identifier(source.projectId),
  };
}
async function sha256(preimage: string): Promise<string> {
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(preimage));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  } catch {
    return invalid();
  }
}

export async function checkedViewConfiguration(value: unknown): Promise<CheckedViewConfiguration> {
  const checked = validatePlannerViewConfigurationV1(
    data(value, VIEW_CAPABILITY_LIMITS_V1.configurationBytes),
  );
  if (!checked.valid) invalid();
  return {
    configuration: checked.normalizedConfiguration,
    configHashSha256: await sha256(checked.hashPreimage),
    diagnostics: { issues: [], totalCount: 0, truncated: false },
  };
}
function normalizedName(value: unknown): string {
  const checked = validatePlannerViewConfigurationV1({
    schemaVersion: 1,
    kind: "engineo-planner-view",
    name: value,
    visibility: "private",
    presentation: NATIVE_PLANNER_PRESENTATION_V1,
  });
  if (!checked.valid) invalid();
  return checked.normalizedConfiguration.name;
}
function utf8Compare(left: string, right: string): number {
  const a = encoder.encode(left),
    b = encoder.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

export function checkSavedViewList(value: unknown, limit = 50, cursor?: string): ViewListV1 {
  if (!integer(limit, 1) || limit > VIEW_CAPABILITY_LIMITS_V1.pageSize) invalid();
  const priorCursor = cursor === undefined ? undefined : identifier(cursor);
  const source = object(data(value), ["schemaVersion", "builtIn", "views", "nextCursor"]);
  if (source.schemaVersion !== 1) invalid("UNSUPPORTED_VERSION");
  const seen = new Set<string>();
  const views = array(source.views, limit).map((value) => {
    const row = object(value, ["viewId", "viewRevision", "name", "configHashSha256", "updatedAt"]);
    const viewId = identifier(row.viewId);
    if (seen.has(viewId) || viewId === priorCursor || !integer(row.viewRevision, 1)) invalid();
    seen.add(viewId);
    return {
      viewId,
      viewRevision: row.viewRevision,
      name: normalizedName(row.name),
      configHashSha256: hash(row.configHashSha256),
      updatedAt: timestamp(row.updatedAt),
    };
  });
  for (let index = 1; index < views.length; index++) {
    const prior = views[index - 1],
      next = views[index];
    if (!prior || !next) invalid();
    const order = utf8Compare(prior.name, next.name);
    if (order > 0 || (order === 0 && prior.viewId >= next.viewId)) invalid();
  }
  const nextCursor = source.nextCursor === null ? null : identifier(source.nextCursor);
  if (
    nextCursor !== null &&
    (views.length !== limit || nextCursor !== views.at(-1)?.viewId || nextCursor === priorCursor)
  )
    invalid();
  return { schemaVersion: 1, builtIn: builtIn(source.builtIn), views, nextCursor };
}

export async function checkSavedViewRead(value: unknown, viewId: string): Promise<ViewReadV1> {
  const source = object(data(value), [
    "schemaVersion",
    "viewId",
    "viewRevision",
    "configuration",
    "configHashSha256",
    "createdAt",
    "updatedAt",
  ]);
  const checked = await checkedViewConfiguration(source.configuration);
  const id = identifier(source.viewId),
    createdAt = timestamp(source.createdAt),
    updatedAt = timestamp(source.updatedAt);
  if (
    source.schemaVersion !== 1 ||
    id !== identifier(viewId) ||
    !integer(source.viewRevision, 1) ||
    source.configHashSha256 !== checked.configHashSha256 ||
    updatedAt < createdAt
  )
    invalid();
  return {
    schemaVersion: 1,
    viewId: id,
    viewRevision: source.viewRevision,
    configuration: checked.configuration,
    configHashSha256: checked.configHashSha256,
    createdAt,
    updatedAt,
  };
}

export function checkSavedViewCapabilities(value: unknown): ViewCapabilitiesV1 {
  const source = object(data(value), [
    "schemaVersion",
    "protocolVersion",
    "projectionVersion",
    "normalizationVersion",
    "visibility",
    "actions",
    "capabilities",
    "builtIn",
    "operationWindowId",
    "operationWindowClosesAt",
    "operationReplayUntil",
    "limits",
  ]);
  for (const key of [
    "schemaVersion",
    "protocolVersion",
    "projectionVersion",
    "normalizationVersion",
  ])
    if (source[key] !== 1) invalid("UNSUPPORTED_VERSION");
  for (const [key, expected] of [
    ["visibility", ["private"]],
    ["actions", ["create", "update", "delete"]],
    ["capabilities", ["project.read", "view.private.write"]],
  ] as const) {
    const values = array(source[key], expected.length);
    if (
      values.length !== expected.length ||
      values.some((value, index) => value !== expected[index])
    )
      invalid();
  }
  const window = operationWindow(source.operationWindowId);
  if (
    source.operationWindowClosesAt !== window.closesAt ||
    source.operationReplayUntil !== window.replayUntil
  )
    invalid();
  const limits = object(source.limits, Object.keys(VIEW_CAPABILITY_LIMITS_V1));
  for (const key of Object.keys(VIEW_CAPABILITY_LIMITS_V1) as Array<
    keyof typeof VIEW_CAPABILITY_LIMITS_V1
  >)
    if (limits[key] !== VIEW_CAPABILITY_LIMITS_V1[key]) invalid();
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    visibility: ["private"],
    actions: ["create", "update", "delete"],
    capabilities: ["project.read", "view.private.write"],
    builtIn: builtIn(source.builtIn),
    operationWindowId: window.operationWindowId,
    operationWindowClosesAt: window.closesAt,
    operationReplayUntil: window.replayUntil,
    limits: { ...VIEW_CAPABILITY_LIMITS_V1 },
  };
}
export function viewConfigurationNeedsCalculation(config: PlannerViewConfigurationV1): boolean {
  return (
    config.presentation.critical !== "all" ||
    config.presentation.sort.field === "earlyStart" ||
    config.presentation.sort.field === "totalFloatMinutes"
  );
}
export async function checkSavedViewValidation(
  value: unknown,
  checkedConfiguration: CheckedViewConfiguration,
): Promise<ViewValidationV1> {
  const source = object(data(value), [
    "schemaVersion",
    "valid",
    "normalizedConfiguration",
    "configHashSha256",
    "observedScheduleRevision",
    "activationAvailable",
    "calculationChecked",
    "diagnostics",
  ]);
  const expectedSource = object(data(checkedConfiguration), [
    "configuration",
    "configHashSha256",
    "diagnostics",
  ]);
  emptyDiagnostics(expectedSource.diagnostics);
  const [expected, checked] = await Promise.all([
    checkedViewConfiguration(expectedSource.configuration),
    checkedViewConfiguration(source.normalizedConfiguration),
  ]);
  if (
    source.schemaVersion !== 1 ||
    source.valid !== true ||
    source.calculationChecked !== false ||
    !integer(source.observedScheduleRevision, 1) ||
    source.activationAvailable !== !viewConfigurationNeedsCalculation(checked.configuration) ||
    expectedSource.configHashSha256 !== expected.configHashSha256 ||
    checked.configHashSha256 !== expected.configHashSha256 ||
    source.configHashSha256 !== checked.configHashSha256
  )
    invalid();
  return {
    schemaVersion: 1,
    valid: true,
    normalizedConfiguration: checked.configuration,
    configHashSha256: checked.configHashSha256,
    observedScheduleRevision: source.observedScheduleRevision,
    activationAvailable: source.activationAvailable as boolean,
    calculationChecked: false,
    diagnostics: emptyDiagnostics(source.diagnostics),
  };
}

async function normalizedPlan(value: unknown): Promise<PlannerViewPlanV1> {
  const checked = validatePlannerViewApplyRequestV1(data(value));
  if (!checked.valid) invalid();
  const plan = checked.value;
  const [base, desired, digest] = await Promise.all([
    plan.review.baseConfiguration ? checkedViewConfiguration(plan.review.baseConfiguration) : null,
    plan.review.desiredConfiguration
      ? checkedViewConfiguration(plan.review.desiredConfiguration)
      : null,
    sha256(serializePlannerViewReviewHashPreimageV1(plan.review)),
  ]);
  if (
    (base?.configHashSha256 ?? null) !== plan.review.baseConfigHash ||
    (desired?.configHashSha256 ?? null) !== plan.review.desiredConfigHash ||
    digest !== plan.reviewedDigest
  )
    invalid();
  return plan;
}
async function boundPlan(
  value: unknown,
  expected: ViewResponseBindingV1,
  historical: boolean,
): Promise<PlannerViewPlanV1> {
  const context = binding(expected);
  const plan = await normalizedPlan(value);
  if (
    !verifyPlannerViewReviewBindingV1(plan.review, {
      ...context,
      sessionId: historical ? plan.review.sessionId : context.sessionId,
    }).valid
  )
    invalid();
  return plan;
}

/** Exact requested intent/current creator-session binding. Hashes never grant authorization. */
export async function checkSavedViewPlan(
  value: unknown,
  expected: ViewResponseBindingV1,
  request: PlannerViewPlanRequestV1,
  base?: ViewReadV1,
): Promise<PlannerViewPlanV1> {
  const plan = await boundPlan(value, expected, false);
  const checked = validatePlannerViewPlanRequestV1(data(request));
  if (!checked.valid) invalid();
  const intent = checked.value,
    review = plan.review;
  const desired =
    intent.action === "delete" ? null : await checkedViewConfiguration(intent.configuration);
  if (
    review.action !== intent.action ||
    review.operationWindowId !== intent.operationWindowId ||
    review.operationId !== intent.operationId ||
    review.expectedScheduleRevision !== intent.expectedScheduleRevision ||
    review.viewId !== (intent.action === "create" ? null : intent.viewId) ||
    review.expectedViewRevision !==
      (intent.action === "create" ? 0 : intent.expectedViewRevision) ||
    review.desiredConfigHash !== (desired?.configHashSha256 ?? null)
  )
    invalid();
  if (base !== undefined) {
    if (intent.action === "create") invalid();
    const current = await checkSavedViewRead(base, intent.viewId);
    if (
      !verifyPlannerViewReviewBaseV1(review, {
        viewId: current.viewId,
        viewRevision: current.viewRevision,
        scheduleRevision: intent.expectedScheduleRevision,
        configHash: current.configHashSha256,
      }).valid
    )
      invalid();
  }
  return plan;
}

/** Historical display/status only: current live access remains the transport/server's duty.
 * No wall-clock/current-record check; expiry/later edits do not erase a retained outcome. */
export async function checkHistoricalViewPlan(
  value: unknown,
  expected: ViewResponseBindingV1,
): Promise<PlannerViewPlanV1> {
  return boundPlan(value, expected, true);
}
export async function checkSavedViewReceipt(
  value: unknown,
  expected: ViewResponseBindingV1,
  operationWindowId: string,
  operationId: string,
  plan?: PlannerViewPlanV1,
): Promise<PlannerViewReceiptV1> {
  const context = binding(expected);
  const checked = validatePlannerViewReceiptV1(data(value, PLANNER_VIEW_MAX_RECEIPT_BYTES));
  if (!checked.valid) invalid();
  const receipt = checked.value;
  if (
    receipt.actorId !== context.actorId ||
    receipt.organizationId !== context.organizationId ||
    receipt.projectId !== context.projectId ||
    receipt.operationWindowId !== operationWindow(operationWindowId).operationWindowId ||
    receipt.operationId !== identifier(operationId)
  )
    invalid();
  if (plan !== undefined) {
    const original = await boundPlan(plan, context, true);
    if (!verifyPlannerViewReceiptBindingV1(receipt, original.review, original.reviewedDigest))
      invalid();
  }
  return receipt;
}
export async function checkSavedViewOperationStatus(
  value: unknown,
  expected: ViewResponseBindingV1,
  operationWindowId: string,
  operationId: string,
  plan?: PlannerViewPlanV1,
): Promise<ViewOperationStatusV1> {
  const context = binding(expected);
  const source = object(data(value), [
    "schemaVersion",
    "status",
    "operationWindowId",
    "operationId",
    "windowClosed",
    "absenceDefinitive",
    "receipt",
  ]);
  const window = operationWindow(operationWindowId),
    id = identifier(operationId);
  if (
    source.schemaVersion !== 1 ||
    source.operationWindowId !== window.operationWindowId ||
    identifier(source.operationId) !== id ||
    typeof source.windowClosed !== "boolean" ||
    typeof source.absenceDefinitive !== "boolean" ||
    source.status !== (source.receipt === null ? "not_recorded" : "recorded") ||
    source.absenceDefinitive !== (source.receipt === null && source.windowClosed)
  )
    invalid();
  if (plan !== undefined) {
    const original = await boundPlan(plan, context, true);
    if (
      original.review.operationWindowId !== window.operationWindowId ||
      original.review.operationId !== id
    )
      invalid();
  }
  const receipt =
    source.receipt === null
      ? null
      : await checkSavedViewReceipt(source.receipt, context, window.operationWindowId, id, plan);
  return {
    schemaVersion: 1,
    status: receipt === null ? "not_recorded" : "recorded",
    operationWindowId: window.operationWindowId,
    operationId: id,
    windowClosed: source.windowClosed,
    absenceDefinitive: source.absenceDefinitive,
    receipt,
  };
}

function label(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.includes("\0") ||
    value.trim().length === 0 ||
    [...value].length > maximum
  )
    invalid();
  return value;
}
/** Observable saved-source DTO consistency only. Coherent authorization/source and genuine
 * engine provenance are server obligations; declarations/digests cannot prove them. */
export async function checkSavedViewProjection(
  value: unknown,
  expected: SavedViewProjectionExpectedV1,
  configuration: PlannerViewConfigurationV1,
): Promise<AvailableViewProjectionV1> {
  const source = object(data(value, VIEW_CAPABILITY_LIMITS_V1.projectionBytes), [
    "available",
    "rows",
    "sourceActivityCount",
    "visibleActivityCount",
    "visualRowCount",
    "groupCount",
    "binding",
  ]);
  const context = object(data(expected), [
    "organizationId",
    "projectId",
    "scheduleRevision",
    "inputHashSha256",
    "configHashSha256",
  ]);
  const checked = await checkedViewConfiguration(configuration);
  if (
    source.available !== true ||
    !integer(source.sourceActivityCount) ||
    source.sourceActivityCount > 10_000 ||
    !integer(source.visibleActivityCount) ||
    !integer(source.visualRowCount) ||
    !integer(source.groupCount) ||
    source.visibleActivityCount > source.sourceActivityCount ||
    source.groupCount > source.visibleActivityCount ||
    source.visualRowCount !== source.visibleActivityCount + source.groupCount
  )
    invalid();
  const presentation = checked.configuration.presentation;
  if (
    presentation.search === "" &&
    presentation.kind === "all" &&
    presentation.wbsId === null &&
    presentation.critical === "all" &&
    source.visibleActivityCount !== source.sourceActivityCount
  )
    invalid();
  const calculated = viewConfigurationNeedsCalculation(checked.configuration);
  const bindingKeys = [
    "organizationId",
    "projectId",
    "scheduleRevision",
    "inputHashSha256",
    "inputState",
    "projectionVersion",
    "normalizationVersion",
    "configHashSha256",
  ];
  const rawBinding = object(
    source.binding,
    calculated ? [...bindingKeys, "calculation"] : bindingKeys,
  );
  const organizationId = identifier(context.organizationId),
    projectId = identifier(context.projectId);
  if (
    !integer(context.scheduleRevision, 1) ||
    identifier(rawBinding.organizationId) !== organizationId ||
    identifier(rawBinding.projectId) !== projectId ||
    rawBinding.scheduleRevision !== context.scheduleRevision ||
    rawBinding.inputHashSha256 !== hash(context.inputHashSha256) ||
    rawBinding.inputState !== "saved" ||
    rawBinding.projectionVersion !== 1 ||
    rawBinding.normalizationVersion !== 1 ||
    hash(context.configHashSha256) !== checked.configHashSha256 ||
    rawBinding.configHashSha256 !== checked.configHashSha256
  )
    invalid();
  const binding: PlannerProjectionBindingV1 = {
    organizationId,
    projectId,
    scheduleRevision: context.scheduleRevision,
    inputHashSha256: hash(rawBinding.inputHashSha256),
    inputState: "saved",
    projectionVersion: 1,
    normalizationVersion: 1,
    configHashSha256: checked.configHashSha256,
  };
  if (calculated) {
    const calculation = object(rawBinding.calculation, [
      "calculationId",
      "resultHashSha256",
      "engineContractVersion",
      "engineVersion",
    ]);
    if (
      calculation.engineContractVersion !== 1 ||
      typeof calculation.engineVersion !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,127}$/.test(calculation.engineVersion)
    )
      invalid();
    binding.calculation = {
      calculationId: identifier(calculation.calculationId),
      resultHashSha256: hash(calculation.resultHashSha256),
      engineContractVersion: 1,
      engineVersion: calculation.engineVersion,
    };
  }
  const rawRows = array(source.rows, 20_000);
  if (rawRows.length !== source.visualRowCount) invalid();
  const rows: PlannerVisualRowV1[] = [],
    activities = new Set<string>(),
    nativeIndexes = new Set<number>(),
    groups = new Set<string>();
  let ordinal = 0,
    groupCount = 0,
    priorNative = -1;
  let currentGroup: { key: string; expected: number; seen: number } | null = null;
  const finishGroup = () => {
    if (currentGroup && currentGroup.seen !== currentGroup.expected) invalid();
  };
  for (const value of rawRows) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
    const kind = (value as Record<string, unknown>).kind;
    if (kind === "group") {
      const row = object(value, ["kind", "key", "wbsId", "wbsCode", "wbsName", "activityCount"]);
      const wbsId = identifier(row.wbsId),
        key = `group:wbs:${wbsId}`;
      if (
        presentation.groupBy !== "wbs" ||
        row.key !== key ||
        groups.has(key) ||
        !integer(row.activityCount, 1) ||
        row.activityCount > source.visibleActivityCount ||
        (presentation.wbsId !== null && wbsId !== presentation.wbsId)
      )
        invalid();
      finishGroup();
      groups.add(key);
      groupCount++;
      currentGroup = { key, expected: row.activityCount, seen: 0 };
      priorNative = -1;
      rows.push({
        kind: "group",
        key,
        wbsId,
        wbsCode: label(row.wbsCode, 100),
        wbsName: label(row.wbsName, 500),
        activityCount: row.activityCount,
      });
    } else if (kind === "activity") {
      const row = object(value, [
        "kind",
        "activityId",
        "nativeIndex",
        "displayOrdinal",
        "groupKey",
      ]);
      const activityId = identifier(row.activityId);
      if (
        !integer(row.nativeIndex) ||
        row.nativeIndex >= source.sourceActivityCount ||
        !integer(row.displayOrdinal, 1) ||
        row.displayOrdinal !== ordinal + 1 ||
        activities.has(activityId) ||
        nativeIndexes.has(row.nativeIndex)
      )
        invalid();
      const groupKey = presentation.groupBy === "none" ? null : currentGroup?.key;
      if (
        groupKey === undefined ||
        row.groupKey !== groupKey ||
        (presentation.sort.field === "native" && row.nativeIndex <= priorNative)
      )
        invalid();
      ordinal++;
      priorNative = row.nativeIndex;
      activities.add(activityId);
      nativeIndexes.add(row.nativeIndex);
      if (currentGroup) currentGroup.seen++;
      rows.push({
        kind: "activity",
        activityId,
        nativeIndex: row.nativeIndex,
        displayOrdinal: ordinal,
        groupKey,
      });
    } else invalid();
  }
  finishGroup();
  if (
    ordinal !== source.visibleActivityCount ||
    groupCount !== source.groupCount ||
    (presentation.groupBy === "none" && groupCount !== 0)
  )
    invalid();
  return {
    available: true,
    rows,
    sourceActivityCount: source.sourceActivityCount,
    visibleActivityCount: ordinal,
    visualRowCount: rows.length,
    groupCount,
    binding,
  };
}
