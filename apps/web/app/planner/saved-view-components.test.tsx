import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  type EngineProjectInputV1,
  type EngineScheduleResultV1,
  NATIVE_PLANNER_PRESENTATION_V1,
  type PlannerPresentationV1,
  type PlannerProjectionV1,
  type PlannerViewActionV1,
  type PlannerViewConfigurationV1,
  type PlannerViewPlanV1,
  type PlannerViewReceiptV1,
  type PlannerViewReviewV1,
  projectPlannerPresentationV1,
  serializePlannerViewHashPreimageV1,
  serializePlannerViewReviewHashPreimageV1,
  serializeScheduleInputV1,
  validatePlannerViewConfigurationV1,
  validatePlannerViewReceiptV1,
  validatePlannerViewReviewV1,
} from "@engineo/contracts";
import { version as reactVersion } from "react";
import { version as reactDomVersion } from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import ActivityTable from "./ActivityTable";
import SavedViewsPanel, { SavedViewControls } from "./SavedViewsPanel";
import {
  EMPTY_SAVED_VIEW_STATE,
  SavedViewController,
  type SavedViewRecovery,
  type SavedViewScope,
  type SavedViewState,
} from "./saved-view-controller";
import type { ViewReadV1 } from "./saved-view-protocol";
import type { GuiViewSource } from "./saved-view-projection";
import { useSavedViewProjection } from "./use-saved-view-projection";

// React/ReactDOM 19.2.0 server rendering only; no browser, mounted app, server,
// HTTP, schedule engine, database or SQL harness. Synthetic DTOs are local fixtures.
if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
const uuid = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const SCOPE: SavedViewScope = {
  actorId: uuid(1),
  sessionId: uuid(2),
  organizationId: uuid(3),
  projectId: uuid(4),
  scheduleRevision: 17,
};
const TIME = "2026-10-03T12:00:00.000Z";
const noAction = () => assert.fail("Static rendering must not dispatch any action");
const callbacks = {
  onSelect: noAction,
  onName: noAction,
  onPresentation: noAction,
  onList: noAction,
  onPreview: noAction,
  onApply: noAction,
  onDiscard: noAction,
  onStop: noAction,
  onRecover: noAction,
};

async function hash(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
function configuration(
  name = "Saved steel view",
  presentation: Partial<PlannerPresentationV1> = {},
): PlannerViewConfigurationV1 {
  const checked = validatePlannerViewConfigurationV1({
    schemaVersion: 1,
    kind: "engineo-planner-view",
    visibility: "private",
    name,
    presentation: { ...structuredClone(NATIVE_PLANNER_PRESENTATION_V1), ...presentation },
  });
  assert.ok(checked.valid);
  return checked.normalizedConfiguration;
}
async function record(): Promise<ViewReadV1> {
  const config = configuration();
  return {
    schemaVersion: 1,
    viewId: uuid(5),
    viewRevision: 7,
    configuration: config,
    configHashSha256: await hash(serializePlannerViewHashPreimageV1(config)),
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: TIME,
  };
}
async function reviewFixture(action: PlannerViewActionV1 = "update", noOp = false) {
  const base = await record();
  const desired = noOp
    ? base.configuration
    : configuration("Changed private view", {
        search: "steel",
        kind: "TASK",
        wbsId: uuid(8),
        critical: "critical",
        sort: { field: "earlyStart", direction: "desc" },
        groupBy: "wbs",
      });
  const review: PlannerViewReviewV1 = {
    schemaVersion: 1,
    kind: "engineo-planner-view-review",
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    actorId: SCOPE.actorId,
    sessionId: SCOPE.sessionId,
    organizationId: SCOPE.organizationId,
    projectId: SCOPE.projectId,
    expectedScheduleRevision: SCOPE.scheduleRevision,
    expectedViewRevision: action === "create" ? 0 : base.viewRevision,
    action,
    viewId: action === "create" ? null : base.viewId,
    baseConfiguration: action === "create" ? null : base.configuration,
    desiredConfiguration: action === "delete" ? null : desired,
    baseConfigHash: action === "create" ? null : base.configHashSha256,
    desiredConfigHash:
      action === "delete" ? null : await hash(serializePlannerViewHashPreimageV1(desired)),
    operationWindowId: "2026-10-03",
    operationId: uuid(6),
    issuedAt: TIME,
    expiresAt: "2026-10-03T12:15:00.000Z",
  };
  assert.ok(validatePlannerViewReviewV1(review).valid);
  const plan: PlannerViewPlanV1 = {
    review,
    reviewedDigest: await hash(serializePlannerViewReviewHashPreimageV1(review)),
  };
  const recovery: SavedViewRecovery = {
    actorId: SCOPE.actorId,
    sessionId: SCOPE.sessionId,
    organizationId: SCOPE.organizationId,
    projectId: SCOPE.projectId,
    expectedScheduleRevision: SCOPE.scheduleRevision,
    previousViewRevision: review.expectedViewRevision,
    action,
    viewId: review.viewId,
    baseConfigHash: review.baseConfigHash,
    desiredConfigHash: review.desiredConfigHash,
    operationWindowId: review.operationWindowId,
    operationId: review.operationId,
    reviewedDigest: plan.reviewedDigest,
  };
  const receipt: PlannerViewReceiptV1 = {
    schemaVersion: 1,
    kind: "engineo-planner-view-receipt",
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    actorId: SCOPE.actorId,
    sessionId: SCOPE.sessionId,
    organizationId: SCOPE.organizationId,
    projectId: SCOPE.projectId,
    expectedScheduleRevision: SCOPE.scheduleRevision,
    previousViewRevision: review.expectedViewRevision,
    committedViewRevision: action === "delete" ? null : action === "create" ? 1 : noOp ? 7 : 8,
    action,
    outcome: action === "delete" ? "deleted" : noOp ? "no_op" : "applied",
    viewId: base.viewId,
    baseConfigHash: review.baseConfigHash,
    desiredConfigHash: review.desiredConfigHash,
    operationWindowId: review.operationWindowId,
    operationId: review.operationId,
    reviewedDigest: plan.reviewedDigest,
    auditId: uuid(7),
    recordedAt: "2026-10-03T12:00:01.000Z",
  };
  assert.ok(validatePlannerViewReceiptV1(receipt).valid);
  return { base, plan, recovery, receipt };
}
function state(patch: Partial<SavedViewState> = {}): SavedViewState {
  return { ...structuredClone(EMPTY_SAVED_VIEW_STATE), ...patch };
}
function inputFixture(count = 4): EngineProjectInputV1 {
  const day = [{ start: "08:00", end: "17:00" }];
  return {
    schemaVersion: 1,
    project: {
      id: SCOPE.projectId,
      name: "Synthetic table fixture",
      plannedStart: "2026-10-05T08:00:00.000Z",
      dataDate: "2026-10-05T08:00:00.000Z",
      requiredFinish: null,
      defaultCalendarId: uuid(7),
    },
    scheduleOptions: {
      criticalFloatThresholdMinutes: 0,
      lagCalendarPolicy: "SUCCESSOR",
      projectFinishPolicy: "CALCULATED",
    },
    calendars: [
      {
        id: uuid(7),
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
      { id: uuid(9), parentId: uuid(8), code: "child", name: "Repeated", sortOrder: 3 },
      { id: uuid(8), parentId: null, code: "parent", name: "Repeated", sortOrder: 1 },
    ],
    activities: Array.from({ length: count }, (_, index) => ({
      id: uuid(100 + index),
      name: `Record ${String(count - index).padStart(3, "0")} ${uuid(100 + index)}`,
      kind: index === 1 ? "START_MILESTONE" : "TASK",
      wbsId: uuid(index % 2 ? 9 : 8),
      calendarId: uuid(7),
      durationMinutes: index === 1 ? 0 : 120 + index,
      constraints: [],
    })),
    relationships: [],
  };
}
function controls(value = state(), options: { disabled?: boolean; dirty?: boolean } = {}) {
  const before = structuredClone(value);
  const html = renderToStaticMarkup(
    <SavedViewControls
      state={value}
      wbs={inputFixture().wbs}
      disabled={options.disabled ?? false}
      dirty={options.dirty ?? false}
      {...callbacks}
    />,
  );
  assert.deepEqual(value, before, "SSR must not mutate private-view state");
  return html;
}
const plain = (value: string) =>
  value
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
function button(html: string, label: string) {
  const buttons = Array.from(html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g));
  const found = buttons.find((match) => plain(match[2] ?? "") === label);
  assert.ok(found, `button ${label} must be rendered`);
  return { disabled: /\bdisabled=""/.test(found[1] ?? ""), html: found[0] };
}
function field(html: string, label: string) {
  const labels = Array.from(html.matchAll(/<label>([\s\S]*?)<\/label>/g));
  const found = labels.find((match) => (match[1] ?? "").startsWith(label));
  assert.ok(found, `field ${label} must be rendered`);
  return found[0];
}
const mutationLabels = ["Review new private view", "Review update", "Review delete"];
async function projection(
  input: EngineProjectInputV1,
  presentation: Partial<PlannerPresentationV1> = {},
) {
  const result = projectPlannerPresentationV1(
    {
      organizationId: SCOPE.organizationId,
      projectId: SCOPE.projectId,
      scheduleRevision: SCOPE.scheduleRevision,
      inputHashSha256: await hash(serializeScheduleInputV1(input)),
      inputState: "unsaved",
      currentEngineVersion: null,
      input,
    },
    null,
    {
      projectionVersion: 1,
      normalizationVersion: 1,
      configHashSha256: null,
      presentation: configuration("Table fixture", presentation).presentation,
    },
  );
  assert.ok(result.available, JSON.stringify(result));
  return result;
}
function table(
  input: EngineProjectInputV1,
  projected?: PlannerProjectionV1 | null,
  options: { editable?: boolean; filter?: string; result?: EngineScheduleResultV1 | null } = {},
) {
  const before = structuredClone(input);
  const html = renderToStaticMarkup(
    <ActivityTable
      input={input}
      result={options.result ?? null}
      editable={options.editable ?? false}
      filter={options.filter ?? ""}
      projection={projected}
      onEdit={noAction}
      onDelete={noAction}
    />,
  );
  assert.deepEqual(input, before, "SSR must not save or edit a schedule draft");
  return html;
}
function indexedRows(html: string) {
  return Array.from(html.matchAll(/<tr\b[^>]*aria-rowindex="(\d+)"[^>]*>([\s\S]*?)<\/tr>/g));
}

test("SSR verification uses exactly pinned React and ReactDOM 19.2.0", () => {
  assert.equal(reactVersion, "19.2.0");
  assert.equal(reactDomVersion, "19.2.0");
});

test("read-only activity viewers can review private views independently of schedule edit permissions", () => {
  const html = controls(state({ listed: true }), { dirty: true });
  assert.equal(button(html, "Review new private view").disabled, false);
  assert.match(html, /Private to your account/);
  assert.match(html, /Viewing an unsaved schedule draft/);
  assert.match(
    field(html, "Selected presentation"),
    /<option value="native" selected="">Native<\/option>/,
  );
  const readonlyTable = table(inputFixture());
  assert.match(readonlyTable, /aria-label="Activity 1 name" disabled=""/);
  assert.match(readonlyTable, /aria-label="Delete activity 1"/);
  assert.equal(button(readonlyTable, "×").disabled, true);
  assert.doesNotMatch(html, /Save schedule|Recalculate|Run schedule/);
});

test("Native is immutable: update and delete are disabled while creating a private view remains enabled", () => {
  const html = controls(state({ listed: true }));
  assert.equal(button(html, "Review update").disabled, true);
  assert.equal(button(html, "Review delete").disabled, true);
  assert.equal(button(html, "Review new private view").disabled, false);
  assert.equal(button(html, "Use Native").disabled, false);
  assert.match(html, /No saved private views\. Native is always available/);
});

test("local presentation is an explicit transient option with no saved record to mutate", () => {
  const html = controls(
    state({ presentation: configuration("Local", { search: "steel" }).presentation }),
  );
  assert.match(
    field(html, "Selected presentation"),
    /<option value="transient" disabled="" selected="">Local presentation<\/option>/,
  );
  assert.equal(button(html, "Review new private view").disabled, false);
  assert.equal(button(html, "Review update").disabled, true);
  assert.equal(button(html, "Review delete").disabled, true);
  assert.match(field(html, "Find activities"), /value="steel"/);
});

test("selected private view has an explicit option even when absent from the current list page", async () => {
  const saved = await record();
  const html = controls(
    state({
      record: saved,
      selectedId: saved.viewId,
      name: saved.configuration.name,
      presentation: saved.configuration.presentation,
    }),
  );
  assert.match(
    field(html, "Selected presentation"),
    new RegExp(`<option value="${saved.viewId}" selected="">Saved steel view</option>`),
  );
  assert.equal(button(html, "Review update").disabled, false);
  assert.equal(button(html, "Review delete").disabled, false);
  assert.doesNotMatch(html, /This presentation has local changes/);
});

test("selected list record is not duplicated and local edits are disclosed until review and apply", async () => {
  const saved = await record();
  const html = controls(
    state({
      record: saved,
      selectedId: saved.viewId,
      name: "Renamed locally",
      presentation: configuration("Local", { search: "steel", groupBy: "wbs" }).presentation,
      views: [
        {
          viewId: saved.viewId,
          name: saved.configuration.name,
          viewRevision: saved.viewRevision,
          configHashSha256: saved.configHashSha256,
          updatedAt: saved.updatedAt,
        },
      ],
      nextCursor: saved.viewId,
    }),
  );
  assert.equal(html.split(`<option value="${saved.viewId}"`).length - 1, 1);
  assert.match(html, /saved private view is unchanged until you review and apply/);
  assert.match(field(html, "Private view name"), /value="Renamed locally"/);
  assert.equal(button(html, "Load more private views").disabled, false);
});

test("stale WBS stays visibly selected instead of silently broadening to all WBS", () => {
  const stale = uuid(999);
  const html = controls(
    state({ presentation: configuration("Stale", { wbsId: stale }).presentation }),
  );
  assert.match(
    field(html, "WBS filter"),
    new RegExp(`<option value="${stale}" selected="">Unavailable WBS reference</option>`),
  );
  assert.doesNotMatch(field(html, "WBS filter"), /value="" selected/);
});

for (const action of ["create", "update", "delete"] as const) {
  test(`${action} preview renders stateless before/after review with apply and discard`, async () => {
    const { base, plan } = await reviewFixture(action);
    const html = controls(state({ record: action === "create" ? null : base, plan }));
    assert.match(html, /aria-label="Review private view action"/);
    assert.match(html, /Saved schedule revision 17 · View revision/);
    assert.match(html, /Expires 2026-10-03T12:15:00.000Z/);
    assert.match(html, /Your schedule draft, source order and calculated dates stay unchanged/);
    assert.equal(button(html, `Apply private view ${action}`).disabled, false);
    assert.equal(button(html, "Discard preview").disabled, false);
    for (const label of mutationLabels) assert.equal(button(html, label).disabled, true);
    assert.equal(button(html, "Use Native").disabled, true);
    if (action === "create") assert.doesNotMatch(html, /Before:/);
    else
      assert.match(
        html,
        /Before: Search: all activities; type: all; WBS: all; critical: all; sort: native asc; grouping: none/,
      );
    if (action === "delete") {
      assert.match(html, /This removes only your private presentation record/);
      assert.doesNotMatch(html, /After:/);
    } else {
      assert.match(html, /After: Search: steel; type: TASK; WBS:/);
      assert.match(html, /critical: critical; sort: earlyStart desc; grouping: wbs/);
    }
  });
}

test("pending request locks controls, exposes busy status and permits stopping the wait", async () => {
  const { base, plan } = await reviewFixture();
  const html = controls(
    state({ record: base, plan, busy: "Applying private view", nextCursor: uuid(5) }),
  );
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /role="status"[^>]*>Applying private view<\/div>/);
  for (const label of [
    ...mutationLabels,
    "Use Native",
    "Load more private views",
    "Reload private views",
    "Apply private view update",
    "Discard preview",
  ])
    assert.equal(button(html, label).disabled, true);
  for (const label of [
    "Selected presentation",
    "Private view name",
    "Find activities",
    "Critical filter",
    "Sort by",
    "WBS filter",
  ])
    assert.match(field(html, label), /disabled=""/);
  assert.equal(button(html, "Stop waiting").disabled, false);
});

test("unknown apply outcome blocks new mutations and exposes the original operation recovery", async () => {
  const { base, recovery } = await reviewFixture();
  const html = controls(
    state({ record: base, recovery, error: "The view apply outcome is unknown." }),
  );
  assert.match(html, /aria-label="Uncertain private view apply"/);
  assert.match(html, /Stopping a request does not cancel a commit/);
  assert.match(html, /Another mutation stays blocked while this outcome is unknown/);
  assert.match(html, new RegExp(`Operation 2026-10-03 / ${uuid(6)}`));
  for (const label of [...mutationLabels, "Use Native"])
    assert.equal(button(html, label).disabled, true);
  assert.equal(button(html, "Check original operation").disabled, false);
  assert.doesNotMatch(html, /Apply private view update|Discard preview/);
  assert.match(html, /role="alert">The view apply outcome is unknown/);
});

test("recovery request itself remains single-flight and still permits Stop waiting", async () => {
  const { recovery } = await reviewFixture();
  const html = controls(state({ recovery, busy: "Checking original operation" }));
  assert.equal(button(html, "Check original operation").disabled, true);
  assert.equal(button(html, "Stop waiting").disabled, false);
});

test("external busy state blocks apply while the unsubmitted preview can still be discarded", async () => {
  const { plan } = await reviewFixture();
  const html = controls(state({ plan }), { disabled: true });
  assert.equal(button(html, "Apply private view update").disabled, true);
  assert.equal(button(html, "Discard preview").disabled, false);
});

for (const outcome of ["applied", "no_op", "deleted"] as const) {
  test(`${outcome} receipt explicitly describes history rather than current view state`, async () => {
    const { receipt: historical } = await reviewFixture(
      outcome === "deleted" ? "delete" : "update",
      outcome === "no_op",
    );
    const html = controls(
      state({ receipt: historical, notice: "Reload private views for their current state." }),
    );
    assert.match(html, new RegExp(`Historical receipt: ${outcome} · 2026-10-03T12:00:01.000Z`));
    assert.match(html, /This does not describe the current view record/);
    assert.match(html, /Reload private views for their current state/);
    assert.equal(button(html, "Reload private views").disabled, false);
    assert.equal(button(html, "Review update").disabled, true);
    assert.equal(button(html, "Review delete").disabled, true);
  });
}

test("SavedViewsPanel SSR performs no initial list request and suppresses another owner's state", () => {
  const controller = new SavedViewController(async () => noAction());
  controller.configure(SCOPE);
  controller.setName("Private account name that must not cross scopes");
  controller.setPresentation(configuration("Local", { search: "owner-only-term" }).presentation);
  const html = renderToStaticMarkup(
    <SavedViewsPanel
      controller={controller}
      scope={{ ...SCOPE, actorId: uuid(999) }}
      wbs={inputFixture().wbs}
      disabled={false}
      dirty={false}
      onSessionFailure={noAction}
    />,
  );
  assert.doesNotMatch(html, /owner-only-term|Private account name that must not cross scopes/);
  assert.match(field(html, "Selected presentation"), /value="native" selected=""/);
  assert.equal(button(html, "Review new private view").disabled, false);
});

test("group headers, visible ordinals and table aria indices share one projected visual sequence", async () => {
  const input = inputFixture();
  const projected = await projection(input, {
    groupBy: "wbs",
    sort: { field: "name", direction: "asc" },
  });
  const html = table(input, projected);
  assert.match(html, /4 of 4 activities · 2 WBS groups/);
  assert.match(html, /<table aria-label="Activities" aria-rowcount="7">/);
  const rows = indexedRows(html);
  assert.deepEqual(
    rows.map((row) => Number(row[1])),
    [2, 3, 4, 5, 6, 7],
  );
  const ordinals = Array.from(html.matchAll(/class="rowNumber">(\d+)<\/td>/g), (match) =>
    Number(match[1]),
  );
  assert.deepEqual(ordinals, [1, 2, 3, 4]);
  assert.match(
    rows[0]?.[2] ?? "",
    /<th scope="row" colSpan="11">WBS child · Repeated · 2 activities/,
  );
  assert.match(rows[3]?.[2] ?? "", /WBS parent · Repeated · 2 activities/);
  assert.match(html, /aria-label="Activity 1 name"/);
  assert.doesNotMatch(html, /aria-label="Activity 5 name"/);
});

test("filtered sorted row bindings resolve activity IDs rather than visible or native positions", async () => {
  const input = inputFixture();
  const projected = await projection(input, {
    search: "Record 00",
    sort: { field: "name", direction: "asc" },
  });
  const activityRows = projected.rows.filter((row) => row.kind === "activity");
  assert.deepEqual(
    activityRows.map((row) => row.nativeIndex),
    [3, 2, 1, 0],
  );
  // Corrupting the index here isolates the renderer's row-ID lookup: the public
  // projection wrapper separately refuses such DTOs before they can be activated.
  const rendered = structuredClone(projected);
  for (const row of rendered.rows) if (row.kind === "activity") row.nativeIndex = 0;
  const html = table(input, rendered, { editable: true, filter: "must be ignored when projected" });
  const rows = indexedRows(html);
  for (const [index, row] of activityRows.entries()) {
    const sourceActivity = input.activities.find((activity) => activity.id === row.activityId);
    assert.ok(sourceActivity);
    assert.match(
      rows[index]?.[2] ?? "",
      new RegExp(
        `aria-label="Activity ${row.displayOrdinal} name"[^>]*value="${sourceActivity.name}"`,
      ),
    );
    assert.match(rows[index]?.[2] ?? "", new RegExp(`value="${sourceActivity.durationMinutes}"`));
    assert.match(
      rows[index]?.[2] ?? "",
      new RegExp(`aria-label="Delete activity ${row.displayOrdinal}"`),
    );
  }
  assert.doesNotMatch(html, /No matching activities/);
  // SSR does not execute DOM event callbacks; these assertions verify the source
  // records retained by editable controls, not mounted onEdit/onDelete behavior.
});

test("more than 24 projected visual rows render a bounded first window and full logical aria count", async () => {
  const input = inputFixture(40);
  const projected = await projection(input, {
    groupBy: "wbs",
    sort: { field: "name", direction: "asc" },
  });
  assert.equal(projected.visualRowCount, 42);
  const html = table(input, projected, { editable: true });
  const rows = indexedRows(html);
  assert.equal(rows.length, 24);
  assert.deepEqual(
    rows.map((row) => Number(row[1])),
    Array.from({ length: 24 }, (_, index) => index + 2),
  );
  assert.match(html, /aria-rowcount="43"/);
  assert.match(html, /Showing 1–24 of 42/);
  assert.match(
    html,
    /<tbody aria-hidden="true"><tr class="spacer"><td colSpan="11" style="height:756px"/,
  );
  assert.equal(button(html, "Previous activities").disabled, true);
  assert.equal(button(html, "Next activities").disabled, false);
  const visible = projected.rows.slice(0, 24).filter((row) => row.kind === "activity");
  for (const row of visible) {
    const sourceActivity = input.activities.find((activity) => activity.id === row.activityId);
    assert.ok(sourceActivity);
    assert.match(
      html,
      new RegExp(
        `aria-label="Activity ${row.displayOrdinal} name"[^>]*value="${sourceActivity.name}"`,
      ),
    );
  }
  assert.doesNotMatch(html, /aria-label="Activity 23 name"/);
  assert.equal(input.activities.length, 40);
});

test("unavailable and pending projections never silently show Native activity rows", () => {
  const input = inputFixture();
  for (const [projected, message] of [
    [null, "Verifying presentation…"],
    [
      { available: false, error: "view_reference_stale", reason: "reference_stale" },
      "This view references an unavailable WBS",
    ],
    [
      { available: false, error: "view_result_required", reason: "calculation_stale" },
      "This view needs a verified current saved calculation",
    ],
    [
      { available: false, error: "view_invalid", reason: "source_invalid" },
      "This presentation is unavailable",
    ],
  ] satisfies Array<[PlannerProjectionV1 | null, string]>) {
    const html = table(input, projected);
    assert.equal(indexedRows(html).length, 0);
    assert.match(html, /aria-rowcount="1"/);
    assert.ok(html.includes(message));
    assert.doesNotMatch(html, /aria-label="Activity 1 name"/);
  }
});

test("an available empty match is distinguished from an unavailable projection", async () => {
  const input = inputFixture();
  const projected = await projection(input, { search: "no fixture matches" });
  const html = table(input, projected);
  assert.match(html, /0 of 4 activities · 0 WBS groups/);
  assert.match(html, /No matching activities/);
  assert.doesNotMatch(
    html,
    /presentation is unavailable|needs a verified current saved calculation/,
  );
});

test("Native filtered ordinals count visible records while preserving their source IDs", () => {
  const input = inputFixture();
  const html = table(input, undefined, { filter: uuid(103), editable: true });
  assert.equal(indexedRows(html).length, 1);
  assert.match(html, /aria-label="Activity 1 name"[^>]*value="Record 001/);
  assert.match(html, /class="rowNumber">1<\/td>/);
  assert.match(html, /1 of 4 activities/);
});

function ProjectionHookTable({
  source,
  native = false,
}: {
  source: GuiViewSource;
  native?: boolean;
}) {
  const view = useSavedViewProjection(source, native, noAction);
  return (
    <>
      <p
        data-pending={String(view.pending)}
        data-reason={view.projection && !view.projection.available ? view.projection.reason : ""}
      />
      <ActivityTable
        input={source.input}
        result={null}
        editable={false}
        filter=""
        projection={view.projection}
        onEdit={noAction}
        onDelete={noAction}
      />
    </>
  );
}
function hookSource(presentation: Partial<PlannerPresentationV1> = {}): GuiViewSource {
  return {
    scope: SCOPE,
    input: inputFixture(),
    dirty: true,
    result: null,
    calculation: null,
    configuration: configuration("Local hook fixture", presentation),
    savedConfigHash: null,
  };
}

test("SSR hook immediately renders the latest input-only filter, sort and group without awaiting effects", () => {
  const source = hookSource({
    search: "Record 00",
    sort: { field: "name", direction: "asc" },
    groupBy: "wbs",
  });
  const before = structuredClone(source);
  const initial = renderToStaticMarkup(<ProjectionHookTable source={source} />);
  assert.match(initial, /data-pending="false"/);
  assert.match(initial, /4 of 4 activities · 2 WBS groups/);
  assert.match(initial, /aria-label="Activity 1 name"[^>]*value="Record 001/);
  const next = structuredClone(source);
  next.configuration.presentation = configuration("New local", {
    search: "Record 002",
  }).presentation;
  const second = renderToStaticMarkup(<ProjectionHookTable source={next} />);
  assert.match(second, /data-pending="false"/);
  assert.match(second, /1 of 4 activities · 0 WBS groups/);
  assert.match(second, /aria-label="Activity 1 name"[^>]*value="Record 002/);
  assert.doesNotMatch(second, /value="Record 001|Verifying presentation/);
  const changed = structuredClone(next);
  const activity = changed.input.activities[2];
  assert.ok(activity);
  activity.name = "Renamed and no longer matching";
  const third = renderToStaticMarkup(<ProjectionHookTable source={changed} />);
  assert.match(third, /No matching activities/);
  assert.equal(indexedRows(third).length, 0);
  assert.deepEqual(source, before);
});

test("SSR dirty calculated hook immediately refuses input rather than showing cached or Native rows", () => {
  const source = hookSource({ critical: "critical" });
  const html = renderToStaticMarkup(<ProjectionHookTable source={source} />);
  assert.match(html, /data-pending="false" data-reason="input_unsaved"/);
  assert.match(html, /This view needs a verified current saved calculation/);
  assert.equal(indexedRows(html).length, 0);
  assert.doesNotMatch(html, /aria-label="Activity 1 name"/);
});

test("SSR saved calculated hook stays pending with no old rows before verification", () => {
  const source = {
    ...hookSource({ sort: { field: "earlyStart", direction: "asc" } }),
    dirty: false,
  };
  const html = renderToStaticMarkup(<ProjectionHookTable source={source} />);
  assert.match(html, /data-pending="true"/);
  assert.match(html, /Verifying presentation…/);
  assert.equal(indexedRows(html).length, 0);
});

test("SSR Native hook supplies undefined projection and retains native input rows synchronously", () => {
  const source = hookSource({ search: "a nonmatching calculated predicate", critical: "critical" });
  const html = renderToStaticMarkup(<ProjectionHookTable source={source} native />);
  assert.match(html, /data-pending="false"/);
  assert.equal(indexedRows(html).length, 4);
  assert.match(html, /aria-label="Activity 1 name"[^>]*value="Record 004/);
  assert.doesNotMatch(html, /Verifying presentation|needs a verified current saved calculation/);
});
