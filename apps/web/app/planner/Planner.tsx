"use client";

import {
  ACTIVITY_CSV_MAX_BYTES,
  type ActivityCsvPreviewV1,
  type ActivityInputV1,
  type CalendarV1,
  ENGINE_TIME_ZONES,
  type EngineProjectInputV1,
  type EngineScheduleResultV1,
  type RelationshipInputV1,
  type ScheduleCalculationMetadataV1,
  serializeScheduleInputV1,
  validateScheduleInputV1,
  WEEKDAYS,
} from "@engineo/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ActivityTable, { displayInstant } from "./ActivityTable";
import {
  ApiError,
  announceSessionChange,
  api,
  bindSession,
  clearSessionBinding,
  currentSessionId,
  sessionCookieChanged,
  sessionCookieFingerprint,
  sessionGeneration,
  subscribeSessionChanges,
} from "./api";
import { type CalculationSnapshot, matchesStoredCalculation } from "./saved-calculation";

type Organization = { id: string; name: string; slug: string; role: string };
type Project = {
  id: string;
  name: string;
  code: string | null;
  revision: number;
  updatedAt: string;
};
type Snapshot = { revision: number; input: EngineProjectInputV1 };
type Permissions = { write: boolean; scheduleRun: boolean };
type User = { id: string; email: string };
type Recovery = { userId: string; organizationId: string; snapshot: Snapshot };
type Panel =
  | "Activities"
  | "WBS"
  | "Relationships"
  | "Calendars"
  | "Constraints"
  | "Schedule"
  | "Import CSV";
const panels: Panel[] = [
  "Activities",
  "WBS",
  "Relationships",
  "Calendars",
  "Constraints",
  "Schedule",
  "Import CSV",
];
const utcInput = (value: string) => new Date(value).toISOString().slice(0, 16);
const utcInstant = (value: string) => `${value}:00Z`;
function nextWbsCode(nodes: EngineProjectInputV1["wbs"]): string {
  const used = new Set(nodes.map((node) => node.code));
  let next = 1;
  while (used.has(`1.${next}`)) next++;
  return `1.${next}`;
}

export default function Planner() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [permissions, setPermissions] = useState<Permissions>({ write: false, scheduleRun: false });
  const [result, setResult] = useState<EngineScheduleResultV1 | null>(null);
  const [calculation, setCalculation] = useState<ScheduleCalculationMetadataV1 | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const lock = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const initialization = useRef<AbortController | null>(null);
  const verification = useRef<AbortController | null>(null);
  const verifySession = useRef<() => void>(() => {});
  const recovery = useRef<Recovery | null>(null);
  const operationDraft = useRef<Recovery | null>(null);
  const [hasRecovery, setHasRecovery] = useState(false);
  const recoveryCookie = useRef<string | undefined>(undefined);
  const errorRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [panel, setPanel] = useState<Panel>("Activities");
  const [filter, setFilter] = useState("");
  const [count, setCount] = useState(1);
  const [constraintActivity, setConstraintActivity] = useState("");
  const [calendarId, setCalendarId] = useState("");
  const [csvFile, setCsvFile] = useState<{ name: string; text: string } | null>(null);
  const [csvPreview, setCsvPreview] = useState<ActivityCsvPreviewV1 | null>(null);
  const [csvPage, setCsvPage] = useState(0);
  const csvPreviewRef = useRef<HTMLElement>(null);
  const input = snapshot?.input;
  const activitiesById = useMemo(
    () => new Map(input?.activities.map((activity) => [activity.id, activity]) ?? []),
    [input?.activities],
  );
  const selectedConstraintActivity = activitiesById.has(constraintActivity)
    ? constraintActivity
    : (input?.activities[0]?.id ?? "");
  const editable = permissions.write && !busy;
  const canStopRequest =
    busy === "Saving and calculating" || busy === "Previewing CSV" || busy === "Applying CSV";
  const projectPath = input ? `/organizations/${organizationId}/projects/${input.project.id}` : "";
  const currentState = useRef({ user, organizationId, snapshot, dirty });
  currentState.current = { user, organizationId, snapshot, dirty };

  const clearWorkspace = useCallback(() => {
    setOrganizations([]);
    setOrganizationId("");
    setProjects([]);
    setSnapshot(null);
    setPermissions({ write: false, scheduleRun: false });
    setResult(null);
    setCalculation(null);
    setDirty(false);
    setCalendarId("");
    setConstraintActivity("");
    setFilter("");
    setPanel("Activities");
    setCsvFile(null);
    setCsvPreview(null);
  }, []);

  const invalidateAccount = useCallback(
    (recoverDraft: boolean, message: string) => {
      const state = currentState.current;
      const draft = operation.current
        ? operationDraft.current
        : state.user && state.snapshot && state.dirty
          ? {
              userId: state.user.id,
              organizationId: state.organizationId,
              snapshot: state.snapshot,
            }
          : null;
      if (recoverDraft && draft) {
        recovery.current = draft;
        setHasRecovery(true);
      } else if (!recoverDraft) {
        recovery.current = null;
        setHasRecovery(false);
        window.history.replaceState(null, "", "/");
      }
      recoveryCookie.current = sessionCookieFingerprint();
      initialization.current?.abort();
      verification.current?.abort();
      verification.current = null;
      operation.current?.abort();
      operation.current = null;
      operationDraft.current = null;
      lock.current = false;
      clearSessionBinding();
      currentState.current = { user: null, organizationId: "", snapshot: null, dirty: false };
      setUser(null);
      clearWorkspace();
      setBusy("");
      setNotice("");
      setReady(true);
      setError(message);
    },
    [clearWorkspace],
  );

  const loadProjects = useCallback(async (id: string, signal?: AbortSignal) => {
    const data = await api<{ projects: Project[] }>(`/organizations/${id}/projects`, { signal });
    signal?.throwIfAborted();
    setProjects(data.projects);
  }, []);
  const openProject = useCallback(async (org: string, id: string, signal?: AbortSignal) => {
    const path = `/organizations/${org}/projects/${id}`;
    let resultReadError: string | null = null;
    const [loaded, detail, saved] = await Promise.all([
      api<Snapshot>(`${path}/schedule`, { signal }),
      api<{ permissions: Permissions }>(path, { signal }),
      api<CalculationSnapshot>(`${path}/schedule/result`, { signal }).catch((error) => {
        if (
          signal?.aborted ||
          (error instanceof ApiError && [401, 403, 404, 409].includes(error.status))
        )
          throw error;
        if (error instanceof ApiError && error.code.startsWith("schedule_"))
          resultReadError = error.message;
        // A transient optional result-read failure does not hide the saved plan.
        return null;
      }),
    ]);
    const matched = saved ? await matchesStoredCalculation(saved, loaded) : false;
    signal?.throwIfAborted();
    if (sessionCookieChanged())
      throw new ApiError(409, "session_changed", "Your sign-in changed. Sign in again.");
    setSnapshot(loaded);
    setCsvFile(null);
    setCsvPreview(null);
    setPermissions(detail.permissions);
    setResult(matched && saved ? saved.result : null);
    setCalculation(matched && saved ? saved.calculation : null);
    if (resultReadError) setError(resultReadError);
    if (!saved)
      setNotice("Saved calculation could not be loaded. Reload the saved version to try again.");
    else if (saved.revision !== loaded.revision)
      setNotice("The project changed while loading its calculation. Reload the saved version.");
    else if ((saved.result || saved.calculation) && !matched)
      setNotice(
        "Saved calculation could not be verified. Reload or recalculate before using dates.",
      );
    else if (matched && saved.result)
      setNotice(
        `Saved calculation restored · finish ${displayInstant(saved.result.projectFinish)} UTC`,
      );
    setDirty(false);
    setConstraintActivity(loaded.input.activities[0]?.id ?? "");
    setCalendarId(loaded.input.project.defaultCalendarId);
    setPanel("Activities");
    setFilter("");
    window.history.replaceState(null, "", `/?organization=${org}&project=${id}`);
    return { loaded, permissions: detail.permissions };
  }, []);
  const initialize = useCallback(
    async (signal?: AbortSignal) => {
      const me = await api<{ user: User; session: { id: string } }>("/auth/me", {
        signal,
        sessionBound: false,
      });
      signal?.throwIfAborted();
      bindSession(me.session.id);
      // A verified account switch permanently discards the previous account's
      // draft, even when subsequent organization/project loading fails.
      if (recovery.current && recovery.current.userId !== me.user.id) {
        recovery.current = null;
        setHasRecovery(false);
      }
      const data = await api<{ organizations: Organization[] }>("/organizations", { signal });
      signal?.throwIfAborted();
      clearWorkspace();
      setUser(me.user);
      setOrganizations(data.organizations);
      let draft = recovery.current?.userId === me.user.id ? recovery.current : null;
      const accessLost = () => {
        recovery.current = null;
        setHasRecovery(false);
        setNotice("Your edits could not be restored because your project access changed.");
        window.history.replaceState(null, "", "/");
      };
      if (draft && !data.organizations.some((org) => org.id === draft?.organizationId)) {
        accessLost();
        draft = null;
      }
      if (!draft) {
        recovery.current = null;
        setHasRecovery(false);
      }
      const query = new URLSearchParams(window.location.search);
      const selected =
        data.organizations.find(
          (org) => org.id === (draft?.organizationId ?? query.get("organization")),
        )?.id ??
        data.organizations[0]?.id ??
        "";
      setOrganizationId(selected);
      if (selected) {
        await loadProjects(selected, signal);
        const project = draft?.snapshot.input.project.id ?? query.get("project");
        if (project) {
          let current: Awaited<ReturnType<typeof openProject>>;
          try {
            current = await openProject(selected, project, signal);
          } catch (error) {
            if (draft && error instanceof ApiError && [403, 404].includes(error.status)) {
              accessLost();
              return;
            }
            throw error;
          }
          if (draft && selected === draft.organizationId) {
            if (current.permissions.write) {
              setSnapshot(draft.snapshot);
              setResult(null);
              setCalculation(null);
              setDirty(true);
              setCalendarId(draft.snapshot.input.project.defaultCalendarId);
              setConstraintActivity(draft.snapshot.input.activities[0]?.id ?? "");
              setNotice(
                current.loaded.revision === draft.snapshot.revision
                  ? "Your unsaved edits have been restored. Review them before saving."
                  : "Your edits have been restored, but the saved version changed. Copy your edits before reloading.",
              );
            } else
              setNotice("Your edits could not be restored because your project access changed.");
            recovery.current = null;
            setHasRecovery(false);
          }
        }
      }
    },
    [clearWorkspace, loadProjects, openProject],
  );
  useEffect(() => {
    const controller = new AbortController();
    initialization.current = controller;
    initialize(controller.signal)
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.code === "session_changed") {
          invalidateAccount(false, error.message);
        } else if (error instanceof ApiError && error.status === 401) {
          // An ordinary anonymous first visit stays quiet. Expiry after a
          // verified identity must clear the partly initialized workspace.
          if (currentSessionId() || currentState.current.user || recovery.current)
            invalidateAccount(true, error.message);
        } else setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setReady(true);
      });
    return () => {
      controller.abort();
      operation.current?.abort();
    };
  }, [initialize, invalidateAccount]);
  useEffect(() => {
    let disposed = false;
    const verify = async () => {
      const account = currentState.current.user;
      const pendingRecovery = recovery.current;
      if (
        verification.current ||
        operation.current ||
        (!account && !pendingRecovery) ||
        document.visibilityState !== "visible"
      )
        return;
      const controller = new AbortController();
      verification.current = controller;
      const deadline = window.setTimeout(() => controller.abort(), 5000);
      const started = sessionGeneration();
      const expected = currentSessionId();
      try {
        const me = await api<{ user: User; session: { id: string } }>("/auth/me", {
          sessionBound: false,
          signal: controller.signal,
        });
        if (!disposed && sessionGeneration() === started) {
          if (account && me.session.id !== expected)
            invalidateAccount(true, "Your sign-in changed in another tab. Sign in again.");
          const draft = recovery.current;
          if (draft && me.user.id !== draft.userId)
            invalidateAccount(false, "Your sign-in changed in another tab. Sign in again.");
          else recoveryCookie.current = sessionCookieFingerprint();
        }
      } catch (error) {
        if (disposed || sessionGeneration() !== started || verification.current !== controller)
          return;
        if (error instanceof ApiError && error.status === 401)
          invalidateAccount(true, "Your session has ended. Sign in again.");
        else if (error instanceof ApiError && error.code === "session_changed") {
          invalidateAccount(true, error.message);
          queueMicrotask(() => verifySession.current());
        } else if (!currentState.current.user)
          setError("Sign-in verification did not finish. Sign in again to continue.");
      } finally {
        window.clearTimeout(deadline);
        if (verification.current === controller) verification.current = null;
      }
    };
    const checkCookie = () => {
      if (currentState.current.user && sessionCookieChanged())
        invalidateAccount(true, "Your sign-in changed in another tab. Sign in again.");
    };
    const focused = () => {
      // A known changed binding clears visible data before any network probe.
      checkCookie();
      void verify();
    };
    const runVerification = () => void verify();
    verifySession.current = runVerification;
    const unsubscribe = subscribeSessionChanges((change) => {
      invalidateAccount(change === "login", "Your sign-in changed in another tab. Sign in again.");
      if (change === "login") void verify();
    });
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", focused);
    // Cookie comparison is local; it does not poll the database every second.
    const timer = window.setInterval(() => {
      if (
        (currentState.current.user && sessionCookieChanged()) ||
        (recovery.current && recoveryCookie.current !== sessionCookieFingerprint())
      )
        focused();
    }, 1000);
    return () => {
      disposed = true;
      verification.current?.abort();
      verification.current = null;
      if (verifySession.current === runVerification) verifySession.current = () => {};
      unsubscribe();
      window.removeEventListener("focus", focused);
      document.removeEventListener("visibilitychange", focused);
      window.clearInterval(timer);
    };
  }, [invalidateAccount]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (csvPreview) csvPreviewRef.current?.focus();
  }, [csvPreview]);
  useEffect(() => {
    if (!dirty && !hasRecovery) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, hasRecovery]);

  async function perform(
    label: string,
    action: (signal: AbortSignal) => Promise<unknown>,
    recoverDraft = true,
  ) {
    if (lock.current) return;
    initialization.current?.abort();
    initialization.current = null;
    verification.current?.abort();
    verification.current = null;
    setReady(true);
    lock.current = true;
    operationDraft.current =
      recoverDraft && user && snapshot && dirty
        ? { userId: user.id, organizationId, snapshot }
        : null;
    setBusy(label);
    setError("");
    setNotice("");
    const controller = new AbortController();
    operation.current = controller;
    try {
      await action(controller.signal);
    } catch (error) {
      if (operation.current !== controller) return;
      if (error instanceof ApiError && error.code === "session_changed") {
        invalidateAccount(recoverDraft, error.message);
        verifySession.current();
        return;
      }
      if (error instanceof ApiError && error.status === 401) {
        invalidateAccount(recoverDraft, error.message);
        return;
      }
      setError(
        error instanceof Error && error.name === "AbortError"
          ? "Request stopped. Reload the saved version to check its state before trying again."
          : error instanceof Error
            ? error.message
            : "The request failed. Try again.",
      );
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        operationDraft.current = null;
        lock.current = false;
        setBusy("");
      }
    }
  }
  function change(update: (input: EngineProjectInputV1) => EngineProjectInputV1) {
    if (!snapshot || !editable) return;
    setSnapshot((previous) =>
      previous ? { ...previous, input: update(previous.input) } : previous,
    );
    setDirty(true);
    setCsvPreview(null);
    setResult(null);
    setCalculation(null);
    setNotice("");
  }
  function editActivity(id: string, patch: Partial<ActivityInputV1>) {
    change((value) => ({
      ...value,
      activities: value.activities.map((activity) =>
        activity.id === id ? { ...activity, ...patch } : activity,
      ),
    }));
  }
  async function calculate(
    signal: AbortSignal,
    revision: number,
    expectedInput: EngineProjectInputV1,
  ) {
    let data: CalculationSnapshot;
    let recovered = false;
    try {
      data = await api<CalculationSnapshot>(`${projectPath}/schedule/run`, {
        method: "POST",
        body: { expectedRevision: revision },
        signal,
      });
    } catch (error) {
      if (
        error instanceof ApiError &&
        ["schedule_invalid_output", "schedule_result_conflict", "schedule_output_limit"].includes(
          error.code,
        )
      ) {
        setResult(null);
        setCalculation(null);
      }
      if (
        signal.aborted ||
        !(
          error instanceof TypeError ||
          error instanceof SyntaxError ||
          (error instanceof ApiError &&
            error.status >= 500 &&
            ["request_failed", "temporarily_unavailable", "internal_error"].includes(error.code))
        )
      )
        throw error;
      // An interrupted response may follow a committed calculation. Read its
      // authoritative state rather than silently issuing a second mutation.
      let saved: CalculationSnapshot;
      try {
        saved = await api<CalculationSnapshot>(`${projectPath}/schedule/result`, { signal });
      } catch (readError) {
        if (
          readError instanceof ApiError &&
          ["schedule_invalid_output", "schedule_result_conflict", "schedule_output_limit"].includes(
            readError.code,
          )
        ) {
          setResult(null);
          setCalculation(null);
        }
        if (
          readError instanceof ApiError &&
          ([401, 403, 404, 409].includes(readError.status) ||
            readError.code.startsWith("schedule_"))
        )
          throw readError;
        throw error;
      }
      if (!(await matchesStoredCalculation(saved, { revision, input: expectedInput }))) {
        setResult(null);
        setCalculation(null);
        throw error;
      }
      data = saved;
      recovered = true;
    }
    if (
      !(await matchesStoredCalculation(data, { revision, input: expectedInput })) ||
      !data.result
    ) {
      setResult(null);
      setCalculation(null);
      throw new Error(
        "Calculation could not be verified for this saved version. Reload the project.",
      );
    }
    signal.throwIfAborted();
    if (sessionCookieChanged())
      throw new ApiError(409, "session_changed", "Your sign-in changed. Sign in again.");
    setResult(data.result);
    setCalculation(data.calculation);
    setNotice(
      `${recovered ? "Recovered saved calculation" : "Schedule calculated"} · finish ${displayInstant(data.result.projectFinish)} UTC`,
    );
  }
  function saveAndCalculate() {
    if (!snapshot) return;
    void perform("Saving and calculating", async (signal) => {
      const validation = validateScheduleInputV1(snapshot.input);
      if (!validation.valid)
        throw new Error(
          validation.issues
            .slice(0, 3)
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join(" "),
        );
      let revision = snapshot.revision;
      if (dirty) {
        const saved = await api<{ revision: number }>(`${projectPath}/schedule`, {
          method: "PUT",
          body: { expectedRevision: revision, input: snapshot.input },
          signal,
        });
        revision = saved.revision;
        setSnapshot({ ...snapshot, revision });
        setDirty(false);
        operationDraft.current = null;
        setNotice("Edits saved.");
        await loadProjects(organizationId, signal);
      }
      // Always refresh before calculation, including retries after a confirmed
      // save whose response normalization/read was interrupted. v1 timestamps
      // and field order can differ between a draft and its persisted snapshot.
      const current = await api<Snapshot>(`${projectPath}/schedule`, { signal });
      signal.throwIfAborted();
      if (current.revision !== revision)
        throw new Error(
          "The project changed after saving. Reload the saved version before recalculating.",
        );
      setSnapshot(current);
      if (permissions.scheduleRun) await calculate(signal, revision, current.input);
    });
  }
  const discard = () =>
    !dirty || window.confirm("Discard your unsaved edits and load the saved version?");

  return (
    <main className="workspace">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Engineo home">
          <span className="mark" aria-hidden="true">
            E
          </span>
          <span>
            Engineo<span className="brandSub">PROJECT PLANNING & CONTROLS</span>
          </span>
        </a>
        <div className="account">
          {user ? (
            <>
              <span>{user.email}</span>
              <button
                type="button"
                disabled={!ready || Boolean(busy)}
                onClick={() => {
                  if (discard())
                    void perform(
                      "Signing out",
                      async (signal) => {
                        // Discard intent survives an expired session or failed logout.
                        recovery.current = null;
                        setHasRecovery(false);
                        operationDraft.current = null;
                        clearWorkspace();
                        try {
                          await api("/auth/logout", { method: "POST", signal });
                        } catch (error) {
                          if (!(error instanceof ApiError && error.code === "unauthenticated"))
                            throw error;
                        }
                        setUser(null);
                        clearSessionBinding();
                        announceSessionChange("logout");
                        window.history.replaceState(null, "", "/");
                      },
                      false,
                    );
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <span className="muted">Your project. Your data.</span>
          )}
        </div>
      </header>
      {error ? (
        <div className="errorBanner" role="alert" aria-label="Error" tabIndex={-1} ref={errorRef}>
          {error}
          <button type="button" aria-label="Dismiss error" onClick={() => setError("")}>
            ×
          </button>
        </div>
      ) : null}
      <div className="liveStatus" role="status" aria-live="polite">
        {busy || notice}
      </div>
      {!ready ? (
        <section className="loginPanel">
          <h1>Opening your workspace…</h1>
        </section>
      ) : !user ? (
        <section className="loginPanel">
          <div>
            <p className="eyebrow">PLAN WITH CONFIDENCE</p>
            <h1>
              Bring every
              <br />
              dependency into view.
            </h1>
            <p className="lede">
              Build a clear, connected project plan. See what drives your finish and keep every
              change accountable.
            </p>
            <div className="loginFeatures">
              <span>Calendar-aware schedules</span>
              <span>Connected activities</span>
              <span>Data you can export</span>
            </div>
          </div>
          <form
            className="signIn"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void perform("Signing in", async (signal) => {
                await api("/auth/login", {
                  method: "POST",
                  body: {
                    email: String(form.get("email")),
                    password: String(form.get("password")),
                  },
                  signal,
                });
                announceSessionChange("login");
                await initialize(signal);
              });
            }}
          >
            <p className="eyebrow">YOUR WORKSPACE</p>
            <h2>Sign in to Engineo</h2>
            {hasRecovery ? (
              <p className="muted">
                Your unsaved edits are kept in this tab. Sign in with the same account to restore
                them. A different account will discard them.
              </p>
            ) : null}
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                disabled={Boolean(busy)}
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                disabled={Boolean(busy)}
              />
            </label>
            <button className="primary" type="submit" disabled={Boolean(busy)}>
              Sign in
            </button>
            <p className="muted">Use the account provided by your organization.</p>
          </form>
        </section>
      ) : (
        <>
          <div className="workspaceHeading">
            <div>
              <p className="eyebrow">PROJECT WORKSPACE</p>
              <h1>{input?.project.name ?? "Your projects"}</h1>
            </div>
            <label className="organizationPicker">
              Organization
              <select
                aria-label="Organization"
                value={organizationId}
                disabled={Boolean(busy)}
                onChange={(event) => {
                  if (!discard()) return;
                  const id = event.target.value;
                  void perform("Opening organization", async (signal) => {
                    setOrganizationId(id);
                    setSnapshot(null);
                    setProjects([]);
                    setPermissions({ write: false, scheduleRun: false });
                    setDirty(false);
                    setResult(null);
                    setCalculation(null);
                    await loadProjects(id, signal);
                    window.history.replaceState(null, "", `/?organization=${id}`);
                  });
                }}
              >
                {organizations.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <nav className="projectStrip" aria-label="Projects">
            {projects.map((project) => (
              <button
                type="button"
                key={project.id}
                data-project-id={project.id}
                className={
                  input?.project.id === project.id ? "projectCard selectedProject" : "projectCard"
                }
                disabled={Boolean(busy)}
                onClick={() => {
                  if (discard())
                    void perform("Opening project", async (signal) =>
                      openProject(organizationId, project.id, signal),
                    );
                }}
              >
                <span className="projectCode">{project.code ?? "PROJECT"}</span>
                <strong>{project.name}</strong>
                <span>Revision {project.revision}</span>
              </button>
            ))}
            {projects.length === 0 ? (
              <p className="muted">Create a project to start planning.</p>
            ) : null}
          </nav>
          <div className="creationForms">
            <details>
              <summary>New organization</summary>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!discard()) return;
                  const form = new FormData(event.currentTarget);
                  void perform("Creating organization", async (signal) => {
                    const created = await api<Organization>("/organizations", {
                      method: "POST",
                      body: { name: String(form.get("name")), slug: String(form.get("slug")) },
                      signal,
                    });
                    setOrganizations((previous) => [...previous, created]);
                    setOrganizationId(created.id);
                    setProjects([]);
                    setSnapshot(null);
                    setDirty(false);
                    setResult(null);
                    setCalculation(null);
                    setNotice("Organization created.");
                  });
                }}
              >
                <label>
                  Organization name
                  <input name="name" required maxLength={500} />
                </label>
                <label>
                  Address
                  <input
                    name="slug"
                    required
                    pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]"
                    placeholder="my-organization"
                  />
                </label>
                <button type="submit" disabled={Boolean(busy)}>
                  Create organization
                </button>
              </form>
            </details>
            {organizationId &&
            organizations.find((org) => org.id === organizationId)?.role !== "viewer" ? (
              <details>
                <summary>New project</summary>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!discard()) return;
                    const form = new FormData(event.currentTarget);
                    void perform("Creating project", async (signal) => {
                      const created = await api<{ projectId: string }>(
                        `/organizations/${organizationId}/projects`,
                        {
                          method: "POST",
                          body: {
                            name: String(form.get("name")),
                            code: String(form.get("code")) || null,
                            plannedStart: utcInstant(String(form.get("start"))),
                            timeZone: String(form.get("zone")),
                          },
                          signal,
                        },
                      );
                      await loadProjects(organizationId, signal);
                      await openProject(organizationId, created.projectId, signal);
                      setNotice("Project created. Add your activities below.");
                    });
                  }}
                >
                  <label>
                    Project name
                    <input name="name" required maxLength={500} />
                  </label>
                  <label>
                    Code
                    <input name="code" maxLength={100} />
                  </label>
                  <label>
                    Planned start (UTC)
                    <input
                      name="start"
                      type="datetime-local"
                      defaultValue={new Date().toISOString().slice(0, 16)}
                      required
                    />
                  </label>
                  <label>
                    Working calendar time zone
                    <input
                      name="zone"
                      list="engine-time-zones"
                      defaultValue="UTC"
                      required
                      placeholder="Europe/London"
                    />
                  </label>
                  <button className="primary" type="submit" disabled={Boolean(busy)}>
                    Create project
                  </button>
                </form>
              </details>
            ) : null}
          </div>
          {input && snapshot ? (
            <section className="plannerPanel" aria-label="Project planner">
              <div className="plannerToolbar">
                <div className="revisionBadge">
                  Revision {snapshot.revision}
                  <span
                    className={`stableToolbarLabel ${dirty ? "unsaved" : "saved"}`}
                    data-stable-label="Unsaved edits"
                  >
                    <span>{dirty ? "Unsaved edits" : "Saved"}</span>
                  </span>
                  {!permissions.write ? <span>Read only</span> : null}
                </div>
                <div className="toolbarActions">
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (discard())
                        void perform("Reloading project", async (signal) =>
                          openProject(organizationId, input.project.id, signal),
                        );
                    }}
                  >
                    Reload saved version
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void perform("Exporting project", async (signal) => {
                        if (dirty) throw new Error("Save your edits before exporting the project.");
                        const data = await api<EngineProjectInputV1>(
                          `${projectPath}/schedule/export`,
                          { signal },
                        );
                        const href = URL.createObjectURL(
                          new Blob([serializeScheduleInputV1(data)], { type: "application/json" }),
                        );
                        const link = document.createElement("a");
                        link.href = href;
                        link.download = `engineo-${input.project.id}.json`;
                        link.click();
                        URL.revokeObjectURL(href);
                        setNotice("Project exported.");
                      })
                    }
                  >
                    Export JSON
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void perform("Exporting activities", async (signal) => {
                        if (dirty) throw new Error("Save your edits before exporting activities.");
                        const csv = await api<string>(`${projectPath}/activities/export`, {
                          signal,
                          responseType: "text",
                        });
                        const href = URL.createObjectURL(
                          new Blob([csv], { type: "text/csv;charset=utf-8" }),
                        );
                        const link = document.createElement("a");
                        link.href = href;
                        link.download = `engineo-${input.project.id}-activities.csv`;
                        link.click();
                        URL.revokeObjectURL(href);
                        setNotice("Saved activities exported as CSV.");
                      })
                    }
                  >
                    Export activities CSV
                  </button>
                  {permissions.write ? (
                    <button
                      type="button"
                      className="primary stableToolbarLabel"
                      data-stable-label="Save & recalculate"
                      disabled={Boolean(busy) || (!dirty && !permissions.scheduleRun)}
                      onClick={saveAndCalculate}
                    >
                      <span>{dirty ? "Save & recalculate" : "Recalculate"}</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="requestStop"
                    disabled={!canStopRequest}
                    aria-hidden={!canStopRequest}
                    tabIndex={canStopRequest ? undefined : -1}
                    onClick={() => operation.current?.abort()}
                  >
                    Stop request
                  </button>
                </div>
              </div>
              <div className="summaryStrip">
                <div>
                  <span>Activities</span>
                  <strong>{input.activities.length.toLocaleString()}</strong>
                </div>
                <div>
                  <span>Relationships</span>
                  <strong>{input.relationships.length.toLocaleString()}</strong>
                </div>
                <div>
                  <span>Data date · UTC</span>
                  <strong>{displayInstant(input.project.dataDate)}</strong>
                </div>
                <div>
                  <span>Calculated finish · UTC</span>
                  <strong>{displayInstant(result?.projectFinish)}</strong>
                </div>
              </div>
              <nav className="panelTabs" aria-label="Planner views">
                {panels.map((item) => (
                  <button
                    type="button"
                    key={item}
                    aria-current={panel === item ? "page" : undefined}
                    onClick={() => setPanel(item)}
                  >
                    {item}
                  </button>
                ))}
              </nav>
              {panel === "Import CSV" ? (
                <section className="csvPanel" aria-label="Activity CSV import">
                  <h2>Update activities from a spreadsheet</h2>
                  <p>
                    Export activities CSV, edit names, kinds, duration minutes, WBS IDs or calendar
                    IDs, then select the file below. Keep project and activity IDs unchanged.
                  </p>
                  <p>
                    Existing activities only. Omitted rows, constraints, relationships, calendars
                    and project settings stay unchanged. Use JSON for a complete project export.
                    UTF-8 CSV, up to 512 KiB and 10,000 rows per import.
                  </p>
                  {!permissions.write ? (
                    <p>
                      This project is read only. You can export activities; importing requires edit
                      access.
                    </p>
                  ) : (
                    <>
                      {dirty ? (
                        <p>Save or reload your unsaved edits before previewing an import.</p>
                      ) : null}
                      <label>
                        Activity CSV file
                        <input
                          type="file"
                          accept=".csv,text/csv"
                          disabled={!editable || dirty}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (!file) return;
                            void perform("Reading CSV", async (signal) => {
                              setCsvFile(null);
                              setCsvPreview(null);
                              setCsvPage(0);
                              if (file.size > ACTIVITY_CSV_MAX_BYTES)
                                throw new Error("CSV exceeds the 512 KiB limit.");
                              // Keep the BOM so the audit digest matches the original file bytes.
                              const text = new TextDecoder("utf-8", {
                                fatal: true,
                                ignoreBOM: true,
                              }).decode(await file.arrayBuffer());
                              signal.throwIfAborted();
                              setCsvFile({ name: file.name, text });
                            });
                          }}
                        />
                      </label>
                      {csvFile ? <p>Selected: {csvFile.name}</p> : null}
                      <button
                        type="button"
                        disabled={!editable || dirty || !csvFile}
                        onClick={() => {
                          if (!csvFile) return;
                          void perform("Previewing CSV", async (signal) => {
                            setCsvPreview(null);
                            const preview = await api<ActivityCsvPreviewV1>(
                              `${projectPath}/activities/import/preview`,
                              {
                                method: "POST",
                                body: { csv: csvFile.text, expectedRevision: snapshot.revision },
                                signal,
                              },
                            );
                            setCsvPage(0);
                            setCsvPreview(preview);
                          });
                        }}
                      >
                        Preview CSV changes
                      </button>
                      {csvPreview ? (
                        <section aria-label="CSV import preview" tabIndex={-1} ref={csvPreviewRef}>
                          <h3>Review before applying</h3>
                          <p>
                            {csvPreview.changedCount} changed · {csvPreview.unchangedCount}{" "}
                            unchanged · {csvPreview.omittedCount} omitted and preserved · saved
                            revision {csvPreview.expectedRevision}
                          </p>
                          {csvPreview.changedCount ? (
                            <>
                              <div className="csvChanges">
                                <table>
                                  <caption>
                                    Changes {csvPage * 50 + 1}–
                                    {Math.min((csvPage + 1) * 50, csvPreview.changedCount)} of{" "}
                                    {csvPreview.changedCount}
                                  </caption>
                                  <thead>
                                    <tr>
                                      <th>Activity</th>
                                      <th>Field</th>
                                      <th>Saved value</th>
                                      <th>Imported value</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {csvPreview.changes
                                      .slice(csvPage * 50, (csvPage + 1) * 50)
                                      .flatMap((change) =>
                                        (
                                          [
                                            "name",
                                            "kind",
                                            "durationMinutes",
                                            "wbsId",
                                            "calendarId",
                                          ] as const
                                        )
                                          .filter((key) => change.before[key] !== change.after[key])
                                          .map((key) => (
                                            <tr key={`${change.activityId}-${key}`}>
                                              <td>
                                                {change.before.name}
                                                <small>{change.activityId}</small>
                                              </td>
                                              <td>{key}</td>
                                              <td>{change.before[key]}</td>
                                              <td>{change.after[key]}</td>
                                            </tr>
                                          )),
                                      )}
                                  </tbody>
                                </table>
                              </div>
                              <div className="toolbarActions">
                                <button
                                  type="button"
                                  disabled={csvPage === 0 || Boolean(busy)}
                                  onClick={() => setCsvPage(csvPage - 1)}
                                >
                                  Previous changes
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    (csvPage + 1) * 50 >= csvPreview.changedCount || Boolean(busy)
                                  }
                                  onClick={() => setCsvPage(csvPage + 1)}
                                >
                                  Next changes
                                </button>
                                <button
                                  type="button"
                                  className="primary"
                                  disabled={!editable || dirty}
                                  onClick={() => {
                                    if (!csvFile) return;
                                    void perform("Applying CSV", async (signal) => {
                                      const applied = await api<{
                                        revision: number;
                                        changedCount: number;
                                      }>(`${projectPath}/activities/import/apply`, {
                                        method: "POST",
                                        body: {
                                          csv: csvFile.text,
                                          expectedRevision: csvPreview.expectedRevision,
                                          previewHash: csvPreview.previewHash,
                                        },
                                        signal,
                                      });
                                      setCsvFile(null);
                                      setCsvPreview(null);
                                      setResult(null);
                                      setCalculation(null);
                                      await openProject(organizationId, input.project.id, signal);
                                      await loadProjects(organizationId, signal);
                                      setNotice(
                                        `Imported ${applied.changedCount} activity changes at revision ${applied.revision}. Recalculate to update dates.`,
                                      );
                                    });
                                  }}
                                >
                                  Apply CSV changes
                                </button>
                              </div>
                            </>
                          ) : (
                            <p>No changes to apply.</p>
                          )}
                          <button
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => {
                              setCsvPreview(null);
                              setCsvFile(null);
                            }}
                          >
                            Cancel CSV import
                          </button>
                        </section>
                      ) : null}
                    </>
                  )}
                </section>
              ) : null}
              {panel === "Activities" ? (
                <div className="panelBody">
                  <div className="activityTools">
                    <label>
                      Find activities
                      <input
                        type="search"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                        placeholder="Search name or ID"
                      />
                    </label>
                    {permissions.write ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (
                            !input.wbs[0] ||
                            !Number.isInteger(count) ||
                            count < 1 ||
                            count > 1000 ||
                            input.activities.length + count > 10_000
                          ) {
                            setError(
                              "Add between 1 and 1,000 activities at a time, up to 10,000 per project.",
                            );
                            return;
                          }
                          const group = input.wbs[0];
                          change((value) => ({
                            ...value,
                            activities: [
                              ...value.activities,
                              ...Array.from(
                                { length: count },
                                (_, index): ActivityInputV1 => ({
                                  id: crypto.randomUUID(),
                                  name: `Activity ${value.activities.length + index + 1}`,
                                  wbsId: group.id,
                                  calendarId: value.project.defaultCalendarId,
                                  kind: "TASK",
                                  durationMinutes: 480,
                                  constraints: [],
                                }),
                              ),
                            ],
                          }));
                        }}
                      >
                        <label>
                          Number to add
                          <input
                            aria-label="Number of activities to add"
                            type="number"
                            min={1}
                            max={1000}
                            value={count}
                            onChange={(event) => setCount(Number(event.target.value))}
                            disabled={!editable}
                          />
                        </label>
                        <button type="submit" disabled={!editable}>
                          Add activities
                        </button>
                      </form>
                    ) : null}
                  </div>
                  <ActivityTable
                    input={input}
                    result={dirty ? null : result}
                    editable={editable}
                    filter={filter}
                    onEdit={editActivity}
                    onDelete={(id) =>
                      change((value) => ({
                        ...value,
                        activities: value.activities.filter((activity) => activity.id !== id),
                        relationships: value.relationships.filter(
                          (link) => link.predecessorId !== id && link.successorId !== id,
                        ),
                      }))
                    }
                  />
                </div>
              ) : null}
              {panel === "WBS" ? (
                <div className="panelBody">
                  <h2>Work breakdown structure</h2>
                  <p className="muted">
                    Group your activities and move each group under its parent.
                  </p>
                  <div className="editorList">
                    {input.wbs.map((node) => (
                      <div className="editorRow" key={node.id}>
                        <label>
                          Code
                          <input
                            aria-label={`WBS ${node.code} code`}
                            value={node.code}
                            disabled={!editable}
                            onChange={(event) =>
                              change((value) => ({
                                ...value,
                                wbs: value.wbs.map((item) =>
                                  item.id === node.id
                                    ? { ...item, code: event.target.value }
                                    : item,
                                ),
                              }))
                            }
                          />
                        </label>
                        <label>
                          Name
                          <input
                            aria-label={`WBS ${node.code} name`}
                            value={node.name}
                            disabled={!editable}
                            onChange={(event) =>
                              change((value) => ({
                                ...value,
                                wbs: value.wbs.map((item) =>
                                  item.id === node.id
                                    ? { ...item, name: event.target.value }
                                    : item,
                                ),
                              }))
                            }
                          />
                        </label>
                        <label>
                          Parent
                          <select
                            aria-label={`WBS ${node.code} parent`}
                            value={node.parentId ?? ""}
                            disabled={!editable}
                            onChange={(event) =>
                              change((value) => ({
                                ...value,
                                wbs: value.wbs.map((item) =>
                                  item.id === node.id
                                    ? { ...item, parentId: event.target.value || null }
                                    : item,
                                ),
                              }))
                            }
                          >
                            <option value="">Project level</option>
                            {input.wbs
                              .filter((item) => item.id !== node.id)
                              .map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.code} · {item.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          disabled={!editable || input.wbs.length < 2}
                          onClick={() => {
                            if (
                              input.activities.some((activity) => activity.wbsId === node.id) ||
                              input.wbs.some((item) => item.parentId === node.id)
                            ) {
                              setError(
                                "Move this group's activities and child groups before removing it.",
                              );
                              return;
                            }
                            change((value) => ({
                              ...value,
                              wbs: value.wbs.filter((item) => item.id !== node.id),
                            }));
                          }}
                        >
                          Remove group
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={!editable}
                    onClick={() =>
                      change((value) => ({
                        ...value,
                        wbs: [
                          ...value.wbs,
                          {
                            id: crypto.randomUUID(),
                            parentId: value.wbs[0]?.id ?? null,
                            code: nextWbsCode(value.wbs),
                            name: "New work package",
                            sortOrder: value.wbs.length,
                          },
                        ],
                      }))
                    }
                  >
                    Add WBS group
                  </button>
                </div>
              ) : null}
              {panel === "Relationships" ? (
                <div className="panelBody">
                  <h2>Activity relationships</h2>
                  <p className="muted">
                    Define how work connects. Positive lag delays; negative lag overlaps work, using
                    the selected lag calendar policy.
                  </p>
                  <form
                    className="inlineForm"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      const link: RelationshipInputV1 = {
                        predecessorId: String(form.get("predecessor")),
                        successorId: String(form.get("successor")),
                        type: String(form.get("type")) as RelationshipInputV1["type"],
                        lagMinutes: Number(form.get("lag")),
                      };
                      if (link.predecessorId === link.successorId) {
                        setError("Choose two different activities.");
                        return;
                      }
                      if (
                        input.relationships.some(
                          (item) =>
                            item.predecessorId === link.predecessorId &&
                            item.successorId === link.successorId &&
                            item.type === link.type,
                        )
                      ) {
                        setError(
                          "This relationship already exists. Remove it before replacing its lag.",
                        );
                        return;
                      }
                      change((value) => ({
                        ...value,
                        relationships: [...value.relationships, link],
                      }));
                    }}
                  >
                    <label>
                      Predecessor
                      <select name="predecessor" required disabled={!editable}>
                        {input.activities.map((activity) => (
                          <option key={activity.id} value={activity.id}>
                            {activity.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Successor
                      <select name="successor" required disabled={!editable}>
                        {input.activities.map((activity) => (
                          <option key={activity.id} value={activity.id}>
                            {activity.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Relationship type
                      <select name="type" disabled={!editable}>
                        <option>FS</option>
                        <option>SS</option>
                        <option>FF</option>
                        <option>SF</option>
                      </select>
                    </label>
                    <label>
                      Lag (working minutes)
                      <input
                        name="lag"
                        type="number"
                        step={1}
                        defaultValue={0}
                        disabled={!editable}
                      />
                    </label>
                    <button type="submit" disabled={!editable || input.activities.length < 2}>
                      Add relationship
                    </button>
                  </form>
                  <ul className="relationshipList">
                    {input.relationships.map((link, index) => (
                      <li
                        key={`${link.predecessorId}-${link.successorId}-${link.type}-${link.lagMinutes}`}
                      >
                        <span>
                          {activitiesById.get(link.predecessorId)?.name}{" "}
                          <strong>
                            {link.type} · {link.lagMinutes} min
                          </strong>{" "}
                          {activitiesById.get(link.successorId)?.name}
                        </span>
                        <button
                          type="button"
                          disabled={!editable}
                          onClick={() =>
                            change((value) => ({
                              ...value,
                              relationships: value.relationships.filter(
                                (_, item) => item !== index,
                              ),
                            }))
                          }
                        >
                          Remove relationship
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {panel === "Calendars" ? (
                <div className="panelBody">
                  <h2>Working calendars</h2>
                  <div className="inlineForm">
                    <label>
                      Calendar
                      <select
                        value={calendarId}
                        onChange={(event) => setCalendarId(event.target.value)}
                      >
                        {input.calendars.map((calendar) => (
                          <option key={calendar.id} value={calendar.id}>
                            {calendar.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={!editable}
                      onClick={() => {
                        const source = input.calendars.find(
                          (calendar) => calendar.id === calendarId,
                        );
                        if (!source) return;
                        const created = {
                          ...structuredClone(source),
                          id: crypto.randomUUID(),
                          name: `${source.name} copy`,
                        };
                        change((value) => ({ ...value, calendars: [...value.calendars, created] }));
                        setCalendarId(created.id);
                      }}
                    >
                      Copy calendar
                    </button>
                  </div>
                  {input.calendars
                    .filter((calendar) => calendar.id === calendarId)
                    .map((calendar) => (
                      <CalendarEditor
                        key={calendar.id}
                        calendar={calendar}
                        editable={editable}
                        onChange={(updated) =>
                          change((value) => ({
                            ...value,
                            calendars: value.calendars.map((item) =>
                              item.id === updated.id ? updated : item,
                            ),
                          }))
                        }
                      />
                    ))}
                </div>
              ) : null}
              {panel === "Constraints" ? (
                <div className="panelBody">
                  <h2>Activity constraints</h2>
                  <label>
                    Activity
                    <select
                      value={selectedConstraintActivity}
                      onChange={(event) => setConstraintActivity(event.target.value)}
                    >
                      {input.activities.map((activity) => (
                        <option key={activity.id} value={activity.id}>
                          {activity.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <form
                    className="inlineForm"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      const activity = input.activities.find(
                        (item) => item.id === selectedConstraintActivity,
                      );
                      if (!activity) return;
                      const constraint = {
                        type: String(
                          form.get("type"),
                        ) as ActivityInputV1["constraints"][number]["type"],
                        instant: utcInstant(String(form.get("instant"))),
                      };
                      if (
                        activity.constraints.some(
                          (item) =>
                            item.type === constraint.type && item.instant === constraint.instant,
                        )
                      ) {
                        setError("This constraint already exists.");
                        return;
                      }
                      editActivity(activity.id, {
                        constraints: [...activity.constraints, constraint],
                      });
                    }}
                  >
                    <label>
                      Constraint type
                      <select name="type" disabled={!editable}>
                        <option value="START_ON_OR_AFTER">Start on or after</option>
                        <option value="START_ON_OR_BEFORE">Start on or before</option>
                        <option value="FINISH_ON_OR_AFTER">Finish on or after</option>
                        <option value="FINISH_ON_OR_BEFORE">Finish on or before</option>
                      </select>
                    </label>
                    <label>
                      Date and time (UTC)
                      <input name="instant" type="datetime-local" required disabled={!editable} />
                    </label>
                    <button type="submit" disabled={!editable || !selectedConstraintActivity}>
                      Add constraint
                    </button>
                  </form>
                  <ul className="relationshipList">
                    {input.activities
                      .find((activity) => activity.id === selectedConstraintActivity)
                      ?.constraints.map((constraint, index) => (
                        <li key={`${constraint.type}-${constraint.instant}`}>
                          <span>
                            {constraint.type.replaceAll("_", " ")} ·{" "}
                            {displayInstant(constraint.instant)} UTC
                          </span>
                          <button
                            type="button"
                            disabled={!editable}
                            onClick={() => {
                              const activity = input.activities.find(
                                (item) => item.id === selectedConstraintActivity,
                              );
                              if (activity)
                                editActivity(activity.id, {
                                  constraints: activity.constraints.filter(
                                    (_, item) => item !== index,
                                  ),
                                });
                            }}
                          >
                            Remove constraint
                          </button>
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}
              {panel === "Schedule" ? (
                <div className="panelBody">
                  <h2>Schedule controls</h2>
                  {calculation ? (
                    <section className="muted" aria-label="Saved calculation provenance">
                      Saved calculation · revision {calculation.projectRevision} ·{" "}
                      {displayInstant(calculation.calculatedAt)} UTC · engine{" "}
                      {calculation.engineVersion}
                    </section>
                  ) : null}
                  <div className="controlGrid">
                    <label>
                      Project name
                      <input
                        value={input.project.name}
                        disabled={!editable}
                        onChange={(event) =>
                          change((value) => ({
                            ...value,
                            project: { ...value.project, name: event.target.value },
                          }))
                        }
                      />
                    </label>
                    <label>
                      Planned start (UTC)
                      <input
                        type="datetime-local"
                        value={utcInput(input.project.plannedStart)}
                        disabled={!editable}
                        onChange={(event) => {
                          if (event.target.value)
                            change((value) => ({
                              ...value,
                              project: {
                                ...value.project,
                                plannedStart: utcInstant(event.target.value),
                              },
                            }));
                        }}
                      />
                    </label>
                    <label>
                      Data date (UTC)
                      <input
                        type="datetime-local"
                        value={utcInput(input.project.dataDate)}
                        disabled={!editable}
                        onChange={(event) => {
                          if (event.target.value)
                            change((value) => ({
                              ...value,
                              project: {
                                ...value.project,
                                dataDate: utcInstant(event.target.value),
                              },
                            }));
                        }}
                      />
                    </label>
                    <label>
                      Default calendar
                      <select
                        value={input.project.defaultCalendarId}
                        disabled={!editable}
                        onChange={(event) =>
                          change((value) => ({
                            ...value,
                            project: { ...value.project, defaultCalendarId: event.target.value },
                          }))
                        }
                      >
                        {input.calendars.map((calendar) => (
                          <option key={calendar.id} value={calendar.id}>
                            {calendar.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Lag calendar
                      <select
                        value={input.scheduleOptions.lagCalendarPolicy}
                        disabled={!editable}
                        onChange={(event) =>
                          change((value) => ({
                            ...value,
                            scheduleOptions: {
                              ...value.scheduleOptions,
                              lagCalendarPolicy: event.target
                                .value as EngineProjectInputV1["scheduleOptions"]["lagCalendarPolicy"],
                            },
                          }))
                        }
                      >
                        <option>PREDECESSOR</option>
                        <option>SUCCESSOR</option>
                        <option>PROJECT</option>
                      </select>
                    </label>
                    <label>
                      Critical float threshold (minutes)
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={input.scheduleOptions.criticalFloatThresholdMinutes}
                        disabled={!editable}
                        onChange={(event) =>
                          change((value) => ({
                            ...value,
                            scheduleOptions: {
                              ...value.scheduleOptions,
                              criticalFloatThresholdMinutes: Number(event.target.value),
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      Project finish policy
                      <select
                        value={input.scheduleOptions.projectFinishPolicy}
                        disabled={!editable}
                        onChange={(event) =>
                          change((value) => ({
                            ...value,
                            scheduleOptions: {
                              ...value.scheduleOptions,
                              projectFinishPolicy: event.target
                                .value as EngineProjectInputV1["scheduleOptions"]["projectFinishPolicy"],
                            },
                          }))
                        }
                      >
                        <option value="CALCULATED">Calculated finish</option>
                        <option value="REQUIRED_FINISH">Required finish</option>
                      </select>
                    </label>
                    <label>
                      Required finish (UTC)
                      <input
                        type="datetime-local"
                        value={
                          input.project.requiredFinish ? utcInput(input.project.requiredFinish) : ""
                        }
                        disabled={!editable}
                        onChange={(event) =>
                          change((value) => ({
                            ...value,
                            project: {
                              ...value.project,
                              requiredFinish: event.target.value
                                ? utcInstant(event.target.value)
                                : null,
                            },
                          }))
                        }
                      />
                    </label>
                  </div>
                  {result ? (
                    <div className="diagnostics">
                      <h3>Schedule diagnostics</h3>
                      <p>
                        {result.constraintViolations.length} constraint violations · controlling
                        path {result.controllingPath.length} activities
                      </p>
                      {result.constraintViolations.map((violation) => (
                        <p
                          key={`${violation.activityId}-${violation.constraintType}-${violation.constraintInstant}`}
                        >
                          {
                            input.activities.find(
                              (activity) => activity.id === violation.activityId,
                            )?.name
                          }
                          : {violation.constraintType.replaceAll("_", " ")} at{" "}
                          {displayInstant(violation.constraintInstant)}; calculated{" "}
                          {displayInstant(violation.actualInstant)} UTC
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : (
            <section className="emptyWorkspace">
              <h2>A clear plan starts here.</h2>
              <p>
                Create or open a project to organize work, connect activities and calculate your
                schedule.
              </p>
            </section>
          )}
        </>
      )}
      <footer>
        Engineo · Every calculated date comes from your project inputs and working calendars.
      </footer>
      <datalist id="engine-time-zones">
        {ENGINE_TIME_ZONES.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>
    </main>
  );
}

function CalendarEditor({
  calendar,
  editable,
  onChange,
}: {
  calendar: CalendarV1;
  editable: boolean;
  onChange: (calendar: CalendarV1) => void;
}) {
  const [exceptionDate, setExceptionDate] = useState("");
  return (
    <>
      <div className="inlineForm">
        <label>
          Calendar name
          <input
            value={calendar.name}
            disabled={!editable}
            onChange={(event) => onChange({ ...calendar, name: event.target.value })}
          />
        </label>
        <label>
          IANA time zone
          <input
            value={calendar.timeZone}
            list="engine-time-zones"
            disabled={!editable}
            onChange={(event) => onChange({ ...calendar, timeZone: event.target.value })}
          />
        </label>
      </div>
      <p className="muted">
        Working times are local to this calendar. Separate multiple intervals with a comma, for
        example 08:00-12:00, 13:00-17:00. Leave nonworking days empty.
      </p>
      <div className="calendarWeek">
        {WEEKDAYS.map((day) => (
          <label key={day} htmlFor={`calendar-${calendar.id}-${day}`}>
            {day.toLowerCase()}
            <WorkingIntervalsInput
              id={`calendar-${calendar.id}-${day}`}
              label={`${day.toLowerCase()} working intervals`}
              editable={editable}
              intervals={calendar.week[day]}
              onChange={(values) =>
                onChange({ ...calendar, week: { ...calendar.week, [day]: values } })
              }
            />
          </label>
        ))}
      </div>
      <form
        className="inlineForm"
        onSubmit={(event) => {
          event.preventDefault();
          if (!exceptionDate || calendar.exceptions.some((item) => item.date === exceptionDate))
            return;
          onChange({
            ...calendar,
            exceptions: [...calendar.exceptions, { date: exceptionDate, workingIntervals: [] }],
          });
          setExceptionDate("");
        }}
      >
        <label>
          Nonworking exception date
          <input
            type="date"
            value={exceptionDate}
            disabled={!editable}
            onChange={(event) => setExceptionDate(event.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={!editable}>
          Add nonworking day
        </button>
      </form>
      <ul className="relationshipList">
        {calendar.exceptions.map((exception) => (
          <li key={exception.date}>
            <span>
              {exception.date} ·{" "}
              {exception.workingIntervals.length ? "Custom working day" : "Nonworking"}
            </span>
            <button
              type="button"
              disabled={!editable}
              onClick={() =>
                onChange({
                  ...calendar,
                  exceptions: calendar.exceptions.filter((item) => item.date !== exception.date),
                })
              }
            >
              Remove exception
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function WorkingIntervalsInput({
  id,
  label,
  editable,
  intervals,
  onChange,
}: {
  id: string;
  label: string;
  editable: boolean;
  intervals: CalendarV1["week"]["MONDAY"];
  onChange: (values: CalendarV1["week"]["MONDAY"]) => void;
}) {
  const formatted = intervals
    .map((interval) =>
      interval.end === "" && interval.start.includes("-")
        ? interval.start
        : `${interval.start}-${interval.end}`,
    )
    .join(", ");
  const invalid = intervals.some(
    ({ start, end }) =>
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(end) ||
      start >= end,
  );
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  return (
    <>
      <input
        id={id}
        aria-label={label}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        disabled={!editable}
        value={editing ? draft : formatted}
        onFocus={() => {
          setDraft(formatted);
          setEditing(true);
        }}
        onBlur={() => setEditing(false)}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          onChange(
            text
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean)
              .map((part) => {
                const parts = part.split("-");
                if (parts.length !== 2) return { start: part, end: "" };
                const [start, end] = parts;
                return { start: start ?? "", end: end ?? "" };
              }),
          );
        }}
      />
      {invalid ? (
        <span id={`${id}-error`} className="criticalText">
          Use HH:mm-HH:mm for each interval.
        </span>
      ) : null}
    </>
  );
}
