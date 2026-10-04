import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  type EngineProjectInputV1,
  type EngineScheduleResultV1,
  NATIVE_PLANNER_PRESENTATION_V1,
  type PlannerPresentationV1,
  type PlannerProjectionV1,
  type PlannerViewConfigurationV1,
  projectPlannerPresentationV1,
  serializePlannerViewHashPreimageV1,
  serializeScheduleInputV1,
  serializeScheduleResultV1,
  validatePlannerViewConfigurationV1,
} from "@engineo/contracts";
import {
  type GuiViewSource,
  type ProjectionRequest,
  projectGuiInputOnly,
  projectGuiSavedView,
  viewNeedsCalculation,
} from "./saved-view-projection";
import { SavedViewProtocolError } from "./saved-view-protocol";
import { localInputHash } from "./local-input-hash";

// Synthetic published DTOs test presentation/consistency only. No engine, server,
// application, HTTP client, database or SQL harness is started by these tests.
if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const PROJECT = uuid(4);
const CALENDAR = uuid(7);
const WBS_A = uuid(8);
const WBS_B = uuid(9);
const INSTANT = "2026-10-05T08:00:00.000Z";
type AvailableProjection = Extract<PlannerProjectionV1, { available: true }>;

function inputFixture(): EngineProjectInputV1 {
  const day = [{ start: "08:00", end: "17:00" }];
  return {
    schemaVersion: 1,
    project: {
      id: PROJECT,
      name: "Synthetic projection fixture",
      plannedStart: INSTANT,
      dataDate: INSTANT,
      requiredFinish: null,
      defaultCalendarId: CALENDAR,
    },
    scheduleOptions: {
      criticalFloatThresholdMinutes: 0,
      lagCalendarPolicy: "SUCCESSOR",
      projectFinishPolicy: "CALCULATED",
    },
    calendars: [
      {
        id: CALENDAR,
        name: "Weekdays",
        timeZone: "UTC",
        week: {
          MONDAY: day,
          TUESDAY: day,
          WEDNESDAY: day,
          THURSDAY: day,
          FRIDAY: day,
          SATURDAY: [],
          SUNDAY: [],
        },
        exceptions: [],
      },
    ],
    wbs: [
      { id: WBS_B, parentId: WBS_A, code: "child", name: "Design", sortOrder: 3 },
      { id: WBS_A, parentId: null, code: "parent", name: "Build", sortOrder: 1 },
    ],
    activities: ["Zulu steel", "Alpha", "Alpha steel", "Beta steel"].map((name, index) => ({
      id: uuid(100 - index),
      name,
      kind: index === 1 ? "START_MILESTONE" : "TASK",
      wbsId: index % 2 === 0 ? WBS_A : WBS_B,
      calendarId: CALENDAR,
      durationMinutes: index === 1 ? 0 : 120,
      constraints: [],
    })),
    relationships: [],
  };
}
function configuration(presentation: Partial<PlannerPresentationV1> = {}) {
  const checked = validatePlannerViewConfigurationV1({
    schemaVersion: 1,
    kind: "engineo-planner-view",
    name: "Synthetic private view",
    visibility: "private",
    presentation: { ...structuredClone(NATIVE_PLANNER_PRESENTATION_V1), ...presentation },
  });
  assert.ok(checked.valid, "fixture must satisfy the published configuration contract");
  return checked.normalizedConfiguration;
}
async function hash(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function sourceFixture(
  presentation: Partial<PlannerPresentationV1> = {},
): Promise<GuiViewSource> {
  const input = inputFixture();
  const dates = [
    "2026-10-05T11:00:00.000Z",
    "2026-10-05T08:00:00.000Z",
    "2026-10-05T10:00:00.000Z",
    "2026-10-05T09:00:00.000Z",
  ];
  const result: EngineScheduleResultV1 = {
    schemaVersion: 1,
    projectFinish: "2026-10-05T17:00:00.000Z",
    lateProjectFinish: "2026-10-05T17:00:00.000Z",
    controllingFinishActivity: null,
    controllingPath: [],
    constraintViolations: [],
    activities: Object.fromEntries(
      input.activities.map((activity, index) => [
        activity.id,
        {
          earlyStart: dates[index] ?? INSTANT,
          earlyFinish: "2026-10-05T17:00:00.000Z",
          lateStart: INSTANT,
          lateFinish: "2026-10-05T17:00:00.000Z",
          totalFloatMinutes: index % 2 === 0 ? 0 : 120,
          freeFloatMinutes: 0,
          critical: index % 2 === 0,
          drivingCauses: [],
        },
      ]),
    ),
  };
  const config = configuration(presentation);
  return {
    scope: {
      actorId: uuid(1),
      sessionId: uuid(2),
      organizationId: uuid(3),
      projectId: PROJECT,
      scheduleRevision: 17,
    },
    dirty: false,
    input,
    configuration: config,
    savedConfigHash: await hash(serializePlannerViewHashPreimageV1(config)),
    result,
    calculation: {
      schemaVersion: 1,
      calculationId: uuid(6),
      projectRevision: 17,
      inputHashSha256: await hash(serializeScheduleInputV1(input)),
      resultHashSha256: await hash(serializeScheduleResultV1(result)),
      engineContractVersion: 1,
      engineVersion: "engineo-synthetic-fixture",
      calculatedAt: INSTANT,
    },
  };
}
function available(value: PlannerProjectionV1): AvailableProjection {
  assert.ok(value.available, JSON.stringify(value));
  return value;
}
function assertUnavailable(value: PlannerProjectionV1, reason: string): void {
  assert.equal(value.available, false);
  assert.ok(!value.available);
  assert.equal(value.reason, reason);
  assert.equal(value.error, reason === "source_invalid" ? "view_invalid" : "view_result_required");
  assert.equal("rows" in value, false, "refusal is not empty success or Native fallback");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
async function sharedProjection(source: GuiViewSource): Promise<AvailableProjection> {
  assert.ok(source.result && source.calculation);
  return available(
    projectPlannerPresentationV1(
      {
        organizationId: source.scope.organizationId,
        projectId: source.scope.projectId,
        scheduleRevision: source.scope.scheduleRevision,
        inputHashSha256: source.calculation.inputHashSha256,
        inputState: "saved",
        currentEngineVersion: source.calculation.engineVersion,
        input: source.input,
      },
      {
        verification: "caller-verified-current-engine",
        organizationId: source.scope.organizationId,
        projectId: source.scope.projectId,
        metadata: source.calculation,
        result: source.result,
      },
      {
        projectionVersion: 1,
        normalizationVersion: 1,
        configHashSha256: await hash(serializePlannerViewHashPreimageV1(source.configuration)),
        presentation: source.configuration.presentation,
      },
    ),
  );
}
function requester(value: unknown) {
  const calls: Array<{ path: string; body: unknown; signal: AbortSignal }> = [];
  const request: ProjectionRequest = async (path, body, signal) => {
    calls.push({ path, body, signal });
    return structuredClone(value);
  };
  return { calls, request };
}

test("input-only unsaved drafts project locally without requests or source mutation", async () => {
  const source = await sourceFixture({
    search: "steel",
    kind: "TASK",
    sort: { field: "name", direction: "asc" },
    groupBy: "wbs",
  });
  source.dirty = true;
  source.savedConfigHash = null;
  source.result = null;
  source.calculation = null;
  const before = structuredClone(source);
  freeze(source);
  const { calls, request } = requester(null);
  const projected = available(
    await projectGuiSavedView(source, request, new AbortController().signal),
  );
  assert.equal(calls.length, 0);
  assert.equal(projected.binding.inputState, "unsaved");
  assert.equal(projected.binding.configHashSha256, null);
  assert.equal(projected.binding.calculation, undefined);
  assert.equal(projected.visibleActivityCount, 3);
  assert.equal(projected.groupCount, 2);
  assert.deepEqual(
    projected.rows.flatMap((row) => (row.kind === "activity" ? [row.activityId] : [])),
    [uuid(97), uuid(98), uuid(100)],
  );
  assert.deepEqual(
    projected.rows.flatMap((row) =>
      row.kind === "activity" ? [[row.nativeIndex, row.displayOrdinal]] : [],
    ),
    [
      [3, 1],
      [2, 2],
      [0, 3],
    ],
  );
  assert.deepEqual(source, before);
});

test("Native projection retains source array order rather than canonical export or cached result order", async () => {
  const source = await sourceFixture();
  source.dirty = true;
  const before = structuredClone(source);
  const { calls, request } = requester(null);
  const projected = available(
    await projectGuiSavedView(freeze(source), request, new AbortController().signal),
  );
  const nativeIds = source.input.activities.map((row) => row.id);
  const canonical = JSON.parse(serializeScheduleInputV1(source.input)) as EngineProjectInputV1;
  assert.notDeepEqual(
    nativeIds,
    canonical.activities.map((row) => row.id),
  );
  assert.deepEqual(
    projected.rows.map((row) => row.kind === "activity" && row.activityId),
    nativeIds,
  );
  assert.equal(projected.binding.calculation, undefined);
  assert.equal(calls.length, 0);
  assert.deepEqual(source, before);
});

test("current WBS filtering is local and a stale WBS returns an explicit unavailable projection", async () => {
  const source = await sourceFixture({ wbsId: WBS_A });
  source.dirty = true;
  const { calls, request } = requester(null);
  const projected = available(
    await projectGuiSavedView(source, request, new AbortController().signal),
  );
  assert.deepEqual(
    projected.rows.map((row) => row.kind === "activity" && row.nativeIndex),
    [0, 2],
  );
  source.configuration.presentation.wbsId = uuid(999);
  const stale = await projectGuiSavedView(source, request, new AbortController().signal);
  assert.deepEqual(stale, {
    available: false,
    error: "view_reference_stale",
    reason: "reference_stale",
  });
  assert.equal(calls.length, 0);
});

test("only critical predicates and calculated sorts require a saved calculation", () => {
  for (const field of [
    "native",
    "name",
    "durationMinutes",
    "earlyStart",
    "totalFloatMinutes",
  ] as const)
    for (const critical of ["all", "critical", "noncritical"] as const)
      assert.equal(
        viewNeedsCalculation(configuration({ critical, sort: { field, direction: "asc" } })),
        critical !== "all" || field === "earlyStart" || field === "totalFloatMinutes",
      );
});

for (const presentation of [
  { critical: "critical" },
  { critical: "noncritical" },
  { sort: { field: "earlyStart", direction: "asc" } },
  { sort: { field: "totalFloatMinutes", direction: "desc" } },
] satisfies Array<Partial<PlannerPresentationV1>>) {
  test(`calculated draft ${JSON.stringify(presentation)} is unavailable without API or calculation`, async () => {
    const source = await sourceFixture(presentation);
    source.dirty = true;
    const before = structuredClone(source);
    const { calls, request } = requester(null);
    assertUnavailable(
      await projectGuiSavedView(freeze(source), request, new AbortController().signal),
      "input_unsaved",
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(source, before);
  });
}

for (const missing of ["result", "calculation", "both"] as const) {
  test(`missing ${missing} makes a calculated view unavailable before requesting a projection`, async () => {
    const source = await sourceFixture({ critical: "critical" });
    if (missing !== "calculation") source.result = null;
    if (missing !== "result") source.calculation = null;
    const { calls, request } = requester(null);
    assertUnavailable(
      await projectGuiSavedView(source, request, new AbortController().signal),
      "calculation_missing",
    );
    assert.equal(calls.length, 0);
  });
}

const staleCacheCases: Array<[string, (source: GuiViewSource) => void]> = [
  [
    "old project revision",
    (source) => {
      if (source.calculation) source.calculation.projectRevision--;
    },
  ],
  [
    "wrong input hash",
    (source) => {
      if (source.calculation) source.calculation.inputHashSha256 = "a".repeat(64);
    },
  ],
  [
    "wrong result hash",
    (source) => {
      if (source.calculation) source.calculation.resultHashSha256 = "b".repeat(64);
    },
  ],
  [
    "malformed calculation identity",
    (source) => {
      if (source.calculation) source.calculation.calculationId = "not-an-id";
    },
  ],
  [
    "malformed engine version",
    (source) => {
      if (source.calculation) source.calculation.engineVersion = "engine\ninvalid";
    },
  ],
  [
    "malformed calculation timestamp",
    (source) => {
      if (source.calculation) source.calculation.calculatedAt = "2026-02-30T08:00:00Z";
    },
  ],
  [
    "unsupported metadata schema",
    (source) => {
      Object.assign(source.calculation ?? {}, { schemaVersion: 2 });
    },
  ],
  [
    "unsupported engine contract",
    (source) => {
      Object.assign(source.calculation ?? {}, { engineContractVersion: 2 });
    },
  ],
  [
    "unsupported result schema",
    (source) => {
      Object.assign(source.result ?? {}, { schemaVersion: 2 });
    },
  ],
  [
    "changed cached result",
    (source) => {
      const row = source.result?.activities[uuid(100)];
      if (row) row.critical = false;
    },
  ],
  [
    "changed source input",
    (source) => {
      const row = source.input.activities[0];
      if (row) row.name = "Changed elsewhere";
    },
  ],
];
for (const [name, edit] of staleCacheCases) {
  test(`${name} refuses the cached calculation without API, fallback or source mutation`, async () => {
    const source = await sourceFixture({ critical: "critical" });
    edit(source);
    const before = structuredClone(source);
    const { calls, request } = requester(null);
    assertUnavailable(
      await projectGuiSavedView(freeze(source), request, new AbortController().signal),
      "calculation_stale",
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(source, before);
  });
}

for (const presentation of [
  { critical: "critical", groupBy: "wbs" },
  { critical: "noncritical", sort: { field: "name", direction: "desc" } },
  { sort: { field: "earlyStart", direction: "asc" } },
  { sort: { field: "totalFloatMinutes", direction: "desc" }, groupBy: "wbs" },
] satisfies Array<Partial<PlannerPresentationV1>>) {
  test(`coherent saved mocked projection matches the exact shared projector for ${JSON.stringify(presentation)}`, async () => {
    const source = await sourceFixture(presentation);
    const serverProjection = await sharedProjection(source);
    const before = structuredClone(source);
    const responseBefore = structuredClone(serverProjection);
    const { calls, request } = requester(freeze(serverProjection));
    const signal = new AbortController().signal;
    const actual = await projectGuiSavedView(freeze(source), request, signal);
    assert.deepEqual(actual, serverProjection);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      path: `/organizations/${source.scope.organizationId}/projects/${PROJECT}/views/projection`,
      body: { configuration: source.configuration, expectedScheduleRevision: 17 },
      signal,
    });
    assert.deepEqual(source, before);
    assert.deepEqual(serverProjection, responseBefore);
  });
}

const malformedResultCases: Array<[string, (result: EngineScheduleResultV1) => void]> = [
  [
    "missing activity result",
    (result) => {
      delete result.activities[uuid(100)];
    },
  ],
  [
    "additional activity result",
    (result) => {
      const first = result.activities[uuid(100)];
      assert.ok(first);
      result.activities[uuid(999)] = structuredClone(first);
    },
  ],
  [
    "invalid row date",
    (result) => {
      const row = result.activities[uuid(100)];
      if (row) row.earlyStart = "2026-02-30T08:00:00Z";
    },
  ],
  [
    "fractional row float",
    (result) => {
      const row = result.activities[uuid(100)];
      if (row) row.totalFloatMinutes = 0.5;
    },
  ],
  [
    "invalid driving reference",
    (result) => {
      const row = result.activities[uuid(100)];
      if (row) row.drivingCauses = [{ kind: "relationship", predecessorId: uuid(999) }];
    },
  ],
  [
    "unknown result field",
    (result) => {
      Object.assign(result, { untrusted: "not published" });
    },
  ],
];
for (const [name, edit] of malformedResultCases) {
  test(`${name} remains unavailable even when its cached result hash is recomputed`, async () => {
    const source = await sourceFixture({ sort: { field: "earlyStart", direction: "asc" } });
    const serverProjection = await sharedProjection(source);
    assert.ok(source.result && source.calculation && serverProjection.binding.calculation);
    edit(source.result);
    source.calculation.resultHashSha256 = await hash(serializeScheduleResultV1(source.result));
    serverProjection.binding.calculation.resultHashSha256 = source.calculation.resultHashSha256;
    const { calls, request } = requester(serverProjection);
    const before = structuredClone(source);
    assertUnavailable(
      await projectGuiSavedView(freeze(source), request, new AbortController().signal),
      "calculation_stale",
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(source, before);
  });
}

const mismatchCases: Array<[string, (projection: AvailableProjection) => void]> = [
  [
    "different calculation ID",
    (projection) => {
      if (projection.binding.calculation) projection.binding.calculation.calculationId = uuid(999);
    },
  ],
  [
    "different result hash",
    (projection) => {
      if (projection.binding.calculation)
        projection.binding.calculation.resultHashSha256 = "a".repeat(64);
    },
  ],
  [
    "different engine version",
    (projection) => {
      if (projection.binding.calculation)
        projection.binding.calculation.engineVersion = "another-engine-version";
    },
  ],
  [
    "wrong activity identity",
    (projection) => {
      const row = projection.rows[0];
      if (row?.kind === "activity") row.activityId = uuid(999);
    },
  ],
  [
    "swapped native indices",
    (projection) => {
      const a = projection.rows[0];
      const b = projection.rows[1];
      if (a?.kind === "activity" && b?.kind === "activity")
        [a.nativeIndex, b.nativeIndex] = [b.nativeIndex, a.nativeIndex];
    },
  ],
  [
    "wrong coherent activity order",
    (projection) => {
      const a = projection.rows[0];
      const b = projection.rows[1];
      if (a?.kind === "activity" && b?.kind === "activity") {
        projection.rows[0] = { ...b, displayOrdinal: 1 };
        projection.rows[1] = { ...a, displayOrdinal: 2 };
      }
    },
  ],
];
for (const [name, edit] of mismatchCases) {
  test(`${name} is refused despite a structurally valid saved response`, async () => {
    const source = await sourceFixture({ sort: { field: "earlyStart", direction: "asc" } });
    const projection = await sharedProjection(source);
    edit(projection);
    const { calls, request } = requester(projection);
    assertUnavailable(
      await projectGuiSavedView(freeze(source), request, new AbortController().signal),
      "calculation_stale",
    );
    assert.equal(calls.length, 1);
  });
}

const invalidResponseCases: Array<[string, (projection: AvailableProjection) => void]> = [
  [
    "wrong organization binding",
    (projection) => {
      projection.binding.organizationId = uuid(999);
    },
  ],
  [
    "wrong project binding",
    (projection) => {
      projection.binding.projectId = uuid(999);
    },
  ],
  [
    "wrong schedule revision",
    (projection) => {
      projection.binding.scheduleRevision++;
    },
  ],
  [
    "wrong input hash binding",
    (projection) => {
      projection.binding.inputHashSha256 = "a".repeat(64);
    },
  ],
  [
    "wrong configuration hash",
    (projection) => {
      projection.binding.configHashSha256 = "a".repeat(64);
    },
  ],
  [
    "unsaved response source",
    (projection) => {
      projection.binding.inputState = "unsaved";
    },
  ],
  [
    "unsupported projection version",
    (projection) => {
      Object.assign(projection.binding, { projectionVersion: 2 });
    },
  ],
  [
    "unsupported engine contract",
    (projection) => {
      Object.assign(projection.binding.calculation ?? {}, { engineContractVersion: 2 });
    },
  ],
  [
    "missing calculation declaration",
    (projection) => {
      delete projection.binding.calculation;
    },
  ],
  [
    "out-of-range native index",
    (projection) => {
      const row = projection.rows[0];
      if (row?.kind === "activity") row.nativeIndex = 4;
    },
  ],
  [
    "duplicate activity",
    (projection) => {
      const a = projection.rows[0];
      const b = projection.rows[1];
      if (a?.kind === "activity" && b?.kind === "activity") b.activityId = a.activityId;
    },
  ],
  [
    "wrong visible ordinal",
    (projection) => {
      const row = projection.rows[0];
      if (row?.kind === "activity") row.displayOrdinal = 2;
    },
  ],
  [
    "missing visual rows",
    (projection) => {
      projection.rows.pop();
    },
  ],
];
for (const [name, edit] of invalidResponseCases) {
  test(`${name} cannot activate through an invalid projection response`, async () => {
    const source = await sourceFixture({ sort: { field: "earlyStart", direction: "asc" } });
    const projection = await sharedProjection(source);
    edit(projection);
    const { calls, request } = requester(projection);
    await assert.rejects(
      projectGuiSavedView(freeze(source), request, new AbortController().signal),
      SavedViewProtocolError,
    );
    assert.equal(calls.length, 1);
  });
}

test("tampered WBS group labels cannot replace the exact local shared projection", async () => {
  const source = await sourceFixture({ critical: "critical", groupBy: "wbs" });
  const projection = await sharedProjection(source);
  const group = projection.rows[0];
  assert.ok(group?.kind === "group");
  group.wbsName = "A different saved WBS";
  const { request } = requester(projection);
  assertUnavailable(
    await projectGuiSavedView(source, request, new AbortController().signal),
    "calculation_stale",
  );
});

test("malformed source cannot fall back to Native or request a projection", async () => {
  const source = await sourceFixture({ search: "steel" });
  const first = source.input.activities[0];
  assert.ok(first);
  first.durationMinutes = Number.NaN;
  const { calls, request } = requester(null);
  assertUnavailable(
    await projectGuiSavedView(source, request, new AbortController().signal),
    "source_invalid",
  );
  assert.equal(calls.length, 0);
});

test("aborted verification never activates a local or mocked saved projection", async () => {
  for (const config of [configuration(), configuration({ critical: "critical" })]) {
    const source = await sourceFixture(config.presentation);
    const { calls, request } = requester(null);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(projectGuiSavedView(source, request, abort.signal), {
      name: "AbortError",
    });
    assert.equal(calls.length, 0);
  }
  const source = await sourceFixture({ critical: "critical" });
  const projection = await sharedProjection(source);
  const abort = new AbortController();
  await assert.rejects(
    projectGuiSavedView(
      source,
      async () => {
        abort.abort();
        return projection;
      },
      abort.signal,
    ),
    { name: "AbortError" },
  );
});

test("invalid configuration is a protocol refusal without projection requests", async () => {
  const source = await sourceFixture();
  source.configuration = {
    ...source.configuration,
    name: "Native",
  } satisfies PlannerViewConfigurationV1;
  const { calls, request } = requester(null);
  await assert.rejects(
    projectGuiSavedView(source, request, new AbortController().signal),
    SavedViewProtocolError,
  );
  assert.equal(calls.length, 0);
});

test("synchronous input hashing matches browser Web Crypto across padding and Unicode vectors", async () => {
  for (const value of [
    "",
    "abc",
    "a".repeat(55),
    "a".repeat(56),
    "a".repeat(63),
    "a".repeat(64),
    "a".repeat(65),
    "日本語 · café · 😀 · e\u0301".repeat(70),
  ]) {
    assert.equal(localInputHash(value), await hash(value));
    assert.notEqual(localInputHash(value), "0".repeat(64));
  }
});

test("synchronous input-only projection exactly matches the async Web Crypto wrapper", async () => {
  for (const presentation of [
    {},
    { search: "steel", sort: { field: "name", direction: "desc" }, groupBy: "wbs" },
    { kind: "START_MILESTONE", wbsId: WBS_B },
    { sort: { field: "durationMinutes", direction: "asc" } },
  ] satisfies Array<Partial<PlannerPresentationV1>>) {
    const source = await sourceFixture(presentation);
    source.dirty = true;
    source.input.project.name = "Unicode fixture 日本語😀é";
    const before = structuredClone(source);
    const { calls, request } = requester(null);
    const local = projectGuiInputOnly(freeze(source));
    assert.equal(
      local instanceof Promise,
      false,
      "no deferred hashing or effects before local rows",
    );
    assert.deepEqual(
      local,
      await projectGuiSavedView(source, request, new AbortController().signal),
    );
    assert.equal(
      available(local).binding.inputHashSha256,
      await hash(serializeScheduleInputV1(source.input)),
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(source, before);
  }
});

test("latest local input and presentation immediately replace filtered sorted and grouped rows", async () => {
  const original = await sourceFixture({
    search: "steel",
    sort: { field: "name", direction: "asc" },
    groupBy: "wbs",
  });
  original.dirty = true;
  original.savedConfigHash = null;
  const before = structuredClone(original);
  const initial = available(projectGuiInputOnly(freeze(original)));
  const next = structuredClone(original);
  const changed = next.input.activities[0];
  assert.ok(changed);
  changed.name = "A new steel record";
  changed.wbsId = WBS_B;
  const nextBefore = structuredClone(next);
  const updated = available(projectGuiInputOnly(freeze(next)));
  assert.equal(updated.rows[0]?.kind, "group");
  assert.equal(updated.rows[1]?.kind === "activity" && updated.rows[1].activityId, changed.id);
  assert.notEqual(updated.binding.inputHashSha256, initial.binding.inputHashSha256);
  assert.equal(updated.binding.inputHashSha256, await hash(serializeScheduleInputV1(next.input)));
  const current = structuredClone(next);
  current.configuration.presentation = configuration({
    search: "Beta",
    sort: { field: "name", direction: "desc" },
    groupBy: "none",
  }).presentation;
  const filtered = available(projectGuiInputOnly(freeze(current)));
  assert.equal(filtered.visibleActivityCount, 1);
  assert.equal(filtered.groupCount, 0);
  assert.deepEqual(filtered.rows, [
    { kind: "activity", activityId: uuid(97), nativeIndex: 3, displayOrdinal: 1, groupKey: null },
  ]);
  assert.equal(filtered.binding.inputHashSha256, updated.binding.inputHashSha256);
  assert.deepEqual(original, before);
  assert.deepEqual(next, nextBefore);
});

test("synchronous helper never treats cached calculated results as permission for a local fallback", async () => {
  const source = await sourceFixture({ critical: "critical" });
  assertUnavailable(projectGuiInputOnly(freeze(source)), "calculation_missing");
  const dirty = { ...source, dirty: true };
  assertUnavailable(projectGuiInputOnly(dirty), "input_unsaved");
  const invalid = structuredClone(source);
  invalid.configuration.name = "Native";
  assert.deepEqual(projectGuiInputOnly(invalid), {
    available: false,
    error: "view_invalid",
    reason: "presentation_invalid",
  });
});
