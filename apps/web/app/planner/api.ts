export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const messages: Record<string, string> = {
  session_changed: "Your sign-in changed in another tab. Sign in again to open a workspace.",
  invalid_credentials: "Email or password is incorrect.",
  too_many_attempts: "Too many sign-in attempts. Wait a few minutes before trying again.",
  unauthenticated: "Your session has ended. Sign in again.",
  forbidden: "Your account does not have permission for this action.",
  revision_conflict:
    "This project changed elsewhere. Reload the saved version before reapplying your edits.",
  duplicate_value: "That code or relationship already exists.",
  slug_unavailable: "That organization address is already in use.",
  invalid_reference_or_value:
    "A selected item no longer exists or is invalid. Reload the saved version.",
  schedule_busy: "Calculation capacity is busy. Try again shortly.",
  schedule_already_running: "A calculation is already running for this project.",
  temporarily_unavailable: "The service is temporarily unavailable. Try again shortly.",
  mfa_required:
    "Your organization requires multi-factor authentication. Contact your administrator.",
};

let binding: { id: string; csrf: string | undefined } | null = null;
let generation = 0;
const authChannel = "engineo-auth-change";
const tabId = typeof window === "undefined" ? "server" : crypto.randomUUID();
const csrfCookie = () =>
  document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith("engineo_csrf="))
    ?.slice(13);
export const sessionCookieFingerprint = () => csrfCookie();

export function bindSession(id: string): void {
  binding = { id, csrf: csrfCookie() };
  generation++;
}
export function clearSessionBinding(): void {
  binding = null;
  generation++;
}
export const sessionGeneration = () => generation;
export const currentSessionId = () => binding?.id;
export function sessionCookieChanged(): boolean {
  return binding !== null && binding.csrf !== csrfCookie();
}
type SessionChange = "login" | "logout";
export function announceSessionChange(change: SessionChange): void {
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(authChannel);
    channel.postMessage({ source: tabId, type: "session-change", change });
    channel.close();
  }
}
export function subscribeSessionChanges(changed: (change: SessionChange) => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const channel = new BroadcastChannel(authChannel);
  channel.onmessage = (event) => {
    if (
      event.data?.type === "session-change" &&
      event.data.source !== tabId &&
      (event.data.change === "login" || event.data.change === "logout")
    )
      changed(event.data.change);
  };
  return () => channel.close();
}

function changedSession(): ApiError {
  return new ApiError(409, "session_changed", messages.session_changed ?? "Sign-in changed.");
}
export async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal | undefined;
    sessionBound?: boolean;
  } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  const expected = options.sessionBound === false || path === "/auth/login" ? null : binding;
  const startedGeneration = generation;
  const startedCsrf = csrfCookie();
  const assertCurrent = (allowClearedLogoutCookie = false) => {
    if (generation !== startedGeneration) throw changedSession();
    const currentCsrf = csrfCookie();
    const original = expected?.csrf ?? startedCsrf;
    if (path !== "/auth/login" && currentCsrf !== original) {
      if (allowClearedLogoutCookie && currentCsrf === undefined) return;
      if (currentCsrf === undefined)
        throw new ApiError(401, "unauthenticated", messages.unauthenticated ?? "Session ended.");
      throw changedSession();
    }
  };
  assertCurrent();
  if (expected) headers["X-Engineo-Session"] = expected.id;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") {
    const token = expected?.csrf ?? startedCsrf;
    if (token) headers["X-CSRF-Token"] = token;
  }
  const response = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: options.signal ?? null,
  });
  assertCurrent(path === "/auth/logout" && response.status === 204);
  if (
    expected &&
    response.headers.get("X-Engineo-Session") !== null &&
    response.headers.get("X-Engineo-Session") !== expected.id
  )
    throw changedSession();
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    assertCurrent();
    const code: string = body.error ?? "request_failed";
    const issue = body.issues?.[0];
    throw new ApiError(
      response.status,
      code,
      messages[code] ??
        (issue
          ? `${issue.path}: ${issue.message}`
          : (body.message ?? `Request failed (${response.status}).`)),
    );
  }
  options.signal?.throwIfAborted();
  if (response.status === 204) return undefined as T;
  const data = (await response.json()) as T;
  assertCurrent();
  options.signal?.throwIfAborted();
  return data;
}
