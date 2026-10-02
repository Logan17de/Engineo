import type { Database } from "../db/client.js";

export type OrganizationRole = "owner" | "admin" | "planner" | "viewer";
export type ProjectRole = "manager" | "planner" | "viewer";
export type Permission =
  | "organization.manage"
  | "project.read"
  | "project.write"
  | "schedule.run"
  | "project.members.manage";

const organizationPermissions: Record<OrganizationRole, ReadonlySet<Permission>> = {
  owner: new Set([
    "organization.manage",
    "project.read",
    "project.write",
    "schedule.run",
    "project.members.manage",
  ]),
  admin: new Set([
    "organization.manage",
    "project.read",
    "project.write",
    "schedule.run",
    "project.members.manage",
  ]),
  planner: new Set(["project.read", "project.write", "schedule.run"]),
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

export async function authorizeProject(
  db: Database,
  userId: string,
  organizationId: string,
  projectId: string,
  permission: Permission,
): Promise<AccessDecision> {
  const organizationRows = await db`
    SELECT role
    FROM organization_memberships
    WHERE organization_id = ${organizationId}
      AND user_id = ${userId}
    LIMIT 1
  `;

  const organizationRole = organizationRows[0]?.role as OrganizationRole | undefined;

  if (!organizationRole) {
    return {
      allowed: false,
      organizationRole: null,
      projectRole: null,
    };
  }

  if (organizationRole === "owner" || organizationRole === "admin") {
    return {
      allowed: organizationPermissions[organizationRole].has(permission),
      organizationRole,
      projectRole: null,
    };
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

  const allowed =
    organizationPermissions[organizationRole].has(permission) &&
    (projectRole ? projectPermissions[projectRole].has(permission) : false);

  return {
    allowed,
    organizationRole,
    projectRole: projectRole ?? null,
  };
}
