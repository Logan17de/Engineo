import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  type EngineProjectInputV1,
  type EngineScheduleResultV1,
  MAX_WORK_MINUTES,
  WEEKDAYS,
} from "@engineo/contracts";
import { buildApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { issueSession } from "./security/session.js";

test("signed lag save/run boundaries agree with Rust and reject legacy invalid rows", {
  skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not configured",
}, async () => {
  assert.ok(process.env.ENGINEO_SCHEDULER_BIN, "Real schedule binary must be configured");
  const db = createDatabase();
  await migrateDatabase(db);
  const app = buildApp({ database: db });
  const org = randomUUID();
  const user = randomUUID();
  try {
    await db`INSERT INTO organizations (id,slug,name) VALUES (${org},${org},'Lag boundaries')`;
    await db`INSERT INTO users (id,email) VALUES (${user},${`${user}@example.test`})`;
    await db`INSERT INTO organization_memberships (organization_id,user_id,role) VALUES (${org},${user},'owner')`;
    const auth = await issueSession(db, user, `${user}@example.test`, null, undefined);
    const headers = {
      cookie: `engineo_session=${auth.token}; engineo_csrf=${auth.csrfToken}`,
      "x-csrf-token": auth.csrfToken,
    };
    const created = await app.inject({
      method: "POST",
      url: `/organizations/${org}/projects`,
      headers,
      payload: { name: "Lag bounds", plannedStart: "2026-10-05T08:00:00Z", timeZone: "UTC" },
    });
    assert.equal(created.statusCode, 201, created.body);
    const project = created.json<{ projectId: string; calendarId: string; rootWbsId: string }>();
    const url = `/organizations/${org}/projects/${project.projectId}/schedule`;
    const snapshot = (await app.inject({ method: "GET", url, headers })).json<{
      revision: number;
      input: EngineProjectInputV1;
    }>();
    const first = randomUUID(),
      second = randomUUID();
    const input = snapshot.input;
    input.activities = [first, second].map((id) => ({
      id,
      wbsId: project.rootWbsId,
      calendarId: project.calendarId,
      name: id,
      kind: "TASK",
      durationMinutes: 480,
      constraints: [],
    }));
    input.relationships = [
      { predecessorId: first, successorId: second, type: "FS", lagMinutes: 0 },
    ];
    const relationship = input.relationships[0];
    const calendar = input.calendars[0];
    assert.ok(relationship);
    assert.ok(calendar);
    let revision = snapshot.revision;
    const save = () =>
      app.inject({ method: "PUT", url, headers, payload: { expectedRevision: revision, input } });
    const run = () =>
      app.inject({
        method: "POST",
        url: `${url}/run`,
        headers,
        payload: { expectedRevision: revision },
      });
    for (const sign of [-1, 1]) {
      relationship.lagMinutes = sign * (MAX_WORK_MINUTES + 1);
      const rejected = await save();
      assert.equal(rejected.statusCode, 400, rejected.body);
      const rejectedRelationship = await app.inject({
        method: "POST",
        url: `/organizations/${org}/projects/${project.projectId}/relationships`,
        headers,
        payload: { expectedRevision: revision, ...input.relationships[0] },
      });
      assert.equal(rejectedRelationship.statusCode, 400, rejectedRelationship.body);
      assert.equal((await app.inject({ method: "GET", url, headers })).json().revision, revision);
      assert.equal(
        (
          await db`SELECT count(*)::int AS count FROM relationships WHERE project_id=${project.projectId}`
        )[0]?.count,
        0,
      );
    }
    for (const lag of [-480, 480]) {
      relationship.lagMinutes = lag;
      const saved = await save();
      assert.equal(saved.statusCode, 200, saved.body);
      revision = saved.json<{ revision: number }>().revision;
      const calculated = await run();
      assert.equal(calculated.statusCode, 200, calculated.body);
      const result = calculated.json<{ result: EngineScheduleResultV1 }>().result;
      assert.equal(
        Date.parse(result.projectFinish),
        Date.parse(lag < 0 ? "2026-10-05T17:00:00Z" : "2026-10-07T17:00:00Z"),
      );
    }
    // An empty calendar bounds the run at its documented search horizon, so the
    // numeric edges do not require millions of working-day iterations in CI.
    for (const day of WEEKDAYS) calendar.week[day] = [];
    for (const sign of [-1, 1]) {
      relationship.lagMinutes = sign * MAX_WORK_MINUTES;
      const saved = await save();
      assert.equal(saved.statusCode, 200, saved.body);
      revision = saved.json<{ revision: number }>().revision;
      const calculated = await run();
      assert.equal(calculated.statusCode, 422, calculated.body);
      assert.equal(calculated.json().error, "invalid_schedule");
      assert.match(calculated.json().message, /no working time found within search horizon/);
      assert.doesNotMatch(calculated.body, /lag is outside supported range/);
      // Simulate data written before the corrected API/contract gate. Run must
      // reject it before starting the engine, preserving the stored revision.
      await db`UPDATE relationships SET lag_minutes=${sign * (MAX_WORK_MINUTES + 1)} WHERE project_id=${project.projectId}`;
      const invalid = await run();
      assert.equal(invalid.statusCode, 422, invalid.body);
      assert.ok(
        invalid
          .json<{ issues: { code: string }[] }>()
          .issues.some((issue) => issue.code === "INVALID_LAG"),
      );
      assert.equal((await app.inject({ method: "GET", url, headers })).json().revision, revision);
    }
  } finally {
    await app.close();
    await db.end({ timeout: 5 });
  }
});
