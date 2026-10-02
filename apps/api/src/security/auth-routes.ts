import type { FastifyInstance } from "fastify";
import type { Database } from "../db/client.js";
import { appendAuditEvent } from "./audit.js";
import { credentialByEmail, membershipsForUser } from "./auth-repository.js";
import { clearSessionCookies, issuedSessionCookies } from "./cookies.js";
import { consumePasswordWork, verifyPassword } from "./password.js";
import {
  LOGIN_ACCOUNT_LIMIT,
  LOGIN_IP_LIMIT,
  LOGIN_WINDOW_MS,
  type LoginRateLimiter,
  PasswordWorkGate,
} from "./rate-limit.js";
import { requireAllowedOrigin, requireCsrf, requireSession } from "./request-auth.js";
import { issueSession, revokeSession } from "./session.js";

interface LoginBody {
  email: string;
  password: string;
}

function secureCookies(): boolean {
  if (process.env.COOKIE_SECURE === "false") {
    return false;
  }
  return process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true";
}

function sessionTtlSeconds(): number {
  const configured = process.env.SESSION_TTL_SECONDS;
  if (!configured) {
    return 60 * 60 * 12;
  }

  const parsed = Number.parseInt(configured, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 300 || parsed > 60 * 60 * 24 * 30) {
    throw new Error("SESSION_TTL_SECONDS must be between 300 and 2592000");
  }
  return parsed;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  db: Database,
  limiter: LoginRateLimiter,
): void {
  const workGate = new PasswordWorkGate();

  app.post<{ Body: LoginBody }>(
    "/auth/login",
    {
      config: { rateLimit: { max: LOGIN_IP_LIMIT, timeWindow: LOGIN_WINDOW_MS } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "password"],
          properties: {
            email: { type: "string", minLength: 3, maxLength: 320 },
            password: { type: "string", minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!requireAllowedOrigin(request, reply)) {
        return;
      }

      const email = request.body.email.trim().toLowerCase();
      let limit: { current: number; ttl: number };
      try {
        limit = await limiter.consume(`account:${email}`, LOGIN_ACCOUNT_LIMIT);
      } catch {
        await reply.header("Retry-After", "1").code(503).send({ error: "login_unavailable" });
        return;
      }
      if (limit.current > LOGIN_ACCOUNT_LIMIT) {
        reply.header("Retry-After", String(Math.ceil(limit.ttl / 1000)));
        await reply.code(429).send({
          error: "too_many_attempts",
        });
        return;
      }

      const release = workGate.acquire();
      if (!release) {
        await reply.header("Retry-After", "1").code(503).send({ error: "login_busy" });
        return;
      }

      try {
        const credential = await credentialByEmail(db, email);
        if (!credential) {
          await consumePasswordWork(request.body.password);
          await reply.code(401).send({
            error: "invalid_credentials",
          });
          return;
        }

        const valid = await verifyPassword(request.body.password, credential.passwordHash);
        if (!valid) {
          await reply.code(401).send({
            error: "invalid_credentials",
          });
          return;
        }

        if (credential.mfaRequired) {
          await reply.code(403).send({
            error: "mfa_required",
            enrolled: credential.mfaEnrolled,
          });
          return;
        }

        const ttlSeconds = sessionTtlSeconds();
        const { issued, memberships } = await db.begin(async (sql) => {
          const issued = await issueSession(
            sql,
            credential.userId,
            credential.email,
            credential.displayName,
            request.headers["user-agent"],
            ttlSeconds,
          );
          const memberships = await membershipsForUser(sql, credential.userId);
          for (const membership of memberships) {
            await appendAuditEvent(sql, {
              organizationId: membership.organizationId,
              actorType: "user",
              actorId: credential.userId,
              action: "auth.login",
              resourceType: "session",
              resourceId: issued.principal.sessionId,
              source: "api",
              correlationId: request.id,
              payload: {},
            });
          }
          return { issued, memberships };
        });
        reply.header(
          "Set-Cookie",
          issuedSessionCookies(issued, {
            secure: secureCookies(),
            maxAgeSeconds: ttlSeconds,
          }),
        );
        reply.header("Cache-Control", "no-store");

        await reply.send({
          user: {
            id: credential.userId,
            email: credential.email,
            displayName: credential.displayName,
          },
          memberships,
        });
      } finally {
        release();
      }
    },
  );

  app.get("/auth/me", async (request, reply) => {
    const principal = await requireSession(db, request, reply);
    if (!principal) {
      return;
    }

    reply.header("Cache-Control", "no-store");
    await reply.send({
      user: {
        id: principal.userId,
        email: principal.email,
        displayName: principal.displayName,
      },
      memberships: await membershipsForUser(db, principal.userId),
    });
  });

  app.post("/auth/logout", async (request, reply) => {
    if (!requireAllowedOrigin(request, reply)) {
      return;
    }

    const principal = await requireSession(db, request, reply);
    if (!principal || !(await requireCsrf(db, request, reply, principal))) {
      return;
    }

    await db.begin(async (sql) => {
      const firstRevocation = await revokeSession(sql, principal.sessionId);
      if (!firstRevocation) return;
      const memberships = await membershipsForUser(sql, principal.userId);

      for (const membership of memberships) {
        await appendAuditEvent(sql, {
          organizationId: membership.organizationId,
          actorType: "user",
          actorId: principal.userId,
          action: "auth.logout",
          resourceType: "session",
          resourceId: principal.sessionId,
          source: "api",
          correlationId: request.id,
          payload: {},
        });
      }
    });

    reply.header("Set-Cookie", clearSessionCookies(secureCookies()));
    reply.header("Cache-Control", "no-store");
    await reply.code(204).send();
  });
}
