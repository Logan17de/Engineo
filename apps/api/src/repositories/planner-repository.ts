import { createHash, randomUUID } from "node:crypto";
import {
  type ActivityConstraintV1,
  type ActivityKindV1,
  type CalendarV1,
  type EngineProjectInputV1,
  type RelationshipTypeV1,
  type ScheduleValidationIssue,
  validateScheduleInputV1,
} from "@engineo/contracts";
import type { Database, DatabaseExecutor } from "../db/client.js";
import type { TenantContext } from "../db/tenant-context.js";
import { appendAuditEvent } from "../security/audit.js";
import { readPlannerSnapshot } from "./project-repository.js";

export class PlannerInputError extends Error {
  constructor(public readonly issues: ScheduleValidationIssue[]) {
    super("Invalid schedule input");
  }
}
export class PlannerNotFoundError extends Error {}
function assertValid(input: EngineProjectInputV1): void {
  const result = validateScheduleInputV1(input);
  if (!result.valid) throw new PlannerInputError(result.issues);
}
function inputHash(input: EngineProjectInputV1): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

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

  async listAccessibleProjects(userId: string, organizationId: string): Promise<ProjectSummary[]> {
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

  async createProject(context: TenantContext, input: CreateProjectInput): Promise<CreatedProject> {
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
          'Standard 5x8', ${input.timeZone}, ${JSON.stringify(definition)}::text::jsonb
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
      await appendAuditEvent(sql, {
        organizationId: context.organizationId,
        actorType: "user",
        actorId: context.actorId,
        action: "project.create",
        resourceType: "project",
        resourceId: projectId,
        source: "api",
        correlationId: context.correlationId,
        payload: { revision: 1 },
      });
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
            ${JSON.stringify({ week: input.week, exceptions: input.exceptions })}::text::jsonb
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
            ${input.kind}, ${input.durationMinutes}, ${JSON.stringify(input.constraints)}::text::jsonb,
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
    return await this.bumpRevisionAndMutate(context, projectId, expectedRevision, async (sql) => {
      const rows = await sql`
          DELETE FROM activities
          WHERE organization_id = ${context.organizationId}
            AND project_id = ${projectId}
            AND id = ${activityId}
          RETURNING id
        `;
      if (rows.length !== 1) {
        throw new PlannerNotFoundError("Activity not found.");
      }
    });
  }

  async deleteRelationship(
    context: TenantContext,
    projectId: string,
    relationshipId: string,
    expectedRevision: number,
  ): Promise<number> {
    return await this.bumpRevisionAndMutate(context, projectId, expectedRevision, async (sql) => {
      const rows = await sql`
          DELETE FROM relationships
          WHERE organization_id = ${context.organizationId}
            AND project_id = ${projectId}
            AND id = ${relationshipId}
          RETURNING id
        `;
      if (rows.length !== 1) {
        throw new PlannerNotFoundError("Relationship not found.");
      }
    });
  }

  async replaceSchedule(
    context: TenantContext,
    projectId: string,
    expectedRevision: number,
    input: EngineProjectInputV1,
  ): Promise<number> {
    if (input.project.id !== projectId)
      throw new PlannerInputError([
        {
          code: "INVALID_ID",
          path: "project.id",
          message: "Schedule project must match the requested project.",
        },
      ]);
    assertValid(input);
    return await this.bumpRevisionAndMutate(context, projectId, expectedRevision, async (sql) => {
      // The project revision lock serializes writers. Delete/reinsert is contained
      // in one transaction; a failure retains the complete previous schedule.
      await sql`DELETE FROM project_schedule_settings WHERE organization_id = ${context.organizationId} AND project_id = ${projectId}`;
      await sql`DELETE FROM relationships WHERE organization_id = ${context.organizationId} AND project_id = ${projectId}`;
      await sql`DELETE FROM activities WHERE organization_id = ${context.organizationId} AND project_id = ${projectId}`;
      await sql`DELETE FROM wbs_nodes WHERE organization_id = ${context.organizationId} AND project_id = ${projectId}`;
      await sql`DELETE FROM calendars WHERE organization_id = ${context.organizationId} AND project_id = ${projectId}`;
      await sql`UPDATE projects SET name = ${input.project.name} WHERE organization_id = ${context.organizationId} AND id = ${projectId}`;
      await sql`
        INSERT INTO calendars (id, organization_id, project_id, name, time_zone, definition)
        SELECT id, ${context.organizationId}, ${projectId}, name, "timeZone",
          jsonb_build_object('week', week, 'exceptions', exceptions)
        FROM jsonb_to_recordset(${JSON.stringify(input.calendars)}::text::jsonb)
          AS c(id uuid, name text, "timeZone" text, week jsonb, exceptions jsonb)
      `;
      await sql`
        INSERT INTO wbs_nodes (id, organization_id, project_id, parent_id, code, name, sort_order)
        SELECT id, ${context.organizationId}, ${projectId}, "parentId", code, name, "sortOrder"
        FROM jsonb_to_recordset(${JSON.stringify(input.wbs)}::text::jsonb)
          AS w(id uuid, "parentId" uuid, code text, name text, "sortOrder" bigint)
      `;
      if (input.activities.length)
        await sql`
        INSERT INTO activities (id, organization_id, project_id, wbs_id, calendar_id, name, kind, duration_minutes, constraints, sort_order)
        SELECT id, ${context.organizationId}, ${projectId}, "wbsId", "calendarId", name, kind, "durationMinutes", constraints, ordinality - 1
        FROM ROWS FROM(jsonb_to_recordset(${JSON.stringify(input.activities)}::text::jsonb)
          AS (id uuid, "wbsId" uuid, "calendarId" uuid, name text, kind text, "durationMinutes" bigint, constraints jsonb))
          WITH ORDINALITY AS a(id, "wbsId", "calendarId", name, kind, "durationMinutes", constraints, ordinality)
      `;
      if (input.relationships.length)
        await sql`
        INSERT INTO relationships (id, organization_id, project_id, predecessor_id, successor_id, relationship_type, lag_minutes)
        SELECT gen_random_uuid(), ${context.organizationId}, ${projectId}, "predecessorId", "successorId", type, "lagMinutes"
        FROM jsonb_to_recordset(${JSON.stringify(input.relationships)}::text::jsonb)
          AS r("predecessorId" uuid, "successorId" uuid, type text, "lagMinutes" bigint)
      `;
      await sql`
        INSERT INTO project_schedule_settings (organization_id, project_id, planned_start, data_date, required_finish,
          default_calendar_id, critical_float_threshold_minutes, lag_calendar_policy, project_finish_policy)
        VALUES (${context.organizationId}, ${projectId}, ${input.project.plannedStart}, ${input.project.dataDate},
          ${input.project.requiredFinish}, ${input.project.defaultCalendarId},
          ${input.scheduleOptions.criticalFloatThresholdMinutes}, ${input.scheduleOptions.lagCalendarPolicy}, ${input.scheduleOptions.projectFinishPolicy})
      `;
    });
  }

  private async bumpRevisionAndMutate(
    context: TenantContext,
    projectId: string,
    expectedRevision: number,
    mutate: (sql: DatabaseExecutor) => Promise<void>,
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

      const before = await readPlannerSnapshot(sql, context, projectId);
      await mutate(sql);
      const after = await readPlannerSnapshot(sql, context, projectId);
      if (!before || !after) throw new PlannerNotFoundError("Project not found");
      assertValid(after.input);
      await appendAuditEvent(sql, {
        organizationId: context.organizationId,
        actorType: "user",
        actorId: context.actorId,
        action: "project.schedule.edit",
        resourceType: "project",
        resourceId: projectId,
        source: "api",
        correlationId: context.correlationId,
        payload: {
          revision: Number(row.revision),
          previousRevision: expectedRevision,
          beforeHash: inputHash(before.input),
          afterHash: inputHash(after.input),
          before: JSON.parse(JSON.stringify(before.input)),
          after: JSON.parse(JSON.stringify(after.input)),
        },
      });
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
