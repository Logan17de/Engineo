import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { after, type TestContext } from "node:test";
import {
  type ActivityInputV1,
  type EngineProjectInputV1,
  type EngineScheduleResultV1,
  MAX_WORK_MINUTES,
  NATIVE_PLANNER_PRESENTATION_V1,
  type PlannerProjectionV1,
  projectPlannerPresentationV1,
} from "@engineo/contracts";
import { act, type ReactElement, version as reactVersion } from "react";
import {
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
  type TestRendererOptions,
} from "react-test-renderer";
import ActivityTable from "./ActivityTable";
import { withIncompleteDurations } from "./activity-draft";
import DurationEditor from "./DurationEditor";

// Pure in-memory React rendering of synthetic DTOs. No browser, server, HTTP,
// application, schedule engine, database, SQL, or migration harness is used.
const previousActEnvironment = Object.getOwnPropertyDescriptor(
  globalThis,
  "IS_REACT_ACT_ENVIRONMENT",
);
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
  writable: true,
});
const previousResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
class LocalResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe() {
    this.callback();
  }
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: LocalResizeObserver,
  writable: true,
});
after(() => {
  if (previousActEnvironment)
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  if (previousResizeObserver)
    Object.defineProperty(globalThis, "ResizeObserver", previousResizeObserver);
  else Reflect.deleteProperty(globalThis, "ResizeObserver");
});

async function mount(
  context: TestContext,
  element: ReactElement,
  options?: TestRendererOptions,
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(element, options);
  });
  context.after(async () => {
    await act(() => renderer.unmount());
  });
  return renderer;
}

const input = (renderer: ReactTestRenderer) => renderer.root.findByType("input");
async function focus(renderer: ReactTestRenderer) {
  await act(() => input(renderer).props.onFocus());
}
async function change(renderer: ReactTestRenderer, raw: string) {
  await act(() => input(renderer).props.onChange({ target: { value: raw } }));
}
async function blur(renderer: ReactTestRenderer) {
  await act(() => input(renderer).props.onBlur());
}
function editor(value: number, editable = true, key = "current") {
  const commits: number[] = [];
  const drafts: Array<string | null> = [];
  const element = (nextValue = value, nextEditable = editable, nextKey = key, draft?: string) => (
    <DurationEditor
      key={nextKey}
      value={nextValue}
      editable={nextEditable}
      draft={draft}
      label="Activity duration in minutes"
      onCommit={(number) => commits.push(number)}
      onDraft={(raw) => drafts.push(raw)}
    />
  );
  return { commits, drafts, element };
}

test("in-memory component verification uses official pinned React/renderers", () => {
  const require = createRequire(import.meta.url);
  assert.equal(reactVersion, "19.2.0");
  assert.equal(require("react-test-renderer/package.json").version, "19.2.0");
  assert.equal(require("@types/react-test-renderer/package.json").version, "19.1.0");
});

test("duration focus, clear, and replacement retain a blank buffer without a NaN commit", async (t) => {
  const observed = editor(480);
  const renderer = await mount(t, observed.element());
  assert.equal(input(renderer).props.value, "480");
  assert.equal(input(renderer).props["aria-invalid"], undefined);

  await focus(renderer);
  await change(renderer, "");
  assert.equal(input(renderer).props.value, "");
  assert.equal(input(renderer).props["aria-invalid"], true);
  assert.deepEqual(observed.commits, []);
  assert.deepEqual(observed.drafts, [""]);

  // An unrelated controlled rerender must not replace an active empty buffer.
  await act(() => renderer.update(observed.element(480)));
  assert.equal(input(renderer).props.value, "");
  assert.deepEqual(observed.commits, []);

  await change(renderer, "6");
  assert.equal(input(renderer).props.value, "6");
  assert.equal(input(renderer).props["aria-invalid"], undefined);
  assert.deepEqual(observed.commits, [6]);
  assert.deepEqual(observed.drafts, ["", null]);
  await change(renderer, "60");
  assert.deepEqual(observed.commits, [6, 60]);
  assert.deepEqual(observed.drafts, ["", null, null]);
  await blur(renderer);
  assert.deepEqual(observed.commits, [6, 60]);
  assert.deepEqual(observed.drafts, ["", null, null, null]);
  assert.ok(observed.commits.every(Number.isFinite));
});

test("valid zero and typed values commit immediately without adding a blur edit", async (t) => {
  const observed = editor(120);
  const renderer = await mount(t, observed.element());
  await focus(renderer);
  await change(renderer, "0");
  assert.equal(input(renderer).props.value, "0");
  assert.equal(input(renderer).props["aria-invalid"], undefined);
  assert.deepEqual(observed.commits, [0]);
  await change(renderer, "90");
  assert.deepEqual(observed.commits, [0, 90]);
  await change(renderer, String(MAX_WORK_MINUTES));
  assert.deepEqual(observed.commits, [0, 90, MAX_WORK_MINUTES]);
  assert.equal(input(renderer).props.max, MAX_WORK_MINUTES);
  assert.equal(input(renderer).props["aria-invalid"], undefined);
  await blur(renderer);
  assert.deepEqual(observed.commits, [0, 90, MAX_WORK_MINUTES]);
  assert.deepEqual(observed.drafts, [null, null, null, null]);
});

const invalidDurations = [
  { name: "negative", raw: "-1" },
  { name: "negative fractional", raw: "-0.5" },
  { name: "fractional", raw: "1.5" },
  { name: "over MAX_WORK_MINUTES", raw: String(MAX_WORK_MINUTES + 1) },
  { name: "unsafe integer", raw: "9007199254740993" },
  { name: "non-finite exponent", raw: "1e309" },
];
for (const { name, raw } of invalidDurations) {
  test(`${name} duration stays local until blur commits its parsed invalid value`, async (t) => {
    const observed = editor(120);
    const renderer = await mount(t, observed.element());
    await focus(renderer);
    await change(renderer, raw);
    assert.equal(input(renderer).props.value, raw);
    assert.equal(input(renderer).props["aria-invalid"], true);
    assert.deepEqual(observed.commits, []);
    assert.deepEqual(observed.drafts, [raw]);
    await act(() => renderer.update(observed.element(120)));
    assert.equal(input(renderer).props.value, raw);
    assert.deepEqual(observed.commits, []);
    await blur(renderer);
    assert.deepEqual(observed.commits, [Number(raw)]);
    assert.deepEqual(observed.drafts, [raw, null]);
    await focus(renderer);
    await blur(renderer);
    assert.equal(observed.commits.length, 1, "an untouched invalid blur must not commit again");
  });
}

test("replacing a nonempty invalid duration with a valid value clears its draft immediately", async (t) => {
  const observed = editor(120);
  const renderer = await mount(t, observed.element());
  await focus(renderer);
  for (const { raw } of invalidDurations) await change(renderer, raw);
  assert.deepEqual(observed.commits, []);
  assert.deepEqual(
    observed.drafts,
    invalidDurations.map(({ raw }) => raw),
  );
  await change(renderer, "45");
  assert.deepEqual(observed.commits, [45]);
  assert.equal(observed.drafts.at(-1), null);
  assert.equal(input(renderer).props["aria-invalid"], undefined);
  await blur(renderer);
  assert.deepEqual(observed.commits, [45]);
});

test("untouched finite and recovered empty duration blur do not dirty the schedule", async (t) => {
  for (const value of [120, Number.NaN]) {
    const observed = editor(value);
    const renderer = await mount(t, observed.element());
    await focus(renderer);
    await blur(renderer);
    await focus(renderer);
    await blur(renderer);
    assert.deepEqual(observed.commits, [], "focus/blur alone must not dispatch an edit");
    assert.deepEqual(observed.drafts, [null, null]);
    assert.equal(input(renderer).props.value, Number.isFinite(value) ? String(value) : "");
  }
});

test("edited empty duration commits NaN only on blur and remains repairable in Native", async (t) => {
  const observed = editor(240);
  const renderer = await mount(t, observed.element());
  await focus(renderer);
  await change(renderer, "");
  assert.deepEqual(observed.commits, []);
  assert.deepEqual(observed.drafts, [""]);

  await blur(renderer);
  assert.equal(observed.commits.length, 1);
  assert.ok(Number.isNaN(observed.commits[0]));
  assert.deepEqual(observed.drafts, ["", null]);
  assert.equal(input(renderer).props.value, "");

  await act(() => renderer.update(observed.element(Number.NaN)));
  await focus(renderer);
  await blur(renderer);
  assert.equal(observed.commits.length, 1, "an untouched invalid field must not repeatedly dirty");
  await focus(renderer);
  await change(renderer, "30");
  assert.equal(input(renderer).props.value, "30");
  assert.equal(observed.commits[1], 30);
  assert.equal(input(renderer).props["aria-invalid"], undefined);
  await blur(renderer);
  assert.equal(observed.commits.length, 2);
  assert.deepEqual(observed.drafts, ["", null, null, null, null]);
});

test("draft callback tracks repeated clears and resets after replacement and blur", async (t) => {
  const observed = editor(40);
  const renderer = await mount(t, observed.element());
  await focus(renderer);
  await change(renderer, "");
  await change(renderer, "7");
  await change(renderer, "");
  assert.deepEqual(observed.drafts, ["", null, ""]);
  assert.deepEqual(observed.commits, [7]);
  await change(renderer, "75");
  await blur(renderer);
  assert.deepEqual(observed.drafts, ["", null, "", null, null]);
  assert.deepEqual(observed.commits, [7, 75]);
});

test("read-only durations are disabled including a recovered invalid value", async (t) => {
  const observed = editor(180, false);
  const renderer = await mount(t, observed.element());
  assert.equal(input(renderer).props.disabled, true);
  assert.equal(input(renderer).props.type, "number");
  assert.equal(input(renderer).props.min, 0);
  assert.equal(input(renderer).props.step, 1);
  assert.equal(input(renderer).props["aria-label"], "Activity duration in minutes");
  await act(() => renderer.update(observed.element(Number.NaN, false)));
  assert.equal(input(renderer).props.disabled, true);
  assert.equal(input(renderer).props.value, "");
  assert.equal(input(renderer).props["aria-invalid"], true);
  assert.deepEqual(observed.commits, []);
  assert.deepEqual(observed.drafts, []);
});

test("controlled saved values reload while unfocused without commit or draft side effects", async (t) => {
  const observed = editor(120);
  const renderer = await mount(t, observed.element());
  for (const value of [480, Number.NaN, 0, 960]) {
    await act(() => renderer.update(observed.element(value)));
    assert.equal(input(renderer).props.value, Number.isFinite(value) ? String(value) : "");
    assert.equal(input(renderer).props["aria-invalid"], Number.isFinite(value) ? undefined : true);
  }
  assert.deepEqual(observed.commits, []);
  assert.deepEqual(observed.drafts, []);
});

test("a keyed saved reload discards an active buffer without committing the discarded draft", async (t) => {
  const observed = editor(120);
  const renderer = await mount(t, observed.element());
  await focus(renderer);
  await change(renderer, "");
  assert.equal(input(renderer).props.value, "");
  await act(() => renderer.update(observed.element(720, true, "reloaded-saved-revision")));
  assert.equal(input(renderer).props.value, "720");
  assert.equal(input(renderer).props["aria-invalid"], undefined);
  assert.deepEqual(observed.commits, []);
  assert.deepEqual(observed.drafts, [""]);
  await focus(renderer);
  await blur(renderer);
  assert.deepEqual(observed.commits, []);
  assert.deepEqual(observed.drafts, ["", null]);
});

test("explicit draft props restore invalid text on remount and commit it on first blur", async (t) => {
  for (const raw of ["", ...invalidDurations.map(({ raw }) => raw)]) {
    const observed = editor(120);
    const renderer = await mount(t, observed.element());
    await focus(renderer);
    await change(renderer, raw);
    assert.deepEqual(observed.commits, []);
    await act(() => renderer.update(observed.element(120, true, `remounted:${raw}`, raw)));
    assert.equal(input(renderer).props.value, raw);
    assert.equal(input(renderer).props["aria-invalid"], true);
    assert.deepEqual(observed.commits, [], "remount alone must not commit");
    assert.deepEqual(observed.drafts, [raw], "remount must not clear the pending draft");
    await focus(renderer);
    await blur(renderer);
    const parsed = raw === "" ? Number.NaN : Number(raw);
    assert.deepEqual(observed.commits, [parsed]);
    assert.deepEqual(observed.drafts, [raw, null]);
    // The parent clears its map after the blur and controls the resulting value.
    await act(() => renderer.update(observed.element(parsed, true, `remounted:${raw}`)));
    await focus(renderer);
    await blur(renderer);
    assert.equal(observed.commits.length, 1);
  }
});

test("unfocused controlled draft updates restore and clear text without dispatching edits", async (t) => {
  const observed = editor(120);
  const renderer = await mount(t, observed.element());
  for (const { raw } of invalidDurations) {
    await act(() => renderer.update(observed.element(120, true, "current", raw)));
    assert.equal(input(renderer).props.value, raw);
    assert.equal(input(renderer).props["aria-invalid"], true);
  }
  await act(() => renderer.update(observed.element(240)));
  assert.equal(input(renderer).props.value, "240");
  assert.equal(input(renderer).props["aria-invalid"], undefined);
  assert.deepEqual(observed.commits, []);
  assert.deepEqual(observed.drafts, []);
});

const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
function entry<T>(values: readonly T[], index: number): T {
  const value = values[index];
  assert.ok(value !== undefined, `fixture entry ${index} must exist`);
  return value;
}
function schedule(count = 6): EngineProjectInputV1 {
  const day = [{ start: "08:00", end: "17:00" }];
  return {
    schemaVersion: 1,
    project: {
      id: uuid(1),
      name: "In-memory activity fixture",
      plannedStart: "2026-10-05T08:00:00.000Z",
      dataDate: "2026-10-05T08:00:00.000Z",
      requiredFinish: null,
      defaultCalendarId: uuid(2),
    },
    scheduleOptions: {
      criticalFloatThresholdMinutes: 0,
      lagCalendarPolicy: "SUCCESSOR",
      projectFinishPolicy: "CALCULATED",
    },
    calendars: [
      {
        id: uuid(2),
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
      { id: uuid(4), parentId: uuid(3), code: "B", name: "Child", sortOrder: 2 },
      { id: uuid(3), parentId: null, code: "A", name: "Parent", sortOrder: 1 },
    ],
    activities: Array.from({ length: count }, (_, index) => ({
      id: uuid(100 + index),
      name: `Record ${String(count - index).padStart(3, "0")}`,
      kind: "TASK",
      wbsId: uuid(index % 2 ? 4 : 3),
      calendarId: uuid(2),
      durationMinutes: 120 + index,
      constraints: [],
    })),
    relationships: [
      {
        predecessorId: uuid(100),
        successorId: uuid(101),
        type: "FS",
        lagMinutes: 15,
      },
    ],
  };
}
function calculation(value: EngineProjectInputV1): EngineScheduleResultV1 {
  const instant = "2026-10-05T08:00:00.000Z";
  const finish = "2026-10-05T12:00:00.000Z";
  return {
    schemaVersion: 1,
    projectFinish: finish,
    lateProjectFinish: finish,
    controllingFinishActivity: value.activities.at(-1)?.id ?? null,
    controllingPath: value.activities.map((activity) => activity.id),
    activities: Object.fromEntries(
      value.activities.map((activity) => [
        activity.id,
        {
          earlyStart: instant,
          earlyFinish: finish,
          lateStart: instant,
          lateFinish: finish,
          totalFloatMinutes: 0,
          freeFloatMinutes: 0,
          critical: true,
          drivingCauses: [],
        },
      ]),
    ),
    constraintViolations: [],
  };
}

test("incomplete-duration recovery clones only marked activities and preserves schedule/result identity", () => {
  const saved = { input: schedule(), result: calculation(schedule()), revision: 17 };
  const before = structuredClone(saved);
  const marked = new Set([
    entry(saved.input.activities, 1).id,
    entry(saved.input.activities, 4).id,
  ]);
  const drafts = new Map([...marked].map((id) => [id, ""]));
  drafts.set(uuid(999), "");
  const beforeDrafts = new Map(drafts);
  const recovered = withIncompleteDurations(saved.input, drafts);

  assert.notEqual(recovered, saved.input);
  assert.notEqual(recovered.activities, saved.input.activities);
  assert.deepEqual(saved, before, "the saved schedule and cached results must remain unchanged");
  assert.deepEqual(drafts, beforeDrafts);
  for (const key of ["project", "scheduleOptions", "calendars", "wbs", "relationships"] as const)
    assert.equal(recovered[key], saved.input[key], `${key} must not be cloned or rewritten`);
  assert.deepEqual(
    recovered.activities.map((activity) => activity.id),
    saved.input.activities.map((activity) => activity.id),
  );
  for (const [index, activity] of recovered.activities.entries()) {
    const original = entry(saved.input.activities, index);
    if (marked.has(activity.id)) {
      assert.notEqual(activity, original);
      assert.ok(Number.isNaN(activity.durationMinutes));
      assert.deepEqual({ ...activity, durationMinutes: original.durationMinutes }, original);
      assert.equal(activity.constraints, original.constraints);
    } else assert.equal(activity, original);
  }
  assert.deepEqual(saved.result, before.result);
  assert.equal(saved.revision, before.revision);
});

test("empty duration recovery map returns the original schedule without cloning", () => {
  const saved = schedule();
  assert.equal(withIncompleteDurations(saved, new Map()), saved);
});

test("recovery preserves actual parsed invalid durations without touching source or untouched rows", () => {
  const rawValues = ["", ...invalidDurations.map(({ raw }) => raw)];
  const saved = schedule(rawValues.length + 1);
  const before = structuredClone(saved);
  const drafts = new Map(rawValues.map((raw, index) => [entry(saved.activities, index).id, raw]));
  const recovered = withIncompleteDurations(saved, drafts);
  assert.deepEqual(saved, before);
  assert.equal(recovered.activities.length, saved.activities.length);
  for (const [index, raw] of rawValues.entries()) {
    const original = entry(saved.activities, index);
    const activity = entry(recovered.activities, index);
    assert.notEqual(activity, original);
    assert.deepEqual(activity.durationMinutes, raw === "" ? Number.NaN : Number(raw));
    assert.deepEqual({ ...activity, durationMinutes: original.durationMinutes }, original);
  }
  assert.equal(recovered.activities.at(-1), saved.activities.at(-1));
  assert.deepEqual(
    recovered.activities.map(({ id }) => id),
    saved.activities.map(({ id }) => id),
  );
  assert.equal(recovered.project, saved.project);
  assert.equal(recovered.scheduleOptions, saved.scheduleOptions);
  assert.equal(recovered.wbs, saved.wbs);
  assert.equal(recovered.calendars, saved.calendars);
  assert.equal(recovered.relationships, saved.relationships);
  assert.deepEqual(
    [...drafts.values()],
    rawValues,
    "the recovery overlay must not normalize or rewrite stored raw draft text",
  );
});

function projected(value: EngineProjectInputV1): Extract<PlannerProjectionV1, { available: true }> {
  const projection = projectPlannerPresentationV1(
    {
      organizationId: uuid(5),
      projectId: value.project.id,
      scheduleRevision: 17,
      inputHashSha256: "a".repeat(64),
      inputState: "unsaved",
      currentEngineVersion: null,
      input: value,
    },
    null,
    {
      projectionVersion: 1,
      normalizationVersion: 1,
      configHashSha256: null,
      presentation: {
        ...structuredClone(NATIVE_PLANNER_PRESENTATION_V1),
        sort: { field: "name", direction: "asc" },
        groupBy: "wbs",
      },
    },
  );
  assert.ok(projection.available, JSON.stringify(projection));
  return projection;
}
function tableFixture(
  value: EngineProjectInputV1,
  projection: PlannerProjectionV1,
  editable = true,
  durationDrafts = new Map<string, string>(),
) {
  const edits: Array<{ id: string; patch: Partial<ActivityInputV1> }> = [];
  const deletes: string[] = [];
  const drafts: Array<{ id: string; raw: string | null }> = [];
  const scroll = {
    scrollTop: 0,
    clientHeight: 18 * 42,
    scrollHeight: projection.available ? projection.rows.length * 42 : 0,
    scrollTo({ top }: { top: number }) {
      this.scrollTop = top;
    },
  };
  const element = (
    <ActivityTable
      input={value}
      result={calculation(value)}
      editable={editable}
      filter=""
      projection={projection}
      durationDrafts={durationDrafts}
      onEdit={(id, patch) => edits.push({ id, patch })}
      onDelete={(id) => deletes.push(id)}
      onDurationDraft={(id, raw) => {
        drafts.push({ id, raw });
        if (raw === null) durationDrafts.delete(id);
        else durationDrafts.set(id, raw);
      }}
    />
  );
  const options: TestRendererOptions = {
    createNodeMock: (element) =>
      element.type === "section" &&
      typeof element.props === "object" &&
      element.props !== null &&
      "className" in element.props &&
      element.props.className === "activityScroll"
        ? scroll
        : null,
  };
  return { element, options, edits, deletes, drafts, scroll, durationDrafts };
}
const field = (renderer: ReactTestRenderer, label: string): ReactTestInstance =>
  renderer.root.find((node) => typeof node.type === "string" && node.props["aria-label"] === label);

test("grouped reordered activity callbacks use activity UUIDs for every editable field", async (t) => {
  const saved = schedule(8);
  const before = structuredClone(saved);
  const projection = projected(saved);
  const row = projection.rows.find((row) => row.kind === "activity");
  assert.ok(row?.kind === "activity");
  assert.notEqual(row.nativeIndex, row.displayOrdinal - 1);
  assert.equal(projection.rows[0]?.kind, "group");
  const observed = tableFixture(saved, projection);
  const renderer = await mount(t, observed.element, observed.options);
  const label = `Activity ${row.displayOrdinal}`;
  assert.equal(
    field(renderer, `${label} name`).props.value,
    entry(saved.activities, row.nativeIndex).name,
  );

  for (const [suffix, raw, patch] of [
    ["name", "Renamed projected row", { name: "Renamed projected row" }],
    ["type", "FINISH_MILESTONE", { kind: "FINISH_MILESTONE", durationMinutes: 0 }],
    ["WBS", uuid(4), { wbsId: uuid(4) }],
    ["calendar", uuid(2), { calendarId: uuid(2) }],
  ] as const) {
    await act(() =>
      field(renderer, `${label} ${suffix}`).props.onChange({ target: { value: raw } }),
    );
    assert.deepEqual(observed.edits.at(-1), { id: row.activityId, patch });
  }
  const duration = () => field(renderer, `${label} duration in minutes`);
  await act(() => duration().props.onFocus());
  await act(() => duration().props.onChange({ target: { value: "" } }));
  assert.equal(duration().props.value, "");
  assert.deepEqual(observed.drafts, [{ id: row.activityId, raw: "" }]);
  assert.equal(observed.edits.length, 4, "clearing must not dispatch a NaN edit");
  await act(() => duration().props.onChange({ target: { value: "45" } }));
  assert.deepEqual(observed.edits.at(-1), { id: row.activityId, patch: { durationMinutes: 45 } });
  await act(() => duration().props.onBlur());
  assert.deepEqual(observed.drafts, [
    { id: row.activityId, raw: "" },
    { id: row.activityId, raw: null },
    { id: row.activityId, raw: null },
  ]);
  await act(() => field(renderer, `Delete ${label.toLowerCase()}`).props.onClick());
  assert.deepEqual(observed.deletes, [row.activityId]);
  assert.ok(observed.edits.every((edit) => edit.id === row.activityId));
  assert.deepEqual(saved, before);
});

test("virtualized grouped rows retain UUID targets after scrolling away from native positions", async (t) => {
  const saved = schedule(64);
  const before = structuredClone(saved);
  const projection = projected(saved);
  const observed = tableFixture(saved, projection);
  const renderer = await mount(t, observed.element, observed.options);
  const firstActivity = projection.rows.find((row) => row.kind === "activity");
  assert.ok(firstActivity?.kind === "activity");
  observed.scroll.scrollTop = 32 * 42;
  await act(() =>
    field(renderer, "Activity table and synchronized Gantt").props.onScroll({
      currentTarget: observed.scroll,
    }),
  );
  const firstVisibleRow = 29; // floor(scrollTop / 42) - three overscan rows
  const visible = projection.rows.slice(firstVisibleRow, firstVisibleRow + 24);
  const row = visible.find((row) => row.kind === "activity");
  assert.ok(row?.kind === "activity");
  assert.notEqual(row.nativeIndex, row.displayOrdinal - 1);
  assert.notEqual(row.nativeIndex, firstVisibleRow);
  assert.equal(
    renderer.root.findAll(
      (node) =>
        node.type === "input" &&
        node.props["aria-label"] === `Activity ${firstActivity.displayOrdinal} name`,
    ).length,
    0,
    "the first projected activity must be outside the mounted window",
  );
  const label = `Activity ${row.displayOrdinal}`;
  await act(() =>
    field(renderer, `${label} name`).props.onChange({ target: { value: "Scrolled edit" } }),
  );
  assert.deepEqual([...observed.edits], [{ id: row.activityId, patch: { name: "Scrolled edit" } }]);
  const duration = () => field(renderer, `${label} duration in minutes`);
  await act(() => duration().props.onFocus());
  await act(() => duration().props.onChange({ target: { value: "" } }));
  assert.equal(observed.edits.length, 1);
  assert.deepEqual(observed.drafts, [{ id: row.activityId, raw: "" }]);
  await act(() => duration().props.onBlur());
  const committed = observed.edits.at(-1);
  assert.ok(committed);
  assert.equal(committed.id, row.activityId);
  assert.ok(Number.isNaN(committed.patch.durationMinutes));
  assert.deepEqual(observed.drafts, [
    { id: row.activityId, raw: "" },
    { id: row.activityId, raw: null },
  ]);
  await act(() => field(renderer, `Delete ${label.toLowerCase()}`).props.onClick());
  assert.deepEqual(observed.deletes, [row.activityId]);
  assert.deepEqual(saved, before);
});

test("UUID-keyed invalid drafts survive virtual scroll-away and scroll-back before blur", async (t) => {
  for (const raw of ["", ...invalidDurations.map(({ raw }) => raw)]) {
    const saved = schedule(64);
    const before = structuredClone(saved);
    const projection = projected(saved);
    const row = projection.rows.find((row) => row.kind === "activity");
    assert.ok(row?.kind === "activity");
    const observed = tableFixture(saved, projection);
    const renderer = await mount(t, observed.element, observed.options);
    const label = `Activity ${row.displayOrdinal} duration in minutes`;
    const duration = () => field(renderer, label);
    await act(() => duration().props.onFocus());
    await act(() => duration().props.onChange({ target: { value: raw } }));
    assert.deepEqual(observed.edits, []);
    assert.equal(observed.durationDrafts.get(row.activityId), raw);
    observed.scroll.scrollTop = 32 * 42;
    await act(() =>
      field(renderer, "Activity table and synchronized Gantt").props.onScroll({
        currentTarget: observed.scroll,
      }),
    );
    assert.equal(
      renderer.root.findAll((node) => node.type === "input" && node.props["aria-label"] === label)
        .length,
      0,
    );
    assert.deepEqual(observed.edits, [], "virtual unmount must not commit or drop the draft");
    assert.equal(observed.durationDrafts.get(row.activityId), raw);
    observed.scroll.scrollTop = 0;
    await act(() =>
      field(renderer, "Activity table and synchronized Gantt").props.onScroll({
        currentTarget: observed.scroll,
      }),
    );
    assert.equal(duration().props.value, raw);
    assert.equal(duration().props["aria-invalid"], true);
    assert.deepEqual(observed.edits, []);
    assert.deepEqual(observed.drafts, [{ id: row.activityId, raw }]);
    await act(() => duration().props.onFocus());
    await act(() => duration().props.onBlur());
    assert.deepEqual(observed.edits, [
      { id: row.activityId, patch: { durationMinutes: raw === "" ? Number.NaN : Number(raw) } },
    ]);
    assert.equal(observed.durationDrafts.has(row.activityId), false);
    assert.deepEqual(observed.drafts, [
      { id: row.activityId, raw },
      { id: row.activityId, raw: null },
    ]);
    assert.deepEqual(saved, before);
  }
});

test("a whole-table tab remount restores each projected draft by UUID rather than row position", async (t) => {
  const saved = schedule(8);
  const before = structuredClone(saved);
  const projection = projected(saved);
  const rows = projection.rows.filter((row) => row.kind === "activity");
  const first = entry(rows, 0);
  const second = entry(rows, 1);
  const durationDrafts = new Map([
    [first.activityId, "-5"],
    [second.activityId, "1.5"],
  ]);
  const observed = tableFixture(saved, projection, true, durationDrafts);
  const renderer = await mount(t, observed.element, observed.options);
  const firstLabel = `Activity ${first.displayOrdinal} duration in minutes`;
  const secondLabel = `Activity ${second.displayOrdinal} duration in minutes`;
  assert.equal(field(renderer, firstLabel).props.value, "-5");
  assert.equal(field(renderer, secondLabel).props.value, "1.5");
  await act(() => renderer.update(<div>Another local planner tab</div>));
  assert.deepEqual(observed.edits, []);
  assert.deepEqual(observed.drafts, []);
  await act(() => renderer.update(observed.element));
  assert.equal(field(renderer, firstLabel).props.value, "-5");
  assert.equal(field(renderer, secondLabel).props.value, "1.5");
  await act(() => field(renderer, secondLabel).props.onFocus());
  await act(() => field(renderer, secondLabel).props.onChange({ target: { value: "90" } }));
  assert.deepEqual(observed.edits, [{ id: second.activityId, patch: { durationMinutes: 90 } }]);
  assert.equal(durationDrafts.has(second.activityId), false);
  assert.equal(durationDrafts.get(first.activityId), "-5");
  await act(() => field(renderer, firstLabel).props.onFocus());
  await act(() => field(renderer, firstLabel).props.onBlur());
  assert.deepEqual(observed.edits.at(-1), {
    id: first.activityId,
    patch: { durationMinutes: -5 },
  });
  assert.equal(durationDrafts.size, 0);
  assert.deepEqual(saved, before);
});

test("read-only projected rows disable all schedule edits including duration and deletion", async (t) => {
  const saved = schedule();
  const projection = projected(saved);
  const observed = tableFixture(saved, projection, false);
  const renderer = await mount(t, observed.element, observed.options);
  const editableControls = renderer.root.findAll(
    (node) =>
      typeof node.type === "string" &&
      ["input", "select", "button"].includes(node.type) &&
      typeof node.props["aria-label"] === "string" &&
      /^(?:Activity \d+|Delete activity \d+)/.test(node.props["aria-label"]),
  );
  assert.equal(editableControls.length, saved.activities.length * 6);
  assert.ok(editableControls.every((node) => node.props.disabled === true));
  assert.deepEqual(observed.edits, []);
  assert.deepEqual(observed.deletes, []);
  assert.deepEqual(observed.drafts, []);
});

test("Native keeps invalid recovered durations editable while milestone durations stay disabled", async (t) => {
  const saved = schedule(3);
  saved.activities[1] = {
    ...entry(saved.activities, 1),
    kind: "START_MILESTONE",
    durationMinutes: 0,
  };
  const recovered = withIncompleteDurations(saved, new Map([[entry(saved.activities, 0).id, ""]]));
  const commits: Array<{ id: string; patch: Partial<ActivityInputV1> }> = [];
  const renderer = await mount(
    t,
    <ActivityTable
      input={recovered}
      result={null}
      editable={true}
      filter=""
      onEdit={(id, patch) => commits.push({ id, patch })}
      onDelete={() => assert.fail("repair must not delete an activity")}
    />,
  );
  const duration = () => field(renderer, "Activity 1 duration in minutes");
  assert.equal(duration().props.disabled, false);
  assert.equal(duration().props.value, "");
  assert.equal(duration().props["aria-invalid"], true);
  assert.equal(field(renderer, "Activity 2 duration in minutes").props.disabled, true);
  await act(() => duration().props.onFocus());
  await act(() => duration().props.onChange({ target: { value: "180" } }));
  await act(() => duration().props.onBlur());
  assert.deepEqual(commits, [
    { id: entry(saved.activities, 0).id, patch: { durationMinutes: 180 } },
  ]);
  assert.equal(entry(saved.activities, 0).durationMinutes, 120);
});
