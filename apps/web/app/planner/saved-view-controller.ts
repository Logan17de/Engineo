import {
  NATIVE_PLANNER_PRESENTATION_V1,
  type PlannerPresentationV1,
  type PlannerViewActionV1,
  type PlannerViewPlanRequestV1,
  type PlannerViewPlanV1,
  type PlannerViewReceiptV1,
  validatePlannerViewConfigurationV1,
} from "@engineo/contracts";
import { ApiError } from "./api";
import {
  type ViewListV1,
  type ViewReadV1,
  type ViewResponseBindingV1,
  checkSavedViewCapabilities,
  checkSavedViewList,
  checkSavedViewOperationStatus,
  checkSavedViewPlan,
  checkSavedViewRead,
  checkSavedViewReceipt,
} from "./saved-view-protocol";

export interface SavedViewScope extends ViewResponseBindingV1 {
  scheduleRevision: number;
}
export type SavedViewRequest = (
  method: "GET" | "POST",
  path: string,
  signal: AbortSignal,
  body?: unknown,
) => Promise<unknown>;
export interface SavedViewRecovery {
  actorId: string;
  sessionId: string;
  organizationId: string;
  projectId: string;
  action: PlannerViewActionV1;
  viewId: string | null;
  operationWindowId: string;
  operationId: string;
  reviewedDigest: string;
  expectedScheduleRevision: number;
  previousViewRevision: number;
  baseConfigHash: string | null;
  desiredConfigHash: string | null;
}
export interface SavedViewState {
  views: ViewListV1["views"];
  nextCursor: string | null;
  listed: boolean;
  record: ViewReadV1 | null;
  selectedId: string;
  name: string;
  presentation: PlannerPresentationV1;
  plan: PlannerViewPlanV1 | null;
  recovery: SavedViewRecovery | null;
  receipt: PlannerViewReceiptV1 | null;
  busy: string;
  error: string;
  notice: string;
  authFailure: ApiError | null;
}
const initialState = (): SavedViewState => ({
  views: [],
  nextCursor: null,
  listed: false,
  record: null,
  selectedId: "native",
  name: "My private view",
  presentation: structuredClone(NATIVE_PLANNER_PRESENTATION_V1),
  plan: null,
  recovery: null,
  receipt: null,
  busy: "",
  error: "",
  notice: "",
  authFailure: null,
});
export const EMPTY_SAVED_VIEW_STATE = initialState();
const ownerKey = (scope: ViewResponseBindingV1) =>
  `${scope.actorId}:${scope.organizationId}:${scope.projectId}`;
const sameOwner = (a: ViewResponseBindingV1, b: ViewResponseBindingV1) =>
  a.actorId === b.actorId && a.organizationId === b.organizationId && a.projectId === b.projectId;
const sameScope = (a: ViewResponseBindingV1, b: ViewResponseBindingV1) =>
  sameOwner(a, b) && a.sessionId === b.sessionId;
const responseBinding = (scope: SavedViewScope): ViewResponseBindingV1 => ({
  actorId: scope.actorId,
  sessionId: scope.sessionId,
  organizationId: scope.organizationId,
  projectId: scope.projectId,
});
function recoveryFor(plan: PlannerViewPlanV1): SavedViewRecovery {
  const r = plan.review;
  return {
    actorId: r.actorId,
    sessionId: r.sessionId,
    organizationId: r.organizationId,
    projectId: r.projectId,
    action: r.action,
    viewId: r.viewId,
    operationWindowId: r.operationWindowId,
    operationId: r.operationId,
    reviewedDigest: plan.reviewedDigest,
    expectedScheduleRevision: r.expectedScheduleRevision,
    previousViewRevision: r.expectedViewRevision,
    baseConfigHash: r.baseConfigHash,
    desiredConfigHash: r.desiredConfigHash,
  };
}
function matchesRecovery(receipt: PlannerViewReceiptV1, recovery: SavedViewRecovery): boolean {
  return (
    receipt.sessionId === recovery.sessionId &&
    receipt.action === recovery.action &&
    (recovery.viewId === null || receipt.viewId === recovery.viewId) &&
    receipt.reviewedDigest === recovery.reviewedDigest &&
    receipt.expectedScheduleRevision === recovery.expectedScheduleRevision &&
    receipt.previousViewRevision === recovery.previousViewRevision &&
    receipt.baseConfigHash === recovery.baseConfigHash &&
    receipt.desiredConfigHash === recovery.desiredConfigHash
  );
}
/** Local memory only; no private names/configuration/credentials enter storage, history or URLs. */
export class SavedViewController {
  private state = initialState();
  private scope: SavedViewScope | null = null;
  private epoch = 0;
  private task: { controller: AbortController; epoch: number; scope: SavedViewScope } | null = null;
  private identity: SavedViewRecovery | null = null;
  private recoveries = new Map<string, SavedViewRecovery>();
  private lastActorId: string | null = null;
  private listeners = new Set<() => void>();
  constructor(
    private readonly request: SavedViewRequest,
    private readonly uuid: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = () => Date.now(),
    private readonly canStart: () => boolean = () => true,
    private readonly sessionIsCurrent: (scope: SavedViewScope) => boolean = () => true,
  ) {}
  getSnapshot = (): SavedViewState => this.state;
  hasPendingRecovery = (): boolean => this.recoveries.size > 0;
  private rememberIdentity(identity: SavedViewRecovery | null): void {
    if (identity) this.recoveries.set(ownerKey(identity), identity);
    else if (this.identity) this.recoveries.delete(ownerKey(this.identity));
    this.identity = identity;
  }
  belongsTo(scope: SavedViewScope): boolean {
    return this.scope !== null && sameScope(this.scope, scope);
  }
  verifyActor(actorId: string): void {
    if (this.lastActorId !== null && this.lastActorId !== actorId) {
      this.recoveries.clear();
      this.identity = null;
      this.configure(null);
    }
    this.lastActorId = actorId;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<SavedViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  configure(scope: SavedViewScope | null): void {
    const previous = this.scope;
    if (previous && scope && sameScope(previous, scope)) {
      if (previous.scheduleRevision === scope.scheduleRevision) return;
      this.scope = { ...scope };
      this.epoch++;
      this.task?.controller.abort();
      this.task = null;
      this.publish({
        busy: "",
        plan: null,
        recovery: this.identity,
        notice: this.identity
          ? "A view apply may have committed. Check its original operation."
          : "Saved project revision changed. Review any view action again.",
      });
      return;
    }
    this.epoch++;
    this.task?.controller.abort();
    this.task = null;
    this.scope = scope ? { ...scope } : null;
    if (scope) {
      if (this.lastActorId !== null && this.lastActorId !== scope.actorId) this.recoveries.clear();
      this.lastActorId = scope.actorId;
      this.identity = this.recoveries.get(ownerKey(scope)) ?? null;
    }
    this.state = {
      ...initialState(),
      recovery: scope && this.identity && sameOwner(scope, this.identity) ? this.identity : null,
    };
    for (const listener of this.listeners) listener();
  }
  private start(label: string): NonNullable<SavedViewController["task"]> | null {
    if (!this.scope || this.task || !this.canStart() || !this.sessionIsCurrent(this.scope))
      return null;
    const task = { controller: new AbortController(), epoch: this.epoch, scope: { ...this.scope } };
    this.task = task;
    this.publish({ busy: label, error: "", notice: "", authFailure: null });
    return task;
  }
  private current(task: NonNullable<SavedViewController["task"]>): boolean {
    return (
      this.task === task &&
      task.epoch === this.epoch &&
      !task.controller.signal.aborted &&
      this.sessionIsCurrent(task.scope)
    );
  }
  private path(scope: SavedViewScope): string {
    return `/organizations/${scope.organizationId}/projects/${scope.projectId}/views`;
  }
  private finish(task: NonNullable<SavedViewController["task"]>): void {
    if (this.task === task) {
      this.task = null;
      this.publish({ busy: "" });
    }
  }
  private fail(error: unknown, task: NonNullable<SavedViewController["task"]>): void {
    if (!this.current(task)) return;
    const authFailure =
      error instanceof ApiError &&
      (error.status === 401 || error.code === "session_changed" || error.status === 403)
        ? error
        : null;
    this.publish({
      error:
        error instanceof ApiError
          ? error.message
          : "The private-view response could not be verified. Try reloading your views.",
      authFailure,
    });
  }
  setName(name: string): void {
    if (!this.task && !this.state.plan && !this.identity)
      this.publish({ name, error: "", receipt: null });
  }
  setPresentation(presentation: PlannerPresentationV1): void {
    if (!this.task && !this.state.plan && !this.identity)
      this.publish({ presentation: structuredClone(presentation), error: "", receipt: null });
  }
  native(): void {
    if (this.task || this.identity) return;
    this.publish({
      selectedId: "native",
      record: null,
      name: "My private view",
      presentation: structuredClone(NATIVE_PLANNER_PRESENTATION_V1),
      plan: null,
      error: "",
      notice: "Native presentation selected. Your schedule edits are unchanged.",
    });
  }
  async loadPage(more = false): Promise<void> {
    const cursor = more ? this.state.nextCursor : null;
    if (more && !cursor) return;
    const task = this.start("Loading private views");
    if (!task) return;
    try {
      const value = await this.request(
        "GET",
        `${this.path(task.scope)}?limit=50${cursor ? `&cursor=${cursor}` : ""}`,
        task.controller.signal,
      );
      const page = checkSavedViewList(value, 50, cursor ?? undefined);
      if (!this.current(task)) return;
      const views = more ? [...this.state.views, ...page.views] : page.views;
      if (new Set(views.map((view) => view.viewId)).size !== views.length)
        throw new Error("Repeated page");
      this.publish({ views, nextCursor: page.nextCursor, listed: true });
    } catch (error) {
      this.fail(error, task);
    } finally {
      this.finish(task);
    }
  }
  async select(viewId: string): Promise<void> {
    if (viewId === "native") {
      this.native();
      return;
    }
    if (this.identity || this.state.plan) return;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(viewId)) {
      this.publish({ error: "Select a current private view from the list." });
      return;
    }
    const task = this.start("Opening private view");
    if (!task) return;
    try {
      const record = await checkSavedViewRead(
        await this.request("GET", `${this.path(task.scope)}/${viewId}`, task.controller.signal),
        viewId,
      );
      if (!this.current(task)) return;
      this.publish({
        selectedId: record.viewId,
        record,
        name: record.configuration.name,
        presentation: record.configuration.presentation,
        receipt: null,
        notice: "Private presentation selected. Your schedule edits are unchanged.",
      });
    } catch (error) {
      this.fail(error, task);
    } finally {
      this.finish(task);
    }
  }
  async preview(action: PlannerViewActionV1): Promise<void> {
    if (this.identity || this.state.plan) return;
    const base = this.state.record;
    if (action !== "create" && !base) return;
    const checked = validatePlannerViewConfigurationV1({
      schemaVersion: 1,
      kind: "engineo-planner-view",
      name: this.state.name,
      visibility: "private",
      presentation: this.state.presentation,
    });
    if (action !== "delete" && !checked.valid) {
      this.publish({ error: checked.diagnostics.issues[0]?.message ?? "Invalid private view." });
      return;
    }
    const task = this.start(`Reviewing view ${action}`);
    if (!task) return;
    try {
      const capabilities = checkSavedViewCapabilities(
        await this.request("GET", `${this.path(task.scope)}/capabilities`, task.controller.signal),
      );
      if (!this.current(task)) return;
      if (this.now() >= Date.parse(capabilities.operationWindowClosesAt))
        throw new ApiError(
          409,
          "view_review_expired",
          "The server operation window closed. Review again.",
        );
      const common = {
        operationWindowId: capabilities.operationWindowId,
        operationId: this.uuid(),
        expectedScheduleRevision: task.scope.scheduleRevision,
      };
      let request: PlannerViewPlanRequestV1;
      if (action === "create" && checked.valid)
        request = { ...common, action, configuration: checked.normalizedConfiguration };
      else if (action === "update" && base && checked.valid)
        request = {
          ...common,
          action,
          viewId: base.viewId,
          expectedViewRevision: base.viewRevision,
          configuration: checked.normalizedConfiguration,
        };
      else if (action === "delete" && base)
        request = {
          ...common,
          action,
          viewId: base.viewId,
          expectedViewRevision: base.viewRevision,
        };
      else return;
      const plan = await checkSavedViewPlan(
        await this.request(
          "POST",
          `${this.path(task.scope)}/plan`,
          task.controller.signal,
          request,
        ),
        responseBinding(task.scope),
        request,
        action === "create" ? undefined : (base ?? undefined),
      );
      if (this.current(task)) this.publish({ plan, receipt: null });
    } catch (error) {
      this.fail(error, task);
    } finally {
      this.finish(task);
    }
  }
  discardPreview(): void {
    if (!this.task && !this.identity)
      this.publish({ plan: null, notice: "Preview discarded. No view mutation was sent." });
  }
  stopWaiting(): void {
    const task = this.task;
    if (!task) return;
    task.controller.abort();
    this.task = null;
    this.publish({
      busy: "",
      recovery: this.identity,
      plan: null,
      notice: this.identity
        ? "Stopped waiting. The apply may have committed; check its original operation."
        : "Request stopped. Your presentation and schedule drafts are unchanged.",
    });
  }
  async apply(): Promise<void> {
    const plan = this.state.plan;
    if (!plan || this.identity) return;
    if (this.now() >= Date.parse(plan.review.expiresAt)) {
      this.publish({ plan: null, error: "This preview expired. Review again before applying." });
      return;
    }
    const task = this.start("Applying private view");
    if (!task) return;
    this.rememberIdentity(recoveryFor(plan));
    this.publish({ recovery: this.identity });
    try {
      const value = await this.request(
        "POST",
        `${this.path(task.scope)}/apply`,
        task.controller.signal,
        plan,
      );
      const receipt = await checkSavedViewReceipt(
        value,
        responseBinding(task.scope),
        plan.review.operationWindowId,
        plan.review.operationId,
        plan,
      );
      if (!this.current(task)) return;
      this.rememberIdentity(null);
      this.publish({
        recovery: null,
        plan: null,
        receipt,
        record: null,
        selectedId: "native",
        views: [],
        nextCursor: null,
        listed: false,
        notice: `Historical receipt confirms ${receipt.outcome}. Reload private views for their current state.`,
      });
    } catch (error) {
      if (!this.current(task)) return;
      // Explicit current-request rejections are known failures; transport, auth/session and
      // protocol errors after submission cannot prove rollback or cancel a committed apply.
      const known =
        error instanceof ApiError &&
        [
          "revision_conflict",
          "view_revision_conflict",
          "view_schedule_revision_conflict",
          "view_reference_stale",
          "view_review_expired",
          "view_not_found",
          "view_capacity_exceeded",
          "view_rate_limited",
        ].includes(error.code);
      if (known) {
        this.rememberIdentity(null);
        this.publish({ recovery: null, plan: null });
        this.fail(error, task);
      } else {
        this.publish({
          plan: null,
          recovery: this.identity,
          error:
            "The view apply outcome is unknown. Check the original operation before starting another mutation.",
        });
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403 || error.code === "session_changed")
        )
          this.publish({ authFailure: error });
      }
    } finally {
      this.finish(task);
    }
  }
  async recover(): Promise<void> {
    const identity = this.identity;
    if (!identity) return;
    const task = this.start("Checking original operation");
    if (!task) return;
    try {
      const value = await this.request(
        "GET",
        `${this.path(task.scope)}/operations/${identity.operationWindowId}/${identity.operationId}`,
        task.controller.signal,
      );
      const status = await checkSavedViewOperationStatus(
        value,
        responseBinding(task.scope),
        identity.operationWindowId,
        identity.operationId,
      );
      if (!this.current(task)) return;
      if (status.receipt) {
        if (!matchesRecovery(status.receipt, identity)) throw new Error("Receipt mismatch");
        this.rememberIdentity(null);
        this.publish({
          recovery: null,
          receipt: status.receipt,
          record: null,
          selectedId: "native",
          views: [],
          nextCursor: null,
          listed: false,
          notice: `Historical receipt confirms ${status.receipt.outcome}. Reload private views for their current state.`,
        });
      } else if (status.absenceDefinitive) {
        this.rememberIdentity(null);
        this.publish({
          recovery: null,
          notice:
            "The closed operation window confirms this apply was not recorded. You can review a new action.",
        });
      } else
        this.publish({
          notice:
            "No receipt yet. An in-flight apply may still commit; keep checking this original operation.",
        });
    } catch (error) {
      this.fail(error, task);
    } finally {
      this.finish(task);
    }
  }
}
