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
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal | undefined } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") {
    const token = document.cookie
      .split("; ")
      .find((cookie) => cookie.startsWith("engineo_csrf="))
      ?.slice(13);
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
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
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
  options.signal?.throwIfAborted();
  return data;
}
