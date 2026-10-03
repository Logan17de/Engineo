import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus, platform, arch } from "node:os";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  type PlannerNativeSnapshotV1,
  type PlannerPresentationSelectionV1,
  type PlannerProjectionV1,
  type PlannerVerifiedCalculationV1,
  projectPlannerPresentationV1,
} from "./planner-presentation.js";
import { NATIVE_PLANNER_PRESENTATION_V1, type PlannerPresentationV1 } from "./planner-view.js";
import type { EngineScheduleResultV1 } from "./result.js";
import { serializeScheduleResultV1 } from "./result-serialization.js";
import type { EngineProjectInputV1 } from "./schedule.js";
import { serializeScheduleInputV1 } from "./serialization.js";

const uuid = (index: number) => `10000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
const ORG = uuid(1),
  PROJECT = uuid(2),
  CAL = uuid(3),
  A = uuid(4),
  B = uuid(5),
  C = uuid(6);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function input(count = 6): EngineProjectInputV1 {
  const day = [{ start: "08:00", end: "17:00" }];
  return {
    schemaVersion: 1,
    project: {
      id: PROJECT,
      name: "Projection fixture",
      plannedStart: "2026-10-05T08:00:00Z",
      dataDate: "2026-10-05T08:00:00Z",
      requiredFinish: null,
      defaultCalendarId: CAL,
    },
    scheduleOptions: {
      criticalFloatThresholdMinutes: 0,
      lagCalendarPolicy: "SUCCESSOR",
      projectFinishPolicy: "CALCULATED",
    },
    calendars: [
      {
        id: CAL,
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
    // Child precedes parent in native order; equal labels must not merge separate groups.
    wbs: [
      { id: B, parentId: A, name: "Repeated", code: "child", sortOrder: 300 },
      { id: A, parentId: null, name: "Repeated", code: "parent", sortOrder: 1 },
      { id: C, parentId: null, name: "Unused", code: "empty", sortOrder: 0 },
    ],
    activities: Array.from({ length: count }, (_, index) => ({
      id: uuid(100 + count - index),
      wbsId: index % 2 ? A : B,
      name: ["beta", "ALPHA", "alpha", "Éclair", "İstanbul", "😀"][index % 6] ?? "Work",
      kind: index % 6 === 1 ? "START_MILESTONE" : index % 6 === 2 ? "FINISH_MILESTONE" : "TASK",
      durationMinutes:
        index % 6 === 1 || index % 6 === 2 ? 0 : ([60, 0, 0, 120, 60, 240][index % 6] ?? 60),
      calendarId: CAL,
      constraints: [],
    })),
    relationships: [],
  };
}
function snapshot(value = input()): PlannerNativeSnapshotV1 {
  return {
    organizationId: ORG,
    projectId: PROJECT,
    scheduleRevision: 7,
    inputHashSha256: hash(serializeScheduleInputV1(value)),
    inputState: "saved",
    currentEngineVersion: "engineo-unit-comparator-fixture",
    input: value,
  };
}
function selection(
  presentation: Partial<PlannerPresentationV1> = {},
): PlannerPresentationSelectionV1 {
  return {
    projectionVersion: 1,
    normalizationVersion: 1,
    configHashSha256: null,
    presentation: { ...NATIVE_PLANNER_PRESENTATION_V1, ...presentation },
  };
}
// Synthetic fixtures exercise consistency checks and comparator vectors only. They do not
// authenticate the engine or demonstrate engine mathematics. The separately gated real
// binary test below supplies actual Rust output and independently computes both hashes.
function comparatorCalculation(source: PlannerNativeSnapshotV1): PlannerVerifiedCalculationV1 {
  const dates = [
    "2026-10-05T08:00:00.000000002Z",
    "2026-10-05T08:00:00.000000001Z",
    "2026-10-05T07:59:59.999999999Z",
    "2026-10-05T09:00:00.000000001+01:00",
    "2026-10-05T03:00:00.000000001-05:00",
    "2026-10-05T08:00:00.000000003Z",
  ];
  const result: EngineScheduleResultV1 = {
    schemaVersion: 1,
    projectFinish: "2026-10-05T17:00:00Z",
    lateProjectFinish: "2026-10-05T17:00:00Z",
    controllingFinishActivity: null,
    controllingPath: [],
    constraintViolations: [],
    activities: Object.fromEntries(
      source.input.activities.map((activity, index) => [
        activity.id,
        {
          earlyStart: dates[index % 6] ?? dates[0],
          earlyFinish: "2026-10-05T17:00:00Z",
          lateStart: "2026-10-05T08:00:00Z",
          lateFinish: "2026-10-05T17:00:00Z",
          totalFloatMinutes: [-10, 0, -10, 15, 0, 90][index % 6],
          freeFloatMinutes: 0,
          critical: index % 2 === 0,
          drivingCauses: [],
        },
      ]),
    ) as EngineScheduleResultV1["activities"],
  };
  return {
    verification: "caller-verified-current-engine",
    organizationId: ORG,
    projectId: PROJECT,
    metadata: {
      schemaVersion: 1,
      calculationId: uuid(10),
      projectRevision: source.scheduleRevision,
      inputHashSha256: source.inputHashSha256,
      resultHashSha256: hash(serializeScheduleResultV1(result)),
      engineContractVersion: 1,
      engineVersion: source.currentEngineVersion ?? "engine-unavailable",
      calculatedAt: "2026-10-05T08:00:00.123456789Z",
    },
    result,
  };
}
function available(value: PlannerProjectionV1) {
  assert.equal(value.available, true, JSON.stringify(value));
  assert.ok(value.available);
  return value;
}
function activityIds(value: PlannerProjectionV1) {
  return available(value).rows.flatMap((row) => (row.kind === "activity" ? [row.activityId] : []));
}
function rejected(value: PlannerProjectionV1, reason: string, error?: string) {
  assert.equal(value.available, false);
  assert.ok(!value.available);
  assert.equal(value.reason, reason);
  if (error) assert.equal(value.error, error);
  assert.equal("rows" in value, false);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

test("Native exactly preserves native snapshot sequence rather than UUID/canonical/result order", () => {
  const source = snapshot();
  const ids = source.input.activities.map((row) => row.id);
  assert.notDeepEqual(
    ids,
    JSON.parse(serializeScheduleInputV1(source.input)).activities.map(
      (row: { id: string }) => row.id,
    ),
  );
  assert.deepEqual(activityIds(projectPlannerPresentationV1(source, null, selection())), ids);
  const projected = available(
    projectPlannerPresentationV1(source, comparatorCalculation(source), selection()),
  );
  assert.equal(projected.binding.calculation, undefined);
  assert.deepEqual(
    projected.rows.map((row) => row.kind === "activity" && [row.nativeIndex, row.displayOrdinal]),
    ids.map((_, i) => [i, i + 1]),
  );
});

test("name sorting uses lowercase UTF-16 order; descending keeps native order for equal keys", () => {
  const source = snapshot();
  const ids = source.input.activities.map((row) => row.id);
  assert.deepEqual(
    activityIds(
      projectPlannerPresentationV1(
        source,
        null,
        selection({ sort: { field: "name", direction: "asc" } }),
      ),
    ),
    [ids[1], ids[2], ids[0], ids[4], ids[3], ids[5]],
  );
  assert.deepEqual(
    activityIds(
      projectPlannerPresentationV1(
        source,
        null,
        selection({ sort: { field: "name", direction: "desc" } }),
      ),
    ),
    [ids[5], ids[3], ids[4], ids[0], ids[1], ids[2]],
  );
});

test("stored duration sort handles mixed task and zero-duration milestones with stable ties", () => {
  const source = snapshot(),
    ids = source.input.activities.map((row) => row.id);
  assert.deepEqual(
    activityIds(
      projectPlannerPresentationV1(
        source,
        null,
        selection({ sort: { field: "durationMinutes", direction: "desc" } }),
      ),
    ),
    [ids[5], ids[3], ids[0], ids[4], ids[1], ids[2]],
  );
});

test("critical, search, kind and direct WBS predicates are AND; critical flag is never inferred from float", () => {
  const source = snapshot(),
    calc = comparatorCalculation(source),
    ids = source.input.activities.map((row) => row.id);
  const view = selection({
    search: " ALPHA ",
    kind: "FINISH_MILESTONE",
    wbsId: B,
    critical: "critical",
  });
  assert.deepEqual(activityIds(projectPlannerPresentationV1(source, calc, view)), [ids[2]]);
  assert.deepEqual(
    activityIds(projectPlannerPresentationV1(source, calc, selection({ critical: "noncritical" }))),
    [ids[1], ids[3], ids[5]],
  );
  assert.equal(calc.result.activities[ids[1] ?? ""]?.totalFloatMinutes, 0);
  assert.equal(calc.result.activities[ids[1] ?? ""]?.critical, false);
  assert.deepEqual(
    activityIds(projectPlannerPresentationV1(source, calc, selection({ wbsId: A }))),
    [ids[1], ids[3], ids[5]],
  );
});

test("literal search Unicode casing and UUID substring matching have deterministic vectors", () => {
  const source = snapshot(),
    ids = source.input.activities.map((row) => row.id);
  assert.deepEqual(
    activityIds(projectPlannerPresentationV1(source, null, selection({ search: "İSTANBUL" }))),
    [ids[4]],
  );
  assert.deepEqual(
    activityIds(projectPlannerPresentationV1(source, null, selection({ search: "i\u0307" }))),
    [ids[4]],
  );
  assert.deepEqual(
    activityIds(projectPlannerPresentationV1(source, null, selection({ search: "ISTANBUL" }))),
    [],
  );
  assert.deepEqual(
    activityIds(projectPlannerPresentationV1(source, null, selection({ search: "ÉC" }))),
    [ids[3]],
  );
  assert.deepEqual(
    activityIds(
      projectPlannerPresentationV1(
        source,
        null,
        selection({ search: (ids[0] ?? "").toUpperCase() }),
      ),
    ),
    [ids[0]],
  );
  assert.deepEqual(
    activityIds(
      projectPlannerPresentationV1(
        source,
        null,
        selection({ search: "https://example.test/$" + "{name}" }),
      ),
    ),
    [],
  );
});

test("negative stored float sorts numerically and descending reverses only primary key", () => {
  const source = snapshot(),
    calc = comparatorCalculation(source),
    ids = source.input.activities.map((row) => row.id);
  assert.deepEqual(
    activityIds(
      projectPlannerPresentationV1(
        source,
        calc,
        selection({ sort: { field: "totalFloatMinutes", direction: "asc" } }),
      ),
    ),
    [ids[0], ids[2], ids[1], ids[4], ids[3], ids[5]],
  );
  assert.deepEqual(
    activityIds(
      projectPlannerPresentationV1(
        source,
        calc,
        selection({ sort: { field: "totalFloatMinutes", direction: "desc" } }),
      ),
    ),
    [ids[5], ids[3], ids[1], ids[4], ids[0], ids[2]],
  );
});

test("earlyStart uses full nanoseconds and normalized positive/negative offsets with native ties", () => {
  const source = snapshot(),
    calc = comparatorCalculation(source),
    ids = source.input.activities.map((row) => row.id);
  assert.deepEqual(
    activityIds(
      projectPlannerPresentationV1(
        source,
        calc,
        selection({ sort: { field: "earlyStart", direction: "asc" } }),
      ),
    ),
    [ids[2], ids[1], ids[3], ids[4], ids[0], ids[5]],
  );
  assert.deepEqual(
    activityIds(
      projectPlannerPresentationV1(
        source,
        calc,
        selection({ sort: { field: "earlyStart", direction: "desc" } }),
      ),
    ),
    [ids[5], ids[0], ids[1], ids[3], ids[4], ids[2]],
  );
});

test("exact date keys handle year 0000/0099, leap centuries and offset-crossed day boundaries", () => {
  const source = snapshot(),
    calc = comparatorCalculation(source),
    ids = source.input.activities.map((row) => row.id);
  const dates = [
    "2000-03-01T00:00:00Z",
    "2000-02-29T23:30:00-01:00",
    "0099-01-01T00:00:00Z",
    "0000-02-29T00:00:00Z",
    "2000-03-01T01:00:00+01:00",
    "1999-12-31T23:59:59.999999999Z",
  ];
  ids.forEach((id, index) => {
    const row = calc.result.activities[id];
    if (row) row.earlyStart = dates[index] ?? dates[0] ?? "";
  });
  assert.deepEqual(
    activityIds(
      projectPlannerPresentationV1(
        source,
        calc,
        selection({ sort: { field: "earlyStart", direction: "asc" } }),
      ),
    ),
    [ids[3], ids[2], ids[5], ids[0], ids[4], ids[1]],
  );
});

test("unsupported/excess-precision, impossible, leap-second and malformed result dates fail closed", () => {
  const source = snapshot(),
    first = source.input.activities[0]?.id ?? "";
  for (const date of [
    "2026-10-05T08:00:00.1234567890Z",
    "1900-02-29T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:00:60Z",
    "2026-01-01T00:00:00+24:00",
    "+10000-01-01T00:00:00Z",
    "not a date",
  ]) {
    const calc = comparatorCalculation(source),
      row = calc.result.activities[first];
    assert.ok(row);
    row.earlyStart = date;
    rejected(
      projectPlannerPresentationV1(source, calc, selection({ critical: "critical" })),
      "calculation_invalid",
    );
  }
});

test("one-level WBS grouping uses native WBS order, distinct headers and exact visible counts", () => {
  const source = snapshot(),
    ids = source.input.activities.map((row) => row.id);
  const view = selection({ groupBy: "wbs", sort: { field: "name", direction: "asc" } });
  const projected = available(projectPlannerPresentationV1(source, null, view));
  const headers = projected.rows.filter((row) => row.kind === "group");
  assert.deepEqual(
    headers.map((row) => [row.key, row.wbsId, row.activityCount]),
    [
      [`group:wbs:${B}`, B, 3],
      [`group:wbs:${A}`, A, 3],
    ],
  );
  assert.deepEqual(activityIds(projected), [ids[2], ids[0], ids[4], ids[1], ids[3], ids[5]]);
  assert.equal(projected.groupCount, 2);
  assert.equal(projected.visualRowCount, 8);
  assert.equal(projected.visibleActivityCount, 6);
  for (const header of headers) {
    assert.equal("activityId" in header, false);
    assert.equal("earlyStart" in header, false);
  }
  assert.deepEqual(
    projected.rows.flatMap((row) => (row.kind === "activity" ? [row.displayOrdinal] : [])),
    [1, 2, 3, 4, 5, 6],
  );
});

test("empty saved sources reject primitive activity maps for every result-dependent selector", () => {
  const source = snapshot(input(0));
  const presentations: Partial<PlannerPresentationV1>[] = [
    { critical: "critical" },
    { sort: { field: "earlyStart", direction: "asc" } },
    { sort: { field: "totalFloatMinutes", direction: "asc" } },
  ];
  for (const presentation of presentations) {
    for (const activities of [7, true]) {
      const calc = comparatorCalculation(source);
      (calc.result as unknown as { activities: unknown }).activities = activities;
      rejected(
        projectPlannerPresentationV1(source, calc, selection(presentation)),
        "calculation_invalid",
      );
    }
  }
});

test("valid empty saved result maps remain available without fabricated rows or groups", () => {
  const source = snapshot(input(0));
  const calc = comparatorCalculation(source);
  for (const presentation of [
    { critical: "critical" },
    { sort: { field: "earlyStart", direction: "asc" } },
    { sort: { field: "totalFloatMinutes", direction: "asc" } },
  ] satisfies Partial<PlannerPresentationV1>[]) {
    const projected = available(
      projectPlannerPresentationV1(source, calc, selection(presentation)),
    );
    assert.deepEqual(projected.rows, []);
    assert.equal(projected.sourceActivityCount, 0);
    assert.equal(projected.visibleActivityCount, 0);
    assert.equal(projected.visualRowCount, 0);
    assert.equal(projected.groupCount, 0);
    assert.equal(projected.binding.calculation?.calculationId, calc.metadata.calculationId);
  }
});

test("empty matches are explicit successful zero counts and do not emit empty groups", () => {
  const projected = available(
    projectPlannerPresentationV1(snapshot(), null, selection({ search: "absent", groupBy: "wbs" })),
  );
  assert.deepEqual(projected.rows, []);
  assert.equal(projected.groupCount, 0);
  assert.equal(projected.visibleActivityCount, 0);
  assert.equal(projected.sourceActivityCount, 6);
});

test("missing/deleted WBS references never silently widen a filter, while renames update labels", () => {
  const source = snapshot();
  rejected(
    projectPlannerPresentationV1(source, null, selection({ wbsId: uuid(9999) })),
    "reference_stale",
    "view_reference_stale",
  );
  const view = selection({ wbsId: C });
  source.input.wbs = source.input.wbs.filter((node) => node.id !== C);
  rejected(projectPlannerPresentationV1(source, null, view), "reference_stale");
  const node = source.input.wbs[0];
  assert.ok(node);
  node.name = "Renamed";
  const rows = available(
    projectPlannerPresentationV1(source, null, selection({ groupBy: "wbs" })),
  ).rows;
  assert.equal(rows[0]?.kind === "group" && rows[0].wbsName, "Renamed");
});

test("input-only views work on an unsaved input and ignore stale/missing calculations", () => {
  const source = snapshot(),
    calc = comparatorCalculation(source);
  source.inputState = "unsaved";
  calc.metadata.projectRevision = 0;
  const projected = available(projectPlannerPresentationV1(source, calc, selection()));
  assert.equal(projected.binding.inputState, "unsaved");
  assert.equal(projected.binding.calculation, undefined);
  source.currentEngineVersion = null;
  available(projectPlannerPresentationV1(source, null, selection()));
});

test("result-dependent views require saved input and an explicitly verified current envelope", () => {
  const source = snapshot(),
    calc = comparatorCalculation(source),
    view = selection({ critical: "critical" });
  rejected(
    projectPlannerPresentationV1(source, null, view),
    "calculation_missing",
    "view_result_required",
  );
  source.inputState = "unsaved";
  rejected(projectPlannerPresentationV1(source, calc, view), "input_unsaved");
  source.inputState = "saved";
  calc.verification = "unverified" as PlannerVerifiedCalculationV1["verification"];
  rejected(projectPlannerPresentationV1(source, calc, view), "calculation_invalid");
});

test("source identity, input hash, schedule revision and supported engine version must all match", () => {
  const source = snapshot(),
    view = selection({ sort: { field: "earlyStart", direction: "asc" } });
  for (const mutate of [
    (calc: PlannerVerifiedCalculationV1) => {
      calc.organizationId = uuid(999);
    },
    (calc: PlannerVerifiedCalculationV1) => {
      calc.projectId = uuid(999);
    },
    (calc: PlannerVerifiedCalculationV1) => {
      calc.metadata.projectRevision++;
    },
    (calc: PlannerVerifiedCalculationV1) => {
      calc.metadata.inputHashSha256 = "b".repeat(64);
    },
  ]) {
    const calc = comparatorCalculation(source);
    mutate(calc);
    rejected(projectPlannerPresentationV1(source, calc, view), "calculation_stale");
  }
  const calc = comparatorCalculation(source);
  calc.metadata.engineVersion = "old-engine";
  rejected(projectPlannerPresentationV1(source, calc, view), "engine_unsupported");
  calc.metadata.engineVersion = source.currentEngineVersion ?? "";
  calc.result.schemaVersion = 2 as 1;
  rejected(projectPlannerPresentationV1(source, calc, view), "engine_unsupported");
});

test("unknown current engine and forged null engine declaration cannot activate a calculated view", () => {
  const source = snapshot(),
    calc = comparatorCalculation(source),
    view = selection({ critical: "critical" });
  source.currentEngineVersion = null;
  rejected(projectPlannerPresentationV1(source, calc, view), "engine_unsupported");
  calc.metadata.engineVersion = null as unknown as string;
  rejected(projectPlannerPresentationV1(source, calc, view), "engine_unsupported");
});

test("malformed Unicode native labels cannot escape into group/activity projections", () => {
  const source = snapshot(),
    node = source.input.wbs[0];
  assert.ok(node);
  node.name = "\ud800";
  rejected(
    projectPlannerPresentationV1(source, null, selection({ groupBy: "wbs" })),
    "source_invalid",
  );
  node.name = "Valid";
  const activity = source.input.activities[0];
  assert.ok(activity);
  activity.name = "\udfff";
  rejected(
    projectPlannerPresentationV1(
      source,
      null,
      selection({ sort: { field: "name", direction: "asc" } }),
    ),
    "source_invalid",
  );
});

test("missing, extra, corrupt result rows and malformed metadata are unavailable even with no matching filter rows", () => {
  const source = snapshot(),
    id = source.input.activities[0]?.id ?? "",
    view = selection({ search: "absent", critical: "critical" });
  for (const mutate of [
    (calc: PlannerVerifiedCalculationV1) => {
      delete calc.result.activities[id];
    },
    (calc: PlannerVerifiedCalculationV1) => {
      calc.result.activities[uuid(9999)] = calc.result.activities[id] as NonNullable<
        (typeof calc.result.activities)[string]
      >;
    },
    (calc: PlannerVerifiedCalculationV1) => {
      const row = calc.result.activities[id];
      if (row) row.critical = "true" as unknown as boolean;
    },
    (calc: PlannerVerifiedCalculationV1) => {
      const row = calc.result.activities[id];
      if (row) row.totalFloatMinutes = Infinity;
    },
    (calc: PlannerVerifiedCalculationV1) => {
      calc.metadata.resultHashSha256 = "x";
    },
    (calc: PlannerVerifiedCalculationV1) => {
      calc.metadata.calculationId = "foreign";
    },
  ]) {
    const calc = comparatorCalculation(source);
    mutate(calc);
    rejected(projectPlannerPresentationV1(source, calc, view), "calculation_invalid");
  }
});

test("version and invalid presentation/source envelopes fail without partial rows", () => {
  const source = snapshot();
  for (const mutate of [
    (view: PlannerPresentationSelectionV1) => {
      view.projectionVersion = 2 as 1;
    },
    (view: PlannerPresentationSelectionV1) => {
      view.normalizationVersion = 2 as 1;
    },
  ]) {
    const view = selection();
    mutate(view);
    rejected(projectPlannerPresentationV1(source, null, view), "version_unsupported");
  }
  rejected(
    projectPlannerPresentationV1(
      source,
      null,
      selection({ sort: { field: "native", direction: "desc" } }),
    ),
    "presentation_invalid",
  );
  source.projectId = uuid(999);
  rejected(projectPlannerPresentationV1(source, null, selection()), "source_invalid");
});

test("malformed projection input identity/reference/duration and prototype/accessor arrays fail without getter execution", () => {
  for (const mutate of [
    (source: PlannerNativeSnapshotV1) => {
      const row = source.input.activities[1];
      if (row) row.id = source.input.activities[0]?.id ?? "";
    },
    (source: PlannerNativeSnapshotV1) => {
      const row = source.input.activities[0];
      if (row) row.wbsId = uuid(999);
    },
    (source: PlannerNativeSnapshotV1) => {
      const row = source.input.activities[0];
      if (row) row.durationMinutes = -1;
    },
    (source: PlannerNativeSnapshotV1) => {
      Object.setPrototypeOf(source.input.activities, {});
    },
    (source: PlannerNativeSnapshotV1) => {
      Object.defineProperty(source.input.activities, "4294967295", {
        value: "lost",
        enumerable: true,
      });
    },
    (source: PlannerNativeSnapshotV1) => {
      Object.defineProperty(source.input.activities, "01", { value: "lost", enumerable: true });
    },
    (source: PlannerNativeSnapshotV1) => {
      delete source.input.activities[1];
    },
  ]) {
    const source = snapshot();
    mutate(source);
    rejected(projectPlannerPresentationV1(source, null, selection()), "source_invalid");
  }
  let called = 0;
  const source = snapshot();
  Object.defineProperty(source.input.activities, "0", {
    get() {
      called++;
      throw Error("getter");
    },
    enumerable: true,
  });
  rejected(projectPlannerPresentationV1(source, null, selection()), "source_invalid");
  assert.equal(called, 0);
});

test("projection and all sorts/groups preserve deeply frozen schedule/result/config and exact serialization", () => {
  const source = snapshot(),
    calc = comparatorCalculation(source);
  const before = JSON.stringify({ source, calc }),
    canonical = serializeScheduleInputV1(source.input),
    result = serializeScheduleResultV1(calc.result);
  freeze(source);
  freeze(calc);
  for (const field of [
    "native",
    "name",
    "durationMinutes",
    "earlyStart",
    "totalFloatMinutes",
  ] as const) {
    const view = freeze(selection({ groupBy: "wbs", sort: { field, direction: "asc" } }));
    available(projectPlannerPresentationV1(source, calc, view));
  }
  assert.equal(JSON.stringify({ source, calc }), before);
  assert.equal(serializeScheduleInputV1(source.input), canonical);
  assert.equal(serializeScheduleResultV1(calc.result), result);
});

test("source binding carries only consumed result provenance and the caller-checked config digest", () => {
  const source = snapshot(),
    calc = comparatorCalculation(source),
    view = selection({ critical: "critical" });
  view.configHashSha256 = "c".repeat(64);
  const projected = available(projectPlannerPresentationV1(source, calc, view));
  assert.deepEqual(projected.binding.calculation, {
    calculationId: calc.metadata.calculationId,
    resultHashSha256: calc.metadata.resultHashSha256,
    engineContractVersion: 1,
    engineVersion: calc.metadata.engineVersion,
  });
  assert.equal(projected.binding.configHashSha256, view.configHashSha256);
  assert.equal(projected.binding.inputHashSha256, source.inputHashSha256);
});

const binary = process.env.ENGINEO_PLANNER_VIEW_TEST_ENGINE ?? process.env.ENGINEO_SCHEDULER_BIN;
test("real Rust output on exact 1,000-row input: Native/current result/filter/group immutability and named timing", {
  skip: binary ? false : "Set ENGINEO_SCHEDULER_BIN to a freshly built trusted binary",
}, (t) => {
  assert.ok(binary);
  const value = input(1000),
    info = spawnSync(binary, ["--engine-info"], { encoding: "utf8", timeout: 10000 });
  const firstCalendar = value.calendars[0];
  assert.ok(firstCalendar);
  value.calendars.push({
    ...firstCalendar,
    id: uuid(7),
    name: "Tokyo weekdays",
    timeZone: "Asia/Tokyo",
  });
  value.wbs.push({
    id: uuid(8),
    parentId: null,
    name: "Empty fourth group",
    code: "empty4",
    sortOrder: 5,
  });
  const directWbs = [B, A, C];
  value.activities.forEach((row, index) => {
    row.wbsId = directWbs[index % 3] ?? B;
    row.calendarId = index % 2 ? uuid(7) : CAL;
  });
  // Sparse two-branch DAG: 999 edges, unequal calendar/duration paths and noncritical rows.
  for (let index = 1; index < value.activities.length; index++) {
    const predecessor = value.activities[index === 500 ? 0 : index - 1],
      successor = value.activities[index];
    assert.ok(predecessor && successor);
    value.relationships.push({
      predecessorId: predecessor.id,
      successorId: successor.id,
      type: "FS",
      lagMinutes: 0,
    });
  }
  assert.equal(info.status, 0, info.stderr);
  const engine = JSON.parse(info.stdout) as {
    engineVersion: string;
    engineContractVersion: number;
  };
  assert.equal(engine.engineContractVersion, 1);
  const source = snapshot(value);
  source.currentEngineVersion = engine.engineVersion;
  const output = spawnSync(binary, ["--engine-version", engine.engineVersion], {
    input: serializeScheduleInputV1(value),
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(output.status, 0, output.stderr);
  const calc = comparatorCalculation(source);
  calc.result = JSON.parse(output.stdout) as EngineScheduleResultV1;
  calc.metadata.engineVersion = engine.engineVersion;
  calc.metadata.resultHashSha256 = hash(serializeScheduleResultV1(calc.result));
  assert.equal(calc.metadata.inputHashSha256, hash(serializeScheduleInputV1(value)));
  assert.equal(Object.keys(calc.result.activities).length, 1000);
  const before = JSON.stringify({ source, calc });
  freeze(source);
  freeze(calc);
  assert.deepEqual(
    activityIds(projectPlannerPresentationV1(source, calc, selection())),
    value.activities.map((row) => row.id),
  );
  const expectedCritical = value.activities
    .filter((row) => calc.result.activities[row.id]?.critical)
    .map((row) => row.id);
  assert.deepEqual(
    activityIds(projectPlannerPresentationV1(source, calc, selection({ critical: "critical" }))),
    expectedCritical,
  );
  assert.ok(expectedCritical.length > 0 && expectedCritical.length < 1000);
  const view = freeze(
    selection({ sort: { field: "earlyStart", direction: "desc" }, groupBy: "wbs" }),
  );
  const samples: number[] = [],
    cold: number[] = [];
  const heapBefore = process.memoryUsage().heapUsed;
  for (let index = 0; index < 23; index++) {
    const start = performance.now();
    const projected = available(projectPlannerPresentationV1(source, calc, view));
    const elapsed = performance.now() - start;
    (index < 3 ? cold : samples).push(elapsed);
    assert.equal(projected.visibleActivityCount, 1000);
    assert.equal(projected.visualRowCount, 1003);
    assert.equal(new Set(activityIds(projected)).size, 1000);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  t.diagnostic(
    JSON.stringify({
      label: "planner-1000-pure-projection-characterization",
      runtime: process.version,
      v8: process.versions.v8,
      os: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      fixtureActivities: 1000,
      fixtureRelationships: value.relationships.length,
      fixtureCalendars: value.calendars.length,
      fixtureWbsNodes: value.wbs.length,
      method:
        "3 first-call samples then 20 warm samples; same frozen snapshot/result; engine excluded; GC uncontrolled",
      coldMs: cold,
      warmMs: {
        min: sorted[0],
        median: (Number(sorted[9]) + Number(sorted[10])) / 2,
        p95: sorted[18],
        max: sorted[19],
      },
      heapUsedDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
      inputHashSha256: source.inputHashSha256,
      resultHashSha256: calc.metadata.resultHashSha256,
      engineVersion: engine.engineVersion,
      claim:
        "One named-runtime characterization, not a universal latency/allocation guarantee or end-to-end acceptance",
    }),
  );
  assert.equal(JSON.stringify({ source, calc }), before);
});
