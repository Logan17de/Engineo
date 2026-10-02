import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";
import type { EngineProjectInputV1, EngineScheduleResultV1 } from "@engineo/contracts";
import { buildApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { ProcessScheduleRunner } from "./scheduler/runner.js";
import { issueSession } from "./security/session.js";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL is not configured";

test("Planner routes persist, calculate and audit tenant-scoped revisioned edits", {
  skip,
}, async (t) => {
  const binaryPath = process.env.ENGINEO_SCHEDULER_BIN;
  assert.ok(
    binaryPath,
    "Build engineo-schedule and set ENGINEO_SCHEDULER_BIN; real engine integration must not be silently skipped",
  );
  await access(binaryPath);
  const db = createDatabase();
  await migrateDatabase(db);
  const app = buildApp({ database: db, scheduleRunner: new ProcessScheduleRunner({ binaryPath }) });
  const org = randomUUID();
  const foreignOrg = randomUUID();
  const owner = randomUUID();
  const viewer = randomUUID();
  const foreignUser = randomUUID();
  const email = `${owner}@example.test`;
  try {
    await db`INSERT INTO organizations (id, slug, name) VALUES (${org}, ${org}, 'Planner'), (${foreignOrg}, ${foreignOrg}, 'Foreign')`;
    await db`INSERT INTO users (id, email) VALUES (${owner}, ${email}), (${viewer}, ${`${viewer}@example.test`}), (${foreignUser}, ${`${foreignUser}@example.test`})`;
    await db`INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (${org}, ${owner}, 'owner'), (${org}, ${viewer}, 'viewer'), (${foreignOrg}, ${foreignUser}, 'owner')`;
    const auth = await issueSession(db, owner, email, null, undefined);
    const viewAuth = await issueSession(db, viewer, `${viewer}@example.test`, null, undefined);
    const otherAuth = await issueSession(
      db,
      foreignUser,
      `${foreignUser}@example.test`,
      null,
      undefined,
    );
    const headers = {
      cookie: `engineo_session=${auth.token}; engineo_csrf=${auth.csrfToken}`,
      "x-csrf-token": auth.csrfToken,
    };
    const viewerHeaders = {
      cookie: `engineo_session=${viewAuth.token}; engineo_csrf=${viewAuth.csrfToken}`,
      "x-csrf-token": viewAuth.csrfToken,
    };
    const foreignHeaders = {
      cookie: `engineo_session=${otherAuth.token}; engineo_csrf=${otherAuth.csrfToken}`,
      "x-csrf-token": otherAuth.csrfToken,
    };
    const create = await app.inject({
      method: "POST",
      url: `/organizations/${org}/projects`,
      headers,
      payload: { name: "Bridge", plannedStart: "2026-10-05T08:00:00Z", timeZone: "UTC" },
    });
    assert.equal(create.statusCode, 201, create.body);
    const project = create.json<{
      projectId: string;
      calendarId: string;
      rootWbsId: string;
      revision: number;
    }>();
    const url = `/organizations/${org}/projects/${project.projectId}`;
    const read = async () => {
      const response = await app.inject({ method: "GET", url: `${url}/schedule`, headers });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<{
        revision: number;
        input: EngineProjectInputV1;
        relationshipIds: string[];
      }>();
    };
    await db`INSERT INTO project_memberships (organization_id, project_id, user_id, role) VALUES (${org}, ${project.projectId}, ${viewer}, 'viewer')`;

    await t.test("schemas, authentication, CSRF, role and tenant denial", async () => {
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
      assert.equal(
        (await app.inject({ method: "GET", url, headers: foreignHeaders })).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: `/organizations/${foreignOrg}/projects/${project.projectId}`,
            headers,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: `${url}/schedule`, headers: viewerHeaders }))
          .statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `${url}/activities`,
            headers: viewerHeaders,
            payload: {
              expectedRevision: 1,
              name: "Denied",
              wbsId: project.rootWbsId,
              calendarId: project.calendarId,
              kind: "TASK",
              durationMinutes: 480,
            },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `${url}/schedule/run`,
            headers: { cookie: headers.cookie },
            payload: { expectedRevision: 1 },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/organizations/${org}/projects`,
            headers,
            payload: { name: 123 },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (await app.inject({ method: "GET", url: `/organizations/not-uuid/projects`, headers }))
          .statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/organizations/${org}/projects`,
            headers,
            payload: {
              name: "Invalid date",
              plannedStart: "2026-02-31T08:00:00Z",
              timeZone: "UTC",
            },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `${url}/activities`,
            headers,
            payload: {
              expectedRevision: "1",
              name: "Invalid",
              wbsId: project.rootWbsId,
              calendarId: project.calendarId,
              kind: "TASK",
              durationMinutes: 480,
            },
          })
        ).statusCode,
        400,
      );
      assert.equal((await read()).revision, 1);
    });

    let revision = 1;
    await t.test("WBS, calendar and activity inputs reject invalid values atomically", async () => {
      const wbs = await app.inject({
        method: "POST",
        url: `${url}/wbs`,
        headers,
        payload: {
          expectedRevision: revision,
          parentId: project.rootWbsId,
          code: "1.1",
          name: "Civil",
        },
      });
      assert.equal(wbs.statusCode, 201, wbs.body);
      revision = wbs.json<{ revision: number }>().revision;
      const input = (await read()).input;
      const calendar = input.calendars[0];
      assert.ok(calendar);
      const invalidWeek = structuredClone(calendar.week);
      invalidWeek.MONDAY.push({ start: "09:00", end: "11:00" });
      const invalid = await app.inject({
        method: "POST",
        url: `${url}/calendars`,
        headers,
        payload: {
          expectedRevision: revision,
          name: "Overlap",
          timeZone: "UTC",
          week: invalidWeek,
        },
      });
      assert.equal(invalid.statusCode, 422, invalid.body);
      assert.equal((await read()).input.calendars.length, 1);
      assert.equal((await read()).revision, revision);
      const milestone = await app.inject({
        method: "POST",
        url: `${url}/activities`,
        headers,
        payload: {
          expectedRevision: revision,
          wbsId: project.rootWbsId,
          calendarId: project.calendarId,
          name: "Bad milestone",
          kind: "START_MILESTONE",
          durationMinutes: 60,
        },
      });
      assert.equal(milestone.statusCode, 422, milestone.body);
      const foreignReference = await app.inject({
        method: "POST",
        url: `${url}/activities`,
        headers,
        payload: {
          expectedRevision: revision,
          wbsId: randomUUID(),
          calendarId: project.calendarId,
          name: "Unknown WBS",
          kind: "TASK",
          durationMinutes: 60,
        },
      });
      assert.equal(foreignReference.statusCode, 422, foreignReference.body);
      assert.equal((await read()).revision, revision);
    });

    let first = "";
    let second = "";
    await t.test(
      "real Rust dates, relationships, float and controlling path agree with persisted inputs",
      async () => {
        for (const [name, duration] of [
          ["Foundation", 480],
          ["Structure", 960],
        ] as const) {
          const response = await app.inject({
            method: "POST",
            url: `${url}/activities`,
            headers,
            payload: {
              expectedRevision: revision,
              wbsId: project.rootWbsId,
              calendarId: project.calendarId,
              name,
              kind: "TASK",
              durationMinutes: duration,
            },
          });
          assert.equal(response.statusCode, 201, response.body);
          const row = response.json<{ id: string; revision: number }>();
          if (!first) first = row.id;
          else second = row.id;
          revision = row.revision;
        }
        const link = await app.inject({
          method: "POST",
          url: `${url}/relationships`,
          headers,
          payload: {
            expectedRevision: revision,
            predecessorId: first,
            successorId: second,
            type: "FS",
            lagMinutes: 0,
          },
        });
        assert.equal(link.statusCode, 201, link.body);
        revision = link.json<{ revision: number }>().revision;
        const run = await app.inject({
          method: "POST",
          url: `${url}/schedule/run`,
          headers,
          payload: { expectedRevision: revision },
        });
        assert.equal(run.statusCode, 200, run.body);
        const calculated = run.json<{ revision: number; result: EngineScheduleResultV1 }>();
        assert.equal(calculated.revision, revision);
        assert.equal(
          Date.parse(calculated.result.projectFinish),
          Date.parse("2026-10-07T17:00:00Z"),
        );
        assert.equal(
          Date.parse(calculated.result.activities[first]?.earlyFinish ?? ""),
          Date.parse("2026-10-05T17:00:00Z"),
        );
        assert.equal(
          Date.parse(calculated.result.activities[second]?.earlyStart ?? ""),
          Date.parse("2026-10-06T08:00:00Z"),
        );
        assert.equal(calculated.result.activities[first]?.totalFloatMinutes, 0);
        assert.deepEqual(calculated.result.controllingPath, [first, second]);
        const cycle = await app.inject({
          method: "POST",
          url: `${url}/relationships`,
          headers,
          payload: {
            expectedRevision: revision,
            predecessorId: second,
            successorId: first,
            type: "FS",
            lagMinutes: 0,
          },
        });
        assert.equal(cycle.statusCode, 422, cycle.body);
        assert.equal((await read()).revision, revision);
      },
    );

    await t.test(
      "bulk edit persists 1000 activities; competing and repeated edits preserve one revision",
      async () => {
        const snapshot = await read();
        for (let i = snapshot.input.activities.length; i < 1000; i++)
          snapshot.input.activities.push({
            id: randomUUID(),
            wbsId: project.rootWbsId,
            calendarId: project.calendarId,
            name: `Work ${i + 1}`,
            kind: "TASK",
            durationMinutes: 480,
            constraints: [],
          });
        const start = performance.now();
        const put = await app.inject({
          method: "PUT",
          url: `${url}/schedule`,
          headers,
          payload: { expectedRevision: revision, input: snapshot.input },
        });
        assert.equal(put.statusCode, 200, put.body);
        revision = put.json<{ revision: number }>().revision;
        const run = await app.inject({
          method: "POST",
          url: `${url}/schedule/run`,
          headers,
          payload: { expectedRevision: revision },
        });
        assert.equal(run.statusCode, 200, run.body);
        assert.equal(
          Object.keys(run.json<{ result: EngineScheduleResultV1 }>().result.activities).length,
          1000,
        );
        assert.equal((await read()).input.activities.length, 1000);
        console.log(
          `Planner 1000 activity save + real Rust run + read: ${(performance.now() - start).toFixed(1)} ms`,
        );
        const current = (await read()).input;
        const alternative = structuredClone(current);
        alternative.project.name = "Competing name";
        const edits = await Promise.all(
          [current, alternative].map((input) =>
            app.inject({
              method: "PUT",
              url: `${url}/schedule`,
              headers,
              payload: { expectedRevision: revision, input },
            }),
          ),
        );
        assert.deepEqual(edits.map((response) => response.statusCode).sort(), [200, 409]);
        const staleRun = await app.inject({
          method: "POST",
          url: `${url}/schedule/run`,
          headers,
          payload: { expectedRevision: revision },
        });
        assert.equal(staleRun.statusCode, 409);
        const retry = await app.inject({
          method: "PUT",
          url: `${url}/schedule`,
          headers,
          payload: { expectedRevision: revision, input: current },
        });
        assert.equal(retry.statusCode, 409);
        revision++;
        assert.equal((await read()).revision, revision);
      },
    );

    await t.test(
      "audit fault rolls edits and project creation back; retry records one committed change",
      async () => {
        const before = await read();
        const projectCount = Number(
          (await db`SELECT count(*)::int AS count FROM projects WHERE organization_id = ${org}`)[0]
            ?.count,
        );
        await db.unsafe(`CREATE FUNCTION engineo_test_planner_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action IN ('project.schedule.edit', 'project.create') THEN RAISE EXCEPTION 'private planner audit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER engineo_test_planner_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION engineo_test_planner_audit_failure();`);
        const input = structuredClone(before.input);
        input.project.name = "Retry name";
        const failed = await app.inject({
          method: "PUT",
          url: `${url}/schedule`,
          headers,
          payload: { expectedRevision: revision, input },
        });
        assert.equal(failed.statusCode, 500);
        assert.equal(failed.body.includes("private"), false);
        assert.deepEqual((await read()).input, before.input);
        assert.equal((await read()).revision, revision);
        const failedCreate = await app.inject({
          method: "POST",
          url: `/organizations/${org}/projects`,
          headers,
          payload: {
            name: "Must roll back",
            plannedStart: "2026-10-05T08:00:00Z",
            timeZone: "UTC",
          },
        });
        assert.equal(failedCreate.statusCode, 500);
        assert.equal(
          Number(
            (
              await db`SELECT count(*)::int AS count FROM projects WHERE organization_id = ${org}`
            )[0]?.count,
          ),
          projectCount,
        );
        await db.unsafe(
          "DROP TRIGGER engineo_test_planner_audit_failure ON audit_events; DROP FUNCTION engineo_test_planner_audit_failure();",
        );
        const retry = await app.inject({
          method: "PUT",
          url: `${url}/schedule`,
          headers,
          payload: { expectedRevision: revision, input },
        });
        assert.equal(retry.statusCode, 200, retry.body);
        revision++;
        const audits =
          await db`SELECT payload FROM audit_events WHERE organization_id = ${org} AND resource_id = ${project.projectId} AND action = 'project.schedule.edit' AND (payload->>'revision')::bigint = ${revision}`;
        assert.equal(audits.length, 1);
        assert.equal(audits[0]?.payload.before.project.name, before.input.project.name);
        assert.equal(audits[0]?.payload.after.project.name, "Retry name");
      },
    );
  } finally {
    await db.unsafe(
      "DROP TRIGGER IF EXISTS engineo_test_planner_audit_failure ON audit_events; DROP FUNCTION IF EXISTS engineo_test_planner_audit_failure();",
    );
    await app.close();
    await db.end({ timeout: 5 });
  }
});
