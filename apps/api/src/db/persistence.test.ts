import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDatabase } from "./client.js";
import { migrateDatabase } from "./migrate.js";
import { tenantContext } from "./tenant-context.js";
import { ProjectRepository } from "../repositories/project-repository.js";

const databaseUrl = process.env.DATABASE_URL;

test(
  "tenant-safe persistence reconstructs the canonical schedule contract",
  { skip: databaseUrl === undefined },
  async () => {
    assert.ok(databaseUrl);

    const db = createDatabase({
      url: databaseUrl,
      maxConnections: 4,
      idleTimeoutSeconds: 5,
      connectTimeoutSeconds: 5,
    });

    try {
      await migrateDatabase(db);
      await migrateDatabase(db);
      await db.unsafe("TRUNCATE organizations CASCADE");

      const orgA = randomUUID();
      const orgB = randomUUID();
      const projectA = randomUUID();
      const projectB = randomUUID();
      const calendarA = randomUUID();
      const wbsA = randomUUID();
      const activityA = randomUUID();
      const relationshipId = randomUUID();
      const userA = randomUUID();
      const auditId = randomUUID();

      await db`
        INSERT INTO organizations (id, slug, name)
        VALUES
          (${orgA}, 'alpha-org', 'Alpha'),
          (${orgB}, 'beta-org', 'Beta')
      `;
      await db`
        INSERT INTO users (id, email, display_name)
        VALUES (${userA}, 'planner@example.com', 'Planner')
      `;
      await db`
        INSERT INTO organization_memberships (organization_id, user_id, role)
        VALUES (${orgA}, ${userA}, 'planner')
      `;
      await db`
        INSERT INTO projects (id, organization_id, name, code)
        VALUES
          (${projectA}, ${orgA}, 'Alpha Project', 'ALPHA'),
          (${projectB}, ${orgB}, 'Beta Project', 'BETA')
      `;

      await assert.rejects(async () => {
        await db`
          INSERT INTO calendars (
            id, organization_id, project_id, name, time_zone, definition
          )
          VALUES (
            ${randomUUID()},
            ${orgA},
            ${projectB},
            'Cross tenant calendar',
            'UTC',
            ${db.json({ week: {}, exceptions: [] })}
          )
        `;
      });

      const week = {
        MONDAY: [{ start: "08:00", end: "16:00" }],
        TUESDAY: [{ start: "08:00", end: "16:00" }],
        WEDNESDAY: [{ start: "08:00", end: "16:00" }],
        THURSDAY: [{ start: "08:00", end: "16:00" }],
        FRIDAY: [{ start: "08:00", end: "16:00" }],
        SATURDAY: [],
        SUNDAY: [],
      };

      await db`
        INSERT INTO calendars (
          id, organization_id, project_id, name, time_zone, definition
        )
        VALUES (
          ${calendarA},
          ${orgA},
          ${projectA},
          'Standard',
          'UTC',
          ${db.json({ week, exceptions: [] })}
        )
      `;
      await db`
        INSERT INTO wbs_nodes (
          id, organization_id, project_id, parent_id, code, name, sort_order
        )
        VALUES (
          ${wbsA}, ${orgA}, ${projectA}, NULL, '1', 'Project', 0
        )
      `;
      await db`
        INSERT INTO activities (
          id, organization_id, project_id, wbs_id, calendar_id,
          name, kind, duration_minutes, constraints, sort_order
        )
        VALUES (
          ${activityA}, ${orgA}, ${projectA}, ${wbsA}, ${calendarA},
          'Mobilization', 'TASK', 480, '[]'::jsonb, 0
        )
      `;
      await db`
        INSERT INTO relationships (
          id, organization_id, project_id, predecessor_id, successor_id,
          relationship_type, lag_minutes
        )
        VALUES (
          ${relationshipId}, ${orgA}, ${projectA}, ${activityA}, ${activityA},
          'FS', 0
        )
      `.catch(() => undefined);

      const relationshipRows = await db`
        SELECT count(*)::int AS count
        FROM relationships
        WHERE organization_id = ${orgA}
          AND project_id = ${projectA}
      `;
      assert.equal(relationshipRows[0]?.count, 0);

      await db`
        INSERT INTO project_schedule_settings (
          organization_id,
          project_id,
          planned_start,
          data_date,
          required_finish,
          default_calendar_id,
          critical_float_threshold_minutes,
          lag_calendar_policy,
          project_finish_policy
        )
        VALUES (
          ${orgA},
          ${projectA},
          '2026-10-05T08:00:00Z',
          '2026-10-05T08:00:00Z',
          NULL,
          ${calendarA},
          0,
          'SUCCESSOR',
          'CALCULATED'
        )
      `;

      const repository = new ProjectRepository(db);
      const alpha = tenantContext(orgA, userA, "test-correlation");
      const beta = tenantContext(orgB, userA, "test-correlation");

      const visible = await repository.findById(alpha, projectA);
      assert.equal(visible?.name, "Alpha Project");
      assert.equal(await repository.findById(beta, projectA), null);

      const snapshot = await repository.scheduleSnapshot(alpha, projectA);
      assert.ok(snapshot);
      assert.equal(snapshot.schemaVersion, 1);
      assert.equal(snapshot.project.id, projectA);
      assert.equal(snapshot.calendars.length, 1);
      assert.deepEqual(snapshot.calendars[0]?.week, week);
      assert.equal(snapshot.wbs.length, 1);
      assert.equal(snapshot.activities.length, 1);
      assert.equal(snapshot.activities[0]?.durationMinutes, 480);

      await db`
        INSERT INTO audit_events (
          id, organization_id, actor_type, actor_id, action,
          resource_type, resource_id, source, correlation_id, payload
        )
        VALUES (
          ${auditId}, ${orgA}, 'user', ${userA}, 'project.read',
          'project', ${projectA}, 'test', 'test-correlation',
          ${db.json({ projectId: projectA })}
        )
      `;

      await assert.rejects(async () => {
        await db`
          UPDATE audit_events
          SET action = 'tampered'
          WHERE id = ${auditId}
        `;
      });
    } finally {
      await db.end();
    }
  },
);
