import type { DatabaseExecutor } from "../db/client.js";

export interface CredentialRecord {
  userId: string;
  email: string;
  displayName: string | null;
  passwordHash: string;
  mfaRequired: boolean;
  mfaEnrolled: boolean;
}

export interface MembershipRecord {
  organizationId: string;
  organizationName: string;
  role: "owner" | "admin" | "planner" | "viewer";
}

export async function credentialByEmail(
  db: DatabaseExecutor,
  email: string,
): Promise<CredentialRecord | null> {
  const rows = await db`
    SELECT
      u.id AS user_id,
      u.email,
      u.display_name,
      c.password_hash,
      c.mfa_required,
      c.mfa_enrolled
    FROM users u
    JOIN password_credentials c ON c.user_id = u.id
    WHERE lower(u.email) = lower(${email})
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    userId: String(row.user_id),
    email: String(row.email),
    displayName: row.display_name === null ? null : String(row.display_name),
    passwordHash: String(row.password_hash),
    mfaRequired: Boolean(row.mfa_required),
    mfaEnrolled: Boolean(row.mfa_enrolled),
  };
}

export async function membershipsForUser(
  db: DatabaseExecutor,
  userId: string,
): Promise<MembershipRecord[]> {
  const rows = await db`
    SELECT
      m.organization_id,
      o.name AS organization_name,
      m.role
    FROM organization_memberships m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = ${userId}
    ORDER BY o.name, m.organization_id
  `;

  return rows.map((row) => ({
    organizationId: String(row.organization_id),
    organizationName: String(row.organization_name),
    role: row.role as MembershipRecord["role"],
  }));
}
