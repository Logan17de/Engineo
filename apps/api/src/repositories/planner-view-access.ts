import type { DatabaseExecutor } from "../db/client.js";
import type { TenantContext } from "../db/tenant-context.js";
import { authorizeProject } from "../security/rbac.js";
import type { SessionPrincipal } from "../security/session.js";
import { assertViewNotCancelled, PlannerViewError } from "./planner-view-errors.js";

export async function assertLiveViewSession(
  sql: DatabaseExecutor,
  principal: SessionPrincipal,
  signal?: AbortSignal,
): Promise<Date> {
  const rows = await sql`SELECT expires_at FROM auth_sessions WHERE id=${principal.sessionId}
    AND user_id=${principal.userId} AND revoked_at IS NULL AND expires_at > clock_timestamp()`;
  assertViewNotCancelled(signal);
  if (rows.length !== 1) throw new PlannerViewError("unauthenticated", 401);
  return rows[0]?.expires_at instanceof Date
    ? rows[0].expires_at
    : new Date(String(rows[0]?.expires_at));
}

/** Live identity -> org membership -> project SHARE -> project membership. */
export async function authorizePrivateView(
  sql: DatabaseExecutor,
  context: TenantContext,
  projectId: string,
  principal: SessionPrincipal,
  write: boolean,
  signal?: AbortSignal,
): Promise<Date> {
  assertViewNotCancelled(signal);
  if (context.actorId !== principal.userId) throw new PlannerViewError("forbidden", 403);
  const sessions = await sql`SELECT id FROM auth_sessions WHERE id=${principal.sessionId}
    AND user_id=${principal.userId} FOR SHARE`;
  assertViewNotCancelled(signal);
  if (sessions.length !== 1) throw new PlannerViewError("unauthenticated", 401);
  await assertLiveViewSession(sql, principal, signal);
  const memberships = await sql`SELECT role FROM organization_memberships
    WHERE organization_id=${context.organizationId} AND user_id=${principal.userId} FOR SHARE`;
  assertViewNotCancelled(signal);
  if (memberships.length !== 1) throw new PlannerViewError("forbidden", 403);
  const projects = await sql`SELECT id FROM projects WHERE organization_id=${context.organizationId}
    AND id=${projectId} FOR SHARE`;
  assertViewNotCancelled(signal);
  if (projects.length !== 1) throw new PlannerViewError("forbidden", 403);
  const members = await sql`SELECT role FROM project_memberships
    WHERE organization_id=${context.organizationId} AND project_id=${projectId}
      AND user_id=${principal.userId} FOR SHARE`;
  assertViewNotCancelled(signal);
  if (!["owner", "admin"].includes(String(memberships[0]?.role)) && members.length !== 1)
    throw new PlannerViewError("forbidden", 403);
  const decision = await authorizeProject(
    sql,
    principal.userId,
    context.organizationId,
    projectId,
    write ? "view.private.write" : "project.read",
  );
  assertViewNotCancelled(signal);
  if (!decision.allowed) throw new PlannerViewError("forbidden", 403);
  return await assertLiveViewSession(sql, principal, signal);
}
