import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseExecutor } from "../db/client.js";

export interface SessionPrincipal {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string | null;
  expiresAt: Date;
}

export interface IssuedSession {
  principal: SessionPrincipal;
  token: string;
  csrfToken: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function equalHex(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export async function issueSession(
  db: DatabaseExecutor,
  userId: string,
  email: string,
  displayName: string | null,
  userAgent: string | undefined,
  ttlSeconds = 60 * 60 * 12,
): Promise<IssuedSession> {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const userAgentHash = userAgent ? sha256Hex(userAgent) : null;

  await db`
    INSERT INTO auth_sessions (
      id, user_id, token_hash_sha256, csrf_hash_sha256,
      user_agent_hash_sha256, expires_at
    )
    VALUES (
      ${sessionId}, ${userId}, ${sha256Hex(token)}, ${sha256Hex(csrfToken)},
      ${userAgentHash}, ${expiresAt.toISOString()}
    )
  `;

  return {
    principal: {
      sessionId,
      userId,
      email,
      displayName,
      expiresAt,
    },
    token,
    csrfToken,
  };
}

export async function resolveSession(
  db: DatabaseExecutor,
  token: string,
): Promise<SessionPrincipal | null> {
  const tokenHash = sha256Hex(token);
  const rows = await db`
    SELECT
      s.id AS session_id,
      s.user_id,
      s.expires_at,
      u.email,
      u.display_name
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash_sha256 = ${tokenHash}
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    return null;
  }

  await db`
    UPDATE auth_sessions
    SET last_seen_at = now()
    WHERE id = ${String(row.session_id)}
  `;

  return {
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    email: String(row.email),
    displayName: row.display_name === null ? null : String(row.display_name),
    expiresAt: new Date(String(row.expires_at)),
  };
}

export async function validateCsrf(
  db: DatabaseExecutor,
  sessionId: string,
  csrfToken: string,
): Promise<boolean> {
  const rows = await db`
    SELECT csrf_hash_sha256
    FROM auth_sessions
    WHERE id = ${sessionId}
      AND revoked_at IS NULL
      AND expires_at > now()
    LIMIT 1
  `;
  const expected = rows[0]?.csrf_hash_sha256;
  if (typeof expected !== "string") {
    return false;
  }

  return equalHex(expected, sha256Hex(csrfToken));
}

export async function revokeSession(db: DatabaseExecutor, sessionId: string): Promise<void> {
  await db`
    UPDATE auth_sessions
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE id = ${sessionId}
  `;
}
