import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  NATIVE_PLANNER_PRESENTATION_V1,
  plannerViewOperationWindowV1,
  serializePlannerViewHashPreimageV1,
  serializePlannerViewReviewHashPreimageV1,
  validatePlannerViewConfigurationV1,
  validatePlannerViewPlanRequestV1,
  validatePlannerViewReceiptV1,
  validatePlannerViewReviewV1,
  type PlannerPresentationV1,
  type PlannerViewActionV1,
  type PlannerViewConfigurationV1,
  type PlannerViewPlanRequestV1,
  type PlannerViewPlanV1,
  type PlannerViewReceiptV1,
  type PlannerViewReviewV1,
} from "@engineo/contracts";
import { ApiError } from "./api";
import {
  SavedViewController,
  type SavedViewRequest,
  type SavedViewScope,
} from "./saved-view-controller";
import {
  VIEW_CAPABILITY_LIMITS_V1,
  type ViewCapabilitiesV1,
  type ViewListV1,
  type ViewOperationStatusV1,
  type ViewReadV1,
} from "./saved-view-protocol";

// These are local DTO fixtures and deferred promises only. The preload guard blocks
// runtime fetch, HTTP, sockets and listeners; no application/server/DB is started.
if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
const TIME = "2026-10-03T12:00:00.000Z";
const uuid = (number: number): string =>
  `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
const SCOPE: SavedViewScope = {
  actorId: uuid(1),
  sessionId: uuid(2),
  organizationId: uuid(3),
  projectId: uuid(4),
  scheduleRevision: 17,
};
const VIEW_ID = uuid(5);
const OTHER_VIEW_ID = uuid(6);
const binding = (scope: SavedViewScope) => ({
  actorId: scope.actorId,
  sessionId: scope.sessionId,
  organizationId: scope.organizationId,
  projectId: scope.projectId,
});
const route = (scope: SavedViewScope = SCOPE) =>
  `/organizations/${scope.organizationId}/projects/${scope.projectId}/views`;
const presentation = (search = "steel"): PlannerPresentationV1 => ({
  ...structuredClone(NATIVE_PLANNER_PRESENTATION_V1),
  search,
  sort: { field: "name", direction: "desc" },
  groupBy: "wbs",
});
function configuration(name = "My private view", p = presentation()): PlannerViewConfigurationV1 {
  const result = validatePlannerViewConfigurationV1({
    schemaVersion: 1,
    kind: "engineo-planner-view",
    visibility: "private",
    name,
    presentation: p,
  });
  assert.ok(result.valid, "fixture must be a strict, normalized configuration");
  return result.normalizedConfiguration;
}
async function hash(preimage: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(preimage),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
const configHash = (config: PlannerViewConfigurationV1) =>
  hash(serializePlannerViewHashPreimageV1(config));
async function record(
  viewId = VIEW_ID,
  name = "Saved steel view",
  revision = 7,
): Promise<ViewReadV1> {
  const config = configuration(name);
  return {
    schemaVersion: 1,
    viewId,
    viewRevision: revision,
    configuration: config,
    configHashSha256: await configHash(config),
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: TIME,
  };
}
const pageRecords = () =>
  Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      record(uuid(1_000 + index), `View ${String(index).padStart(3, "0")}`),
    ),
  );
function capabilities(): ViewCapabilitiesV1 {
  const window = plannerViewOperationWindowV1(TIME);
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    visibility: ["private"],
    actions: ["create", "update", "delete"],
    capabilities: ["project.read", "view.private.write"],
    builtIn: { id: "native", immutable: true },
    operationWindowId: window.operationWindowId,
    operationWindowClosesAt: window.closesAt,
    operationReplayUntil: window.replayUntil,
    limits: { ...VIEW_CAPABILITY_LIMITS_V1 },
  };
}
function list(records: ViewReadV1[] = [], more = false): ViewListV1 {
  return {
    schemaVersion: 1,
    builtIn: { id: "native", immutable: true },
    views: records.map((row) => ({
      viewId: row.viewId,
      viewRevision: row.viewRevision,
      name: row.configuration.name,
      configHashSha256: row.configHashSha256,
      updatedAt: row.updatedAt,
    })),
    nextCursor: more ? (records.at(-1)?.viewId ?? null) : null,
  };
}
async function planFor(
  request: PlannerViewPlanRequestV1,
  scope = SCOPE,
  base?: ViewReadV1,
): Promise<PlannerViewPlanV1> {
  assert.ok(
    validatePlannerViewPlanRequestV1(request).valid,
    "fixture intent must satisfy the shared contract",
  );
  const desired = request.action === "delete" ? null : request.configuration;
  const review: PlannerViewReviewV1 = {
    schemaVersion: 1,
    kind: "engineo-planner-view-review",
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    ...binding(scope),
    action: request.action,
    operationWindowId: request.operationWindowId,
    operationId: request.operationId,
    expectedScheduleRevision: request.expectedScheduleRevision,
    viewId: request.action === "create" ? null : request.viewId,
    expectedViewRevision: request.action === "create" ? 0 : request.expectedViewRevision,
    baseConfiguration: request.action === "create" ? null : (base?.configuration ?? null),
    baseConfigHash: request.action === "create" ? null : (base?.configHashSha256 ?? null),
    desiredConfiguration: desired,
    desiredConfigHash: desired ? await configHash(desired) : null,
    issuedAt: TIME,
    expiresAt: "2026-10-03T12:15:00.000Z",
  };
  assert.ok(
    validatePlannerViewReviewV1(review).valid,
    "fixture review must satisfy the shared contract",
  );
  return { review, reviewedDigest: await hash(serializePlannerViewReviewHashPreimageV1(review)) };
}
function receiptFor(plan: PlannerViewPlanV1): PlannerViewReceiptV1 {
  const review = plan.review;
  const noOp = review.action === "update" && review.baseConfigHash === review.desiredConfigHash;
  const receipt: PlannerViewReceiptV1 = {
    schemaVersion: 1,
    kind: "engineo-planner-view-receipt",
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    ...binding({ ...SCOPE, ...review }),
    action: review.action,
    outcome: review.action === "delete" ? "deleted" : noOp ? "no_op" : "applied",
    viewId: review.viewId ?? OTHER_VIEW_ID,
    previousViewRevision: review.expectedViewRevision,
    committedViewRevision:
      review.action === "delete" ? null : review.expectedViewRevision + (noOp ? 0 : 1),
    expectedScheduleRevision: review.expectedScheduleRevision,
    baseConfigHash: review.baseConfigHash,
    desiredConfigHash: review.desiredConfigHash,
    operationWindowId: review.operationWindowId,
    operationId: review.operationId,
    reviewedDigest: plan.reviewedDigest,
    auditId: uuid(9),
    recordedAt: "2026-10-03T12:00:01.000Z",
  };
  assert.ok(
    validatePlannerViewReceiptV1(receipt).valid,
    "fixture receipt must satisfy the shared contract",
  );
  return receipt;
}
function statusFor(
  plan: PlannerViewPlanV1,
  receipt: PlannerViewReceiptV1 | null = null,
  closed = false,
): ViewOperationStatusV1 {
  return {
    schemaVersion: 1,
    status: receipt ? "recorded" : "not_recorded",
    operationWindowId: plan.review.operationWindowId,
    operationId: plan.review.operationId,
    windowClosed: closed,
    absenceDefinitive: receipt === null && closed,
    receipt,
  };
}
interface Call {
  method: "GET" | "POST";
  path: string;
  signal: AbortSignal;
  body: unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}
function harness(scope: SavedViewScope | null = SCOPE) {
  const calls: Call[] = [];
  const waiters = new Set<() => void>();
  let sequence = 100;
  let now = Date.parse(TIME);
  let mayStart = true;
  let currentSession = true;
  const sessionChecks: SavedViewScope[] = [];
  const request: SavedViewRequest = (method, path, signal, body) =>
    new Promise((resolve, reject) => {
      calls.push({ method, path, signal, body, resolve, reject });
      for (const notify of waiters) notify();
    });
  const controller = new SavedViewController(
    request,
    () => uuid(++sequence),
    () => now,
    () => mayStart,
    (checkedScope) => {
      sessionChecks.push({ ...checkedScope });
      return currentSession;
    },
  );
  controller.configure(scope);
  return {
    controller,
    calls,
    sessionChecks,
    setTime: (value: string) => {
      now = Date.parse(value);
    },
    setCanStart: (value: boolean) => {
      mayStart = value;
    },
    setSessionIsCurrent: (value: boolean) => {
      currentSession = value;
    },
    call: (index: number): Call => {
      assert.ok(calls[index], `expected mock call ${index}`);
      return calls[index];
    },
    last: (): Call => {
      const call = calls.at(-1);
      assert.ok(call, "expected a pending mock request");
      return call;
    },
    async waitForCalls(count: number): Promise<void> {
      // Event-driven synchronization for Web Crypto; timeout only reports a stuck mock.
      if (calls.length < count) {
        await new Promise<void>((resolve, reject) => {
          const notify = () => {
            if (calls.length >= count) {
              clearTimeout(timeout);
              waiters.delete(notify);
              resolve();
            }
          };
          const timeout = setTimeout(() => {
            waiters.delete(notify);
            reject(
              new Error(
                `Mock request ${count} was not sent: ${JSON.stringify(controller.getSnapshot())}`,
              ),
            );
          }, 2_000);
          waiters.add(notify);
        });
      }
      assert.equal(
        calls.length,
        count,
        `expected ${count} calls; state: ${JSON.stringify(controller.getSnapshot())}`,
      );
    },
  };
}
type Harness = ReturnType<typeof harness>;
async function selectRecord(h: Harness, provided?: ViewReadV1): Promise<ViewReadV1> {
  const base = provided ?? (await record());
  const index = h.calls.length;
  const pending = h.controller.select(base.viewId);
  const call = h.call(index);
  assert.equal(call.method, "GET");
  call.resolve(base);
  await pending;
  assert.equal(h.controller.getSnapshot().record?.viewRevision, base.viewRevision);
  return base;
}
async function preview(
  h: Harness,
  action: PlannerViewActionV1 = "create",
  base?: ViewReadV1,
  scope = SCOPE,
): Promise<PlannerViewPlanV1> {
  const index = h.calls.length;
  const pending = h.controller.preview(action);
  const capability = h.call(index);
  assert.equal(capability.method, "GET");
  assert.equal(capability.path, `${route(scope)}/capabilities`);
  capability.resolve(capabilities());
  await h.waitForCalls(index + 2);
  const call = h.call(index + 1);
  assert.equal(call.method, "POST");
  assert.equal(call.path, `${route(scope)}/plan`);
  const intent = call.body as PlannerViewPlanRequestV1;
  const plan = await planFor(intent, scope, base);
  call.resolve(plan);
  await pending;
  assert.deepEqual(h.controller.getSnapshot().plan, plan, "verified preview should be retained");
  return plan;
}
async function unknownApply(h: Harness, plan: PlannerViewPlanV1, scope = SCOPE): Promise<void> {
  const index = h.calls.length;
  const pending = h.controller.apply();
  assert.equal(h.call(index).path, `${route(scope)}/apply`);
  assert.deepEqual(h.call(index).body, plan);
  h.call(index).reject(new TypeError("mock connection lost after send"));
  await pending;
  assert.ok(h.controller.getSnapshot().recovery);
  assert.equal(h.controller.getSnapshot().plan, null);
}
function assertHistorical(h: Harness, receipt: PlannerViewReceiptV1): void {
  const state = h.controller.getSnapshot();
  assert.deepEqual(state.receipt, receipt);
  assert.equal(state.record, null);
  assert.equal(state.selectedId, "native");
  assert.deepEqual(state.views, []);
  assert.equal(state.nextCursor, null);
  assert.equal(state.listed, false);
  assert.equal(state.plan, null);
  assert.equal(state.recovery, null);
  assert.match(state.notice, /Historical receipt.*Reload private views/);
}

test("native/selection changes only presentation and preserves a caller-owned unsaved schedule draft", async () => {
  const scheduleDraft = Object.freeze({
    revision: 17,
    dirty: true,
    activities: Object.freeze([
      Object.freeze({ id: uuid(20), name: "Unsaved task", durationMinutes: 43 }),
    ]),
    relationships: Object.freeze([]),
    result: Object.freeze({ scheduleRevision: 16, stale: true }),
  });
  const original = structuredClone(scheduleDraft);
  const h = harness();
  await selectRecord(h);
  assert.equal(h.controller.getSnapshot().presentation.search, "steel");
  assert.match(h.controller.getSnapshot().notice, /schedule edits are unchanged/);
  h.controller.native();
  assert.deepEqual(h.controller.getSnapshot().presentation, NATIVE_PLANNER_PRESENTATION_V1);
  assert.equal(h.controller.getSnapshot().selectedId, "native");
  assert.equal(h.controller.getSnapshot().record, null);
  assert.deepEqual(scheduleDraft, original);
  assert.ok(h.calls.every((call) => call.method === "GET" && !call.path.includes("schedule")));
  assert.ok(!Object.hasOwn(h.controller.getSnapshot(), "schedule"));
});

test("presentation input is cloned, native is fresh, and subscriptions can be removed", () => {
  const h = harness();
  let notifications = 0;
  const unsubscribe = h.controller.subscribe(() => {
    notifications++;
  });
  const source = presentation();
  h.controller.setPresentation(source);
  source.search = "changed by caller";
  source.sort.direction = "asc";
  assert.equal(h.controller.getSnapshot().presentation.search, "steel");
  assert.equal(h.controller.getSnapshot().presentation.sort.direction, "desc");
  h.controller.native();
  h.controller.getSnapshot().presentation.sort.direction = "desc";
  h.controller.native();
  assert.equal(h.controller.getSnapshot().presentation.sort.direction, "asc");
  assert.equal(NATIVE_PLANNER_PRESENTATION_V1.sort.direction, "asc");
  assert.equal(notifications, 3);
  unsubscribe();
  h.controller.setName("Changed");
  assert.equal(notifications, 3);
});

test("unconfigured controller performs no requests or previews", async () => {
  const h = harness(null);
  await Promise.all([
    h.controller.loadPage(),
    h.controller.select(VIEW_ID),
    h.controller.preview("create"),
    h.controller.apply(),
    h.controller.recover(),
  ]);
  assert.equal(h.calls.length, 0);
  assert.equal(h.controller.getSnapshot().busy, "");
});

for (const mutation of [
  ["new session", { sessionId: uuid(31) }],
  ["new actor", { actorId: uuid(32) }],
  ["new organization", { organizationId: uuid(33) }],
  ["new project", { projectId: uuid(34) }],
] as const) {
  for (const operation of ["list", "read"] as const) {
    test(`${operation}: ${mutation[0]} aborts the old scope and ignores late private data`, async () => {
      const h = harness();
      const old = operation === "list" ? h.controller.loadPage() : h.controller.select(VIEW_ID);
      const oldCall = h.call(0);
      assert.equal(
        oldCall.path,
        operation === "list" ? `${route()}?limit=50` : `${route()}/${VIEW_ID}`,
      );
      const scope = { ...SCOPE, ...mutation[1] };
      h.controller.configure(scope);
      assert.equal(oldCall.signal.aborted, true);
      const newer = h.controller.loadPage();
      assert.equal(h.call(1).path, `${route(scope)}?limit=50`);
      h.call(1).resolve(list());
      await newer;
      const settled = h.controller.getSnapshot();
      const privateRecord = await record();
      oldCall.resolve(operation === "list" ? list([privateRecord]) : privateRecord);
      await old;
      assert.strictEqual(
        h.controller.getSnapshot(),
        settled,
        "old completion must not publish or finish the new task",
      );
      assert.equal(settled.record, null);
      assert.deepEqual(settled.views, []);
      assert.equal(settled.listed, true);
    });
  }
}

test("logout aborts pending reads and rejects late errors without an auth/error leak", async () => {
  const h = harness();
  const pending = h.controller.select(VIEW_ID);
  h.controller.configure(null);
  const empty = h.controller.getSnapshot();
  assert.equal(h.call(0).signal.aborted, true);
  h.call(0).reject(new ApiError(403, "forbidden", "Old account is forbidden"));
  await pending;
  assert.strictEqual(h.controller.getSnapshot(), empty);
  assert.equal(empty.authFailure, null);
  assert.equal(empty.error, "");
});

test("same exact scope is a no-op; changed saved revision aborts reads and invalidates review", async () => {
  const h = harness();
  const pending = h.controller.loadPage();
  const state = h.controller.getSnapshot();
  h.controller.configure({ ...SCOPE });
  assert.equal(h.call(0).signal.aborted, false);
  assert.strictEqual(h.controller.getSnapshot(), state);
  h.controller.configure({ ...SCOPE, scheduleRevision: 18 });
  assert.equal(h.call(0).signal.aborted, true);
  h.call(0).resolve(list([await record()]));
  await pending;
  assert.deepEqual(h.controller.getSnapshot().views, []);
  const plan = await preview(h, "create", undefined, { ...SCOPE, scheduleRevision: 18 });
  assert.equal(plan.review.expectedScheduleRevision, 18);
  h.controller.configure({ ...SCOPE, scheduleRevision: 19 });
  assert.equal(h.controller.getSnapshot().plan, null);
  assert.equal(h.controller.getSnapshot().recovery, null);
  assert.match(h.controller.getSnapshot().notice, /Review any view action again/);
});

test("paging appends verified pages, uses exact UUID cursor and no-ops at the end", async () => {
  const h = harness();
  const first = await pageRecords();
  const load = h.controller.loadPage();
  h.call(0).resolve(list(first, true));
  await load;
  assert.equal(h.controller.getSnapshot().views.length, 50);
  assert.equal(h.controller.getSnapshot().nextCursor, first[49]?.viewId);
  const more = h.controller.loadPage(true);
  assert.equal(h.call(1).path, `${route()}?limit=50&cursor=${first[49]?.viewId}`);
  const final = await record(uuid(2_000), "View 050");
  h.call(1).resolve(list([final]));
  await more;
  assert.equal(h.controller.getSnapshot().views.length, 51);
  assert.equal(h.controller.getSnapshot().nextCursor, null);
  await h.controller.loadPage(true);
  assert.equal(h.calls.length, 2);
  const reload = h.controller.loadPage();
  assert.equal(h.call(2).path, `${route()}?limit=50`);
  h.call(2).resolve(list([final]));
  await reload;
  assert.deepEqual(
    h.controller.getSnapshot().views.map((view) => view.viewId),
    [final.viewId],
  );
});

test("duplicate identities across pages preserve the verified first page and fail closed", async () => {
  const h = harness();
  const first = await pageRecords();
  const load = h.controller.loadPage();
  h.call(0).resolve(list(first, true));
  await load;
  const before = h.controller.getSnapshot();
  const more = h.controller.loadPage(true);
  const repeated = first[0];
  assert.ok(repeated);
  h.call(1).resolve(list([repeated]));
  await more;
  assert.deepEqual(h.controller.getSnapshot().views, before.views);
  assert.equal(h.controller.getSnapshot().nextCursor, before.nextCursor);
  assert.match(h.controller.getSnapshot().error, /could not be verified/);
});

test("malformed or wrong-id read cannot replace a previously verified presentation", async () => {
  const h = harness();
  await selectRecord(h);
  const before = h.controller.getSnapshot();
  const pending = h.controller.select(OTHER_VIEW_ID);
  h.call(1).resolve(await record(VIEW_ID));
  await pending;
  assert.equal(h.controller.getSnapshot().selectedId, before.selectedId);
  assert.deepEqual(h.controller.getSnapshot().presentation, before.presentation);
  assert.match(h.controller.getSnapshot().error, /could not be verified/);
  const malformed = h.controller.loadPage();
  h.call(2).resolve({ ...list(), extra: "private untrusted field" });
  await malformed;
  assert.equal(h.controller.getSnapshot().listed, false);
  assert.ok(!h.controller.getSnapshot().error.includes("private untrusted field"));
});

test("request mutex suppresses repeated reads, selection/native/edit changes, and parallel previews", async () => {
  const h = harness();
  const load = h.controller.loadPage();
  await Promise.all([
    h.controller.loadPage(),
    h.controller.select(VIEW_ID),
    h.controller.preview("create"),
  ]);
  h.controller.native();
  h.controller.setName("Blocked");
  h.controller.setPresentation(presentation("Blocked"));
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getSnapshot().name, "My private view");
  h.call(0).resolve(list());
  await load;
  const review = h.controller.preview("create");
  await Promise.all([
    h.controller.preview("create"),
    h.controller.loadPage(),
    h.controller.select(VIEW_ID),
  ]);
  assert.equal(h.calls.length, 2);
  h.call(1).resolve(capabilities());
  await h.waitForCalls(3);
  const plan = await planFor(h.call(2).body as PlannerViewPlanRequestV1);
  h.call(2).resolve(plan);
  await review;
  assert.deepEqual(h.controller.getSnapshot().plan, plan);
});

for (const action of ["create", "update", "delete"] as const) {
  test(`${action} preview binds exact schedule/view revisions and canonical reviewed configuration`, async () => {
    const h = harness();
    const base = action === "create" ? undefined : await selectRecord(h);
    const draft = Object.freeze({ dirty: true, durationMinutes: 222, scheduleRevision: 17 });
    if (action !== "delete") {
      h.controller.setName("  Reviewed private view  ");
      h.controller.setPresentation(presentation("concrete"));
    }
    const plan = await preview(h, action, base);
    const request = h.calls.at(-1)?.body as PlannerViewPlanRequestV1;
    assert.equal(request.action, action);
    assert.equal(request.expectedScheduleRevision, 17);
    assert.equal(request.operationWindowId, "2026-10-03");
    assert.equal(request.operationId, uuid(101));
    assert.equal(plan.review.expectedViewRevision, base?.viewRevision ?? 0);
    assert.equal(plan.review.baseConfigHash, base?.configHashSha256 ?? null);
    assert.equal(plan.review.viewId, base?.viewId ?? null);
    if (request.action === "delete") {
      assert.deepEqual(Object.keys(request).sort(), [
        "action",
        "expectedScheduleRevision",
        "expectedViewRevision",
        "operationId",
        "operationWindowId",
        "viewId",
      ]);
      assert.equal(plan.review.desiredConfiguration, null);
    } else {
      assert.equal(request.configuration.name, "Reviewed private view");
      assert.equal(request.configuration.presentation.search, "concrete");
      assert.equal(plan.review.desiredConfigHash, await configHash(request.configuration));
    }
    assert.equal(
      plan.reviewedDigest,
      await hash(serializePlannerViewReviewHashPreimageV1(plan.review)),
    );
    assert.deepEqual(draft, { dirty: true, durationMinutes: 222, scheduleRevision: 17 });
    assert.equal(h.calls.filter((call) => call.path.endsWith("/apply")).length, 0);
    h.controller.setName("Unreviewed name");
    h.controller.setPresentation(presentation("Unreviewed search"));
    await h.controller.select(OTHER_VIEW_ID);
    await h.controller.preview(action);
    assert.deepEqual(h.controller.getSnapshot().plan, plan);
    const count = h.calls.length;
    h.controller.discardPreview();
    assert.equal(h.controller.getSnapshot().plan, null);
    assert.equal(h.calls.length, count);
    assert.match(h.controller.getSnapshot().notice, /No view mutation was sent/);
  });
}

test("create while a saved view is selected has no base/view identity and preserves the selected presentation", async () => {
  const h = harness();
  const base = await selectRecord(h);
  h.controller.setName("Copy of private view");
  const plan = await preview(h, "create");
  assert.equal(plan.review.viewId, null);
  assert.equal(plan.review.expectedViewRevision, 0);
  assert.equal(plan.review.baseConfiguration, null);
  assert.deepEqual(plan.review.desiredConfiguration?.presentation, base.configuration.presentation);
});

for (const [label, change] of [
  ["actor", { actorId: uuid(800) }],
  ["creator session", { sessionId: uuid(801) }],
  ["organization", { organizationId: uuid(802) }],
  ["project", { projectId: uuid(803) }],
  ["saved schedule revision", { expectedScheduleRevision: 18 }],
  ["operation key", { operationId: uuid(804) }],
  ["selected view", { viewId: OTHER_VIEW_ID }],
  ["view revision", { expectedViewRevision: 8 }],
] as const) {
  test(`preview rejects a hash-consistent response bound to the wrong ${label}`, async () => {
    const h = harness();
    const base = await selectRecord(h);
    h.controller.setName("Intended update");
    const index = h.calls.length;
    const pending = h.controller.preview("update");
    h.call(index).resolve(capabilities());
    await h.waitForCalls(index + 2);
    const plan = await planFor(h.call(index + 1).body as PlannerViewPlanRequestV1, SCOPE, base);
    Object.assign(plan.review, change);
    plan.reviewedDigest = await hash(serializePlannerViewReviewHashPreimageV1(plan.review));
    h.call(index + 1).resolve(plan);
    await pending;
    assert.equal(h.controller.getSnapshot().plan, null);
    assert.equal(h.controller.getSnapshot().recovery, null);
    assert.equal(h.controller.getSnapshot().record?.viewId, base.viewId);
    assert.match(h.controller.getSnapshot().error, /could not be verified/);
    await h.controller.apply();
    assert.equal(h.calls.filter((call) => call.path.endsWith("/apply")).length, 0);
  });
}

test("preview rejects canonical desired configuration changes even when server recomputes its digest", async () => {
  const h = harness();
  h.controller.setName("Intended private view");
  const pending = h.controller.preview("create");
  h.call(0).resolve(capabilities());
  await h.waitForCalls(2);
  const plan = await planFor(h.call(1).body as PlannerViewPlanRequestV1);
  plan.review.desiredConfiguration = configuration("Different server intent");
  plan.review.desiredConfigHash = await configHash(plan.review.desiredConfiguration);
  plan.reviewedDigest = await hash(serializePlannerViewReviewHashPreimageV1(plan.review));
  h.call(1).resolve(plan);
  await pending;
  assert.equal(h.controller.getSnapshot().plan, null);
  assert.match(h.controller.getSnapshot().error, /could not be verified/);
});

test("stopped plan POST cannot publish an old preview over a newer selection", async () => {
  const h = harness();
  const pending = h.controller.preview("create");
  h.call(0).resolve(capabilities());
  await h.waitForCalls(2);
  const oldPlan = await planFor(h.call(1).body as PlannerViewPlanRequestV1);
  h.controller.stopWaiting();
  assert.equal(h.call(1).signal.aborted, true);
  const selected = h.controller.select(VIEW_ID);
  h.call(2).resolve(await record());
  await selected;
  const selectedState = h.controller.getSnapshot();
  h.call(1).resolve(oldPlan);
  await pending;
  assert.strictEqual(h.controller.getSnapshot(), selectedState);
  assert.equal(selectedState.plan, null);
  assert.equal(selectedState.selectedId, VIEW_ID);
});

test("update/delete without a verified base and invalid create configurations send nothing", async () => {
  const h = harness();
  await h.controller.preview("update");
  await h.controller.preview("delete");
  h.controller.setName("");
  await h.controller.preview("create");
  assert.equal(h.calls.length, 0);
  assert.ok(h.controller.getSnapshot().error.length > 0);
  assert.equal(h.controller.getSnapshot().plan, null);
});

test("expired capability window blocks new plan submission", async () => {
  const h = harness();
  h.setTime(capabilities().operationWindowClosesAt);
  const pending = h.controller.preview("create");
  h.call(0).resolve(capabilities());
  await pending;
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getSnapshot().plan, null);
  assert.match(h.controller.getSnapshot().error, /operation window closed/);
});

test("preview expiring exactly at apply is discarded without an apply request", async () => {
  const h = harness();
  const plan = await preview(h);
  const count = h.calls.length;
  h.setTime(plan.review.expiresAt);
  await h.controller.apply();
  assert.equal(h.calls.length, count);
  assert.equal(h.controller.getSnapshot().plan, null);
  assert.equal(h.controller.getSnapshot().recovery, null);
  assert.match(h.controller.getSnapshot().error, /preview expired/);
});

test("native discards an unsent preview without mutation", async () => {
  const h = harness();
  await preview(h);
  const count = h.calls.length;
  h.controller.native();
  assert.equal(h.controller.getSnapshot().plan, null);
  assert.equal(h.controller.getSnapshot().selectedId, "native");
  assert.equal(h.calls.length, count);
});

for (const action of ["create", "update", "delete"] as const) {
  test(`${action} apply sends the exact reviewed plan once and treats receipt as historical only`, async () => {
    const h = harness();
    const base = action === "create" ? undefined : await selectRecord(h);
    if (action === "update") h.controller.setName("Changed private view");
    const plan = await preview(h, action, base);
    const receipt = receiptFor(plan);
    const index = h.calls.length;
    const pending = h.controller.apply();
    assert.equal(h.call(index).method, "POST");
    assert.equal(h.call(index).path, `${route()}/apply`);
    assert.deepEqual(h.call(index).body, plan);
    assert.equal(h.controller.getSnapshot().recovery?.operationId, plan.review.operationId);
    await Promise.all([
      h.controller.apply(),
      h.controller.preview("create"),
      h.controller.select(OTHER_VIEW_ID),
      h.controller.recover(),
    ]);
    h.controller.discardPreview();
    h.controller.native();
    h.controller.setName("Blocked after send");
    assert.equal(h.calls.length, index + 1);
    assert.deepEqual(h.controller.getSnapshot().plan, plan);
    h.call(index).resolve(receipt);
    await pending;
    assertHistorical(h, receipt);
    assert.equal(h.controller.getSnapshot().busy, "");
  });
}

test("canonical no-op update retains revision but never infers the current record from receipt", async () => {
  const h = harness();
  const base = await selectRecord(h);
  const plan = await preview(h, "update", base);
  const receipt = receiptFor(plan);
  assert.equal(receipt.outcome, "no_op");
  assert.equal(receipt.committedViewRevision, base.viewRevision);
  const pending = h.controller.apply();
  h.last().resolve(receipt);
  await pending;
  assertHistorical(h, receipt);
});

for (const code of [
  "revision_conflict",
  "view_revision_conflict",
  "view_schedule_revision_conflict",
  "view_reference_stale",
  "view_review_expired",
  "view_not_found",
  "view_capacity_exceeded",
  "view_rate_limited",
]) {
  test(`definite current-request ${code} clears pending mutation and requires a new review`, async () => {
    const h = harness();
    await preview(h);
    const pending = h.controller.apply();
    h.last().reject(new ApiError(409, code, "Definite rejected request"));
    await pending;
    assert.equal(h.controller.getSnapshot().recovery, null);
    assert.equal(h.controller.getSnapshot().plan, null);
    assert.equal(h.controller.getSnapshot().error, "Definite rejected request");
    assert.equal(h.controller.hasPendingRecovery(), false);
    const nextPlan = await preview(h);
    assert.equal(nextPlan.review.operationId, uuid(102));
  });
}

for (const [label, error] of [
  ["transport failure", new TypeError("network outcome ambiguous")],
  ["server failure", new ApiError(500, "view_integrity_error", "Integrity unavailable")],
  ["auth failure", new ApiError(401, "unauthenticated", "Sign in again")],
  ["permission failure", new ApiError(403, "forbidden", "Check permission")],
  ["session failure", new ApiError(409, "session_changed", "Session changed")],
  [
    "idempotency conflict",
    new ApiError(409, "view_idempotency_conflict", "Original operation differs"),
  ],
] as const) {
  test(`ambiguous ${label} preserves the original operation identity and blocks new mutations`, async () => {
    const h = harness();
    const plan = await preview(h);
    const pending = h.controller.apply();
    h.last().reject(error);
    await pending;
    const recovery = h.controller.getSnapshot().recovery;
    assert.ok(recovery);
    assert.equal(recovery.operationId, plan.review.operationId);
    assert.equal(recovery.reviewedDigest, plan.reviewedDigest);
    assert.equal(h.controller.getSnapshot().plan, null);
    assert.match(h.controller.getSnapshot().error, /outcome is unknown/);
    assert.equal(
      h.controller.getSnapshot().authFailure,
      error instanceof ApiError &&
        (error.status === 401 || error.status === 403 || error.code === "session_changed")
        ? error
        : null,
    );
    const count = h.calls.length;
    await Promise.all([
      h.controller.apply(),
      h.controller.preview("create"),
      h.controller.select(VIEW_ID),
    ]);
    h.controller.discardPreview();
    h.controller.native();
    h.controller.setName("Blocked");
    assert.equal(h.calls.length, count);
    assert.strictEqual(h.controller.getSnapshot().recovery, recovery);
  });
}

test("malformed successful apply is ambiguous and cannot create a success notice", async () => {
  const h = harness();
  const plan = await preview(h);
  const pending = h.controller.apply();
  h.last().resolve({ ...receiptFor(plan), actorId: uuid(99) });
  await pending;
  assert.equal(h.controller.getSnapshot().receipt, null);
  assert.equal(h.controller.getSnapshot().recovery?.operationId, plan.review.operationId);
  assert.match(h.controller.getSnapshot().error, /outcome is unknown/);
});

test("stop waiting before send aborts preview, and a late response cannot install it", async () => {
  const h = harness();
  const pending = h.controller.preview("create");
  h.controller.stopWaiting();
  assert.equal(h.call(0).signal.aborted, true);
  const stopped = h.controller.getSnapshot();
  h.call(0).resolve(capabilities());
  await pending;
  assert.strictEqual(h.controller.getSnapshot(), stopped);
  assert.equal(h.calls.length, 1);
  assert.equal(stopped.recovery, null);
  assert.match(stopped.notice, /schedule drafts are unchanged/);
});

test("stop waiting after send retains uncertainty; late success cannot erase it or interrupt recovery", async () => {
  const h = harness();
  const plan = await preview(h);
  const index = h.calls.length;
  const applying = h.controller.apply();
  h.controller.stopWaiting();
  assert.equal(h.call(index).signal.aborted, true);
  assert.equal(h.controller.getSnapshot().plan, null);
  assert.equal(h.controller.getSnapshot().recovery?.operationId, plan.review.operationId);
  assert.match(h.controller.getSnapshot().notice, /may have committed/);
  const checking = h.controller.recover();
  const checkingState = h.controller.getSnapshot();
  h.call(index).resolve(receiptFor(plan));
  await applying;
  assert.strictEqual(h.controller.getSnapshot(), checkingState);
  assert.equal(h.controller.getSnapshot().busy, "Checking original operation");
  h.call(index + 1).resolve(statusFor(plan));
  await checking;
  assert.ok(h.controller.getSnapshot().recovery);
  assert.equal(h.controller.getSnapshot().receipt, null);
});

test("old read success cannot finish or replace a newer active read after stop waiting", async () => {
  const h = harness();
  const old = h.controller.select(VIEW_ID);
  h.controller.stopWaiting();
  const newer = h.controller.select(OTHER_VIEW_ID);
  h.call(0).resolve(await record());
  await old;
  assert.equal(h.controller.getSnapshot().busy, "Opening private view");
  assert.equal(h.controller.getSnapshot().record, null);
  h.call(1).resolve(await record(OTHER_VIEW_ID, "Newer selection"));
  await newer;
  assert.equal(h.controller.getSnapshot().selectedId, OTHER_VIEW_ID);
});

test("schedule revision changing after apply was sent retains the original operation for read-only recovery", async () => {
  const h = harness();
  const plan = await preview(h);
  const index = h.calls.length;
  const applying = h.controller.apply();
  h.controller.configure({ ...SCOPE, scheduleRevision: 18 });
  assert.equal(h.call(index).signal.aborted, true);
  assert.equal(h.controller.getSnapshot().recovery?.expectedScheduleRevision, 17);
  h.call(index).reject(new ApiError(409, "view_revision_conflict", "Late rejection"));
  await applying;
  assert.ok(h.controller.getSnapshot().recovery);
  const checking = h.controller.recover();
  h.call(index + 1).resolve(statusFor(plan, receiptFor(plan)));
  await checking;
  assertHistorical(h, receiptFor(plan));
});

test("recovery always checks the same operation key; open absence retains uncertainty, closed absence releases it", async () => {
  const h = harness();
  const plan = await preview(h);
  await unknownApply(h, plan);
  const identity = h.controller.getSnapshot().recovery;
  const path = `${route()}/operations/${plan.review.operationWindowId}/${plan.review.operationId}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const index = h.calls.length;
    const checking = h.controller.recover();
    await h.controller.recover();
    assert.equal(h.call(index).method, "GET");
    assert.equal(h.call(index).path, path);
    assert.equal(h.call(index).body, undefined);
    assert.equal(h.calls.length, index + 1);
    h.call(index).resolve(statusFor(plan));
    await checking;
    assert.strictEqual(h.controller.getSnapshot().recovery, identity);
    assert.match(h.controller.getSnapshot().notice, /in-flight apply may still commit/);
  }
  const checking = h.controller.recover();
  h.last().resolve(statusFor(plan, null, true));
  await checking;
  assert.equal(h.controller.getSnapshot().recovery, null);
  assert.equal(h.controller.getSnapshot().receipt, null);
  assert.match(h.controller.getSnapshot().notice, /closed operation window.*not recorded/);
  const next = await preview(h);
  assert.equal(next.review.operationId, uuid(102));
  assert.equal(h.calls.filter((call) => call.path.endsWith("/apply")).length, 1);
});

test("recovery errors, invalid absence claims and mismatched original receipt do not resolve uncertainty", async () => {
  const h = harness();
  const plan = await preview(h);
  await unknownApply(h, plan);
  const identity = h.controller.getSnapshot().recovery;
  const wrongReceipt = { ...receiptFor(plan), reviewedDigest: "a".repeat(64) };
  const responses: Array<unknown> = [
    { ...statusFor(plan), absenceDefinitive: true },
    { ...statusFor(plan), operationId: uuid(999) },
    statusFor(plan, wrongReceipt),
    statusFor(plan, { ...receiptFor(plan), sessionId: uuid(777) }),
  ];
  for (const response of responses) {
    const checking = h.controller.recover();
    h.last().resolve(response);
    await checking;
    assert.strictEqual(h.controller.getSnapshot().recovery, identity);
    assert.equal(h.controller.getSnapshot().receipt, null);
    assert.match(h.controller.getSnapshot().error, /could not be verified/);
  }
  const checking = h.controller.recover();
  h.last().reject(new ApiError(410, "view_operation_expired", "Receipt retention expired"));
  await checking;
  assert.strictEqual(h.controller.getSnapshot().recovery, identity);
  assert.equal(h.controller.getSnapshot().error, "Receipt retention expired");
});

test("stopping a recovery request retains identity, and late definitive absence cannot release it", async () => {
  const h = harness();
  const plan = await preview(h);
  await unknownApply(h, plan);
  const identity = h.controller.getSnapshot().recovery;
  const checking = h.controller.recover();
  const call = h.last();
  h.controller.stopWaiting();
  assert.equal(call.signal.aborted, true);
  assert.strictEqual(h.controller.getSnapshot().recovery, identity);
  const stopped = h.controller.getSnapshot();
  call.resolve(statusFor(plan, null, true));
  await checking;
  assert.strictEqual(h.controller.getSnapshot(), stopped);
  assert.strictEqual(h.controller.getSnapshot().recovery, identity);
  const retry = h.controller.recover();
  h.last().resolve(statusFor(plan, receiptFor(plan), true));
  await retry;
  assertHistorical(h, receiptFor(plan));
});

test("a recovered historical receipt clears stale paging and requires a fresh list/read for current state", async () => {
  const h = harness();
  const base = await selectRecord(h);
  const fullPage = await pageRecords();
  const loading = h.controller.loadPage();
  h.last().resolve(list(fullPage, true));
  await loading;
  const plan = await preview(h, "update", base);
  await unknownApply(h, plan);
  h.setTime("2026-10-04T12:00:00.000Z");
  const checking = h.controller.recover();
  h.last().resolve(statusFor(plan, receiptFor(plan), true));
  await checking;
  assertHistorical(h, receiptFor(plan));
  const loadingCurrent = h.controller.loadPage();
  assert.equal(h.last().path, `${route()}?limit=50`);
  const current = await record(VIEW_ID, "Changed elsewhere later", 12);
  h.last().resolve(list([current]));
  await loadingCurrent;
  await selectRecord(h, current);
  assert.equal(h.controller.getSnapshot().record?.viewRevision, 12);
  assert.equal(h.controller.getSnapshot().name, "Changed elsewhere later");
  assert.equal(h.controller.getSnapshot().receipt, null);
});

test("same-actor reauthentication retains identity only and recovers original creator-session receipt", async () => {
  const h = harness();
  h.controller.setName("Sensitive private name");
  h.controller.setPresentation(presentation("Sensitive search"));
  const plan = await preview(h);
  await unknownApply(h, plan);
  const identity = h.controller.getSnapshot().recovery;
  h.controller.configure(null);
  assert.equal(h.controller.getSnapshot().recovery, null);
  const freshScope = { ...SCOPE, sessionId: uuid(400), scheduleRevision: 99 };
  h.controller.configure(freshScope);
  const state = h.controller.getSnapshot();
  assert.strictEqual(state.recovery, identity);
  assert.equal(state.name, "My private view");
  assert.deepEqual(state.presentation, NATIVE_PLANNER_PRESENTATION_V1);
  assert.equal(state.plan, null);
  assert.equal(state.record, null);
  assert.deepEqual(state.views, []);
  assert.equal(state.receipt, null);
  assert.ok(!JSON.stringify(state.recovery).includes("Sensitive"));
  assert.ok(state.recovery);
  assert.deepEqual(Object.keys(state.recovery).sort(), [
    "action",
    "actorId",
    "baseConfigHash",
    "desiredConfigHash",
    "expectedScheduleRevision",
    "operationId",
    "operationWindowId",
    "organizationId",
    "previousViewRevision",
    "projectId",
    "reviewedDigest",
    "sessionId",
    "viewId",
  ]);
  const checking = h.controller.recover();
  const last = h.last();
  assert.equal(
    last.path,
    `${route(freshScope)}/operations/${plan.review.operationWindowId}/${plan.review.operationId}`,
  );
  last.resolve(statusFor(plan, receiptFor(plan), true));
  await checking;
  assertHistorical(h, receiptFor(plan));
  assert.equal(h.controller.getSnapshot().receipt?.sessionId, SCOPE.sessionId);
});

test("old apply response after same-actor reauthentication cannot falsely settle the retained identity", async () => {
  const h = harness();
  const plan = await preview(h);
  const index = h.calls.length;
  const pending = h.controller.apply();
  h.controller.configure(null);
  h.controller.configure({ ...SCOPE, sessionId: uuid(500) });
  const fresh = h.controller.getSnapshot();
  h.call(index).resolve(receiptFor(plan));
  await pending;
  assert.strictEqual(h.controller.getSnapshot(), fresh);
  assert.equal(fresh.receipt, null);
  assert.ok(fresh.recovery);
});

for (const [label, different] of [["different actor", { actorId: uuid(600) }]] as const) {
  test(`${label} clears pending private identity and cannot restore it by returning to the old scope`, async () => {
    const h = harness();
    const plan = await preview(h);
    await unknownApply(h, plan);
    h.controller.configure(null);
    h.controller.configure({ ...SCOPE, sessionId: uuid(603), ...different });
    assert.equal(h.controller.getSnapshot().recovery, null);
    assert.equal(h.controller.hasPendingRecovery(), false);
    const count = h.calls.length;
    await h.controller.recover();
    assert.equal(h.calls.length, count);
    h.controller.configure(SCOPE);
    assert.equal(h.controller.getSnapshot().recovery, null);
    assert.equal(h.controller.getSnapshot().record, null);
    assert.deepEqual(h.controller.getSnapshot().presentation, NATIVE_PLANNER_PRESENTATION_V1);
  });
}

for (const [label, different] of [
  ["another project", { projectId: uuid(601) }],
  ["another organization", { organizationId: uuid(602) }],
] as const) {
  test(`navigation to ${label} preserves original uncertainty while allowing independent scoped mutations`, async () => {
    const h = harness();
    const planA = await preview(h);
    await unknownApply(h, planA);
    const identityA = h.controller.getSnapshot().recovery;
    assert.ok(identityA);
    assert.equal(h.controller.hasPendingRecovery(), true);
    const scopeB = { ...SCOPE, ...different };
    h.controller.configure(scopeB);
    assert.equal(h.controller.getSnapshot().recovery, null);
    assert.equal(
      h.controller.hasPendingRecovery(),
      true,
      "hidden project A uncertainty remains pending",
    );
    assert.equal(h.controller.belongsTo(scopeB), true);
    assert.equal(h.controller.belongsTo(SCOPE), false);
    h.controller.setName("Independent B view");
    const planB = await preview(h, "create", undefined, scopeB);
    const applyingB = h.controller.apply();
    assert.equal(h.last().path, `${route(scopeB)}/apply`);
    h.last().resolve(receiptFor(planB));
    await applyingB;
    assertHistorical(h, receiptFor(planB));
    assert.equal(h.controller.hasPendingRecovery(), true, "settling B cannot release A");
    h.controller.configure(SCOPE);
    assert.strictEqual(h.controller.getSnapshot().recovery, identityA);
    assert.equal(h.controller.getSnapshot().name, "My private view");
    assert.equal(h.controller.getSnapshot().plan, null);
    const count = h.calls.length;
    await h.controller.preview("create");
    await h.controller.apply();
    assert.equal(h.calls.length, count, "returning to A must block a fresh mutation");
    const checking = h.controller.recover();
    assert.equal(
      h.last().path,
      `${route()}/operations/${planA.review.operationWindowId}/${planA.review.operationId}`,
    );
    h.last().resolve(statusFor(planA, receiptFor(planA), true));
    await checking;
    assertHistorical(h, receiptFor(planA));
    assert.equal(h.controller.hasPendingRecovery(), false);
  });
}

test("multiple project identities remain independent through same-actor reauthentication and recovery", async () => {
  const h = harness();
  const planA = await preview(h);
  await unknownApply(h, planA);
  const identityA = h.controller.getSnapshot().recovery;
  const scopeB = { ...SCOPE, projectId: uuid(610) };
  h.controller.configure(scopeB);
  const planB = await preview(h, "create", undefined, scopeB);
  await unknownApply(h, planB, scopeB);
  const identityB = h.controller.getSnapshot().recovery;
  h.controller.configure(null);
  assert.equal(h.controller.hasPendingRecovery(), true);
  const reauthenticatedA = { ...SCOPE, sessionId: uuid(611), scheduleRevision: 42 };
  h.controller.configure(reauthenticatedA);
  assert.strictEqual(h.controller.getSnapshot().recovery, identityA);
  assert.equal(h.controller.getSnapshot().recovery?.sessionId, SCOPE.sessionId);
  const checkingA = h.controller.recover();
  h.last().resolve(statusFor(planA, receiptFor(planA), true));
  await checkingA;
  assertHistorical(h, receiptFor(planA));
  assert.equal(h.controller.hasPendingRecovery(), true, "B remains unresolved after A receipt");
  h.controller.configure({ ...scopeB, sessionId: reauthenticatedA.sessionId });
  assert.strictEqual(h.controller.getSnapshot().recovery, identityB);
  const checkingB = h.controller.recover();
  h.last().resolve(statusFor(planB, null, true));
  await checkingB;
  assert.equal(h.controller.hasPendingRecovery(), false);
  assert.equal(h.controller.getSnapshot().recovery, null);
});

test("verified account switch permanently discards every hidden project recovery", async () => {
  const h = harness();
  const planA = await preview(h);
  await unknownApply(h, planA);
  const scopeB = { ...SCOPE, projectId: uuid(620) };
  h.controller.configure(scopeB);
  const planB = await preview(h, "create", undefined, scopeB);
  await unknownApply(h, planB, scopeB);
  assert.equal(h.controller.hasPendingRecovery(), true);
  h.controller.configure(null);
  h.controller.configure({ ...scopeB, actorId: uuid(621), sessionId: uuid(622) });
  assert.equal(h.controller.hasPendingRecovery(), false);
  assert.equal(h.controller.getSnapshot().recovery, null);
  h.controller.configure(SCOPE);
  assert.equal(h.controller.getSnapshot().recovery, null);
  h.controller.configure(scopeB);
  assert.equal(h.controller.getSnapshot().recovery, null);
  assert.equal(h.controller.hasPendingRecovery(), false);
});

test("verified actor before project loading clears a different account's uncertainty and preserves the same actor's original recovery", async () => {
  for (const sameActor of [false, true]) {
    const h = harness();
    h.controller.setName("Private preferences from original account");
    const plan = await preview(h);
    await unknownApply(h, plan);
    const identity = h.controller.getSnapshot().recovery;
    assert.ok(identity);
    h.controller.configure(null);
    assert.equal(h.controller.getSnapshot().recovery, null);
    assert.equal(h.controller.hasPendingRecovery(), true);
    const count = h.calls.length;
    h.controller.verifyActor(sameActor ? SCOPE.actorId : uuid(930));
    assert.equal(h.controller.hasPendingRecovery(), sameActor);
    assert.equal(h.controller.getSnapshot().recovery, null);
    assert.equal(h.controller.getSnapshot().plan, null);
    assert.equal(h.controller.getSnapshot().name, "My private view");
    await h.controller.recover();
    assert.equal(
      h.calls.length,
      count,
      "actor verification without a project must not issue a recovery request",
    );
    if (!sameActor) h.controller.verifyActor(SCOPE.actorId);
    const returnedScope = { ...SCOPE, sessionId: uuid(931) };
    h.controller.configure(returnedScope);
    if (sameActor) {
      assert.strictEqual(h.controller.getSnapshot().recovery, identity);
      assert.equal(identity.sessionId, SCOPE.sessionId);
      assert.equal(identity.operationId, plan.review.operationId);
      assert.equal(identity.reviewedDigest, plan.reviewedDigest);
      const checking = h.controller.recover();
      assert.equal(
        h.last().path,
        `${route(returnedScope)}/operations/${identity.operationWindowId}/${identity.operationId}`,
      );
      h.last().resolve(statusFor(plan, receiptFor(plan), true));
      await checking;
      assertHistorical(h, receiptFor(plan));
    } else {
      assert.equal(h.controller.getSnapshot().recovery, null);
      await h.controller.recover();
      assert.equal(
        h.calls.length,
        count,
        "returning to A cannot restore uncertainty discarded after verified B login",
      );
    }
    assert.equal(h.controller.hasPendingRecovery(), false);
  }
});

test("parent Planner busy callback refuses reads, previews, apply and recovery without consuming their state", async () => {
  const h = harness();
  h.setCanStart(false);
  const initial = h.controller.getSnapshot();
  await Promise.all([
    h.controller.loadPage(),
    h.controller.select(VIEW_ID),
    h.controller.preview("create"),
  ]);
  assert.equal(h.calls.length, 0);
  assert.strictEqual(h.controller.getSnapshot(), initial);
  h.setCanStart(true);
  const base = await selectRecord(h);
  h.setCanStart(false);
  await Promise.all([h.controller.preview("update"), h.controller.preview("delete")]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getSnapshot().record?.viewId, base.viewId);
  h.setCanStart(true);
  const plan = await preview(h, "update", base);
  h.setCanStart(false);
  const reviewed = h.controller.getSnapshot();
  const beforeApply = h.calls.length;
  await h.controller.apply();
  assert.equal(h.calls.length, beforeApply);
  assert.strictEqual(h.controller.getSnapshot(), reviewed);
  assert.equal(h.controller.hasPendingRecovery(), false);
  h.setCanStart(true);
  await unknownApply(h, plan);
  h.setCanStart(false);
  const unresolved = h.controller.getSnapshot();
  const beforeRecovery = h.calls.length;
  await h.controller.recover();
  assert.equal(h.calls.length, beforeRecovery);
  assert.strictEqual(h.controller.getSnapshot(), unresolved);
  h.setCanStart(true);
  const checking = h.controller.recover();
  h.last().resolve(statusFor(plan, null, true));
  await checking;
  assert.equal(h.controller.hasPendingRecovery(), false);
});

test("session guard false before start sends no reads, previews, apply or recovery", async () => {
  const h = harness();
  h.setSessionIsCurrent(false);
  const initial = h.controller.getSnapshot();
  await Promise.all([
    h.controller.loadPage(),
    h.controller.select(VIEW_ID),
    h.controller.preview("create"),
  ]);
  assert.equal(h.calls.length, 0);
  assert.strictEqual(h.controller.getSnapshot(), initial);
  assert.equal(h.sessionChecks.length, 3);
  assert.ok(h.sessionChecks.every((scope) => JSON.stringify(scope) === JSON.stringify(SCOPE)));
  h.setSessionIsCurrent(true);
  const plan = await preview(h);
  h.setSessionIsCurrent(false);
  const reviewed = h.controller.getSnapshot();
  const count = h.calls.length;
  await h.controller.apply();
  assert.equal(h.calls.length, count);
  assert.strictEqual(h.controller.getSnapshot(), reviewed);
  assert.equal(h.controller.hasPendingRecovery(), false);
  h.setSessionIsCurrent(true);
  await unknownApply(h, plan);
  h.setSessionIsCurrent(false);
  const unresolved = h.controller.getSnapshot();
  const recoveryCount = h.calls.length;
  await h.controller.recover();
  assert.equal(h.calls.length, recoveryCount);
  assert.strictEqual(h.controller.getSnapshot(), unresolved);
});

test("session changing after a list response prevents old private rows from publishing", async () => {
  const h = harness();
  const candidate = await record();
  const pending = h.controller.loadPage();
  h.last().resolve(list([candidate]));
  h.setSessionIsCurrent(false);
  await pending;
  assert.deepEqual(h.controller.getSnapshot().views, []);
  assert.equal(h.controller.getSnapshot().listed, false);
  assert.equal(h.controller.getSnapshot().error, "");
  assert.equal(h.controller.getSnapshot().busy, "");
});

test("session changing at read Web Crypto completion prevents a stale verified record publishing", async (context) => {
  const h = harness();
  const original = await selectRecord(h);
  const candidate = await record(OTHER_VIEW_ID, "Private data from expired session", 9);
  const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let hashes = 0;
  context.mock.method(
    globalThis.crypto.subtle,
    "digest",
    async (...args: Parameters<SubtleCrypto["digest"]>) => {
      const result = await realDigest(...args);
      hashes++;
      h.setSessionIsCurrent(false);
      return result;
    },
  );
  const pending = h.controller.select(candidate.viewId);
  h.last().resolve(candidate);
  await pending;
  assert.ok(hashes > 0, "session change must occur after actual Web Crypto completion");
  assert.equal(h.controller.getSnapshot().record?.viewId, original.viewId);
  assert.equal(h.controller.getSnapshot().name, original.configuration.name);
  assert.deepEqual(h.controller.getSnapshot().presentation, original.configuration.presentation);
  assert.equal(h.controller.getSnapshot().error, "");
  assert.equal(h.controller.getSnapshot().busy, "");
  assert.deepEqual(h.sessionChecks.at(-1), SCOPE);
});

test("session changing at plan Web Crypto completion cannot install an old reviewed plan", async (context) => {
  const h = harness();
  const pending = h.controller.preview("create");
  h.call(0).resolve(capabilities());
  await h.waitForCalls(2);
  const plan = await planFor(h.call(1).body as PlannerViewPlanRequestV1);
  const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let hashes = 0;
  context.mock.method(
    globalThis.crypto.subtle,
    "digest",
    async (...args: Parameters<SubtleCrypto["digest"]>) => {
      const result = await realDigest(...args);
      hashes++;
      h.setSessionIsCurrent(false);
      return result;
    },
  );
  h.call(1).resolve(plan);
  await pending;
  assert.ok(hashes > 0);
  assert.equal(h.controller.getSnapshot().plan, null);
  assert.equal(h.controller.getSnapshot().receipt, null);
  assert.equal(h.controller.getSnapshot().recovery, null);
  assert.equal(h.controller.getSnapshot().error, "");
  assert.equal(h.controller.getSnapshot().busy, "");
});

test("session changing at receipt Web Crypto completion retains the original identity-only recovery", async (context) => {
  const h = harness();
  h.controller.setName("Reviewed private draft");
  const plan = await preview(h);
  const receipt = receiptFor(plan);
  const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let hashes = 0;
  context.mock.method(
    globalThis.crypto.subtle,
    "digest",
    async (...args: Parameters<SubtleCrypto["digest"]>) => {
      const result = await realDigest(...args);
      hashes++;
      h.setSessionIsCurrent(false);
      return result;
    },
  );
  const pending = h.controller.apply();
  const identity = h.controller.getSnapshot().recovery;
  assert.ok(identity);
  h.last().resolve(receipt);
  await pending;
  assert.ok(hashes > 0);
  assert.equal(h.controller.getSnapshot().receipt, null);
  assert.strictEqual(h.controller.getSnapshot().recovery, identity);
  assert.equal(h.controller.hasPendingRecovery(), true);
  assert.ok(!Object.hasOwn(identity, "configuration"));
  assert.ok(!JSON.stringify(identity).includes("Reviewed private draft"));
  assert.equal(identity.operationId, plan.review.operationId);
  assert.equal(identity.reviewedDigest, plan.reviewedDigest);
  assert.equal(h.controller.getSnapshot().notice, "");
  assert.equal(h.controller.getSnapshot().busy, "");
  context.mock.restoreAll();
  h.controller.configure(null);
  assert.equal(h.controller.getSnapshot().plan, null);
  const freshScope = { ...SCOPE, sessionId: uuid(901) };
  h.controller.configure(freshScope);
  assert.strictEqual(h.controller.getSnapshot().recovery, identity);
  h.setSessionIsCurrent(true);
  const checking = h.controller.recover();
  assert.equal(
    h.last().path,
    `${route(freshScope)}/operations/${identity.operationWindowId}/${identity.operationId}`,
  );
  h.last().resolve(statusFor(plan, receipt, true));
  await checking;
  assertHistorical(h, receipt);
  assert.equal(h.controller.hasPendingRecovery(), false);
});

for (const outcome of ["recorded", "closed absence"] as const) {
  test(`session changing after ${outcome} status response cannot settle the original uncertainty`, async () => {
    const h = harness();
    const plan = await preview(h);
    await unknownApply(h, plan);
    const identity = h.controller.getSnapshot().recovery;
    const checking = h.controller.recover();
    h.last().resolve(statusFor(plan, outcome === "recorded" ? receiptFor(plan) : null, true));
    h.setSessionIsCurrent(false);
    await checking;
    assert.strictEqual(h.controller.getSnapshot().recovery, identity);
    assert.equal(h.controller.getSnapshot().receipt, null);
    assert.equal(h.controller.hasPendingRecovery(), true);
    assert.equal(h.controller.getSnapshot().notice, "");
    assert.equal(h.controller.getSnapshot().error, "");
    assert.equal(h.controller.getSnapshot().busy, "");
  });
}

test("published generic revision_conflict is definite and preserves the local presentation draft", async () => {
  const h = harness();
  const base = await selectRecord(h);
  h.controller.setName("Unsaved private preferences");
  h.controller.setPresentation(presentation("Current presentation draft"));
  await preview(h, "update", base);
  const before = h.controller.getSnapshot();
  const pending = h.controller.apply();
  h.last().reject(new ApiError(409, "revision_conflict", "Saved schedule changed elsewhere"));
  await pending;
  const state = h.controller.getSnapshot();
  assert.equal(state.plan, null);
  assert.equal(state.recovery, null);
  assert.equal(h.controller.hasPendingRecovery(), false);
  assert.equal(state.receipt, null);
  assert.equal(state.name, before.name);
  assert.deepEqual(state.presentation, before.presentation);
  assert.deepEqual(state.record, before.record);
  assert.equal(state.selectedId, before.selectedId);
  assert.equal(state.error, "Saved schedule changed elsewhere");
  h.controller.setName("Still editable after definite conflict");
  const nextPlan = await preview(h, "update", base);
  assert.equal(nextPlan.review.operationId, uuid(102));
});

test("invalid view identifiers never enter a URL or replace verified selection", async () => {
  const h = harness();
  const base = await selectRecord(h);
  const invalidIds = [
    "",
    "../capabilities",
    "/operations/private",
    `${VIEW_ID}?secret=private`,
    `${VIEW_ID}#private`,
    `${VIEW_ID}/apply`,
    `%2e%2e%2f${VIEW_ID}`,
    ` ${VIEW_ID}`,
    `${VIEW_ID}\n`,
    "Native",
    "constructor",
    "https://example.invalid/private",
  ];
  for (const value of invalidIds) {
    await h.controller.select(value);
    assert.equal(h.calls.length, 1, "invalid ID must not be interpolated into any request");
    assert.equal(h.controller.getSnapshot().selectedId, base.viewId);
    assert.equal(h.controller.getSnapshot().record?.viewRevision, base.viewRevision);
    assert.equal(h.controller.getSnapshot().error, "Select a current private view from the list.");
    assert.ok(!h.controller.getSnapshot().error.includes(value) || value.length === 0);
  }
  await h.controller.select("native");
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getSnapshot().selectedId, "native");
});

test("late recovery response from the old project cannot install its historical receipt", async () => {
  const h = harness();
  const plan = await preview(h);
  await unknownApply(h, plan);
  const index = h.calls.length;
  const checking = h.controller.recover();
  h.controller.configure({ ...SCOPE, projectId: uuid(700) });
  const current = h.controller.getSnapshot();
  h.call(index).resolve(statusFor(plan, receiptFor(plan)));
  await checking;
  assert.equal(h.call(index).signal.aborted, true);
  assert.strictEqual(h.controller.getSnapshot(), current);
  assert.equal(current.receipt, null);
  assert.equal(current.recovery, null);
});

test("pre-send authentication failures are surfaced without creating recovery identity", async () => {
  const h = harness();
  const error = new ApiError(401, "unauthenticated", "Sign in again");
  const pending = h.controller.loadPage();
  h.call(0).reject(error);
  await pending;
  assert.strictEqual(h.controller.getSnapshot().authFailure, error);
  assert.equal(h.controller.getSnapshot().recovery, null);
  const next = h.controller.loadPage();
  assert.equal(h.controller.getSnapshot().authFailure, null);
  h.call(1).resolve(list());
  await next;
  assert.equal(h.controller.getSnapshot().error, "");
});
