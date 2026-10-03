import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePlannerViewConfigurationHashV1,
  calculatePlannerViewReviewDigestV1,
  NATIVE_PLANNER_PRESENTATION_V1,
  type PlannerViewConfigurationV1,
  type PlannerViewPlanRequestV1,
  type PlannerViewPlanV1,
  type PlannerViewReceiptV1,
  type PlannerViewReviewV1,
} from "@engineo/contracts";
import { hash } from "./artifacts.js";
import { CliError } from "./errors.js";
import type { SessionMaterial } from "./transport.js";
import {
  checkedViewConfiguration,
  checkSavedViewReview,
  checkViewCapabilities,
  checkViewList,
  checkViewOperationStatus,
  checkViewPlan,
  checkViewProjection,
  checkViewRead,
  checkViewReceipt,
  checkViewValidation,
  savedViewReview,
  VIEW_CAPABILITY_LIMITS_V1,
  type AvailableViewProjectionV1,
  type ViewReadV1,
} from "./view-artifacts.js";

// Inert test markers only. These fixtures cannot authenticate or access any service.
const id = (number: number) => `00000000-0000-0000-0000-${number.toString(16).padStart(12, "0")}`;
const target = {
  apiOrigin: "https://api.example.invalid",
  appOrigin: "https://app.example.invalid",
  organizationId: id(1),
  projectId: id(2),
};
const session: SessionMaterial = {
  schemaVersion: 1,
  kind: "engineo-cli-session",
  actorId: id(3),
  sessionId: id(4),
  sessionToken: "inert-session-marker",
  csrfToken: "inert-csrf-marker",
};
const newSession = { ...session, sessionId: id(14) };
const operationWindowId = "2020-01-02";
const operationId = id(6);
function config(name = "My tasks"): PlannerViewConfigurationV1 {
  return {
    schemaVersion: 1,
    kind: "engineo-planner-view",
    name,
    visibility: "private",
    presentation: {
      ...NATIVE_PLANNER_PRESENTATION_V1,
      sort: { field: "native", direction: "asc" },
    },
  };
}
const configHash = (value: PlannerViewConfigurationV1) =>
  calculatePlannerViewConfigurationHashV1(value, hash);
function read(configuration = config("Previous")): ViewReadV1 {
  return {
    schemaVersion: 1,
    viewId: id(5),
    viewRevision: 2,
    configuration,
    configHashSha256: configHash(configuration),
    createdAt: "2020-01-01T12:00:00.000Z",
    updatedAt: "2020-01-02T12:00:00.000Z",
  };
}
function plan(
  action: "create" | "update" | "delete" = "create",
  desired = config(),
): PlannerViewPlanV1 {
  const base = action === "create" ? null : config("Previous");
  const review: PlannerViewReviewV1 = {
    schemaVersion: 1,
    kind: "engineo-planner-view-review",
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    action,
    viewId: action === "create" ? null : id(5),
    actorId: session.actorId,
    sessionId: session.sessionId,
    organizationId: target.organizationId,
    projectId: target.projectId,
    expectedViewRevision: action === "create" ? 0 : 2,
    expectedScheduleRevision: 7,
    baseConfigHash: base === null ? null : configHash(base),
    desiredConfigHash: action === "delete" ? null : configHash(desired),
    baseConfiguration: base,
    desiredConfiguration: action === "delete" ? null : desired,
    operationWindowId,
    operationId,
    issuedAt: "2020-01-02T12:00:00.000Z",
    expiresAt: "2020-01-02T12:15:00.000Z",
  };
  return { review, reviewedDigest: calculatePlannerViewReviewDigestV1(review, hash) };
}
function request(value: PlannerViewPlanV1): PlannerViewPlanRequestV1 {
  const review = value.review;
  const common = {
    operationWindowId: review.operationWindowId,
    operationId: review.operationId,
    expectedScheduleRevision: review.expectedScheduleRevision,
  };
  if (review.action === "create") {
    assert.ok(review.desiredConfiguration !== null);
    return { ...common, action: "create", configuration: review.desiredConfiguration };
  }
  assert.ok(review.viewId !== null);
  if (review.action === "update") {
    assert.ok(review.desiredConfiguration !== null);
    return {
      ...common,
      action: "update",
      viewId: review.viewId,
      expectedViewRevision: review.expectedViewRevision,
      configuration: review.desiredConfiguration,
    };
  }
  return {
    ...common,
    action: "delete",
    viewId: review.viewId,
    expectedViewRevision: review.expectedViewRevision,
  };
}
function receipt(value: PlannerViewPlanV1): PlannerViewReceiptV1 {
  const review = value.review;
  const noOp = review.action === "update" && review.baseConfigHash === review.desiredConfigHash;
  return {
    schemaVersion: 1,
    kind: "engineo-planner-view-receipt",
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    action: review.action,
    outcome: review.action === "delete" ? "deleted" : noOp ? "no_op" : "applied",
    viewId: review.viewId ?? id(5),
    actorId: review.actorId,
    sessionId: review.sessionId,
    organizationId: review.organizationId,
    projectId: review.projectId,
    previousViewRevision: review.expectedViewRevision,
    committedViewRevision:
      review.action === "delete" ? null : review.expectedViewRevision + (noOp ? 0 : 1),
    expectedScheduleRevision: review.expectedScheduleRevision,
    baseConfigHash: review.baseConfigHash,
    desiredConfigHash: review.desiredConfigHash,
    operationWindowId: review.operationWindowId,
    operationId: review.operationId,
    reviewedDigest: value.reviewedDigest,
    auditId: id(7),
    recordedAt: "2020-01-02T12:05:00.000Z",
  };
}
function assertIntegrity(action: () => unknown): void {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof CliError &&
      error.category === "integrity" &&
      error.code === "invalid_response",
  );
}
function capabilities() {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    visibility: ["private"],
    actions: ["create", "update", "delete"],
    capabilities: ["project.read", "view.private.write"],
    builtIn: { id: "native", immutable: true },
    operationWindowId,
    operationWindowClosesAt: "2020-01-03T00:00:00.000Z",
    operationReplayUntil: "2020-01-04T00:00:00.000Z",
    limits: { ...VIEW_CAPABILITY_LIMITS_V1 },
  };
}
function projection(configuration = config()): AvailableViewProjectionV1 {
  return {
    available: true,
    rows: [
      { kind: "activity", activityId: id(10), nativeIndex: 0, displayOrdinal: 1, groupKey: null },
      { kind: "activity", activityId: id(11), nativeIndex: 2, displayOrdinal: 2, groupKey: null },
    ],
    sourceActivityCount: 3,
    visibleActivityCount: 2,
    visualRowCount: 2,
    groupCount: 0,
    binding: {
      organizationId: target.organizationId,
      projectId: target.projectId,
      scheduleRevision: 7,
      inputHashSha256: hash("inert-input-fixture"),
      inputState: "saved",
      projectionVersion: 1,
      normalizationVersion: 1,
      configHashSha256: configHash(configuration),
    },
  };
}

test("view source uses duplicate-aware original-byte configuration parsing and independent canonical hashing", () => {
  const configuration = config("  My tasks  ");
  configuration.presentation.search = "  visible  ";
  const checked = checkedViewConfiguration(JSON.stringify(configuration));
  assert.equal(checked.configuration.name, "My tasks");
  assert.equal(checked.configuration.presentation.search, "visible");
  assert.equal(checked.configHashSha256, configHash(checked.configuration));
  assert.deepEqual(checked.diagnostics, { issues: [], totalCount: 0, truncated: false });
  const source = JSON.stringify(config());
  const failures = [
    source.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    source.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1'),
    source.replace('"schemaVersion":1', '"schemaVersion":1.0'),
    source.replace('"schemaVersion":1', '"schemaVersion":1e0'),
    source.replace('"schemaVersion":1', '"schemaVersion":-0'),
    source.replace('"schemaVersion":1', '"schemaVersion":9007199254740993'),
    source.replace('"schemaVersion":1', '"schemaVersion":1,"untrusted-inert-marker":true'),
    source.replace('"schemaVersion":1', '"schemaVersion":1,"__proto__":{}'),
    source.slice(0, -1),
    " ".repeat(8193) + source,
  ];
  for (const failure of failures) {
    assert.throws(
      () => checkedViewConfiguration(failure),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.category, "validation");
        assert.equal(error.code, "view_configuration_invalid");
        assert.ok(!JSON.stringify(error).includes("untrusted-inert-marker"));
        const details = error.details as { issues: Array<{ path: string; message: string }> };
        assert.ok(
          details.issues.every((issue) => issue.path === "" && issue.message === error.message),
        );
        return true;
      },
    );
  }
  assert.throws(
    () =>
      checkedViewConfiguration(JSON.stringify(config("inert-session-marker")), [
        session.sessionToken,
      ]),
    (error: unknown) => error instanceof CliError && error.code === "credentials_in_artifact",
  );
});

test("view read is closed, hash bound and independently normalized", () => {
  const original = read(),
    checked = checkViewRead(original, original.viewId);
  assert.deepEqual(checked, original);
  assert.notEqual(checked, original);
  assert.notEqual(checked.configuration, original.configuration);
  original.configuration.name = "Mutated source";
  assert.equal(checked.configuration.name, "Previous");
  for (const patch of [
    { viewId: id(99) },
    { viewRevision: 0 },
    { viewRevision: -0 },
    { configHashSha256: hash("wrong") },
    { schemaVersion: 2 },
    { updatedAt: "2020-01-01T00:00:00.000Z" },
    { actorId: id(3) },
  ])
    assertIntegrity(() => checkViewRead({ ...read(), ...patch }, id(5)));
});

test("view list is bounded, private, closed and has no fabricated identity or count fields", () => {
  const row = (viewId: string) => ({
    viewId,
    viewRevision: 1,
    name: "My tasks",
    configHashSha256: configHash(config()),
    updatedAt: "2020-01-02T12:00:00.000Z",
  });
  const page = {
    schemaVersion: 1,
    builtIn: { id: "native", immutable: true },
    views: [row(id(5)), row(id(6))],
    nextCursor: id(6),
  };
  assert.deepEqual(checkViewList(page, 2, id(4)), page);
  assert.deepEqual(checkViewList({ ...page, views: [], nextCursor: null }, 50).views, []);
  for (const bad of [
    { ...page, count: 2 },
    { ...page, actorId: id(3) },
    { ...page, scope: "private" },
    { ...page, builtIn: { id: "native", immutable: false } },
    { ...page, views: [row(id(5)), row(id(5))] },
    { ...page, nextCursor: "invalid" },
    { ...page, views: [{ ...row(id(5)), name: "Native" }] },
  ])
    assertIntegrity(() => checkViewList(bad, 2));
  assertIntegrity(() => checkViewList(page, 1));
  assertIntegrity(() => checkViewList(page, 51));
  assert.deepEqual(checkViewList(page, 2, id(5)), page);
  assertIntegrity(() => checkViewList(page, 2, "invalid"));
  const nameOrdered = {
    ...page,
    views: [
      { ...row(id(9)), name: "A" },
      { ...row(id(5)), name: "B" },
    ],
    nextCursor: null,
  };
  assert.deepEqual(checkViewList(nameOrdered, 2), nameOrdered);
  assertIntegrity(() =>
    checkViewList({ ...nameOrdered, views: nameOrdered.views.toReversed() }, 2),
  );
});

test("capabilities advertise the exact protocol, limits and coherent UTC window only", () => {
  const value = capabilities();
  assert.deepEqual(checkViewCapabilities(value), value);
  for (const patch of [
    { actorId: id(3) },
    { projectId: target.projectId },
    { protocolVersion: 2 },
    { actions: ["create", "update", "delete", "publish"] },
    { visibility: ["public"] },
    { operationWindowClosesAt: "2020-01-04T00:00:00.000Z" },
    { operationReplayUntil: "2020-01-05T00:00:00.000Z" },
    { operationWindowId: "2020-02-31" },
    { limits: { ...value.limits, depth: 9 } },
    { limits: { ...value.limits, newLimit: 1 } },
  ])
    assertIntegrity(() => checkViewCapabilities({ ...value, ...patch }));
});

test("view validation binds normalization, revision, diagnostics and calculation-dependent activation", () => {
  for (const altered of [
    config(),
    { ...config(), presentation: { ...config().presentation, critical: "critical" as const } },
    {
      ...config(),
      presentation: {
        ...config().presentation,
        sort: { field: "earlyStart" as const, direction: "asc" as const },
      },
    },
    {
      ...config(),
      presentation: {
        ...config().presentation,
        sort: { field: "totalFloatMinutes" as const, direction: "desc" as const },
      },
    },
  ]) {
    const checked = checkedViewConfiguration(JSON.stringify(altered));
    const activation =
      altered.presentation.critical === "all" &&
      !["earlyStart", "totalFloatMinutes"].includes(altered.presentation.sort.field);
    const response = {
      schemaVersion: 1,
      valid: true,
      normalizedConfiguration: altered,
      configHashSha256: checked.configHashSha256,
      observedScheduleRevision: 7,
      activationAvailable: activation,
      calculationChecked: false,
      diagnostics: checked.diagnostics,
    };
    assert.deepEqual(checkViewValidation(response, checked), response);
    assertIntegrity(() =>
      checkViewValidation({ ...response, activationAvailable: !activation }, checked),
    );
    assertIntegrity(() => checkViewValidation({ ...response, calculationChecked: true }, checked));
    assertIntegrity(() =>
      checkViewValidation({ ...response, observedScheduleRevision: 0 }, checked),
    );
    assertIntegrity(() =>
      checkViewValidation({ ...response, configHashSha256: hash("wrong") }, checked),
    );
    assertIntegrity(() =>
      checkViewValidation({ ...response, normalizedConfiguration: config("Other") }, checked),
    );
    assertIntegrity(() =>
      checkViewValidation(
        { ...response, diagnostics: { issues: [], totalCount: 1, truncated: true } },
        checked,
      ),
    );
  }
});

test("create, update, delete and no-op plans bind exact request, identity and independently checked base", () => {
  for (const value of [
    plan(),
    plan("update"),
    plan("delete"),
    plan("update", config("Previous")),
  ]) {
    const base = value.review.action === "create" ? undefined : read();
    assert.deepEqual(checkViewPlan(value, target, session, request(value), base), value);
    const returned = checkViewPlan(value, target, session, request(value), base);
    assert.notEqual(returned.review, value.review);
    assert.notEqual(
      returned.review.desiredConfiguration,
      value.review.desiredConfiguration === null ? {} : value.review.desiredConfiguration,
    );
  }
  const value = plan("update"),
    expected = request(value);
  const mutate = (patch: Partial<PlannerViewReviewV1>) => {
    const review = { ...value.review, ...patch };
    return { review, reviewedDigest: calculatePlannerViewReviewDigestV1(review, hash) };
  };
  for (const patch of [
    { actorId: id(99) },
    { sessionId: id(99) },
    { organizationId: id(99) },
    { projectId: id(99) },
    { operationId: id(99) },
    { expectedScheduleRevision: 8 },
    { expectedViewRevision: 3 },
    { viewId: id(99) },
    { desiredConfigHash: hash("wrong") },
    { baseConfigHash: hash("wrong") },
  ])
    assertIntegrity(() => checkViewPlan(mutate(patch), target, session, expected, read()));
  assertIntegrity(() =>
    checkViewPlan({ ...value, reviewedDigest: hash("wrong") }, target, session, expected),
  );
  assertIntegrity(() => checkViewPlan({ ...value, extra: true }, target, session, expected));
  assertIntegrity(() =>
    checkViewPlan(value, target, session, { ...expected, operationWindowId: "2020-01-03" }),
  );
  assertIntegrity(() =>
    checkViewPlan(value, target, session, expected, read(config("Other base"))),
  );
  assertIntegrity(() => checkViewPlan(plan(), target, session, request(plan()), read()));
});

test("saved reviews match destination and current creator session unless historical session is explicitly allowed", () => {
  const value = plan("update"),
    saved = savedViewReview(value, target);
  assert.deepEqual(checkSavedViewReview(saved, target, session, 7), saved);
  assert.deepEqual(checkSavedViewReview(saved, target, newSession, undefined, true), saved);
  assert.throws(
    () => checkSavedViewReview(saved, target, newSession, 7),
    (error: unknown) => error instanceof CliError && error.code === "review_identity_mismatch",
  );
  assert.throws(
    () => checkSavedViewReview(saved, target, { ...newSession, actorId: id(99) }, 7, true),
    (error: unknown) => error instanceof CliError && error.code === "review_identity_mismatch",
  );
  assert.throws(
    () =>
      checkSavedViewReview(
        saved,
        { ...target, apiOrigin: "https://other.example.invalid" },
        session,
        7,
      ),
    (error: unknown) => error instanceof CliError && error.code === "review_destination_mismatch",
  );
  assert.throws(
    () => checkSavedViewReview(saved, target, session, 8),
    (error: unknown) => error instanceof CliError && error.code === "review_revision_mismatch",
  );
  assertIntegrity(() =>
    checkSavedViewReview({ ...saved, destination: { ...target, other: true } }, target, session),
  );
  assertIntegrity(() =>
    checkSavedViewReview(
      { ...saved, plan: { ...value, reviewedDigest: hash("wrong") } },
      target,
      session,
    ),
  );
});

test("bare receipts bind create, update, deletion and no-op outcomes, including historical replay from a new session", () => {
  for (const value of [
    plan(),
    plan("update"),
    plan("delete"),
    plan("update", config("Previous")),
  ]) {
    const recorded = receipt(value);
    assert.deepEqual(
      checkViewReceipt(recorded, target, session, operationWindowId, operationId, value),
      recorded,
    );
    assert.deepEqual(
      checkViewReceipt(recorded, target, newSession, operationWindowId, operationId, value),
      recorded,
    );
    assert.deepEqual(
      checkViewReceipt(recorded, target, newSession, operationWindowId, operationId),
      recorded,
    );
    assertIntegrity(() =>
      checkViewReceipt(
        { receipt: recorded },
        target,
        session,
        operationWindowId,
        operationId,
        value,
      ),
    );
    for (const patch of [
      { actorId: id(99) },
      { sessionId: newSession.sessionId },
      { organizationId: id(99) },
      { projectId: id(99) },
      { expectedScheduleRevision: 8 },
      { reviewedDigest: hash("wrong") },
      { operationId: id(99) },
      { recordedAt: "2020-01-02T12:15:00.000Z" },
      { recordedAt: "2020-01-02T11:59:59.999Z" },
    ])
      assertIntegrity(() =>
        checkViewReceipt(
          { ...recorded, ...patch },
          target,
          session,
          operationWindowId,
          operationId,
          value,
        ),
      );
  }
  const value = plan("update"),
    recorded = receipt(value);
  for (const patch of [
    { baseConfigHash: hash("wrong") },
    { desiredConfigHash: hash("wrong") },
    { previousViewRevision: 3, committedViewRevision: 4 },
    { outcome: "no_op", committedViewRevision: 2 },
    { viewId: id(99) },
    { auditId: "invalid" },
    { operationWindowId: "2020-01-03", recordedAt: "2020-01-03T00:05:00.000Z" },
  ])
    assertIntegrity(() =>
      checkViewReceipt(
        { ...recorded, ...patch },
        target,
        session,
        operationWindowId,
        operationId,
        value,
      ),
    );
});

test("open absence stays uncertain, closed absence is definitive, and recorded receipts remain historical", () => {
  const value = plan(),
    recorded = receipt(value);
  const status = {
    schemaVersion: 1,
    status: "not_recorded",
    operationWindowId,
    operationId,
    windowClosed: false,
    absenceDefinitive: false,
    receipt: null,
  };
  assert.deepEqual(
    checkViewOperationStatus(status, target, session, operationWindowId, operationId),
    status,
  );
  const closed = { ...status, windowClosed: true, absenceDefinitive: true };
  assert.deepEqual(
    checkViewOperationStatus(closed, target, newSession, operationWindowId, operationId, value),
    closed,
  );
  const found = { ...status, status: "recorded", windowClosed: true, receipt: recorded };
  assert.deepEqual(
    checkViewOperationStatus(found, target, newSession, operationWindowId, operationId, value),
    found,
  );
  for (const bad of [
    { ...status, absenceDefinitive: true },
    { ...closed, absenceDefinitive: false },
    { ...status, status: "recorded" },
    { ...found, absenceDefinitive: true },
    { ...found, status: "not_recorded" },
    { ...status, operationId: id(99) },
    { ...status, operationWindowId: "2020-01-03" },
    { ...status, unknown: true },
  ])
    assertIntegrity(() =>
      checkViewOperationStatus(bad, target, session, operationWindowId, operationId, value),
    );
});

test("projection binds exact saved input target, revision, configuration and calculation requirement", () => {
  const configuration = config(),
    value = projection(configuration);
  assert.deepEqual(checkViewProjection(value, target, configuration, 7), value);
  for (const patch of [
    { organizationId: id(99) },
    { projectId: id(99) },
    { scheduleRevision: 8 },
    { inputState: "unsaved" },
    { inputHashSha256: "wrong" },
    { configHashSha256: hash("wrong") },
    { projectionVersion: 2 },
    { normalizationVersion: 2 },
    { unknown: true },
    { calculation: {} },
  ])
    assertIntegrity(() =>
      checkViewProjection(
        { ...value, binding: { ...value.binding, ...patch } },
        target,
        configuration,
        7,
      ),
    );
  assertIntegrity(() =>
    checkViewProjection({ schemaVersion: 1, projection: value }, target, configuration, 7),
  );
  assertIntegrity(() =>
    checkViewProjection({ ...value, available: false }, target, configuration, 7),
  );
  const calculated = config();
  calculated.presentation.critical = "critical";
  const withCalculation = projection(calculated);
  assertIntegrity(() => checkViewProjection(withCalculation, target, calculated, 7));
  withCalculation.binding.calculation = {
    calculationId: id(17),
    resultHashSha256: hash("inert-result-fixture"),
    engineContractVersion: 1,
    engineVersion: "fixture-engine-v1",
  };
  assert.deepEqual(checkViewProjection(withCalculation, target, calculated, 7), withCalculation);
  assertIntegrity(() =>
    checkViewProjection(
      {
        ...withCalculation,
        binding: {
          ...withCalculation.binding,
          calculation: { ...withCalculation.binding.calculation, unexpected: true },
        },
      },
      target,
      calculated,
      7,
    ),
  );
});

test("projection rejects corrupt counts, duplicate identities, ordinal gaps and non-native ordering", () => {
  const configuration = config(),
    value = projection();
  for (const patch of [
    { sourceActivityCount: 1 },
    { visibleActivityCount: 1 },
    { visualRowCount: 3 },
    { groupCount: 1 },
    { sourceActivityCount: -0 },
    { visualRowCount: 2.5 },
    { unknown: true },
  ])
    assertIntegrity(() => checkViewProjection({ ...value, ...patch }, target, configuration, 7));
  const a = value.rows[0],
    b = value.rows[1];
  assert.ok(a && b);
  for (const rows of [
    [a, { ...b, activityId: id(10) }],
    [a, { ...b, nativeIndex: 0 }],
    [a, { ...b, displayOrdinal: 3 }],
    [a, { ...b, nativeIndex: 3 }],
    [
      { ...a, nativeIndex: 2 },
      { ...b, nativeIndex: 0 },
    ],
    [a, { ...b, groupKey: "group:wbs:missing" }],
    [a, { ...b, arbitrary: true }],
  ])
    assertIntegrity(() => checkViewProjection({ ...value, rows }, target, configuration, 7));
});

test("WBS projections require unique nonempty headers, contiguous membership, exact counts and native order within each group", () => {
  const configuration = config();
  configuration.presentation.groupBy = "wbs";
  const value = projection(configuration),
    keyA = `group:wbs:${id(20)}`,
    keyB = `group:wbs:${id(21)}`;
  value.rows = [
    { kind: "group", key: keyA, wbsId: id(20), wbsCode: "A", wbsName: "Group A", activityCount: 1 },
    { kind: "activity", activityId: id(10), nativeIndex: 2, displayOrdinal: 1, groupKey: keyA },
    { kind: "group", key: keyB, wbsId: id(21), wbsCode: "B", wbsName: "Group B", activityCount: 1 },
    { kind: "activity", activityId: id(11), nativeIndex: 0, displayOrdinal: 2, groupKey: keyB },
  ];
  value.groupCount = 2;
  value.visualRowCount = 4;
  assert.deepEqual(checkViewProjection(value, target, configuration, 7), value);
  const [gA, a, gB, b] = value.rows;
  for (const rows of [
    [gA, { ...a, groupKey: keyB }, gB, b],
    [{ ...gA, activityCount: 2 }, a, gB, b],
    [{ ...gA, activityCount: 0 }, a, gB, b],
    [gA, a, { ...gB, wbsId: id(20), key: keyA }, b],
    [{ ...gA, key: "arbitrary-group-key" }, a, gB, b],
    [a, gA, gB, b],
    [gA, gB, a, b],
  ])
    assertIntegrity(() => checkViewProjection({ ...value, rows }, target, configuration, 7));
  const together = {
    ...value,
    rows: [{ ...gA, activityCount: 2 }, a, { ...b, groupKey: keyA }],
    groupCount: 1,
    visualRowCount: 3,
  };
  assertIntegrity(() => checkViewProjection(together, target, configuration, 7));
  configuration.presentation.sort.field = "name";
  together.binding = { ...value.binding, configHashSha256: configHash(configuration) };
  assert.equal(checkViewProjection(together, target, configuration, 7).visibleActivityCount, 2);
  configuration.presentation.wbsId = id(20);
  assertIntegrity(() =>
    checkViewProjection(
      { ...value, binding: { ...value.binding, configHashSha256: configHash(configuration) } },
      target,
      configuration,
      7,
    ),
  );
});

test("valid empty available projections remain valid with and without WBS grouping", () => {
  for (const groupBy of ["none", "wbs"] as const) {
    const configuration = config();
    configuration.presentation.groupBy = groupBy;
    const value = projection(configuration);
    value.rows = [];
    value.visibleActivityCount = 0;
    value.visualRowCount = 0;
    value.groupCount = 0;
    assert.deepEqual(checkViewProjection(value, target, configuration, 7), value);
    value.sourceActivityCount = 0;
    assert.deepEqual(checkViewProjection(value, target, configuration, 7), value);
  }
});

test("boundary objects reject accessors and symbol/extra array properties without invoking getters", () => {
  let invoked = false;
  const value = read();
  Object.defineProperty(value, "viewId", {
    enumerable: true,
    get() {
      invoked = true;
      return id(5);
    },
  });
  assertIntegrity(() => checkViewRead(value, id(5)));
  assert.equal(invoked, false);
  assertIntegrity(() => checkViewRead({ ...read(), [Symbol("unknown")]: true }, id(5)));
  const projected = projection();
  Object.defineProperty(projected.rows, "extra", { enumerable: true, value: true });
  assertIntegrity(() => checkViewProjection(projected, target, config(), 7));
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assertIntegrity(() => checkViewRead(revoked.proxy, id(5)));
  const hostile = projection();
  hostile.rows = [
    new Proxy(hostile.rows[0] as object, {
      getOwnPropertyDescriptor() {
        throw new Error("untrusted-inert-marker");
      },
    }),
  ] as AvailableViewProjectionV1["rows"];
  hostile.visualRowCount = 1;
  hostile.visibleActivityCount = 1;
  assertIntegrity(() => checkViewProjection(hostile, target, config(), 7));
});
