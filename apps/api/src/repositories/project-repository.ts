import { ENGINE_CONTRACT_VERSION, type EngineProjectInputV1 } from "@engineo/contracts";
import type { Database, DatabaseExecutor } from "../db/client.js";
import type { TenantContext } from "../db/tenant-context.js";

export interface ProjectRecord {
  id: string;
  organizationId: string;
  name: string;
  code: string | null;
  description: string | null;
  revision: number;
}

interface ProjectRow {
  id: string;
  organization_id: string;
  name: string;
  code: string | null;
  description: string | null;
  revision: string | number;
}

export interface PlannerSnapshot {
  revision: number;
  input: EngineProjectInputV1;
  relationshipIds: string[];
}

export class ProjectRepository {
  constructor(private readonly db: Database) {}

  async findById(context: TenantContext, projectId: string): Promise<ProjectRecord | null> {
    const rows = await this.db<ProjectRow[]>`
      SELECT id, organization_id, name, code, description, revision
      FROM projects
      WHERE organization_id = ${context.organizationId}
        AND id = ${projectId}
      LIMIT 1
    `;

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      code: row.code,
      description: row.description,
      revision: Number(row.revision),
    };
  }

  async scheduleSnapshot(
    context: TenantContext,
    projectId: string,
  ): Promise<EngineProjectInputV1 | null> {
    return (await this.plannerSnapshot(context, projectId))?.input ?? null;
  }

  async plannerSnapshot(
    context: TenantContext,
    projectId: string,
  ): Promise<PlannerSnapshot | null> {
    return await this.db.begin("isolation level repeatable read read only", async (sql) =>
      readPlannerSnapshot(sql, context, projectId),
    );
  }
}

// Call inside an existing transaction when validating a mutation. All component
// reads use that transaction's snapshot, including the revision and project name.
export async function readPlannerSnapshot(
  db: DatabaseExecutor,
  context: TenantContext,
  projectId: string,
): Promise<PlannerSnapshot | null> {
  const projectRows = await db<ProjectRow[]>`
      SELECT id, organization_id, name, code, description, revision FROM projects
      WHERE organization_id = ${context.organizationId} AND id = ${projectId}
    `;
  const project = projectRows[0];
  if (!project) {
    return null;
  }

  const [settingsRows, calendarRows, wbsRows, activityRows, relationshipRows] = await Promise.all([
    db`
          SELECT planned_start, data_date, required_finish, default_calendar_id,
                 critical_float_threshold_minutes, lag_calendar_policy, project_finish_policy
          FROM project_schedule_settings
          WHERE organization_id = ${context.organizationId}
            AND project_id = ${projectId}
        `,
    db`
          SELECT id, name, time_zone, definition
          FROM calendars
          WHERE organization_id = ${context.organizationId}
            AND project_id = ${projectId}
          ORDER BY id
        `,
    db`
          SELECT id, parent_id, code, name, sort_order
          FROM wbs_nodes
          WHERE organization_id = ${context.organizationId}
            AND project_id = ${projectId}
          ORDER BY parent_id NULLS FIRST, sort_order, id
        `,
    db`
          SELECT id, wbs_id, name, kind, duration_minutes, calendar_id, constraints
          FROM activities
          WHERE organization_id = ${context.organizationId}
            AND project_id = ${projectId}
          ORDER BY sort_order, id
        `,
    db`
          SELECT id, predecessor_id, successor_id, relationship_type, lag_minutes
          FROM relationships
          WHERE organization_id = ${context.organizationId}
            AND project_id = ${projectId}
          ORDER BY predecessor_id, successor_id, relationship_type, lag_minutes
        `,
  ]);

  const settings = settingsRows[0];
  if (!settings) {
    throw new Error(`Project ${projectId} is missing schedule settings`);
  }

  const input: EngineProjectInputV1 = {
    schemaVersion: ENGINE_CONTRACT_VERSION,
    project: {
      id: project.id,
      name: project.name,
      plannedStart: new Date(String(settings.planned_start)).toISOString(),
      dataDate: new Date(String(settings.data_date)).toISOString(),
      requiredFinish:
        settings.required_finish === null
          ? null
          : new Date(String(settings.required_finish)).toISOString(),
      defaultCalendarId: String(settings.default_calendar_id),
    },
    scheduleOptions: {
      criticalFloatThresholdMinutes: Number(settings.critical_float_threshold_minutes),
      lagCalendarPolicy:
        settings.lag_calendar_policy as EngineProjectInputV1["scheduleOptions"]["lagCalendarPolicy"],
      projectFinishPolicy:
        settings.project_finish_policy as EngineProjectInputV1["scheduleOptions"]["projectFinishPolicy"],
    },
    calendars: calendarRows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      timeZone: String(row.time_zone),
      ...(row.definition as Omit<
        EngineProjectInputV1["calendars"][number],
        "id" | "name" | "timeZone"
      >),
    })),
    wbs: wbsRows.map((row) => ({
      id: String(row.id),
      parentId: row.parent_id === null ? null : String(row.parent_id),
      code: String(row.code),
      name: String(row.name),
      sortOrder: Number(row.sort_order),
    })),
    activities: activityRows.map((row) => ({
      id: String(row.id),
      wbsId: String(row.wbs_id),
      name: String(row.name),
      kind: row.kind as EngineProjectInputV1["activities"][number]["kind"],
      durationMinutes: Number(row.duration_minutes),
      calendarId: String(row.calendar_id),
      constraints: row.constraints as EngineProjectInputV1["activities"][number]["constraints"],
    })),
    relationships: relationshipRows.map((row) => ({
      predecessorId: String(row.predecessor_id),
      successorId: String(row.successor_id),
      type: row.relationship_type as EngineProjectInputV1["relationships"][number]["type"],
      lagMinutes: Number(row.lag_minutes),
    })),
  };
  return {
    revision: Number(project.revision),
    input,
    relationshipIds: relationshipRows.map((row) => String(row.id)),
  };
}
