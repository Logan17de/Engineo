import type { Arguments, Destination } from "./arguments.js";
import { CliError, integrity, remoteError } from "./errors.js";
import { readDescriptor, readInput } from "./files.js";
import { exactKeys, parseJson, record, uuid } from "./json.js";

export interface SessionMaterial {
  schemaVersion: 1;
  kind: "engineo-cli-session";
  actorId: string;
  sessionId: string;
  sessionToken: string;
  csrfToken: string;
}
export async function loadSession(args: Arguments, signal: AbortSignal): Promise<SessionMaterial> {
  const text = args.values.has("auth-file")
    ? await readInput(args.values.get("auth-file") ?? "", 8192, signal, true)
    : await readDescriptor(Number(args.values.get("auth-fd")), 8192, signal);
  const value = parseJson(text, 8192);
  if (
    !record(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "kind",
      "actorId",
      "sessionId",
      "sessionToken",
      "csrfToken",
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== "engineo-cli-session" ||
    !uuid(value.actorId) ||
    !uuid(value.sessionId) ||
    !token(value.sessionToken) ||
    !token(value.csrfToken)
  )
    throw new CliError(
      "auth",
      "invalid_session_material",
      "Session material must use the documented private JSON v1 shape.",
    );
  return value as unknown as SessionMaterial;
}
function token(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
}
export class AmbiguousTransport extends CliError {
  constructor() {
    super("transport", "transport_failed", "Connection failed or exceeded the command deadline.");
  }
}

export class ApiClient {
  readonly secrets: string[];
  constructor(
    readonly target: Destination,
    readonly session: SessionMaterial,
    private readonly deadline: number,
    private readonly interruption: AbortSignal,
  ) {
    this.secrets = [session.sessionToken, session.csrfToken];
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
      throw new CliError(
        "usage",
        "insecure_tls_environment",
        "TLS verification cannot be disabled.",
      );
  }
  get projectPath(): string {
    return `/organizations/${this.target.organizationId}/projects/${this.target.projectId}`;
  }
  async verifyIdentity(): Promise<void> {
    const value = await this.request("GET", "/auth/me");
    if (
      !record(value) ||
      !record(value.session) ||
      !record(value.user) ||
      value.session.id !== this.session.sessionId ||
      value.user.id !== this.session.actorId
    )
      throw new CliError(
        "auth",
        "identity_mismatch",
        "Live session does not match the explicitly supplied actor and session.",
      );
  }
  async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    maxBytes = 16 * 1024 * 1024,
  ): Promise<unknown> {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") > 1024 * 1024)
      throw new CliError(
        "validation",
        "request_too_large",
        "Request envelope exceeds the API 1 MiB transport limit.",
      );
    const remaining = this.deadline - Date.now();
    if (remaining <= 0 || this.interruption.aborted) throw new AmbiguousTransport();
    const signal = AbortSignal.any([this.interruption, AbortSignal.timeout(remaining)]);
    let response: Response;
    try {
      response = await fetch(`${this.target.apiOrigin}${path}`, {
        method,
        redirect: "manual",
        signal,
        headers: {
          accept: "application/json",
          origin: this.target.appOrigin,
          cookie: `engineo_session=${this.session.sessionToken}; engineo_csrf=${this.session.csrfToken}`,
          "x-engineo-session": this.session.sessionId,
          ...(method === "POST"
            ? { "content-type": "application/json", "x-csrf-token": this.session.csrfToken }
            : {}),
        },
        ...(serialized === undefined ? {} : { body: serialized }),
      });
    } catch {
      throw new AmbiguousTransport();
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new CliError(
        "transport",
        "redirect_refused",
        "Redirects are refused; credentials were not forwarded.",
      );
    }
    const intent = response.headers.get("x-engineo-session");
    if (intent !== null && intent !== this.session.sessionId) {
      await response.body?.cancel();
      throw new CliError("auth", "session_changed", "API returned a different session identity.");
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
      await response.body?.cancel();
      throw new CliError(
        "integrity",
        "response_too_large",
        "API response exceeds the documented byte limit.",
      );
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (!response.body) integrity();
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new CliError(
            "integrity",
            "response_too_large",
            "API response exceeds the documented byte limit.",
          );
        }
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      // An explicit failed status is never converted into recoverable commit uncertainty.
      if (!response.ok) throw remoteError(response.status, null);
      throw new AmbiguousTransport();
    } finally {
      reader.releaseLock();
    }
    let value: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      value = parseJson(text, maxBytes);
    } catch {
      if (!response.ok) throw remoteError(response.status, null);
      return integrity();
    }
    if (!response.ok) throw remoteError(response.status, value);
    if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
      integrity();
    if (intent !== this.session.sessionId) integrity();
    return value;
  }
}
