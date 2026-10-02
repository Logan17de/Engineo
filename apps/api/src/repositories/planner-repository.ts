import { randomUUID } from "node:crypto";
import type { CalendarV1, ActivityConstraintV1, ActivityKindV1, RelationshipTypeV1 } from "@engineo/contracts";
import type { Database } from "../db/client.js";
import type { TenantContext } from "../db/tenant-context.js";

export class RevisionConflictError extends Error {
  constructor() {
    super("Project revision changed. Reload before applying this edit.");
  }
}

export interface ProjectSummary {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  revision: number;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  code: string | null;
  description: string | null;
  plannedStart: string;
  timeZone: string;
}

export interface CreatedProject {
  projectId: string;
  calendarId: string;
  rootWbsId: string;
  revision: number;
}

export interface CreateWbsInput {
  parentId: string | null;
  code: string;
  name: string;
  sortOrder: number;
}

export interface CreateCalendarInput {
  name: string;
  timeZone: string;
  week: CalendarV1["week"];
  exceptions: CalendarV1["exceptions"];
}

export interface CreateActivityInput {
  wbsId: string;
  calendarId: string;
  name: string;
  kind: ActivityKindV1;
  durationMinutes: number;
  constraints: ActivityConstraintV1[];
  sortOrder: number;
}

export interface CreateRelationshipInput {
  predecessorId: string;
  successorId: string;
  type: RelationshipTypeV1;
  lagMinutes: number;
}

export class PlannerRepository {
  constructor(private readonly db: Database) {}

  async listAccessibleProjects(
    userId: string,
    organizationId: string,
  ): Promise<ProjectSummary[]> {
    const rows = await this.db`
      SELECT p.id, p.name, p.code, p.description, p.revision, p.updated_at
      FROM projects p
      JOIN organization_memberships om
        ON om.organization_id = p.organization_id
       AND om.user_id = ${userId}
      WHERE p.organization_id = ${organizationId}
        AND (
          om.role IN ('owner', 'admin')
          OR EXISTS (
            SELECT 1
            FROM project_memberships pm
            WHERE pm.organization_id = p.organization_id
              AND pm.project_id = p.id
              AND pm.user_id = ${userId}
          )
        )
      ORDER BY p.updated_at DESC, p.id
    `;

    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      code: row.code === null ? null : String(row.code),
      description: row.description === null ? null : String(row.description),
      revision: Number(row.revision),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
    }));
  }

  async createProject(
    context: TenantContext,
    input: CreateProjectInput,
  ): Promise<CreatedProject> {
    const projectId = randomUUID();
    const calendarId = randomUUID();
    const rootWbsId = randomUUID();
    const definition = standardCalendarDefinition();

    await this.db.begin(async (sql) => {
      await sql`
        INSERT INTO projects (
          id, organization_id, name, code, description
        )
        VALUES (
          ${projectId}, ${context.organizationId}, ${input.name},
          ${input.code}, ${input.description}
        )
      `;

      await sql`
        INSERT INTO calendars (
          id, organization_id, project_id, name, time_zone, definition
        )
        VALUES (
          ${calendarId}, ${context.organizationId}, ${projectId},
          'Standard 5x8', ${input.timeZone}, ${sql.json(definition)}
        )
      `;

      await sql`
        INSERT INTO wbs_nodes (
          id, organization_id, project_id, parent_id, code, name, sort_order
        )
        VALUES (
          ${rootWbsId}, ${context.organizationId}, ${projectId},
          NULL, '1', ${input.name}, 0
        )
      `;

      await sql`
        INSERT INTO project_schedule_settings (
          organization_id, project_id, planned_start, data_date,
          default_calendar_id, critical_float_threshold_minutes,
          lag_calendar_policy, project_finish_policy
        )
        VALUES (
          ${context.organizationId}, ${projectId}, ${input.plannedStart},
          ${input.plannedStart}, ${calendarId}, 0, 'SUCCESSOR', 'CALCULATED'
        )
      `;

      if (context.actorId) {
        await sql`
          INSERT INTO project_memberships (
            organization_id, project_id, user_id, role
          )
          VALUES (
            ${context.organizationId}, ${projectId}, ${context.actorId}, 'manager'
          )
          ON CONFLICT DO NOTHING
        `;
      }
    });

    return {
      projectId,
      calendarId,
      rootWbsId,
      revision: 1,
    };
  }

  async createWbs(
    context: TenantContext,
    projectId: string,
    expectedRevision: number,
    input: CreateWbsInput,
  ): Promise<{ id: string; revision: number }> {
    const id = randomUUID();
    const revision = await this.bumpRevisionAndMutate(
      context,
      projectId,
      expectedRevision,
      async (sql) => {
        await sql`
          INSERT INTO wbs_nodes (
            id, organization_id, project_id, parent_id, code, name, sort_order
          )
          VALUES (
            ${id}, ${context.organizationId}, ${projectId},
            ${input.parentId}, ${input.code}, ${input.name}, ${input.sortOrder}
          )
        `;
      },
    );
    return { id, revision };
  }

  async createCalendar(
    context: TenantContext,
    projectId: string,
    expectedRevision: number,
    input: CreateCalendarInput,
  ): Promise<{ id: string; revision: number }> {
    const id = randomUUID();
    const revision = await this.bumpRevisionAndMutate(
      context,
      projectId,
      expectedRevision,
      async (sql) => {
        await sql`
          INSERT INTO calendars (
            id, organization_id, project_id, name, time_zone, definition
          )
          VALUES (
            ${id}, ${context.organizationId}, ${projectId},
            ${input.name}, ${input.timeZone},
            ${sql.json({ week: input.week, exceptions: input.exceptions })}
          )
        `;
      },
    );
    return { id, revision };
  }

  async createActivity(
    context: TenantContext,
    projectId: string,
    expectedRevision: number,
    input: CreateActivityInput,
  ): Promise<{ id: string; revision: number }> {
    const id = randomUUID();
    const revision = await this.bumpRevisionAndMutate(
      context,
      projectId,
      expectedRevision,
      async (sql) => {
        await sql`
          INSERT INTO activities (
            id, organization_id, project_id, wbs_id, calendar_id,
            name, kind, duration_minutes, constraints, sort_order
          )
          VALUES (
            ${id}, ${context.organizationId}, ${projectId},
            ${input.wbsId}, ${input.calendarId}, ${input.name},
            ${input.kind}, ${input.durationMinutes}, ${sql.json(input.constraints)},
            ${input.sortOrder}
          )
        `;
      },
    );
    return { id, revision };
  }

  async createRelationship(
    context: TenantContext,
    projectId: string,
    expectedRevision: number,
    input: CreateRelationshipInput,
  ): Promise<{ id: string; revision: number }> {
    const id = randomUUID();
    const revision = await this.bumpRevisionAndMutate(
      context,
      projectId,
      expectedRevision,
      async (sql) => {
        await sql`
          INSERT INTO relationships (
            id, organization_id, project_id, predecessor_id, successor_id,
            relationship_type, lag_minutes
          )
          VALUES (
            ${id}, ${context.organizationId}, ${projectId},
            ${input.predecessorId}, ${input.successorId},
            ${input.type}, ${input.lagMinutes}
          )
        `;
      },
    );
    return { id, revision };
  }

  async deleteActivity(
    context: TenantContext,
    projectId: string,
    activityId: string,
    expectedRevision: number,
  ): Promise<number> {
    return await this.bumpRevisionAndMutate(
      context,
      projectId,
      expectedRevision,
      async (sql) => {
        const rows = await sql`
          DELETE FROM activities
          WHERE organization_id = ${context.organizationId}
            AND project_id = ${projectId}
            AND id = ${activityId}
          RETURNING id
        `;
        if (rows.length !== 1) {
          throw new Error("Activity not found.");
        }
      },
    );
  }

  async deleteRelationship(
    context: TenantContext,
    projectId: string,
    relationshipId: string,
    expectedRevision: number,
  ): Promise<number> {
    return await this.bumpRevisionAndMutate(
      context,
      projectId,
      expectedRevision,
      async (sql) => {
        const rows = await sql`
          DELETE FROM relationships
          WHERE organization_id = ${context.organizationId}
            AND project_id = ${projectId}
            AND id = ${relationshipId}
          RETURNING id
        `;
        if (rows.length !== 1) {
          throw new Error("Relationship not found.");
        }
      },
    );
  }

  private async bumpRevisionAndMutate(
    context: TenantContext,
    projectId: string,
    expectedRevision: number,
    mutate: (sql: Database) => Promise<void>,
  ): Promise<number> {
    return await this.db.begin(async (sql) => {
      const revisions = await sql`
        UPDATE projects
        SET revision = revision + 1, updated_at = now()
        WHERE organization_id = ${context.organizationId}
          AND id = ${projectId}
          AND revision = ${expectedRevision}
        RETURNING revision
      `;

      const row = revisions[0];
      if (!row) {
        throw new RevisionConflictError();
      }

      await mutate(sql as Database);
      return Number(row.revision);
    });
  }
}

function standardCalendarDefinition(): Pick<CalendarV1, "week" | "exceptions"> {
  const day = [
    { start: "08:00", end: "12:00" },
    { start: "13:00", end: "17:00" },
  ];

  return {
    week: {
      MONDAY: day,
      TUESDAY: day,
      WEDNESDAY: day,
      THURSDAY: day,
      FRIDAY: day,
      SATURDAY: [],
      SUNDAY: [],
    },
    exceptions: [],
  };
}
