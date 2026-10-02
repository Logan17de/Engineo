import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import test from "node:test";
import type { EngineScheduleResultV1 } from "@engineo/contracts";
import { buildApp } from "./app.js";
import { createDatabase, type DatabaseExecutor } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { tenantContext } from "./db/tenant-context.js";
import { PlannerRepository } from "./repositories/planner-repository.js";
import { ProjectRepository } from "./repositories/project-repository.js";
import { ProcessScheduleRunner, ScheduleEngineError } from "./scheduler/runner.js";
import { issueSession } from "./security/session.js";

test("Planner boundary regressions use genuine tenant data and database snapshots", {
  skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not configured",
  timeout: 20_000,
}, async (t) => {
  const binaryPath = process.env.ENGINEO_SCHEDULER_BIN;
  assert.ok(binaryPath);
  const db = createDatabase();
  await migrateDatabase(db);
  const app = buildApp({ database: db });
  const org = randomUUID(),
    otherOrg = randomUUID(),
    user = randomUUID(),
    otherUser = randomUUID();
  const planner = new PlannerRepository(db);
  try {
    await db`INSERT INTO organizations (id, slug, name) VALUES (${org}, ${org}, 'Boundary'), (${otherOrg}, ${otherOrg}, 'Foreign')`;
    await db`INSERT INTO users (id, email) VALUES (${user}, ${`${user}@example.test`}), (${otherUser}, ${`${otherUser}@example.test`})`;
    await db`INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (${org}, ${user}, 'owner'), (${otherOrg}, ${otherUser}, 'owner')`;
    const context = tenantContext(org, user, "boundary-fixture");
    const foreignContext = tenantContext(otherOrg, otherUser, "boundary-fixture");
    const definition = {
      name: "Project",
      code: null,
      description: null,
      plannedStart: "2026-10-05T08:00:00Z",
      timeZone: "UTC",
    };
    const project = await planner.createProject(context, definition);
    const foreignProject = await planner.createProject(foreignContext, definition);
    const foreign = await planner.createActivity(foreignContext, foreignProject.projectId, 1, {
      name: "Foreign activity",
      wbsId: foreignProject.rootWbsId,
      calendarId: foreignProject.calendarId,
      kind: "TASK",
      durationMinutes: 480,
      constraints: [],
      sortOrder: 0,
    });
    const own = await planner.createActivity(context, project.projectId, 1, {
      name: "Own activity",
      wbsId: project.rootWbsId,
      calendarId: project.calendarId,
      kind: "TASK",
      durationMinutes: 480,
      constraints: [],
      sortOrder: 0,
    });
    let revision = own.revision;
    const session = await issueSession(db, user, `${user}@example.test`, null, undefined);
    const headers = {
      cookie: `engineo_session=${session.token}; engineo_csrf=${session.csrfToken}`,
      "x-csrf-token": session.csrfToken,
    };
    const url = `/organizations/${org}/projects/${project.projectId}`;
    const read = () => new ProjectRepository(db).plannerSnapshot(context, project.projectId);

    await t.test("organization creation and exact engine timezone identifiers", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/organizations",
        headers,
        payload: { name: "New team", slug: randomUUID() },
      });
      assert.equal(create.statusCode, 201, create.body);
      const organizations = await app.inject({ method: "GET", url: "/organizations", headers });
      assert.equal(organizations.statusCode, 200);
      const ids = organizations
        .json<{ organizations: Array<{ id: string }> }>()
        .organizations.map((org) => org.id);
      assert.ok(ids.includes(org));
      assert.ok(ids.includes(create.json<{ id: string }>().id));
      assert.ok(!ids.includes(otherOrg));
      for (const timeZone of ["+01:00", "utc", "asia/tokyo"]) {
        const response = await app.inject({
          method: "POST",
          url: `/organizations/${org}/projects`,
          headers,
          payload: {
            name: "Invalid zone",
            plannedStart: definition.plannedStart,
            timeZone,
          },
        });
        assert.equal(response.statusCode, 400, response.body);
        const snapshot = await read();
        assert.ok(snapshot);
        const calendar = snapshot.input.calendars[0];
        assert.ok(calendar);
        calendar.timeZone = timeZone;
        const put = await app.inject({
          method: "PUT",
          url: `${url}/schedule`,
          headers,
          payload: { expectedRevision: revision, input: snapshot.input },
        });
        assert.equal(put.statusCode, 422, put.body);
        assert.equal((await read())?.revision, revision);
      }
    });

    await t.test(
      "real foreign WBS, calendar, activity and parent IDs never cross tenant scope",
      async () => {
        for (const [wbsId, calendarId] of [
          [foreignProject.rootWbsId, project.calendarId],
          [project.rootWbsId, foreignProject.calendarId],
        ]) {
          const response = await app.inject({
            method: "POST",
            url: `${url}/activities`,
            headers,
            payload: {
              expectedRevision: revision,
              name: "Substitution",
              wbsId,
              calendarId,
              kind: "TASK",
              durationMinutes: 60,
            },
          });
          assert.equal(response.statusCode, 422, response.body);
        }
        const parent = await app.inject({
          method: "POST",
          url: `${url}/wbs`,
          headers,
          payload: {
            expectedRevision: revision,
            parentId: foreignProject.rootWbsId,
            name: "Foreign parent",
            code: "2",
          },
        });
        assert.equal(parent.statusCode, 422, parent.body);
        const link = await app.inject({
          method: "POST",
          url: `${url}/relationships`,
          headers,
          payload: {
            expectedRevision: revision,
            predecessorId: foreign.id,
            successorId: own.id,
            type: "FS",
            lagMinutes: 0,
          },
        });
        assert.equal(link.statusCode, 422, link.body);
        const deleted = await app.inject({
          method: "DELETE",
          url: `${url}/activities/${foreign.id}`,
          headers,
          payload: { expectedRevision: revision },
        });
        assert.equal(deleted.statusCode, 404);
        assert.equal((await read())?.revision, revision);
        assert.equal(
          Number(
            (await db`SELECT count(*)::int AS count FROM activities WHERE id = ${foreign.id}`)[0]
              ?.count,
          ),
          1,
        );
      },
    );

    await t.test(
      "reader overlapping a committed writer returns its complete older revision",
      async () => {
        const before = await read();
        assert.ok(before);
        let paused: () => void = () => {};
        let resume: () => void = () => {};
        const chosen = new Promise<void>((resolve) => {
          paused = resolve;
        });
        const release = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const coordinatedDb = new Proxy(db, {
          get(target, property, receiver) {
            if (property !== "begin") return Reflect.get(target, property, receiver);
            return async (
              isolation: string,
              callback: (sql: DatabaseExecutor) => Promise<unknown>,
            ) => {
              assert.equal(isolation, "isolation level repeatable read read only");
              return await target.begin(isolation, async (sql) => {
                await sql`SELECT revision FROM projects WHERE id = ${project.projectId}`;
                paused();
                await release;
                return await callback(sql);
              });
            };
          },
        });
        const inFlight = new ProjectRepository(coordinatedDb).plannerSnapshot(
          context,
          project.projectId,
        );
        try {
          await chosen;
          const input = structuredClone(before.input);
          input.project.name = "Committed writer";
          const activity = input.activities[0];
          assert.ok(activity);
          activity.name = "New activity name";
          const update = await app.inject({
            method: "PUT",
            url: `${url}/schedule`,
            headers,
            payload: { expectedRevision: revision, input },
          });
          assert.equal(update.statusCode, 200, update.body);
          revision++;
        } finally {
          resume();
        }
        const old = await inFlight;
        assert.ok(old);
        assert.equal(old.revision, before.revision);
        assert.deepEqual(old.input, before.input);
        assert.equal((await read())?.revision, revision);
      },
    );

    await t.test(
      "deletion, cascade and not-found/stale rollback have one revision and audit",
      async () => {
        const activity = await planner.createActivity(context, project.projectId, revision, {
          name: "Delete me",
          wbsId: project.rootWbsId,
          calendarId: project.calendarId,
          kind: "TASK",
          durationMinutes: 480,
          constraints: [],
          sortOrder: 1,
        });
        revision = activity.revision;
        const createLink = () =>
          app.inject({
            method: "POST",
            url: `${url}/relationships`,
            headers,
            payload: {
              expectedRevision: revision,
              predecessorId: own.id,
              successorId: activity.id,
              type: "FS",
              lagMinutes: 0,
            },
          });
        const link = await createLink();
        assert.equal(link.statusCode, 201, link.body);
        revision++;
        const id = link.json<{ id: string }>().id;
        const stale = await app.inject({
          method: "DELETE",
          url: `${url}/relationships/${id}`,
          headers,
          payload: { expectedRevision: revision - 1 },
        });
        assert.equal(stale.statusCode, 409);
        const remove = await app.inject({
          method: "DELETE",
          url: `${url}/relationships/${id}`,
          headers,
          payload: { expectedRevision: revision },
        });
        assert.equal(remove.statusCode, 200, remove.body);
        revision++;
        const missing = await app.inject({
          method: "DELETE",
          url: `${url}/relationships/${id}`,
          headers,
          payload: { expectedRevision: revision },
        });
        assert.equal(missing.statusCode, 404);
        assert.equal((await read())?.revision, revision);
        const relink = await createLink();
        assert.equal(relink.statusCode, 201, relink.body);
        revision++;
        const deleted = await app.inject({
          method: "DELETE",
          url: `${url}/activities/${activity.id}`,
          headers,
          payload: { expectedRevision: revision },
        });
        assert.equal(deleted.statusCode, 200, deleted.body);
        revision++;
        const after = await read();
        assert.ok(after);
        assert.equal(after.revision, revision);
        assert.ok(!after.input.activities.some((row) => row.id === activity.id));
        assert.equal(after.input.relationships.length, 0);
        const audits =
          await db`SELECT payload FROM audit_events WHERE resource_id = ${project.projectId}
        AND action = 'project.schedule.edit' AND (payload->>'revision')::bigint = ${revision}`;
        assert.equal(audits.length, 1);
        assert.equal(audits[0]?.payload.before.activities.length, 2);
        assert.equal(audits[0]?.payload.after.activities.length, 1);
      },
    );

    await t.test(
      "HTTP disconnect after full POST body cancels calculation and allows real-engine retry",
      async () => {
        let started: () => void = () => {};
        let cancelled: () => void = () => {};
        const start = new Promise<void>((resolve) => {
          started = resolve;
        });
        const abort = new Promise<void>((resolve) => {
          cancelled = resolve;
        });
        let observedAbort = false;
        let calls = 0,
          busy = false;
        const real = new ProcessScheduleRunner({ binaryPath, maxConcurrent: 1 });
        const cancellable = buildApp({
          database: db,
          scheduleRunner: {
            async calculate(input, signal) {
              if (calls++ > 0) {
                assert.equal(busy, false);
                return await real.calculate(input, signal);
              }
              busy = true;
              try {
                return await new Promise<EngineScheduleResultV1>((_, reject) => {
                  const timeout = setTimeout(() => {
                    cancelled();
                    reject(new Error("HTTP cancellation did not reach runner"));
                  }, 3000);
                  signal?.addEventListener(
                    "abort",
                    () => {
                      clearTimeout(timeout);
                      observedAbort = true;
                      cancelled();
                      reject(new ScheduleEngineError("schedule_cancelled", 409, "Cancelled"));
                    },
                    { once: true },
                  );
                  started();
                });
              } finally {
                busy = false;
              }
            },
          },
        });
        await cancellable.listen({ host: "127.0.0.1", port: 0 });
        const address = cancellable.server.address();
        assert.ok(address && typeof address !== "string");
        const request = httpRequest({
          host: "127.0.0.1",
          port: address.port,
          path: `${url}/schedule/run`,
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
        });
        request.on("error", () => {});
        try {
          request.end(JSON.stringify({ expectedRevision: revision }));
          await start;
          request.destroy();
          await abort;
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(observedAbort, true, "Client disconnect must abort the runner signal");
          assert.equal(busy, false);
          const retry = await cancellable.inject({
            method: "POST",
            url: `${url}/schedule/run`,
            headers,
            payload: { expectedRevision: revision },
          });
          assert.equal(retry.statusCode, 200, retry.body);
        } finally {
          request.destroy();
          await cancellable.close();
        }
      },
    );
  } finally {
    await app.close();
    await db.end({ timeout: 5 });
  }
});
