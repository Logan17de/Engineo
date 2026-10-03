import {
  calculatePlannerViewConfigurationHashV1,
  calculatePlannerViewReviewDigestV1,
  NATIVE_PLANNER_PRESENTATION_V1,
  parsePlannerViewConfigurationV1,
  plannerViewOperationWindowV1,
  type PlannerActivityRowV1,
  type PlannerProjectionBindingV1,
  type PlannerProjectionV1,
  type PlannerViewConfigurationV1,
  type PlannerViewDiagnosticsV1,
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
  verifyPlannerViewReviewDigestV1,
} from "@engineo/contracts";
import type { Destination } from "./arguments.js";
import { hash } from "./artifacts.js";
import { CliError, integrity } from "./errors.js";
import { exactKeys, record, rejectCredentials, sha256Text, uuid } from "./json.js";
import type { SessionMaterial } from "./transport.js";

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
export const VIEW_CAPABILITY_LIMITS_V1 = {
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
} as const;
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
export interface SavedViewReviewV1 {
  schemaVersion: 1;
  kind: "engineo-cli-reviewed-view-plan";
  destination: Destination;
  plan: PlannerViewPlanV1;
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
export type AvailableViewProjectionV1 = Extract<PlannerProjectionV1, { available: true }>;

// Inspect descriptors before reading fields. Only bounded, inert JSON DTOs are accepted.
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (!record(value)) integrity();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) integrity();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length || !exactKeys(descriptors, keys))
      integrity();
    const copy: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) integrity();
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return integrity();
  }
}
function array(value: unknown, maximum: number): unknown[] {
  try {
    if (!Array.isArray(value)) integrity();
    if (Object.getPrototypeOf(value) !== Array.prototype) integrity();
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
    if (!integer(length) || length > maximum) integrity();
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    if (Reflect.ownKeys(descriptors).length !== length + 1) integrity();
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) integrity();
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return integrity();
  }
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
  if (typeof value !== "string" || !uuid(value.toLowerCase())) integrity();
  return value.toLowerCase();
}
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function bounded(value: unknown, maximum: number = VIEW_CAPABILITY_LIMITS_V1.bodyBytes): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum) integrity();
}
function cleanDiagnostics(): PlannerViewDiagnosticsV1 {
  return { issues: [], totalCount: 0, truncated: false };
}
function checkEmptyDiagnostics(value: unknown): PlannerViewDiagnosticsV1 {
  const source = object(value, ["issues", "totalCount", "truncated"]);
  if (array(source.issues, 0).length !== 0 || source.totalCount !== 0 || source.truncated !== false)
    integrity();
  return cleanDiagnostics();
}
function configuration(value: unknown): CheckedViewConfiguration {
  const checked = validatePlannerViewConfigurationV1(value);
  if (!checked.valid) integrity();
  const result = {
    configuration: checked.normalizedConfiguration,
    configHashSha256: calculatePlannerViewConfigurationHashV1(
      checked.normalizedConfiguration,
      hash,
    ),
    diagnostics: cleanDiagnostics(),
  };
  rejectCredentials(result.configuration);
  return result;
}
export function checkedViewConfiguration(
  source: string,
  secrets: readonly string[] = [],
): CheckedViewConfiguration {
  const checked = parsePlannerViewConfigurationV1(source);
  if (!checked.valid) {
    // The source parser's paths can contain unknown keys. Never echo them, values or offsets.
    const message = "Input is not a valid bounded Planner view configuration.";
    const diagnostics: PlannerViewDiagnosticsV1 = {
      issues: checked.diagnostics.issues.map((issue) => ({ code: issue.code, path: "", message })),
      totalCount: checked.diagnostics.totalCount,
      truncated: checked.diagnostics.truncated,
    };
    throw new CliError("validation", "view_configuration_invalid", message, diagnostics);
  }
  rejectCredentials(checked.normalizedConfiguration, secrets);
  return {
    configuration: checked.normalizedConfiguration,
    configHashSha256: hash(checked.hashPreimage),
    diagnostics: cleanDiagnostics(),
  };
}
export function checkViewRead(value: unknown, viewId: string): ViewReadV1 {
  const source = object(value, [
    "schemaVersion",
    "viewId",
    "viewRevision",
    "configuration",
    "configHashSha256",
    "createdAt",
    "updatedAt",
  ]);
  const checked = configuration(source.configuration);
  const returnedId = identifier(source.viewId);
  if (
    source.schemaVersion !== 1 ||
    returnedId !== identifier(viewId) ||
    !integer(source.viewRevision, 1) ||
    source.configHashSha256 !== checked.configHashSha256 ||
    !instant(source.createdAt) ||
    !instant(source.updatedAt) ||
    source.updatedAt < source.createdAt
  )
    integrity();
  const result: ViewReadV1 = {
    schemaVersion: 1,
    viewId: returnedId,
    viewRevision: source.viewRevision,
    configuration: checked.configuration,
    configHashSha256: checked.configHashSha256,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
  bounded(result);
  return result;
}
function builtIn(value: unknown): { id: "native"; immutable: true } {
  const source = object(value, ["id", "immutable"]);
  if (source.id !== "native" || source.immutable !== true) integrity();
  return { id: "native", immutable: true };
}
export function checkViewList(value: unknown, limit: number, cursor?: string): ViewListV1 {
  if (!integer(limit, 1) || limit > VIEW_CAPABILITY_LIMITS_V1.pageSize) integrity();
  if (cursor !== undefined) identifier(cursor);
  const source = object(value, ["schemaVersion", "builtIn", "views", "nextCursor"]);
  if (source.schemaVersion !== 1) integrity();
  const seen = new Set<string>();
  const views = array(source.views, limit).map((entry) => {
    const row = object(entry, ["viewId", "viewRevision", "name", "configHashSha256", "updatedAt"]);
    const viewId = identifier(row.viewId);
    if (
      seen.has(viewId) ||
      !integer(row.viewRevision, 1) ||
      !sha256Text(row.configHashSha256) ||
      !instant(row.updatedAt)
    )
      integrity();
    const name = configuration({
      schemaVersion: 1,
      kind: "engineo-planner-view",
      name: row.name,
      visibility: "private",
      presentation: NATIVE_PLANNER_PRESENTATION_V1,
    }).configuration.name;
    seen.add(viewId);
    return {
      viewId,
      viewRevision: row.viewRevision,
      name,
      configHashSha256: row.configHashSha256,
      updatedAt: row.updatedAt,
    };
  });
  // The UUID cursor resolves an owned record's normalized name/position on the server.
  // It is opaque here. Published list order uses UTF-8/C name bytes, then UUID ties.
  for (let index = 1; index < views.length; index++) {
    const previous = views[index - 1],
      current = views[index];
    if (!previous || !current) integrity();
    const order = Buffer.compare(
      Buffer.from(previous.name, "utf8"),
      Buffer.from(current.name, "utf8"),
    );
    if (order > 0 || (order === 0 && previous.viewId >= current.viewId)) integrity();
  }
  const nextCursor = source.nextCursor === null ? null : identifier(source.nextCursor);
  const result: ViewListV1 = {
    schemaVersion: 1,
    builtIn: builtIn(source.builtIn),
    views,
    nextCursor,
  };
  bounded(result);
  rejectCredentials(result);
  return result;
}
function window(operationWindowId: unknown) {
  if (typeof operationWindowId !== "string") integrity();
  try {
    const result = plannerViewOperationWindowV1(`${operationWindowId}T00:00:00.000Z`);
    if (result.operationWindowId !== operationWindowId) integrity();
    return result;
  } catch {
    return integrity();
  }
}
function sameArray(value: unknown, expected: readonly string[]): void {
  const values = array(value, expected.length);
  if (values.length !== expected.length || values.some((item, index) => item !== expected[index]))
    integrity();
}
/** Protocol advertisement only. This is not identity, authorization or permission evidence. */
export function checkViewCapabilities(value: unknown): ViewCapabilitiesV1 {
  const source = object(value, [
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
    if (source[key] !== 1) integrity();
  sameArray(source.visibility, ["private"]);
  sameArray(source.actions, ["create", "update", "delete"]);
  sameArray(source.capabilities, ["project.read", "view.private.write"]);
  const operationWindow = window(source.operationWindowId);
  if (
    source.operationWindowClosesAt !== operationWindow.closesAt ||
    source.operationReplayUntil !== operationWindow.replayUntil
  )
    integrity();
  const limits = object(source.limits, Object.keys(VIEW_CAPABILITY_LIMITS_V1));
  for (const key of Object.keys(VIEW_CAPABILITY_LIMITS_V1) as Array<
    keyof typeof VIEW_CAPABILITY_LIMITS_V1
  >)
    if (limits[key] !== VIEW_CAPABILITY_LIMITS_V1[key]) integrity();
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    visibility: ["private"],
    actions: ["create", "update", "delete"],
    capabilities: ["project.read", "view.private.write"],
    builtIn: builtIn(source.builtIn),
    operationWindowId: operationWindow.operationWindowId,
    operationWindowClosesAt: operationWindow.closesAt,
    operationReplayUntil: operationWindow.replayUntil,
    limits: { ...VIEW_CAPABILITY_LIMITS_V1 },
  };
}
function needsCalculation(config: PlannerViewConfigurationV1): boolean {
  return (
    config.presentation.critical !== "all" ||
    config.presentation.sort.field === "earlyStart" ||
    config.presentation.sort.field === "totalFloatMinutes"
  );
}
export function checkViewValidation(
  value: unknown,
  checkedConfiguration: CheckedViewConfiguration,
): ViewValidationV1 {
  const source = object(value, [
    "schemaVersion",
    "valid",
    "normalizedConfiguration",
    "configHashSha256",
    "observedScheduleRevision",
    "activationAvailable",
    "calculationChecked",
    "diagnostics",
  ]);
  const expected = configuration(checkedConfiguration.configuration);
  const checked = configuration(source.normalizedConfiguration);
  if (
    source.schemaVersion !== 1 ||
    source.valid !== true ||
    source.calculationChecked !== false ||
    !integer(source.observedScheduleRevision, 1) ||
    typeof source.activationAvailable !== "boolean" ||
    source.activationAvailable !== !needsCalculation(checked.configuration) ||
    expected.configHashSha256 !== checkedConfiguration.configHashSha256 ||
    checked.configHashSha256 !== expected.configHashSha256 ||
    source.configHashSha256 !== checked.configHashSha256
  )
    integrity();
  return {
    schemaVersion: 1,
    valid: true,
    normalizedConfiguration: checked.configuration,
    configHashSha256: checked.configHashSha256,
    observedScheduleRevision: source.observedScheduleRevision,
    activationAvailable: source.activationAvailable,
    calculationChecked: false,
    diagnostics: checkEmptyDiagnostics(source.diagnostics),
  };
}
function normalizedPlan(value: unknown): PlannerViewPlanV1 {
  const checked = validatePlannerViewApplyRequestV1(value);
  if (
    !checked.valid ||
    !verifyPlannerViewReviewDigestV1(checked.value.review, checked.value.reviewedDigest, hash).valid
  )
    integrity();
  // Compute independently even though the digest helper also checks its configuration hashes.
  if (
    calculatePlannerViewReviewDigestV1(checked.value.review, hash) !== checked.value.reviewedDigest
  )
    integrity();
  rejectCredentials(checked.value);
  return checked.value;
}
function boundPlan(
  value: unknown,
  target: Destination,
  session: SessionMaterial,
  historical = false,
): PlannerViewPlanV1 {
  const plan = normalizedPlan(value);
  if (
    !verifyPlannerViewReviewBindingV1(plan.review, {
      actorId: session.actorId,
      sessionId: historical ? plan.review.sessionId : session.sessionId,
      organizationId: target.organizationId,
      projectId: target.projectId,
    }).valid
  )
    integrity();
  rejectCredentials(plan, [session.sessionToken, session.csrfToken]);
  return plan;
}
export function checkViewPlan(
  value: unknown,
  target: Destination,
  session: SessionMaterial,
  request: PlannerViewPlanRequestV1,
  base?: ViewReadV1,
): PlannerViewPlanV1 {
  const plan = boundPlan(value, target, session);
  const checked = validatePlannerViewPlanRequestV1(request);
  if (!checked.valid) integrity();
  const expected = checked.value,
    review = plan.review;
  if (
    review.action !== expected.action ||
    review.operationWindowId !== expected.operationWindowId ||
    review.operationId !== expected.operationId ||
    review.expectedScheduleRevision !== expected.expectedScheduleRevision ||
    review.viewId !== (expected.action === "create" ? null : expected.viewId) ||
    review.expectedViewRevision !==
      (expected.action === "create" ? 0 : expected.expectedViewRevision) ||
    (expected.action !== "delete" &&
      review.desiredConfigHash !==
        calculatePlannerViewConfigurationHashV1(expected.configuration, hash))
  )
    integrity();
  if (base !== undefined) {
    if (expected.action === "create") integrity();
    const current = checkViewRead(base, expected.viewId);
    if (
      !verifyPlannerViewReviewBaseV1(review, {
        viewId: current.viewId,
        viewRevision: current.viewRevision,
        scheduleRevision: expected.expectedScheduleRevision,
        configHash: current.configHashSha256,
      }).valid
    )
      integrity();
  }
  return plan;
}
function destinationCopy(target: Destination): Destination {
  return {
    apiOrigin: target.apiOrigin,
    appOrigin: target.appOrigin,
    organizationId: target.organizationId,
    projectId: target.projectId,
  };
}
export function savedViewReview(plan: PlannerViewPlanV1, target: Destination): SavedViewReviewV1 {
  const checked = normalizedPlan(plan);
  if (
    checked.review.organizationId !== target.organizationId ||
    checked.review.projectId !== target.projectId
  )
    integrity();
  return {
    schemaVersion: 1,
    kind: "engineo-cli-reviewed-view-plan",
    destination: destinationCopy(target),
    plan: checked,
  };
}
export function checkSavedViewReview(
  value: unknown,
  target: Destination,
  session: SessionMaterial,
  expectedScheduleRevision?: number,
  allowHistoricalSession = false,
): SavedViewReviewV1 {
  const source = object(value, ["schemaVersion", "kind", "destination", "plan"]);
  if (source.schemaVersion !== 1 || source.kind !== "engineo-cli-reviewed-view-plan") integrity();
  const destination = object(source.destination, [
    "apiOrigin",
    "appOrigin",
    "organizationId",
    "projectId",
  ]);
  for (const key of ["apiOrigin", "appOrigin", "organizationId", "projectId"] as const)
    if (destination[key] !== target[key])
      throw new CliError(
        "conflict",
        "review_destination_mismatch",
        "Saved review does not match the explicit destination and project.",
      );
  const checked = normalizedPlan(source.plan);
  if (
    checked.review.actorId !== session.actorId ||
    (!allowHistoricalSession && checked.review.sessionId !== session.sessionId)
  )
    throw new CliError(
      "auth",
      "review_identity_mismatch",
      "Saved review belongs to a different actor or original session.",
    );
  const plan = boundPlan(checked, target, session, allowHistoricalSession);
  if (
    expectedScheduleRevision !== undefined &&
    (!integer(expectedScheduleRevision, 1) ||
      plan.review.expectedScheduleRevision !== expectedScheduleRevision)
  )
    throw new CliError(
      "conflict",
      "review_revision_mismatch",
      "Expected schedule revision does not match the saved review.",
    );
  // No wall-clock or current-record check: retained replay must remain readable after expiry.
  return savedViewReview(plan, target);
}
export function checkViewReceipt(
  value: unknown,
  target: Destination,
  session: SessionMaterial,
  operationWindowId: string,
  operationId: string,
  plan?: PlannerViewPlanV1,
): PlannerViewReceiptV1 {
  const checked = validatePlannerViewReceiptV1(value);
  if (!checked.valid) integrity();
  const receipt = checked.value;
  if (
    receipt.organizationId !== target.organizationId ||
    receipt.projectId !== target.projectId ||
    receipt.actorId !== session.actorId ||
    receipt.operationWindowId !== window(operationWindowId).operationWindowId ||
    receipt.operationId !== identifier(operationId)
  )
    integrity();
  if (plan !== undefined) {
    // Current live session can retrieve its actor's historical receipt; the receipt binds to
    // the review's creator session and full reviewed content, never to the new session.
    const original = boundPlan(plan, target, session, true);
    if (!verifyPlannerViewReceiptBindingV1(receipt, original.review, original.reviewedDigest))
      integrity();
  }
  rejectCredentials(receipt, [session.sessionToken, session.csrfToken]);
  return receipt;
}
export function checkViewOperationStatus(
  value: unknown,
  target: Destination,
  session: SessionMaterial,
  operationWindowId: string,
  operationId: string,
  plan?: PlannerViewPlanV1,
): ViewOperationStatusV1 {
  const source = object(value, [
    "schemaVersion",
    "status",
    "operationWindowId",
    "operationId",
    "windowClosed",
    "absenceDefinitive",
    "receipt",
  ]);
  if (
    source.schemaVersion !== 1 ||
    source.operationWindowId !== window(operationWindowId).operationWindowId ||
    identifier(source.operationId) !== identifier(operationId) ||
    typeof source.windowClosed !== "boolean" ||
    typeof source.absenceDefinitive !== "boolean" ||
    source.status !== (source.receipt === null ? "not_recorded" : "recorded") ||
    source.absenceDefinitive !== (source.receipt === null && source.windowClosed)
  )
    integrity();
  const receipt =
    source.receipt === null
      ? null
      : checkViewReceipt(source.receipt, target, session, operationWindowId, operationId, plan);
  if (plan !== undefined) {
    const original = boundPlan(plan, target, session, true);
    if (
      original.review.operationWindowId !== operationWindowId ||
      original.review.operationId !== identifier(operationId)
    )
      integrity();
  }
  return {
    schemaVersion: 1,
    status: receipt === null ? "not_recorded" : "recorded",
    operationWindowId,
    operationId: identifier(operationId),
    windowClosed: source.windowClosed,
    absenceDefinitive: source.absenceDefinitive,
    receipt,
  };
}
function projectionBinding(
  value: unknown,
  target: Destination,
  config: CheckedViewConfiguration,
  expectedScheduleRevision: number,
): PlannerProjectionBindingV1 {
  const required = [
    "organizationId",
    "projectId",
    "scheduleRevision",
    "inputHashSha256",
    "inputState",
    "projectionVersion",
    "normalizationVersion",
    "configHashSha256",
  ];
  const calculated = needsCalculation(config.configuration);
  const source = object(value, calculated ? [...required, "calculation"] : required);
  if (
    identifier(source.organizationId) !== target.organizationId ||
    identifier(source.projectId) !== target.projectId ||
    !integer(expectedScheduleRevision, 1) ||
    source.scheduleRevision !== expectedScheduleRevision ||
    !sha256Text(source.inputHashSha256) ||
    source.inputState !== "saved" ||
    source.projectionVersion !== 1 ||
    source.normalizationVersion !== 1 ||
    source.configHashSha256 !== config.configHashSha256
  )
    integrity();
  const binding: PlannerProjectionBindingV1 = {
    organizationId: target.organizationId,
    projectId: target.projectId,
    scheduleRevision: expectedScheduleRevision,
    inputHashSha256: source.inputHashSha256,
    inputState: "saved",
    projectionVersion: 1,
    normalizationVersion: 1,
    configHashSha256: config.configHashSha256,
  };
  if (calculated) {
    const calculation = object(source.calculation, [
      "calculationId",
      "resultHashSha256",
      "engineContractVersion",
      "engineVersion",
    ]);
    if (
      !sha256Text(calculation.resultHashSha256) ||
      calculation.engineContractVersion !== 1 ||
      typeof calculation.engineVersion !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,127}$/.test(calculation.engineVersion)
    )
      integrity();
    binding.calculation = {
      calculationId: identifier(calculation.calculationId),
      resultHashSha256: calculation.resultHashSha256,
      engineContractVersion: 1,
      engineVersion: calculation.engineVersion,
    };
  }
  return binding;
}
/** Checks observable DTO consistency only. Authorized coherent source and real-engine
 * provenance remain the server's responsibility; the client cannot prove either. */
export function checkViewProjection(
  value: unknown,
  target: Destination,
  configurationValue: PlannerViewConfigurationV1,
  expectedScheduleRevision: number,
): AvailableViewProjectionV1 {
  const config = configuration(configurationValue);
  const source = object(value, [
    "available",
    "rows",
    "sourceActivityCount",
    "visibleActivityCount",
    "visualRowCount",
    "groupCount",
    "binding",
  ]);
  if (
    source.available !== true ||
    !integer(source.sourceActivityCount) ||
    !integer(source.visibleActivityCount) ||
    !integer(source.visualRowCount) ||
    !integer(source.groupCount) ||
    source.visibleActivityCount > source.sourceActivityCount ||
    source.groupCount > source.visibleActivityCount ||
    source.visualRowCount !== source.visibleActivityCount + source.groupCount
  )
    integrity();
  // The existing schedule/configuration protocol admits at most 10,000
  // activities, independently of private-view storage budgets. An unfiltered
  // presentation cannot omit a native activity, even when sorting/grouping.
  if (source.sourceActivityCount > 10_000) integrity();
  const presentation = config.configuration.presentation;
  if (
    presentation.search === "" &&
    presentation.kind === "all" &&
    presentation.wbsId === null &&
    presentation.critical === "all" &&
    source.visibleActivityCount !== source.sourceActivityCount
  )
    integrity();
  const binding = projectionBinding(source.binding, target, config, expectedScheduleRevision);
  const rawRows = array(source.rows, 20_000);
  if (rawRows.length !== source.visualRowCount) integrity();
  const rows: PlannerVisualRowV1[] = [];
  const activities = new Set<string>(),
    nativeIndexes = new Set<number>(),
    groups = new Set<string>(),
    wbsIds = new Set<string>();
  let ordinal = 0,
    groupCount = 0,
    currentGroup: { key: string; expected: number; seen: number } | null = null,
    priorNative = -1;
  const endGroup = () => {
    if (currentGroup !== null && currentGroup.seen !== currentGroup.expected) integrity();
  };
  for (const value of rawRows) {
    // Inspect the discriminant without invoking a getter before the closed row check.
    let kind: unknown;
    try {
      kind = record(value)
        ? (Object.getOwnPropertyDescriptor(value, "kind")?.value as unknown)
        : undefined;
    } catch {
      integrity();
    }
    if (kind === "group") {
      const row = object(value, ["kind", "key", "wbsId", "wbsCode", "wbsName", "activityCount"]);
      const wbsId = identifier(row.wbsId),
        key = `group:wbs:${wbsId}`;
      if (
        config.configuration.presentation.groupBy !== "wbs" ||
        row.key !== key ||
        groups.has(key) ||
        wbsIds.has(wbsId) ||
        !integer(row.activityCount, 1) ||
        row.activityCount > source.visibleActivityCount ||
        typeof row.wbsCode !== "string" ||
        !row.wbsCode.isWellFormed() ||
        [...row.wbsCode].length > 100 ||
        row.wbsCode.includes("\0") ||
        row.wbsCode.trim().length === 0 ||
        typeof row.wbsName !== "string" ||
        !row.wbsName.isWellFormed() ||
        [...row.wbsName].length > 500 ||
        row.wbsName.includes("\0") ||
        row.wbsName.trim().length === 0 ||
        (config.configuration.presentation.wbsId !== null &&
          wbsId !== config.configuration.presentation.wbsId)
      )
        integrity();
      endGroup();
      groups.add(key);
      wbsIds.add(wbsId);
      groupCount++;
      currentGroup = { key, expected: row.activityCount, seen: 0 };
      priorNative = -1;
      rows.push({
        kind: "group",
        key,
        wbsId,
        wbsCode: row.wbsCode,
        wbsName: row.wbsName,
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
        integrity();
      const groupKey =
        config.configuration.presentation.groupBy === "none" ? null : currentGroup?.key;
      if (
        groupKey === undefined ||
        row.groupKey !== groupKey ||
        (config.configuration.presentation.sort.field === "native" &&
          row.nativeIndex <= priorNative)
      )
        integrity();
      ordinal++;
      priorNative = row.nativeIndex;
      activities.add(activityId);
      nativeIndexes.add(row.nativeIndex);
      if (currentGroup) currentGroup.seen++;
      const activity: PlannerActivityRowV1 = {
        kind: "activity",
        activityId,
        nativeIndex: row.nativeIndex,
        displayOrdinal: ordinal,
        groupKey,
      };
      rows.push(activity);
    } else integrity();
  }
  endGroup();
  if (
    ordinal !== source.visibleActivityCount ||
    groupCount !== source.groupCount ||
    (config.configuration.presentation.groupBy === "none" && groupCount !== 0)
  )
    integrity();
  const result: AvailableViewProjectionV1 = {
    available: true,
    rows,
    sourceActivityCount: source.sourceActivityCount,
    visibleActivityCount: ordinal,
    visualRowCount: rows.length,
    groupCount,
    binding,
  };
  bounded(result, VIEW_CAPABILITY_LIMITS_V1.projectionBytes);
  rejectCredentials(result);
  return result;
}
