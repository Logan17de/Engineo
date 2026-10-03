import type { EngineProjectInputV1 } from "@engineo/contracts";
import type { DatabaseExecutor } from "../db/client.js";
import type { TenantContext } from "../db/tenant-context.js";

// Never include the occupied ID, entity type, tenant, project, or database detail
// in this error. Availability checks must not disclose another tenant's data.
export class ConfigurationNativeIdError extends Error {
  constructor() {
    super("One or more schedule IDs are unavailable for this project.");
  }
}

/**
 * Check global native primary keys and append-order capacity without exposing
 * foreign ownership. Numeric arithmetic checks capacity without bigint overflow.
 * Input must already be normalized and validated, including its project ID.
 * A successful check is not a reservation; reconcile also handles a racing PK
 * collision. The caller owns authorization and the transaction/snapshot.
 */
export async function assertConfigurationNativeIds(
  sql: DatabaseExecutor,
  context: TenantContext,
  projectId: string,
  input: EngineProjectInputV1,
): Promise<void> {
  const rows = await sql<{ unavailable: boolean }[]>`
    SELECT (EXISTS (
      SELECT 1 FROM calendars AS c
      JOIN jsonb_to_recordset(${JSON.stringify(input.calendars)}::text::jsonb)
        AS wanted(id uuid) ON wanted.id = c.id
      WHERE c.organization_id <> ${context.organizationId} OR c.project_id <> ${projectId}
      UNION ALL
      SELECT 1 FROM wbs_nodes AS w
      JOIN jsonb_to_recordset(${JSON.stringify(input.wbs)}::text::jsonb)
        AS wanted(id uuid) ON wanted.id = w.id
      WHERE w.organization_id <> ${context.organizationId} OR w.project_id <> ${projectId}
      UNION ALL
      SELECT 1 FROM activities AS a
      JOIN jsonb_to_recordset(${JSON.stringify(input.activities)}::text::jsonb)
        AS wanted(id uuid) ON wanted.id = a.id
      WHERE a.organization_id <> ${context.organizationId} OR a.project_id <> ${projectId}
    ) OR (
      (SELECT COALESCE(MAX(sort_order), -1)::numeric FROM activities
        WHERE organization_id = ${context.organizationId} AND project_id = ${projectId})
      + (SELECT COUNT(*)::numeric
        FROM jsonb_to_recordset(${JSON.stringify(input.activities)}::text::jsonb) AS wanted(id uuid)
        WHERE NOT EXISTS (
          SELECT 1 FROM activities AS a WHERE a.id = wanted.id
            AND a.organization_id = ${context.organizationId} AND a.project_id = ${projectId}
        ))
      > 9223372036854775807::numeric
    )) AS unavailable
  `;
  if (rows[0]?.unavailable) throw new ConfigurationNativeIdError();
}

interface ExistingWbsRow {
  id: string;
  parent_id: string | null;
  code: string;
  name: string;
  sort_order: string;
}

/**
 * Reconcile only schedule-owned fields in an existing caller-owned transaction.
 * The caller must lock/authorize the project, validate the normalized candidate,
 * maintain revision/audits, and verify canonical reconstruction before commit.
 * No entity that survives is deleted/reinserted. In particular, native activity
 * sort order and creation time, and relationship identity by tuple, are retained.
 */
export async function reconcileConfigurationSchedule(
  sql: DatabaseExecutor,
  context: TenantContext,
  projectId: string,
  input: EngineProjectInputV1,
): Promise<void> {
  try {
    await assertConfigurationNativeIds(sql, context, projectId, input);
    const calendars = JSON.stringify(input.calendars);
    const activities = JSON.stringify(input.activities);
    const relationships = JSON.stringify(input.relationships);

    // Capture the original maximum, including rows that will be removed. bigint
    // stays a string here to avoid losing integer precision in JavaScript.
    const orderRows = await sql<{ maximum: string }[]>`
      SELECT COALESCE(MAX(sort_order), -1)::text AS maximum FROM activities
      WHERE organization_id = ${context.organizationId} AND project_id = ${projectId}
    `;
    const maximumOrder = orderRows[0]?.maximum;
    if (maximumOrder === undefined) throw new Error("Missing activity order snapshot.");
    const existingWbs = await sql<ExistingWbsRow[]>`
      SELECT id, parent_id, code, name, sort_order::text FROM wbs_nodes
      WHERE organization_id = ${context.organizationId} AND project_id = ${projectId}
      ORDER BY id
    `;
    const byId = new Map(existingWbs.map((node) => [node.id, node]));
    const wbs = JSON.stringify(
      input.wbs.map((node) => {
        const before = byId.get(node.id);
        return {
          ...node,
          changed:
            !before ||
            before.parent_id !== node.parentId ||
            before.code !== node.code ||
            before.name !== node.name ||
            before.sort_order !== String(node.sortOrder),
        };
      }),
    );

    // Every existing code is parked outside both the current and desired code
    // sets, so immediate UNIQUE constraints allow swaps and reuse of deleted
    // codes. Detaching ALL old parent links prevents deletion from cascading
    // into survivors, including when a child is reparented to a new node.
    // Temporary changes intentionally do not alter updated_at.
    if (existingWbs.length) {
      const staging = JSON.stringify(stageWbsCodes(existingWbs, input));
      await sql`
        UPDATE wbs_nodes AS w SET code = staged.code, parent_id = NULL
        FROM jsonb_to_recordset(${staging}::text::jsonb) AS staged(id uuid, code text)
        WHERE w.id = staged.id AND w.organization_id = ${context.organizationId}
          AND w.project_id = ${projectId}
      `;
    }

    await sql`
      UPDATE calendars AS c
      SET name = wanted.name, time_zone = wanted."timeZone",
          definition = jsonb_build_object('week', wanted.week, 'exceptions', wanted.exceptions),
          updated_at = now()
      FROM jsonb_to_recordset(${calendars}::text::jsonb)
        AS wanted(id uuid, name text, "timeZone" text, week jsonb, exceptions jsonb)
      WHERE c.id = wanted.id AND c.organization_id = ${context.organizationId}
        AND c.project_id = ${projectId}
        AND (c.name, c.time_zone, c.definition) IS DISTINCT FROM
          (wanted.name, wanted."timeZone",
           jsonb_build_object('week', wanted.week, 'exceptions', wanted.exceptions))
    `;
    await sql`
      INSERT INTO calendars (id, organization_id, project_id, name, time_zone, definition)
      SELECT wanted.id, ${context.organizationId}, ${projectId}, wanted.name, wanted."timeZone",
        jsonb_build_object('week', wanted.week, 'exceptions', wanted.exceptions)
      FROM jsonb_to_recordset(${calendars}::text::jsonb)
        AS wanted(id uuid, name text, "timeZone" text, week jsonb, exceptions jsonb)
      WHERE NOT EXISTS (
        SELECT 1 FROM calendars AS c WHERE c.id = wanted.id
          AND c.organization_id = ${context.organizationId} AND c.project_id = ${projectId}
      )
    `;

    // Insert/update with null parents first. Target parents may themselves be
    // newly inserted, or be later in the request's non-ordering WBS array.
    await sql`
      UPDATE wbs_nodes AS w
      SET code = wanted.code, name = wanted.name, sort_order = wanted."sortOrder",
          updated_at = CASE WHEN wanted.changed THEN now() ELSE w.updated_at END
      FROM jsonb_to_recordset(${wbs}::text::jsonb)
        AS wanted(id uuid, code text, name text, "sortOrder" bigint, changed boolean)
      WHERE w.id = wanted.id AND w.organization_id = ${context.organizationId}
        AND w.project_id = ${projectId}
    `;
    await sql`
      INSERT INTO wbs_nodes (id, organization_id, project_id, parent_id, code, name, sort_order)
      SELECT wanted.id, ${context.organizationId}, ${projectId}, NULL,
        wanted.code, wanted.name, wanted."sortOrder"
      FROM jsonb_to_recordset(${wbs}::text::jsonb)
        AS wanted(id uuid, code text, name text, "sortOrder" bigint)
      WHERE NOT EXISTS (
        SELECT 1 FROM wbs_nodes AS w WHERE w.id = wanted.id
          AND w.organization_id = ${context.organizationId} AND w.project_id = ${projectId}
      )
    `;
    await sql`
      UPDATE wbs_nodes AS w SET parent_id = wanted."parentId"
      FROM jsonb_to_recordset(${wbs}::text::jsonb) AS wanted(id uuid, "parentId" uuid)
      WHERE w.id = wanted.id AND w.organization_id = ${context.organizationId}
        AND w.project_id = ${projectId} AND w.parent_id IS DISTINCT FROM wanted."parentId"
    `;

    // Update survivor references before deleting their previous WBS/calendar.
    // Neither creation time nor the GUI's persisted sort order is assigned.
    await sql`
      UPDATE activities AS a
      SET wbs_id = wanted."wbsId", calendar_id = wanted."calendarId", name = wanted.name,
          kind = wanted.kind, duration_minutes = wanted."durationMinutes",
          constraints = wanted.constraints, updated_at = now()
      FROM jsonb_to_recordset(${activities}::text::jsonb)
        AS wanted(id uuid, "wbsId" uuid, "calendarId" uuid, name text, kind text,
                  "durationMinutes" bigint, constraints jsonb)
      WHERE a.id = wanted.id AND a.organization_id = ${context.organizationId}
        AND a.project_id = ${projectId}
        AND (a.wbs_id, a.calendar_id, a.name, a.kind, a.duration_minutes, a.constraints)
          IS DISTINCT FROM
          (wanted."wbsId", wanted."calendarId", wanted.name, wanted.kind,
           wanted."durationMinutes", wanted.constraints)
    `;
    await sql`
      INSERT INTO activities (id, organization_id, project_id, wbs_id, calendar_id,
        name, kind, duration_minutes, constraints, sort_order)
      SELECT wanted.id, ${context.organizationId}, ${projectId}, wanted."wbsId",
        wanted."calendarId", wanted.name, wanted.kind, wanted."durationMinutes",
        wanted.constraints, ${maximumOrder}::bigint + row_number() OVER (ORDER BY wanted.id)
      FROM jsonb_to_recordset(${activities}::text::jsonb)
        AS wanted(id uuid, "wbsId" uuid, "calendarId" uuid, name text, kind text,
                  "durationMinutes" bigint, constraints jsonb)
      WHERE NOT EXISTS (
        SELECT 1 FROM activities AS a WHERE a.id = wanted.id
          AND a.organization_id = ${context.organizationId} AND a.project_id = ${projectId}
      )
    `;

    // Delete only absent tuples. Existing UUIDs and created_at remain untouched,
    // even if request-array order changes. Changed type/lag is a different tuple.
    await sql`
      DELETE FROM relationships AS r
      WHERE r.organization_id = ${context.organizationId} AND r.project_id = ${projectId}
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_to_recordset(${relationships}::text::jsonb)
            AS wanted("predecessorId" uuid, "successorId" uuid, type text, "lagMinutes" bigint)
          WHERE r.predecessor_id = wanted."predecessorId"
            AND r.successor_id = wanted."successorId"
            AND r.relationship_type = wanted.type AND r.lag_minutes = wanted."lagMinutes"
        )
    `;
    await sql`
      DELETE FROM activities AS a
      WHERE a.organization_id = ${context.organizationId} AND a.project_id = ${projectId}
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_to_recordset(${activities}::text::jsonb)
            AS wanted(id uuid) WHERE wanted.id = a.id
        )
    `;
    await sql`
      DELETE FROM wbs_nodes AS w
      WHERE w.organization_id = ${context.organizationId} AND w.project_id = ${projectId}
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_to_recordset(${wbs}::text::jsonb)
            AS wanted(id uuid) WHERE wanted.id = w.id
        )
    `;

    // Retarget the default calendar before removing obsolete calendars. Keep
    // the settings row and all fields outside the configuration's schedule scope.
    await sql`
      UPDATE project_schedule_settings
      SET planned_start = ${input.project.plannedStart}, data_date = ${input.project.dataDate},
          required_finish = ${input.project.requiredFinish},
          default_calendar_id = ${input.project.defaultCalendarId},
          critical_float_threshold_minutes = ${input.scheduleOptions.criticalFloatThresholdMinutes},
          lag_calendar_policy = ${input.scheduleOptions.lagCalendarPolicy},
          project_finish_policy = ${input.scheduleOptions.projectFinishPolicy}, updated_at = now()
      WHERE organization_id = ${context.organizationId} AND project_id = ${projectId}
        AND (planned_start, data_date, required_finish, default_calendar_id,
             critical_float_threshold_minutes, lag_calendar_policy, project_finish_policy)
          IS DISTINCT FROM
          (${input.project.plannedStart}::timestamptz, ${input.project.dataDate}::timestamptz,
           ${input.project.requiredFinish}::timestamptz, ${input.project.defaultCalendarId}::uuid,
           ${input.scheduleOptions.criticalFloatThresholdMinutes}::bigint,
           ${input.scheduleOptions.lagCalendarPolicy}::text,
           ${input.scheduleOptions.projectFinishPolicy}::text)
    `;
    await sql`
      DELETE FROM calendars AS c
      WHERE c.organization_id = ${context.organizationId} AND c.project_id = ${projectId}
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_to_recordset(${calendars}::text::jsonb)
            AS wanted(id uuid) WHERE wanted.id = c.id
        )
    `;
    await sql`
      INSERT INTO relationships (id, organization_id, project_id, predecessor_id,
        successor_id, relationship_type, lag_minutes)
      SELECT gen_random_uuid(), ${context.organizationId}, ${projectId},
        wanted."predecessorId", wanted."successorId", wanted.type, wanted."lagMinutes"
      FROM jsonb_to_recordset(${relationships}::text::jsonb)
        AS wanted("predecessorId" uuid, "successorId" uuid, type text, "lagMinutes" bigint)
      WHERE NOT EXISTS (
        SELECT 1 FROM relationships AS r WHERE r.organization_id = ${context.organizationId}
          AND r.project_id = ${projectId} AND r.predecessor_id = wanted."predecessorId"
          AND r.successor_id = wanted."successorId" AND r.relationship_type = wanted.type
          AND r.lag_minutes = wanted."lagMinutes"
      )
    `;
    await sql`
      UPDATE projects SET name = ${input.project.name}
      WHERE organization_id = ${context.organizationId} AND id = ${projectId}
        AND name IS DISTINCT FROM ${input.project.name}
    `;
  } catch (error) {
    // A concurrent reconcile in another project can occupy a fresh ID after the
    // read-only assertion. Do not surface PostgreSQL's foreign-row key details.
    if (isNativePrimaryKeyCollision(error)) throw new ConfigurationNativeIdError();
    throw error;
  }
}

function stageWbsCodes(
  existing: ExistingWbsRow[],
  input: EngineProjectInputV1,
): Array<{ id: string; code: string }> {
  const blocked = new Set<string>();
  for (const code of [
    ...existing.map((node) => node.code),
    ...input.wbs.map((node) => node.code),
  ]) {
    const match = /^__engineo_configuration_wbs:(\d+):/.exec(code);
    if (match?.[1]) blocked.add(match[1]);
  }
  let suffix = 0;
  while (blocked.has(String(suffix))) suffix++;
  // The first unused prefix is found in O(number of codes); temporary codes are
  // short even when an arbitrary user code is very long. IDs make them unique.
  return existing.map((node) => ({
    id: node.id,
    code: `__engineo_configuration_wbs:${suffix}:${node.id}`,
  }));
}

function isNativePrimaryKeyCollision(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint_name?: unknown };
  return (
    candidate.code === "23505" &&
    (candidate.constraint_name === "calendars_pkey" ||
      candidate.constraint_name === "wbs_nodes_pkey" ||
      candidate.constraint_name === "activities_pkey")
  );
}
