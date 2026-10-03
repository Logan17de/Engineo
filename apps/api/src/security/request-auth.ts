import type { FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/client.js";
import { CSRF_COOKIE, parseCookies, SESSION_COOKIE } from "./cookies.js";
import { resolveSession, type SessionPrincipal, validateCsrf } from "./session.js";

export async function requireSession(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionPrincipal | null> {
  const token = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
  if (!token) {
    await reply.code(401).send({
      error: "unauthenticated",
    });
    return null;
  }

  const principal = await resolveSession(db, token);
  if (!principal) {
    await reply.code(401).send({
      error: "unauthenticated",
    });
    return null;
  }

  // A Planner tab binds requests to the session whose identity it displays.
  // Shared browser cookies may have changed to a different session/account.
  // The binding is an intent check, never a replacement for cookie auth/RBAC.
  const expectedSession = request.headers["x-engineo-session"];
  if (expectedSession !== undefined && expectedSession !== principal.sessionId) {
    await reply.code(409).send({ error: "session_changed" });
    return null;
  }
  reply.header("X-Engineo-Session", principal.sessionId);

  return principal;
}

export async function requireCsrf(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply,
  principal: SessionPrincipal,
): Promise<boolean> {
  const cookies = parseCookies(request.headers.cookie);
  const cookieToken = cookies.get(CSRF_COOKIE);
  const headerToken = request.headers["x-csrf-token"];

  if (
    !cookieToken ||
    typeof headerToken !== "string" ||
    cookieToken !== headerToken ||
    !(await validateCsrf(db, principal.sessionId, headerToken))
  ) {
    await reply.code(403).send({
      error: "csrf_validation_failed",
    });
    return false;
  }

  return true;
}

export function requireAllowedOrigin(request: FastifyRequest, reply: FastifyReply): boolean {
  const expected = process.env.APP_ORIGIN;
  const origin = request.headers.origin;

  if (!expected || !origin) {
    return true;
  }

  if (origin !== expected) {
    void reply.code(403).send({
      error: "origin_not_allowed",
    });
    return false;
  }

  return true;
}
