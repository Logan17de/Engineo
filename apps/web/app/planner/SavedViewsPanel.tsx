"use client";

import type {
  EngineProjectInputV1,
  PlannerPresentationV1,
  PlannerViewActionV1,
} from "@engineo/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { type ApiError, api } from "./api";
import {
  EMPTY_SAVED_VIEW_STATE,
  type SavedViewController,
  type SavedViewScope,
  type SavedViewState,
} from "./saved-view-controller";
import { parseSavedViewJson } from "./saved-view-protocol";

export const savedViewRequest = (
  method: "GET" | "POST",
  path: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<unknown> =>
  api(path, {
    method,
    body,
    signal,
    responsePolicy: { maximumBytes: 65536, parseJson: parseSavedViewJson },
  });
export const savedViewProjectionRequest = (
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> =>
  api(path, {
    method: "POST",
    body,
    signal,
    responsePolicy: {
      maximumBytes: 4194304,
      parseJson: (bytes) => parseSavedViewJson(bytes, 4194304),
    },
  });

function describe(presentation: PlannerPresentationV1): string {
  return `Search: ${presentation.search || "all activities"}; type: ${presentation.kind}; WBS: ${presentation.wbsId ?? "all"}; critical: ${presentation.critical}; sort: ${presentation.sort.field} ${presentation.sort.direction}; grouping: ${presentation.groupBy}`;
}
interface ControlsProps {
  state: SavedViewState;
  wbs: EngineProjectInputV1["wbs"];
  disabled: boolean;
  dirty: boolean;
  onSelect: (id: string) => void;
  onName: (name: string) => void;
  onPresentation: (presentation: PlannerPresentationV1) => void;
  onList: (more?: boolean) => void;
  onPreview: (action: PlannerViewActionV1) => void;
  onApply: () => void;
  onDiscard: () => void;
  onStop: () => void;
  onRecover: () => void;
}
/** Pure controls are separately SSR-verifiable; actions never save the schedule or calculate. */
export function SavedViewControls(props: ControlsProps) {
  const { state, disabled, wbs, dirty } = props;
  const locked = disabled || Boolean(state.busy || state.plan || state.recovery);
  const change = (patch: Partial<PlannerPresentationV1>) =>
    props.onPresentation({ ...state.presentation, ...patch });
  const modified =
    state.record &&
    (state.name !== state.record.configuration.name ||
      JSON.stringify(state.presentation) !==
        JSON.stringify(state.record.configuration.presentation));
  const transient =
    !state.record &&
    JSON.stringify(state.presentation) !== JSON.stringify(EMPTY_SAVED_VIEW_STATE.presentation);
  return (
    <section
      className="savedViews"
      aria-label="Private saved activity views"
      aria-busy={Boolean(state.busy)}
    >
      <div className="savedViewHeading">
        <div>
          <h2>Activity presentation</h2>
          <p className="muted">
            Private to your account ·{" "}
            {dirty ? "Viewing an unsaved schedule draft" : "Saved schedule source"}
          </p>
        </div>
        <button
          type="button"
          disabled={disabled || Boolean(state.busy)}
          onClick={() => props.onList()}
        >
          Reload private views
        </button>
      </div>
      <div className="savedViewFields">
        <label>
          Selected presentation
          <select
            value={transient ? "transient" : state.selectedId}
            disabled={locked}
            onChange={(event) => props.onSelect(event.target.value)}
          >
            <option value="native">Native</option>
            {transient ? (
              <option value="transient" disabled>
                Local presentation
              </option>
            ) : null}
            {state.record && !state.views.some((view) => view.viewId === state.record?.viewId) ? (
              <option value={state.record.viewId}>{state.record.configuration.name}</option>
            ) : null}
            {state.views.map((view) => (
              <option key={view.viewId} value={view.viewId}>
                {view.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Private view name
          <input
            value={state.name}
            maxLength={120}
            disabled={locked}
            onChange={(event) => props.onName(event.target.value)}
          />
        </label>
        <label>
          Find activities
          <input
            type="search"
            value={state.presentation.search}
            maxLength={256}
            placeholder="Search name or ID"
            disabled={locked}
            onChange={(event) => change({ search: event.target.value })}
          />
        </label>
        <label>
          Activity type
          <select
            value={state.presentation.kind}
            disabled={locked}
            onChange={(event) =>
              change({ kind: event.target.value as PlannerPresentationV1["kind"] })
            }
          >
            <option value="all">All types</option>
            <option value="TASK">Tasks</option>
            <option value="START_MILESTONE">Start milestones</option>
            <option value="FINISH_MILESTONE">Finish milestones</option>
          </select>
        </label>
        <label>
          WBS filter
          <select
            value={state.presentation.wbsId ?? ""}
            disabled={locked}
            onChange={(event) => change({ wbsId: event.target.value || null })}
          >
            <option value="">All WBS</option>
            {state.presentation.wbsId &&
            !wbs.some((node) => node.id === state.presentation.wbsId) ? (
              <option value={state.presentation.wbsId}>Unavailable WBS reference</option>
            ) : null}
            {wbs.map((node) => (
              <option key={node.id} value={node.id}>
                {node.code} · {node.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Critical filter
          <select
            value={state.presentation.critical}
            disabled={locked}
            onChange={(event) =>
              change({ critical: event.target.value as PlannerPresentationV1["critical"] })
            }
          >
            <option value="all">All activities</option>
            <option value="critical">Critical only</option>
            <option value="noncritical">Noncritical only</option>
          </select>
        </label>
        <label>
          Sort by
          <select
            value={state.presentation.sort.field}
            disabled={locked}
            onChange={(event) =>
              change({
                sort: {
                  ...state.presentation.sort,
                  field: event.target.value as PlannerPresentationV1["sort"]["field"],
                },
              })
            }
          >
            <option value="native">Native order</option>
            <option value="name">Name</option>
            <option value="durationMinutes">Duration</option>
            <option value="earlyStart">Calculated early start</option>
            <option value="totalFloatMinutes">Calculated total float</option>
          </select>
        </label>
        <label>
          Sort direction
          <select
            value={state.presentation.sort.direction}
            disabled={locked || state.presentation.sort.field === "native"}
            onChange={(event) =>
              change({
                sort: {
                  ...state.presentation.sort,
                  direction: event.target.value as "asc" | "desc",
                },
              })
            }
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </label>
        <label>
          Group activities
          <select
            value={state.presentation.groupBy}
            disabled={locked}
            onChange={(event) => change({ groupBy: event.target.value as "none" | "wbs" })}
          >
            <option value="none">No groups</option>
            <option value="wbs">WBS</option>
          </select>
        </label>
      </div>
      {modified ? (
        <p className="tableNote">
          This presentation has local changes. The saved private view is unchanged until you review
          and apply.
        </p>
      ) : null}
      <div className="savedViewActions">
        <button type="button" disabled={locked} onClick={() => props.onSelect("native")}>
          Use Native
        </button>
        <button type="button" disabled={locked} onClick={() => props.onPreview("create")}>
          Review new private view
        </button>
        <button
          type="button"
          disabled={locked || !state.record}
          onClick={() => props.onPreview("update")}
        >
          Review update
        </button>
        <button
          type="button"
          disabled={locked || !state.record}
          onClick={() => props.onPreview("delete")}
        >
          Review delete
        </button>
        {state.nextCursor ? (
          <button type="button" disabled={locked} onClick={() => props.onList(true)}>
            Load more private views
          </button>
        ) : null}
        {state.busy ? (
          <button type="button" onClick={props.onStop}>
            Stop waiting
          </button>
        ) : null}
      </div>
      {!state.busy && state.listed && state.views.length === 0 ? (
        <p className="muted">No saved private views. Native is always available.</p>
      ) : null}
      {state.plan ? (
        <section className="viewReview" aria-label="Review private view action">
          <h3 tabIndex={-1}>
            Review {state.plan.review.action}:{" "}
            {state.plan.review.desiredConfiguration?.name ??
              state.plan.review.baseConfiguration?.name}
          </h3>
          <p>
            Saved schedule revision {state.plan.review.expectedScheduleRevision} · View revision{" "}
            {state.plan.review.expectedViewRevision} · Expires {state.plan.review.expiresAt}
          </p>
          {state.plan.review.baseConfiguration ? (
            <p>Before: {describe(state.plan.review.baseConfiguration.presentation)}</p>
          ) : null}
          {state.plan.review.desiredConfiguration ? (
            <p>After: {describe(state.plan.review.desiredConfiguration.presentation)}</p>
          ) : (
            <p>This removes only your private presentation record.</p>
          )}
          <p>Your schedule draft, source order and calculated dates stay unchanged.</p>
          <button
            type="button"
            className="primary"
            disabled={disabled || Boolean(state.busy || state.recovery)}
            onClick={props.onApply}
          >
            Apply private view {state.plan.review.action}
          </button>
          <button
            type="button"
            disabled={Boolean(state.busy || state.recovery)}
            onClick={props.onDiscard}
          >
            Discard preview
          </button>
        </section>
      ) : null}
      {state.recovery ? (
        <section className="viewReview" aria-label="Uncertain private view apply">
          <h3 tabIndex={-1}>Check the original apply</h3>
          <p>
            Stopping a request does not cancel a commit. Another mutation stays blocked while this
            outcome is unknown.
          </p>
          <p>
            Operation {state.recovery.operationWindowId} / {state.recovery.operationId}
          </p>
          <button
            type="button"
            disabled={disabled || Boolean(state.busy)}
            onClick={props.onRecover}
          >
            Check original operation
          </button>
        </section>
      ) : null}
      {state.receipt ? (
        <p className="tableNote">
          Historical receipt: {state.receipt.outcome} · {state.receipt.recordedAt}. This does not
          describe the current view record.
        </p>
      ) : null}
      <div className="savedViewStatus" role="status" tabIndex={-1}>
        {state.busy || state.notice}
      </div>
      {state.error ? (
        <p className="savedViewError" role="alert">
          {state.error}
        </p>
      ) : null}
    </section>
  );
}

export default function SavedViewsPanel({
  controller,
  scope,
  wbs,
  disabled,
  dirty,
  onSessionFailure,
}: {
  controller: SavedViewController;
  scope: SavedViewScope;
  wbs: EngineProjectInputV1["wbs"];
  disabled: boolean;
  dirty: boolean;
  onSessionFailure: (error: ApiError) => void;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const state = controller.belongsTo(scope) ? snapshot : EMPTY_SAVED_VIEW_STATE;
  const panel = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const previousPlan = useRef(false);
  const restoreOnCompletion = useRef(false);
  useEffect(() => {
    controller.configure(scope);
  }, [controller, scope]);
  const scopeKey = `${scope.actorId}:${scope.sessionId}:${scope.organizationId}:${scope.projectId}`;
  useEffect(() => {
    if (scopeKey) void controller.loadPage();
    return () => controller.configure(null);
  }, [controller, scopeKey]);
  useEffect(() => {
    if (state.authFailure) onSessionFailure(state.authFailure);
  }, [state.authFailure, onSessionFailure]);
  useEffect(() => {
    if (state.plan && !previousPlan.current)
      panel.current?.querySelector<HTMLElement>(".viewReview h3")?.focus();
    if (!state.busy && (restoreOnCompletion.current || (previousPlan.current && !state.plan))) {
      restoreOnCompletion.current = false;
      if (!panel.current?.closest("[hidden]")) {
        if (state.recovery)
          panel.current
            ?.querySelector<HTMLElement>("[aria-label='Uncertain private view apply'] h3")
            ?.focus();
        else if (returnFocus.current?.isConnected && !returnFocus.current.matches(":disabled"))
          returnFocus.current.focus();
        else panel.current?.querySelector<HTMLElement>(".savedViewStatus")?.focus();
      }
    }
    previousPlan.current = Boolean(state.plan);
  }, [state.plan, state.busy, state.recovery]);
  return (
    <div ref={panel}>
      <SavedViewControls
        state={state}
        wbs={wbs}
        disabled={disabled}
        dirty={dirty}
        onSelect={(id) => {
          void controller.select(id);
        }}
        onName={(name) => controller.setName(name)}
        onPresentation={(presentation) => controller.setPresentation(presentation)}
        onList={(more) => {
          void controller.loadPage(more);
        }}
        onPreview={(action) => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
          void controller.preview(action);
        }}
        onApply={() => {
          restoreOnCompletion.current = true;
          void controller.apply();
        }}
        onDiscard={() => {
          controller.discardPreview();
          returnFocus.current?.focus();
        }}
        onStop={() => {
          restoreOnCompletion.current = true;
          controller.stopWaiting();
        }}
        onRecover={() => {
          restoreOnCompletion.current = true;
          void controller.recover();
        }}
      />
    </div>
  );
}
