import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { tenantContext } from "./db/tenant-context.js";
import { ProjectRepository } from "./repositories/project-repository.js";

const databaseUrl = process.env.DATABASE_URL;

test("tenant-safe persistence reconstructs a canonical schedule snapshot", {
  skip: databaseUrl ? false : "DATABASE_URL is not configured",
}, async () => {
  const db = createDatabase({
    url: databaseUrl!,
    maxConnections: 4,
    idleTimeoutSeconds: 5,
    connectTimeoutSeconds: 5,
  });

  try {
    await db.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrateDatabase(db);
    await migrateDatabase(db);

    const orgA = randomUUID();
    const orgB = randomUUID();
    const userA = randomUUID();
    const projectA = randomUUID();
    const projectB = randomUUID();
    const calendarA = randomUUID();
    const calendarB = randomUUID();
    const wbsA = randomUUID();
    const activityA = randomUUID();
    const activityB = randomUUID();
    const relationship = randomUUID();

    await db`
      INSERT INTO organizations (id, slug, name)
      VALUES
        (${orgA}, 'alpha-org', 'Alpha'),
        (${orgB}, 'beta-org', 'Beta')
    `;

    await db`
      INSERT INTO users (id, email, display_name)
      VALUES (${userA}, 'planner@example.test', 'Planner')
    `;

    await db`
      INSERT INTO organization_memberships (organization_id, user_id, role)
      VALUES (${orgA}, ${userA}, 'planner')
    `;

    await db`
      INSERT INTO projects (id, organization_id, name, code)
      VALUES
        (${projectA}, ${orgA}, 'Alpha Project', 'ALPHA-1'),
        (${projectB}, ${orgB}, 'Beta Project', 'BETA-1')
    `;

    const definition = {
      week: {
        MONDAY: [{ start: "08:00", end: "16:00" }],
        TUESDAY: [{ start: "08:00", end: "16:00" }],
        WEDNESDAY: [{ start: "08:00", end: "16:00" }],
        THURSDAY: [{ start: "08:00", end: "16:00" }],
        FRIDAY: [{ start: "08:00", end: "16:00" }],
        SATURDAY: [],
        SUNDAY: [],
      },
      exceptions: [],
    };

    await db`
      INSERT INTO calendars (id, organization_id, project_id, name, time_zone, definition)
      VALUES
        (${calendarA}, ${orgA}, ${projectA}, 'Standard', 'UTC', ${db.json(definition)}),
        (${calendarB}, ${orgB}, ${projectB}, 'Standard', 'UTC', ${db.json(definition)})
    `;

    await db`
      INSERT INTO wbs_nodes (
        id, organization_id, project_id, parent_id, code, name, sort_order
      )
      VALUES (${wbsA}, ${orgA}, ${projectA}, NULL, '1', 'Project', 0)
    `;

    await db`
      INSERT INTO activities (
        id, organization_id, project_id, wbs_id, calendar_id,
        name, kind, duration_minutes, sort_order
      )
      VALUES
        (
          ${activityA}, ${orgA}, ${projectA}, ${wbsA}, ${calendarA},
          'Foundation', 'TASK', 480, 0
        ),
        (
          ${activityB}, ${orgA}, ${projectA}, ${wbsA}, ${calendarA},
          'Structure', 'TASK', 960, 1
        )
    `;

    await db`
      INSERT INTO relationships (
        id, organization_id, project_id, predecessor_id, successor_id,
        relationship_type, lag_minutes
      )
      VALUES (
        ${relationship}, ${orgA}, ${projectA}, ${activityA}, ${activityB}, 'FS', 0
      )
    `;

    await db`
      INSERT INTO project_schedule_settings (
        organization_id, project_id, planned_start, data_date,
        default_calendar_id, critical_float_threshold_minutes,
        lag_calendar_policy, project_finish_policy
      )
      VALUES (
        ${orgA}, ${projectA}, '2026-10-05T08:00:00Z', '2026-10-05T08:00:00Z',
        ${calendarA}, 0, 'SUCCESSOR', 'CALCULATED'
      )
    `;

    const repository = new ProjectRepository(db);
    const snapshot = await repository.scheduleSnapshot(
      tenantContext(orgA, userA, "integration-test"),
      projectA,
    );

    assert.ok(snapshot);
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.project.id, projectA);
    assert.equal(snapshot.project.defaultCalendarId, calendarA);
    assert.equal(snapshot.calendars.length, 1);
    assert.equal(snapshot.wbs.length, 1);
    assert.equal(snapshot.activities.length, 2);
    assert.deepEqual(snapshot.relationships, [
      {
        predecessorId: activityA,
        successorId: activityB,
        type: "FS",
        lagMinutes: 0,
      },
    ]);

    const crossTenantRead = await repository.scheduleSnapshot(tenantContext(orgB), projectA);
    assert.equal(crossTenantRead, null);

    await assert.rejects(
      db`
        INSERT INTO wbs_nodes (
          id, organization_id, project_id, parent_id, code, name, sort_order
        )
        VALUES (
          ${randomUUID()}, ${orgB}, ${projectA}, NULL, 'X', 'Cross Tenant', 0
        )
      `,
    );

    await assert.rejects(
      db`
        INSERT INTO activities (
          id, organization_id, project_id, wbs_id, calendar_id,
          name, kind, duration_minutes
        )
        VALUES (
          ${randomUUID()}, ${orgA}, ${projectA}, ${wbsA}, ${calendarB},
          'Cross Tenant Calendar', 'TASK', 60
        )
      `,
    );
  } finally {
    await db.end({ timeout: 5 });
  }
});

test("audit events are append-only", {
  skip: databaseUrl ? false : "DATABASE_URL is not configured",
}, async () => {
  const db = createDatabase({
    url: databaseUrl!,
    maxConnections: 2,
    idleTimeoutSeconds: 5,
    connectTimeoutSeconds: 5,
  });

  try {
    await migrateDatabase(db);

    const org = randomUUID();
    const event = randomUUID();

    await db`INSERT INTO organizations (id, slug, name) VALUES (${org}, 'audit-org', 'Audit')`;
    await db`
      INSERT INTO audit_events (
        id, organization_id, actor_type, action, resource_type, source
      )
      VALUES (${event}, ${org}, 'system', 'test', 'project', 'integration-test')
    `;

    await assert.rejects(
      db`UPDATE audit_events SET action = 'tampered' WHERE id = ${event}`,
      /append-only/,
    );
    await assert.rejects(db`DELETE FROM audit_events WHERE id = ${event}`, /append-only/);
  } finally {
    await db.end({ timeout: 5 });
  }
});
