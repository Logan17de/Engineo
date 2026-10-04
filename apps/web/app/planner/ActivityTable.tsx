"use client";

import type {
  ActivityInputV1,
  EngineProjectInputV1,
  EngineScheduleResultV1,
  PlannerProjectionV1,
  PlannerVisualRowV1,
} from "@engineo/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import DurationEditor from "./DurationEditor";

export function displayInstant(value: string | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
const ROW_HEIGHT = 42;
const VISIBLE_ROWS = 18;
export default function ActivityTable({
  input,
  result,
  editable,
  filter,
  projection,
  onEdit,
  onDurationDraft,
  durationDrafts,
  onDelete,
}: {
  input: EngineProjectInputV1;
  result: EngineScheduleResultV1 | null;
  editable: boolean;
  filter: string;
  projection?: PlannerProjectionV1 | null | undefined;
  onEdit: (id: string, patch: Partial<ActivityInputV1>) => void;
  onDelete: (id: string) => void;
  onDurationDraft?: ((id: string, raw: string | null) => void) | undefined;
  durationDrafts?: ReadonlyMap<string, string> | undefined;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const scroll = useRef<HTMLElement>(null);
  const [atEnd, setAtEnd] = useState(false);
  const activitiesById = useMemo(
    () => new Map(input.activities.map((activity) => [activity.id, activity])),
    [input.activities],
  );
  const rows = useMemo<PlannerVisualRowV1[]>(() => {
    if (projection !== undefined) return projection?.available ? projection.rows : [];
    const term = filter.trim().toLowerCase();
    return input.activities
      .map((activity, nativeIndex) => ({ activity, nativeIndex }))
      .filter(
        ({ activity }) =>
          !term ||
          activity.name.toLowerCase().includes(term) ||
          activity.id.toLowerCase().includes(term),
      )
      .map(({ activity, nativeIndex }, index) => ({
        kind: "activity",
        activityId: activity.id,
        nativeIndex,
        displayOrdinal: index + 1,
        groupKey: null,
      }));
  }, [input.activities, filter, projection]);
  const visibleActivityCount = projection?.available
    ? projection.visibleActivityCount
    : rows.length;
  const rowIdentity = rows
    .map((row) => (row.kind === "group" ? row.key : row.activityId))
    .join("|");
  useEffect(() => {
    if (rowIdentity !== undefined) {
      scroll.current?.scrollTo({ top: 0 });
      setScrollTop(0);
    }
  }, [rowIdentity]);
  useEffect(() => {
    const node = scroll.current;
    if (!node || rows.length === 0) {
      setAtEnd(true);
      return;
    }
    const update = () => setAtEnd(node.scrollTop + node.clientHeight >= node.scrollHeight - 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [rows.length]);
  const first = Math.max(
    0,
    Math.min(rows.length - VISIBLE_ROWS, Math.floor(scrollTop / ROW_HEIGHT) - 3),
  );
  const visible = rows.slice(first, first + VISIBLE_ROWS + 6);
  const range = useMemo(() => {
    let start = Date.parse(input.project.plannedStart),
      finish = start + 86_400_000;
    if (result)
      for (const row of Object.values(result.activities)) {
        start = Math.min(start, Date.parse(row.earlyStart));
        finish = Math.max(finish, Date.parse(row.earlyFinish));
      }
    return { start, width: Math.max(86_400_000, finish - start) };
  }, [input.project.plannedStart, result]);
  return (
    <>
      <p className="tableNote">
        {visibleActivityCount.toLocaleString()} of {input.activities.length.toLocaleString()}{" "}
        activities · {projection?.available ? `${projection.groupCount} WBS groups · ` : ""}Dates in
        UTC · {result ? "Calculated dates" : "Save and recalculate to show dates"}
      </p>
      {rows.length > VISIBLE_ROWS ? (
        <nav className="tableNavigation" aria-label="Activity range controls">
          <button
            type="button"
            disabled={scrollTop === 0}
            onClick={() => {
              scroll.current?.scrollTo({ top: Math.max(0, first - VISIBLE_ROWS) * ROW_HEIGHT });
            }}
          >
            Previous activities
          </button>
          <span role="status">
            Showing {first + 1}–{Math.min(rows.length, first + visible.length)} of {rows.length}
          </span>
          <button
            type="button"
            disabled={atEnd}
            onClick={() => {
              scroll.current?.scrollTo({ top: (first + VISIBLE_ROWS + 3) * ROW_HEIGHT });
            }}
          >
            Next activities
          </button>
        </nav>
      ) : null}
      <section
        className="activityScroll"
        ref={scroll}
        onScroll={(event) => {
          const node = event.currentTarget;
          setScrollTop(node.scrollTop);
          setAtEnd(node.scrollTop + node.clientHeight >= node.scrollHeight - 1);
        }}
        aria-label="Activity table and synchronized Gantt"
      >
        <table aria-label="Activities" aria-rowcount={rows.length + 1}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Activity</th>
              <th scope="col">Minutes</th>
              <th scope="col">Type</th>
              <th scope="col">WBS</th>
              <th scope="col">Calendar</th>
              <th scope="col">Early start</th>
              <th scope="col">Early finish</th>
              <th scope="col">Float</th>
              <th scope="col" className="ganttHeading">
                Gantt · critical / planned
              </th>
              <th scope="col">
                <span className="srOnly">Actions</span>
              </th>
            </tr>
          </thead>
          {first > 0 ? (
            <tbody aria-hidden="true">
              <tr className="spacer">
                <td colSpan={11} style={{ height: first * ROW_HEIGHT }} />
              </tr>
            </tbody>
          ) : null}
          <tbody>
            {visible.map((row, index) => {
              if (row.kind === "group")
                return (
                  <tr key={row.key} className="wbsGroupRow" aria-rowindex={first + index + 2}>
                    <th scope="row" colSpan={11}>
                      WBS {row.wbsCode} · {row.wbsName} · {row.activityCount} activities
                    </th>
                  </tr>
                );
              const activity = activitiesById.get(row.activityId);
              if (!activity) return null;
              const dates = result?.activities[activity.id];
              const left = dates
                ? ((Date.parse(dates.earlyStart) - range.start) / range.width) * 100
                : 0;
              const width = dates
                ? Math.max(
                    0.7,
                    ((Date.parse(dates.earlyFinish) - Date.parse(dates.earlyStart)) / range.width) *
                      100,
                  )
                : 0;
              const label = `Activity ${row.displayOrdinal}`;
              return (
                <tr key={activity.id} aria-rowindex={first + index + 2}>
                  <td className="rowNumber">{row.displayOrdinal}</td>
                  <td>
                    <input
                      aria-label={`${label} name`}
                      value={activity.name}
                      disabled={!editable}
                      maxLength={500}
                      onChange={(event) => onEdit(activity.id, { name: event.target.value })}
                    />
                  </td>
                  <td>
                    <DurationEditor
                      label={`${label} duration in minutes`}
                      value={activity.durationMinutes}
                      draft={durationDrafts?.get(activity.id)}
                      editable={editable && activity.kind === "TASK"}
                      onCommit={(durationMinutes) => onEdit(activity.id, { durationMinutes })}
                      onDraft={(raw) => onDurationDraft?.(activity.id, raw)}
                    />
                  </td>
                  <td>
                    <select
                      aria-label={`${label} type`}
                      value={activity.kind}
                      disabled={!editable}
                      onChange={(event) =>
                        onEdit(activity.id, {
                          kind: event.target.value as ActivityInputV1["kind"],
                          ...(event.target.value !== "TASK" ? { durationMinutes: 0 } : {}),
                        })
                      }
                    >
                      <option value="TASK">Task</option>
                      <option value="START_MILESTONE">Start milestone</option>
                      <option value="FINISH_MILESTONE">Finish milestone</option>
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`${label} WBS`}
                      value={activity.wbsId}
                      disabled={!editable}
                      onChange={(event) => onEdit(activity.id, { wbsId: event.target.value })}
                    >
                      {input.wbs.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.code} · {node.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`${label} calendar`}
                      value={activity.calendarId}
                      disabled={!editable}
                      onChange={(event) => onEdit(activity.id, { calendarId: event.target.value })}
                    >
                      {input.calendars.map((calendar) => (
                        <option key={calendar.id} value={calendar.id}>
                          {calendar.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="dateCell">{displayInstant(dates?.earlyStart)}</td>
                  <td className="dateCell">{displayInstant(dates?.earlyFinish)}</td>
                  <td>
                    {dates ? (
                      <span className={dates.critical ? "criticalText" : ""}>
                        {dates.totalFloatMinutes}
                        {dates.critical ? " · critical" : ""}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="ganttCell">
                    {dates ? (
                      <div
                        className={`ganttBar ${dates.critical ? "criticalBar" : ""}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={`${activity.name}: ${displayInstant(dates.earlyStart)} — ${displayInstant(dates.earlyFinish)}`}
                      >
                        <span className="srOnly">
                          {dates.critical ? "Critical" : "Planned"} activity
                        </span>
                      </div>
                    ) : (
                      <span className="muted">Awaiting calculation</span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="iconButton"
                      disabled={!editable}
                      aria-label={`Delete ${label.toLowerCase()}`}
                      onClick={() => onDelete(activity.id)}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {first + visible.length < rows.length ? (
            <tbody aria-hidden="true">
              <tr className="spacer">
                <td
                  colSpan={11}
                  style={{ height: (rows.length - first - visible.length) * ROW_HEIGHT }}
                />
              </tr>
            </tbody>
          ) : null}
        </table>
        {rows.length === 0 ? (
          <div className="emptyTable">
            {projection === null
              ? "Verifying presentation…"
              : projection !== undefined && !projection.available
                ? projection.reason === "reference_stale"
                  ? "This view references an unavailable WBS. Choose a current WBS or use Native."
                  : projection.error === "view_result_required"
                    ? "This view needs a verified current saved calculation. Save/recalculate your schedule or use an input-only presentation."
                    : "This presentation is unavailable. Use Native to inspect and repair the draft."
                : input.activities.length
                  ? "No matching activities."
                  : "Add your first activities to begin planning."}
          </div>
        ) : null}
      </section>
    </>
  );
}
