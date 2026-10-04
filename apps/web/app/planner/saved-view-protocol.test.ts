import assert from "node:assert/strict";
import test from "node:test";
import type {
  PlannerViewActionV1,
  PlannerViewConfigurationV1,
  PlannerViewPlanRequestV1,
  PlannerViewPlanV1,
  PlannerViewReceiptV1,
  PlannerViewReviewV1,
} from "@engineo/contracts";
import {
  checkHistoricalViewPlan,
  checkSavedViewCapabilities,
  checkSavedViewList,
  checkSavedViewOperationStatus,
  checkSavedViewPlan,
  checkSavedViewProjection,
  checkSavedViewRead,
  checkSavedViewReceipt,
  checkSavedViewValidation,
  checkedViewConfiguration,
  parseSavedViewJson,
  SavedViewProtocolError,
  type AvailableViewProjectionV1,
  type ViewCapabilitiesV1,
  type ViewReadV1,
  type ViewResponseBindingV1,
  VIEW_CAPABILITY_LIMITS_V1,
} from "./saved-view-protocol.js";

const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const context: ViewResponseBindingV1 = {
  actorId: id(1),
  sessionId: id(2),
  organizationId: id(3),
  projectId: id(4),
};
const timestamp = "2026-10-03T10:00:00.000Z";
const fakeHash = "a".repeat(64);
function configuration(name = "Important"): PlannerViewConfigurationV1 {
  return {
    schemaVersion: 1,
    kind: "engineo-planner-view",
    name,
    visibility: "private",
    presentation: {
      search: "",
      kind: "all",
      wbsId: null,
      critical: "all",
      sort: { field: "native", direction: "asc" },
      groupBy: "none",
    },
  };
}
async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
/** Independent explicit published canonical envelope, not the checker under test. */
async function configHash(value: PlannerViewConfigurationV1): Promise<string> {
  return digest(
    JSON.stringify({
      kind: "engineo-planner-view-v1-canonical",
      projectionVersion: 1,
      normalizationVersion: 1,
      configuration: value,
    }),
  );
}
async function planDigest(review: PlannerViewReviewV1): Promise<string> {
  return digest(
    `{"kind":"engineo-planner-view-review-v1-canonical","review":${JSON.stringify(review)}}`,
  );
}
function protocolError(error: unknown): boolean {
  assert.ok(error instanceof SavedViewProtocolError);
  assert.equal(error.code, "view_response_invalid");
  assert.equal(
    error.message,
    "The saved-view response could not be verified. Reload before continuing.",
  );
  assert.deepEqual(error.diagnostics, {
    issues: [{ code: error.diagnostics.issues[0]?.code, path: "", message: error.message }],
    totalCount: 1,
    truncated: false,
  });
  assert.ok(error.message.length <= 256);
  return true;
}
async function readFixture(): Promise<ViewReadV1> {
  return {
    schemaVersion: 1,
    viewId: id(5),
    viewRevision: 7,
    configuration: configuration(),
    configHashSha256: await configHash(configuration()),
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: timestamp,
  };
}
function capabilities(): ViewCapabilitiesV1 {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    visibility: ["private"],
    actions: ["create", "update", "delete"],
    capabilities: ["project.read", "view.private.write"],
    builtIn: { id: "native", immutable: true },
    operationWindowId: "2026-10-03",
    operationWindowClosesAt: "2026-10-04T00:00:00.000Z",
    operationReplayUntil: "2026-10-05T00:00:00.000Z",
    limits: { ...VIEW_CAPABILITY_LIMITS_V1 },
  };
}
async function planFixture(action: PlannerViewActionV1 = "update", noOp = false) {
  const base = await readFixture();
  const desired = configuration(noOp ? "Important" : "Renamed");
  const review: PlannerViewReviewV1 = {
    schemaVersion: 1,
    kind: "engineo-planner-view-review",
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    action,
    viewId: action === "create" ? null : base.viewId,
    actorId: context.actorId,
    sessionId: context.sessionId,
    organizationId: context.organizationId,
    projectId: context.projectId,
    expectedViewRevision: action === "create" ? 0 : base.viewRevision,
    expectedScheduleRevision: 9,
    baseConfigHash: action === "create" ? null : base.configHashSha256,
    desiredConfigHash: action === "delete" ? null : await configHash(desired),
    baseConfiguration: action === "create" ? null : base.configuration,
    desiredConfiguration: action === "delete" ? null : desired,
    operationWindowId: "2026-10-03",
    operationId: id(6),
    issuedAt: timestamp,
    expiresAt: "2026-10-03T10:15:00.000Z",
  };
  const operation = {
    operationWindowId: review.operationWindowId,
    operationId: review.operationId,
    expectedScheduleRevision: 9,
  };
  const request: PlannerViewPlanRequestV1 =
    action === "create"
      ? { ...operation, action, configuration: desired }
      : action === "delete"
        ? { ...operation, action, viewId: base.viewId, expectedViewRevision: base.viewRevision }
        : {
            ...operation,
            action,
            viewId: base.viewId,
            expectedViewRevision: base.viewRevision,
            configuration: desired,
          };
  const plan: PlannerViewPlanV1 = { review, reviewedDigest: await planDigest(review) };
  const receipt: PlannerViewReceiptV1 = {
    schemaVersion: 1,
    kind: "engineo-planner-view-receipt",
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    action,
    outcome: action === "delete" ? "deleted" : noOp ? "no_op" : "applied",
    viewId: base.viewId,
    actorId: context.actorId,
    sessionId: context.sessionId,
    organizationId: context.organizationId,
    projectId: context.projectId,
    previousViewRevision: action === "create" ? 0 : base.viewRevision,
    committedViewRevision:
      action === "delete" ? null : action === "create" ? 1 : base.viewRevision + (noOp ? 0 : 1),
    expectedScheduleRevision: 9,
    baseConfigHash: review.baseConfigHash,
    desiredConfigHash: review.desiredConfigHash,
    operationWindowId: review.operationWindowId,
    operationId: review.operationId,
    reviewedDigest: plan.reviewedDigest,
    auditId: id(7),
    recordedAt: "2026-10-03T10:00:01.000Z",
  };
  return { plan, request, base, receipt };
}
async function projectionFixture(calculated = false, grouped = false) {
  const config = configuration();
  if (calculated) config.presentation.critical = "critical";
  if (grouped) config.presentation.groupBy = "wbs";
  const configHashSha256 = await configHash(config);
  const expected = {
    organizationId: context.organizationId,
    projectId: context.projectId,
    scheduleRevision: 9,
    inputHashSha256: fakeHash,
    configHashSha256,
  };
  const key = grouped ? `group:wbs:${id(10)}` : null;
  const projection: AvailableViewProjectionV1 = {
    available: true,
    rows: [
      ...(grouped
        ? [
            {
              kind: "group" as const,
              key: key as string,
              wbsId: id(10),
              wbsCode: "1",
              wbsName: "Phase",
              activityCount: 2,
            },
          ]
        : []),
      { kind: "activity", activityId: id(11), nativeIndex: 0, displayOrdinal: 1, groupKey: key },
      { kind: "activity", activityId: id(12), nativeIndex: 1, displayOrdinal: 2, groupKey: key },
    ],
    sourceActivityCount: 2,
    visibleActivityCount: 2,
    visualRowCount: grouped ? 3 : 2,
    groupCount: grouped ? 1 : 0,
    binding: {
      ...expected,
      inputState: "saved",
      projectionVersion: 1,
      normalizationVersion: 1,
      ...(calculated
        ? {
            calculation: {
              calculationId: id(13),
              resultHashSha256: "b".repeat(64),
              engineContractVersion: 1 as const,
              engineVersion: "engineo-1.0.0",
            },
          }
        : {}),
    },
  };
  return { config, expected, projection };
}

test("original JSON parser accepts null-prototype data and exact safe integers", () => {
  const parsed = parseSavedViewJson('{"a":9007199254740991,"b":[true,null,"\\u0061"]}');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.deepEqual({ ...(parsed as object) }, { a: Number.MAX_SAFE_INTEGER, b: [true, null, "a"] });
  assert.deepEqual(parseSavedViewJson(new TextEncoder().encode("[0,-1,1]")), [0, -1, 1]);
});
for (const source of [
  '{"secret-key":1,"secret-\\u006bey":2}',
  '{"__proto__":{}}',
  '{"constructor":{}}',
  '{"prototype":{}}',
  '{"value":-0}',
  '{"value":1.0}',
  '{"value":1e0}',
  '{"value":9007199254740992}',
  '{"value":"\\ud800"}',
  '{"value":01}',
  '{"value":1,}',
  "[true,]",
  "{} {}",
  "\ufeff{}",
  `${"[".repeat(9)}0${"]".repeat(9)}`,
]) {
  test(`original JSON parser rejects hostile or noncanonical case ${JSON.stringify(source).slice(0, 35)}`, () => {
    assert.throws(() => parseSavedViewJson(source), protocolError);
  });
}
test("original byte parser uses fatal UTF-8 and byte/depth/array limits", () => {
  assert.throws(() => parseSavedViewJson(new Uint8Array([0xc0, 0xaf])), protocolError);
  assert.throws(() => parseSavedViewJson('"é"', 3), protocolError);
  assert.throws(() => parseSavedViewJson('"a"', 0), protocolError);
  assert.throws(() => parseSavedViewJson("[]", 4194305), protocolError);
  assert.throws(
    () => parseSavedViewJson(JSON.stringify(Array(20001).fill(0)), 4194304),
    protocolError,
  );
  assert.deepEqual(parseSavedViewJson(`${"[".repeat(8)}0${"]".repeat(8)}`), [[[[[[[[0]]]]]]]]);
  const large = JSON.stringify({ text: "a".repeat(70000) });
  assert.throws(() => parseSavedViewJson(large), protocolError);
  assert.equal((parseSavedViewJson(large, 4194304) as { text: string }).text.length, 70000);
});
test("configuration is normalized and hashed using the exact private-view domain", async () => {
  const input = configuration("  Important  ");
  input.presentation.search = "  design\twork  ";
  const expected = configuration();
  expected.presentation.search = "design\twork";
  const checked = await checkedViewConfiguration(input);
  assert.deepEqual(checked.configuration, expected);
  assert.equal(checked.configHashSha256, await configHash(expected));
  assert.equal(checked.configHashSha256.length, 64);
  assert.deepEqual(input.name, "  Important  ");
  checked.configuration.name = "Local copy";
  assert.equal(input.name, "  Important  ");
});
test("inert checks reject accessors, cycles, symbols, exotic objects, holes and hooks without invoking them", async () => {
  let called = 0;
  const accessor = configuration();
  Object.defineProperty(accessor, "name", {
    enumerable: true,
    get: () => {
      called++;
      return "Secret";
    },
  });
  const hook = {
    ...configuration(),
    toJSON: () => {
      called++;
      return configuration();
    },
  };
  const cyclic: Record<string, unknown> = { ...configuration() };
  cyclic.loop = cyclic;
  const symbol = { ...configuration(), [Symbol("secret")]: "secret" };
  const nonenumerable = configuration();
  Object.defineProperty(nonenumerable, "name", { value: "Secret", enumerable: false });
  for (const value of [
    accessor,
    hook,
    cyclic,
    symbol,
    nonenumerable,
    new Date(),
    Object.assign(Object.create({ inherited: true }), configuration()),
  ]) {
    await assert.rejects(checkedViewConfiguration(value), protocolError);
  }
  assert.equal(called, 0);
  assert.throws(
    () =>
      checkSavedViewList({
        schemaVersion: 1,
        builtIn: { id: "native", immutable: true },
        views: Array(1),
        nextCursor: null,
      }),
    protocolError,
  );
});
test("safe diagnostics never expose unknown property names or source values", async () => {
  const secret = "private-user-token-THIS-MUST-NOT-LEAK";
  await assert.rejects(
    checkedViewConfiguration({ ...configuration(), [secret]: secret }),
    (error) => {
      protocolError(error);
      assert.equal(JSON.stringify(error).includes(secret), false);
      return true;
    },
  );
});
test("list validates UTF-8 name order, UUID ties, pagination and immutable Native", () => {
  const row = (viewId: string, name: string) => ({
    viewId,
    name,
    viewRevision: 1,
    configHashSha256: fakeHash,
    updatedAt: timestamp,
  });
  const source = {
    schemaVersion: 1,
    builtIn: { id: "native", immutable: true },
    views: [row(id(5), "A"), row(id(6), "Z")],
    nextCursor: id(6),
  };
  assert.deepEqual(checkSavedViewList(source, 2), source);
  assert.equal(
    checkSavedViewList({ ...source, views: [row(id(5), "  A  ")], nextCursor: null }).views[0]
      ?.name,
    "A",
  );
  for (const value of [
    { ...source, views: [row(id(6), "Z"), row(id(5), "A")] },
    { ...source, views: [row(id(5), "A"), row(id(5), "B")] },
    { ...source, views: [row(id(6), "A"), row(id(5), "A")] },
    { ...source, nextCursor: id(20) },
    { ...source, views: [], nextCursor: id(6) },
    { ...source, builtIn: { id: "native", immutable: false } },
    { ...source, views: [row(id(5), "Native")], nextCursor: null },
    { ...source, schemaVersion: 2 },
    { ...source, secret: "hidden" },
  ])
    assert.throws(() => checkSavedViewList(value, 2), protocolError);
  assert.throws(() => checkSavedViewList(source, 0), protocolError);
  assert.throws(() => checkSavedViewList(source, 51), protocolError);
  assert.throws(() => checkSavedViewList(source, 2, id(5)), protocolError);
  // U+E000 precedes U+10000 in UTF-8 although JS UTF-16 comparison orders them oppositely.
  assert.equal(
    checkSavedViewList({ ...source, views: [row(id(5), "\ue000"), row(id(6), "\u{10000}")] }, 2)
      .views.length,
    2,
  );
});
test("read verifies exact target, normalization, independent config hash, revision and timestamps", async () => {
  const fixture = await readFixture();
  assert.deepEqual(await checkSavedViewRead(fixture, id(5).toUpperCase()), fixture);
  assert.deepEqual(
    await checkSavedViewRead({ ...fixture, configuration: configuration("  Important  ") }, id(5)),
    fixture,
  );
  for (const value of [
    { ...fixture, viewId: id(8) },
    { ...fixture, viewRevision: 0 },
    { ...fixture, viewRevision: -0 },
    { ...fixture, configHashSha256: fakeHash },
    { ...fixture, configHashSha256: fixture.configHashSha256.toUpperCase() },
    { ...fixture, createdAt: "2026-10-04T00:00:00.000Z" },
    { ...fixture, updatedAt: "2026-02-30T00:00:00.000Z" },
    { ...fixture, updatedAt: "2026-10-03T10:00:00Z" },
    { ...fixture, schemaVersion: 2 },
  ])
    await assert.rejects(checkSavedViewRead(value, id(5)), protocolError);
});
test("capabilities accept only exact published enums/limits and server window horizons", () => {
  const fixture = capabilities();
  assert.deepEqual(checkSavedViewCapabilities(fixture), fixture);
  for (const value of [
    { ...fixture, operationWindowId: "2026-02-30" },
    { ...fixture, operationWindowId: "9999-12-30" },
    { ...fixture, operationWindowClosesAt: "2026-10-03T23:59:59.999Z" },
    { ...fixture, operationReplayUntil: "2026-10-06T00:00:00.000Z" },
    { ...fixture, limits: { ...fixture.limits, pageSize: 500 } },
    { ...fixture, capabilities: ["view.private.write", "project.read"] },
    { ...fixture, visibility: ["public"] },
    { ...fixture, actions: ["create", "update", "delete", "share"] },
    { ...fixture, normalizationVersion: 2 },
  ])
    assert.throws(() => checkSavedViewCapabilities(value), protocolError);
});
test("validation response cannot pretend a calculation was checked or claim calculated activation", async () => {
  for (const calculated of [false, true]) {
    const config = configuration();
    if (calculated) config.presentation.sort = { field: "earlyStart", direction: "asc" };
    const checked = await checkedViewConfiguration(config);
    const fixture = {
      schemaVersion: 1,
      valid: true,
      normalizedConfiguration: config,
      configHashSha256: checked.configHashSha256,
      observedScheduleRevision: 9,
      activationAvailable: !calculated,
      calculationChecked: false,
      diagnostics: { issues: [], totalCount: 0, truncated: false },
    };
    assert.equal(
      (await checkSavedViewValidation(fixture, checked)).activationAvailable,
      !calculated,
    );
    for (const value of [
      { ...fixture, calculationChecked: true },
      { ...fixture, activationAvailable: calculated },
      { ...fixture, configHashSha256: fakeHash },
      { ...fixture, diagnostics: { issues: [], totalCount: 1, truncated: true } },
    ])
      await assert.rejects(checkSavedViewValidation(value, checked), protocolError);
  }
});
for (const action of ["create", "update", "delete"] as const) {
  test(`${action} plan binds exact intent and canonical digest without mutating fixtures`, async () => {
    const { plan, request, base } = await planFixture(action);
    const prior = JSON.stringify(plan);
    assert.deepEqual(
      await checkSavedViewPlan(plan, context, request, action === "create" ? undefined : base),
      plan,
    );
    assert.equal(JSON.stringify(plan), prior);
    await assert.rejects(
      checkSavedViewPlan({ ...plan, reviewedDigest: fakeHash }, context, request),
      protocolError,
    );
  });
}
test("a recomputed valid digest cannot authorize another actor/session/org/project or intent", async () => {
  const { plan, request } = await planFixture();
  for (const key of ["actorId", "sessionId", "organizationId", "projectId"] as const) {
    const changed = structuredClone(plan);
    changed.review[key] = id(30);
    changed.reviewedDigest = await planDigest(changed.review);
    await assert.rejects(checkSavedViewPlan(changed, context, request), protocolError);
  }
  const changed = structuredClone(plan);
  changed.review.desiredConfiguration = configuration("Unrequested");
  changed.review.desiredConfigHash = await configHash(changed.review.desiredConfiguration);
  changed.reviewedDigest = await planDigest(changed.review);
  await assert.rejects(checkSavedViewPlan(changed, context, request), protocolError);
});
test("plan independently verifies config hashes and exact operation/revisions/base", async () => {
  const { plan, request, base } = await planFixture();
  for (const change of [
    { operationId: id(30) },
    { operationWindowId: "2026-10-02" },
    { expectedScheduleRevision: 10 },
    { expectedViewRevision: 8 },
    { viewId: id(30) },
  ])
    await assert.rejects(
      checkSavedViewPlan(plan, context, { ...request, ...change } as PlannerViewPlanRequestV1),
      protocolError,
    );
  const changed = structuredClone(plan);
  changed.review.baseConfigHash = fakeHash;
  changed.reviewedDigest = await planDigest(changed.review);
  await assert.rejects(checkSavedViewPlan(changed, context, request), protocolError);
  await assert.rejects(
    checkSavedViewPlan(plan, context, request, { ...base, viewRevision: 8 }),
    protocolError,
  );
  const foreignBase = await readFixture();
  foreignBase.configuration = configuration("Other base");
  foreignBase.configHashSha256 = await configHash(foreignBase.configuration);
  await assert.rejects(checkSavedViewPlan(plan, context, request, foreignBase), protocolError);
});
test("review versions and canonical timestamp lifetime/window relationships fail closed", async () => {
  const { plan, request } = await planFixture();
  for (const change of [
    { protocolVersion: 2 },
    { expiresAt: "2026-10-03T10:15:00.001Z" },
    { expiresAt: timestamp },
    { issuedAt: "2026-10-02T23:59:59.000Z" },
    { issuedAt: "2026-10-03T23:59:59.000Z", expiresAt: "2026-10-04T00:00:01.000Z" },
    { issuedAt: "2026-10-03T10:00:00Z" },
  ])
    await assert.rejects(
      checkSavedViewPlan(
        { review: { ...plan.review, ...change }, reviewedDigest: plan.reviewedDigest },
        context,
        request,
      ),
      protocolError,
    );
});
for (const [action, noOp] of [
  ["create", false],
  ["update", false],
  ["update", true],
  ["delete", false],
] as const) {
  test(`historical ${action}/${noOp ? "no_op" : "commit"} receipt remains readable after reauthentication`, async () => {
    const { plan, request, receipt } = await planFixture(action, noOp);
    const newSession = { ...context, sessionId: id(99) };
    await assert.rejects(checkSavedViewPlan(plan, newSession, request), protocolError);
    assert.deepEqual(await checkHistoricalViewPlan(plan, newSession), plan);
    assert.deepEqual(
      await checkSavedViewReceipt(receipt, newSession, "2026-10-03", id(6), plan),
      receipt,
    );
    assert.equal(
      (
        await checkSavedViewOperationStatus(
          {
            schemaVersion: 1,
            status: "recorded",
            operationWindowId: "2026-10-03",
            operationId: id(6),
            windowClosed: true,
            absenceDefinitive: false,
            receipt,
          },
          newSession,
          "2026-10-03",
          id(6),
          plan,
        )
      ).receipt?.sessionId,
      context.sessionId,
    );
  });
}
test("historical receipt binds every historical field including original creator session and reviewed time", async () => {
  const { plan, receipt } = await planFixture();
  for (const change of [
    { actorId: id(30) },
    { sessionId: id(30) },
    { organizationId: id(30) },
    { projectId: id(30) },
    { operationId: id(30) },
    { operationWindowId: "2026-10-02" },
    { expectedScheduleRevision: 10 },
    { previousViewRevision: 8, committedViewRevision: 9 },
    { viewId: id(30) },
    { reviewedDigest: fakeHash },
    { baseConfigHash: fakeHash },
    { desiredConfigHash: fakeHash },
    { recordedAt: "2026-10-03T09:59:59.999Z" },
    { recordedAt: "2026-10-03T10:15:00.000Z" },
    { outcome: "no_op" },
    { committedViewRevision: 9 },
    { schemaVersion: 2 },
  ])
    await assert.rejects(
      checkSavedViewReceipt({ ...receipt, ...change }, context, "2026-10-03", id(6), plan),
      protocolError,
    );
  await assert.rejects(
    checkHistoricalViewPlan(plan, { ...context, actorId: id(30) }),
    protocolError,
  );
});
test("status preserves open-window uncertainty and only reports definitive closed absence", async () => {
  const { plan } = await planFixture();
  for (const closed of [false, true]) {
    const value = {
      schemaVersion: 1,
      status: "not_recorded",
      operationWindowId: "2026-10-03",
      operationId: id(6),
      windowClosed: closed,
      absenceDefinitive: closed,
      receipt: null,
    };
    assert.equal(
      (await checkSavedViewOperationStatus(value, context, "2026-10-03", id(6), plan))
        .absenceDefinitive,
      closed,
    );
    await assert.rejects(
      checkSavedViewOperationStatus(
        { ...value, absenceDefinitive: !closed },
        context,
        "2026-10-03",
        id(6),
        plan,
      ),
      protocolError,
    );
    await assert.rejects(
      checkSavedViewOperationStatus(
        { ...value, status: "recorded" },
        context,
        "2026-10-03",
        id(6),
        plan,
      ),
      protocolError,
    );
    await assert.rejects(
      checkSavedViewOperationStatus(
        { ...value, operationId: id(30) },
        context,
        "2026-10-03",
        id(6),
        plan,
      ),
      protocolError,
    );
  }
});
test("projection retains calculation metadata, exact saved-source binding and grouped row counts", async () => {
  for (const calculated of [false, true])
    for (const grouped of [false, true]) {
      const { projection, expected, config } = await projectionFixture(calculated, grouped);
      assert.deepEqual(await checkSavedViewProjection(projection, expected, config), projection);
    }
});
test("projection rejects changed source/config/project/revision and unsupported calculation declarations", async () => {
  const { projection, expected, config } = await projectionFixture(true);
  for (const change of [
    { organizationId: id(30) },
    { projectId: id(30) },
    { scheduleRevision: 10 },
    { inputHashSha256: "c".repeat(64) },
    { configHashSha256: fakeHash },
    { inputState: "unsaved" },
    { projectionVersion: 2 },
    { normalizationVersion: 2 },
    { calculation: undefined },
    { calculation: { ...projection.binding.calculation, engineContractVersion: 2 } },
    { calculation: { ...projection.binding.calculation, engineVersion: "untrusted\nengine" } },
    { calculation: { ...projection.binding.calculation, resultHashSha256: "B".repeat(64) } },
  ])
    await assert.rejects(
      checkSavedViewProjection(
        { ...projection, binding: { ...projection.binding, ...change } },
        expected,
        config,
      ),
      protocolError,
    );
  await assert.rejects(
    checkSavedViewProjection(
      projection,
      { ...expected, inputHashSha256: fakeHash.toUpperCase() },
      config,
    ),
    protocolError,
  );
  const inputOnly = await projectionFixture();
  await assert.rejects(
    checkSavedViewProjection(
      {
        ...inputOnly.projection,
        binding: { ...inputOnly.projection.binding, calculation: projection.binding.calculation },
      },
      inputOnly.expected,
      inputOnly.config,
    ),
    protocolError,
  );
});
test("projection rejects incomplete, duplicate, unbounded and inconsistently ordered activity rows", async () => {
  const { projection, expected, config } = await projectionFixture();
  const first = projection.rows[0],
    second = projection.rows[1];
  assert.ok(first?.kind === "activity" && second?.kind === "activity");
  const cases = [
    { ...projection, rows: [first] },
    { ...projection, rows: [first, { ...second, activityId: first.activityId }] },
    { ...projection, rows: [first, { ...second, nativeIndex: 0 }] },
    { ...projection, rows: [first, { ...second, nativeIndex: 2 }] },
    { ...projection, rows: [first, { ...second, displayOrdinal: 3 }] },
    { ...projection, rows: [first, { ...second, groupKey: `group:wbs:${id(10)}` }] },
    {
      ...projection,
      rows: [
        { ...first, nativeIndex: 1 },
        { ...second, nativeIndex: 0 },
      ],
    },
    { ...projection, visibleActivityCount: 1, visualRowCount: 1, rows: [first] },
    { ...projection, sourceActivityCount: 10001 },
    { ...projection, visualRowCount: 3 },
    { ...projection, groupCount: 1 },
    { ...projection, rows: [first, { ...second, unknown: "secret" }] },
    { ...projection, available: false },
  ];
  for (const value of cases)
    await assert.rejects(checkSavedViewProjection(value, expected, config), protocolError);
});
test("projection groups cannot repeat, be empty, miscount members or mismatch active WBS", async () => {
  const { projection, expected, config } = await projectionFixture(false, true);
  const [group, first, second] = projection.rows;
  assert.ok(group?.kind === "group" && first?.kind === "activity" && second?.kind === "activity");
  for (const rows of [
    [{ ...group, activityCount: 1 }, first, second],
    [{ ...group, activityCount: 0 }, first, second],
    [{ ...group, key: "group:wrong" }, first, second],
    [{ ...group, wbsName: "\0Secret" }, first, second],
    [first, group, second],
    [group, first, group, second],
    [group, first, { ...second, groupKey: `group:wbs:${id(30)}` }],
  ])
    await assert.rejects(
      checkSavedViewProjection(
        { ...projection, rows, visualRowCount: rows.length },
        expected,
        config,
      ),
      protocolError,
    );
  const selected = structuredClone(config);
  selected.presentation.wbsId = id(30);
  const selectedHash = await configHash(selected);
  await assert.rejects(
    checkSavedViewProjection(
      { ...projection, binding: { ...projection.binding, configHashSha256: selectedHash } },
      { ...expected, configHashSha256: selectedHash },
      selected,
    ),
    protocolError,
  );
});
test("direct response checks bound raw DTO bytes before normalization and never trust serialization hooks", async () => {
  const fixture = await readFixture();
  await assert.rejects(
    checkSavedViewRead({ ...fixture, secret: "a".repeat(65536) }, id(5)),
    protocolError,
  );
  const { projection, expected, config } = await projectionFixture();
  await assert.rejects(
    checkSavedViewProjection({ ...projection, unknown: "a".repeat(4194304) }, expected, config),
    protocolError,
  );
  const nested: unknown = [[[[[[[[[0]]]]]]]]];
  assert.throws(() => checkSavedViewCapabilities(nested), protocolError);
});

test("plan checking snapshots mutable caller intent and base before awaiting browser hashing", async () => {
  const { plan, request, base } = await planFixture();
  const check = checkSavedViewPlan(plan, context, request, base);
  request.expectedScheduleRevision = 100;
  base.viewRevision = 100;
  assert.deepEqual(await check, plan);
});
