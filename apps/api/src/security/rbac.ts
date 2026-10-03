import type { DatabaseExecutor } from "../db/client.js";

export type OrganizationRole = "owner" | "admin" | "planner" | "viewer";
export type ProjectRole = "manager" | "planner" | "viewer";
export type Permission =
  | "organization.manage"
  | "project.create"
  | "project.read"
  | "project.write"
  | "schedule.run"
  | "project.members.manage";

const organizationPermissions: Record<OrganizationRole, ReadonlySet<Permission>> = {
  owner: new Set([
    "organization.manage",
    "project.create",
    "project.read",
    "project.write",
    "schedule.run",
    "project.members.manage",
  ]),
  admin: new Set([
    "organization.manage",
    "project.create",
    "project.read",
    "project.write",
    "schedule.run",
    "project.members.manage",
  ]),
  planner: new Set(["project.create", "project.read", "project.write", "schedule.run"]),
  viewer: new Set(["project.read"]),
};

const projectPermissions: Record<ProjectRole, ReadonlySet<Permission>> = {
  manager: new Set(["project.read", "project.write", "schedule.run", "project.members.manage"]),
  planner: new Set(["project.read", "project.write", "schedule.run"]),
  viewer: new Set(["project.read"]),
};

export interface AccessDecision {
  allowed: boolean;
  organizationRole: OrganizationRole | null;
  projectRole: ProjectRole | null;
}

/** Apply the same policy to database rows already locked by a write transaction. */
export function projectAccessDecision(
  organizationRole: OrganizationRole | null,
  projectRole: ProjectRole | null,
  permission: Permission,
): AccessDecision {
  if (!organizationRole) return { allowed: false, organizationRole: null, projectRole: null };
  if (organizationRole === "owner" || organizationRole === "admin") {
    return {
      allowed: organizationPermissions[organizationRole].has(permission),
      organizationRole,
      projectRole: null,
    };
  }
  return {
    allowed:
      organizationPermissions[organizationRole].has(permission) &&
      (projectRole ? projectPermissions[projectRole].has(permission) : false),
    organizationRole,
    projectRole,
  };
}

export async function authorizeProject(
  db: DatabaseExecutor,
  userId: string,
  organizationId: string,
  projectId: string,
  permission: Permission,
): Promise<AccessDecision> {
  const organizationRows = await db`
    SELECT om.role
    FROM organization_memberships om
    JOIN projects p ON p.organization_id = om.organization_id
      AND p.id = ${projectId}
    WHERE om.organization_id = ${organizationId}
      AND om.user_id = ${userId}
    LIMIT 1
  `;

  const organizationRole = organizationRows[0]?.role as OrganizationRole | undefined;

  if (!organizationRole) {
    return projectAccessDecision(null, null, permission);
  }

  if (organizationRole === "owner" || organizationRole === "admin") {
    return projectAccessDecision(organizationRole, null, permission);
  }

  const projectRows = await db`
    SELECT role
    FROM project_memberships
    WHERE organization_id = ${organizationId}
      AND project_id = ${projectId}
      AND user_id = ${userId}
    LIMIT 1
  `;
  const projectRole = projectRows[0]?.role as ProjectRole | undefined;

  return projectAccessDecision(organizationRole, projectRole ?? null, permission);
}

export async function authorizeOrganization(
  db: DatabaseExecutor,
  userId: string,
  organizationId: string,
  permission: Permission,
): Promise<AccessDecision> {
  const rows = await db`
    SELECT role
    FROM organization_memberships
    WHERE organization_id = ${organizationId}
      AND user_id = ${userId}
    LIMIT 1
  `;
  const organizationRole = rows[0]?.role as OrganizationRole | undefined;

  if (!organizationRole) {
    return {
      allowed: false,
      organizationRole: null,
      projectRole: null,
    };
  }

  return {
    allowed: organizationPermissions[organizationRole].has(permission),
    organizationRole,
    projectRole: null,
  };
}
