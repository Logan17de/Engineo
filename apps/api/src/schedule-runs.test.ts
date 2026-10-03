import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import test from "node:test";
import {
  type EngineProjectInputV1,
  type ScheduleCalculationV1,
  serializeScheduleInputV1,
} from "@engineo/contracts";
import type { LightMyRequestResponse } from "fastify";
import { buildApp } from "./app.js";
import { createDatabase, type DatabaseExecutor } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { tenantContext } from "./db/tenant-context.js";
import { readPlannerSnapshot } from "./repositories/project-repository.js";
import { ScheduleRunRepository } from "./repositories/schedule-run-repository.js";
import {
  ProcessScheduleRunner,
  ScheduleEngineError,
  type ScheduleRunner,
} from "./scheduler/runner.js";
import { SCHEDULE_JSON_MAX_BYTES } from "./scheduler/size.js";
import { issueSession } from "./security/session.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForValue<T>(read: () => Promise<T | undefined>, message: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

test("schedule results survive restarts with atomic audit and current authorization/revision", {
  skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not configured",
}, async (t) => {
  const binaryPath = process.env.ENGINEO_SCHEDULER_BIN;
  assert.ok(binaryPath, "Build and configure the real engine; do not silently skip integration");
  await access(binaryPath);
  const db = createDatabase();
  await migrateDatabase(db);
  const real = new ProcessScheduleRunner({ binaryPath });
  let calculationCalls = 0;
  const gate: {
    current: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null;
  } = { current: null };
  const runner: ScheduleRunner = {
    async calculate(input, signal) {
      calculationCalls++;
      const current = gate.current;
      const result = await real.calculate(input, signal);
      if (current) {
        current.entered.resolve();
        await current.release.promise;
      }
      return result;
    },
  };
  let app = buildApp({ database: db, scheduleRunner: runner });
  const org = randomUUID(),
    foreignOrg = randomUUID();
  const owner = randomUUID(),
    viewer = randomUUID(),
    foreign = randomUUID();
  let auth = await issueFixtureSession(owner);
  async function issueFixtureSession(userId: string) {
    const rows = await db`SELECT id FROM users WHERE id = ${userId}`;
    if (rows.length === 0) {
      await db`INSERT INTO users (id,email) VALUES (${userId},${`${userId}@example.test`})`;
    }
    const session = await issueSession(db, userId, `${userId}@example.test`, null, undefined);
    return {
      sessionId: session.principal.sessionId,
      headers: {
        cookie: `engineo_session=${session.token}; engineo_csrf=${session.csrfToken}`,
        "x-csrf-token": session.csrfToken,
      },
    };
  }
  try {
    const viewAuth = await issueFixtureSession(viewer);
    const foreignAuth = await issueFixtureSession(foreign);
    await db`INSERT INTO organizations (id,slug,name) VALUES (${org},${org},'Durable schedule'),(${foreignOrg},${foreignOrg},'Foreign')`;
    await db`INSERT INTO organization_memberships (organization_id,user_id,role) VALUES (${org},${owner},'owner'),(${org},${viewer},'viewer'),(${foreignOrg},${foreign},'owner')`;
    const created = await app.inject({
      method: "POST",
      url: `/organizations/${org}/projects`,
      headers: auth.headers,
      payload: {
        name: "Persistent forecast",
        plannedStart: "2026-10-05T08:00:00Z",
        timeZone: "UTC",
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const projectId = created.json<{ projectId: string }>().projectId;
    const url = `/organizations/${org}/projects/${projectId}/schedule`;
    await db`INSERT INTO project_memberships (organization_id,project_id,user_id,role) VALUES (${org},${projectId},${viewer},'viewer')`;
    type Snapshot = {
      revision: number;
      input: EngineProjectInputV1;
      calculation: ScheduleCalculationV1 | null;
    };
    const read = async () => {
      const response = await app.inject({ method: "GET", url, headers: auth.headers });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<Snapshot>();
    };
    const counts = async () => {
      const runs =
        await db`SELECT count(*)::int AS count FROM schedule_runs WHERE organization_id=${org} AND project_id=${projectId}`;
      const audits =
        await db`SELECT count(*)::int AS count FROM audit_events WHERE organization_id=${org} AND resource_id=${projectId} AND action='schedule.run'`;
      return { runs: Number(runs[0]?.count), audits: Number(audits[0]?.count) };
    };
    const run = async (revision: number) =>
      await app.inject({
        method: "POST",
        url: `${url}/run`,
        headers: auth.headers,
        payload: { expectedRevision: revision },
      });
    const edit = async (name: string) => {
      const current = await read();
      const changed = structuredClone(current.input);
      const activity = changed.activities[0];
      assert.ok(activity);
      activity.name = name;
      const response = await app.inject({
        method: "PUT",
        url,
        headers: auth.headers,
        payload: { expectedRevision: current.revision, input: changed },
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<{ revision: number }>().revision;
    };
    const initial = await read();
    assert.equal(initial.calculation, null);
    const firstId = randomUUID(),
      secondId = randomUUID();
    const input = initial.input;
    input.activities = [firstId, secondId].map((id, index) => ({
      id,
      wbsId: input.wbs[0]?.id ?? "",
      calendarId: input.project.defaultCalendarId,
      name: `Package ${index + 1}`,
      kind: "TASK",
      durationMinutes: 480,
      constraints: [],
    }));
    input.relationships = [
      { predecessorId: firstId, successorId: secondId, type: "FS", lagMinutes: 0 },
    ];
    const save = await app.inject({
      method: "PUT",
      url,
      headers: auth.headers,
      payload: { expectedRevision: initial.revision, input },
    });
    assert.equal(save.statusCode, 200, save.body);
    let firstRunId = "";

    await t.test(
      "real result and exact hash bytes survive application restart and viewer reads",
      async () => {
        const current = await read();
        const response = await run(current.revision);
        assert.equal(response.statusCode, 200, response.body);
        const data = response.json<{
          run: Omit<ScheduleCalculationV1, "result">;
          result: ScheduleCalculationV1["result"];
        }>();
        firstRunId = data.run.id;
        assert.equal(Date.parse(data.result.projectFinish), Date.parse("2026-10-06T17:00:00Z"));
        assert.match(data.run.completedAt, /^2026-/);
        await app.close();
        app = buildApp({ database: db, scheduleRunner: runner });
        const persisted = await read();
        assert.equal(persisted.calculation?.id, firstRunId);
        assert.deepEqual(persisted.calculation?.result, data.result);
        const rows =
          await db`SELECT input_bytes,result_bytes,input_hash,result_hash,created_by FROM schedule_runs WHERE id=${firstRunId}`;
        assert.equal(rows[0]?.created_by, owner);
        assert.equal(rows[0]?.input_bytes, serializeScheduleInputV1(persisted.input));
        for (const column of ["input", "result"]) {
          assert.equal(
            createHash("sha256")
              .update(String(rows[0]?.[`${column}_bytes`]))
              .digest("hex"),
            rows[0]?.[`${column}_hash`],
          );
        }
        const audit =
          await db`SELECT payload FROM audit_events WHERE organization_id=${org} AND action='schedule.run' AND payload->>'runId'=${firstRunId}`;
        assert.equal(audit.length, 1);
        assert.equal(audit[0]?.payload.resultHash, data.run.resultHash);
        const view = await app.inject({ method: "GET", url, headers: viewAuth.headers });
        assert.equal(view.statusCode, 200, view.body);
        assert.equal(view.json<Snapshot>().calculation?.id, firstRunId);
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: `${url}/run`,
              headers: viewAuth.headers,
              payload: { expectedRevision: current.revision },
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (await app.inject({ method: "GET", url, headers: foreignAuth.headers })).statusCode,
          403,
        );
        assert.deepEqual(await counts(), { runs: 1, audits: 1 });
      },
    );

    await t.test("audit failure rolls back result insertion and retry commits once", async () => {
      const before = await counts();
      await db.unsafe(
        `CREATE FUNCTION engineo_test_fail_run_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='schedule.run' THEN RAISE EXCEPTION 'private result audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER engineo_test_fail_run_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION engineo_test_fail_run_audit();`,
      );
      try {
        const failed = await run((await read()).revision);
        assert.equal(failed.statusCode, 500, failed.body);
        assert.equal(failed.body, '{"error":"internal_error"}');
        assert.deepEqual(await counts(), before);
        assert.equal((await read()).calculation?.id, firstRunId);
      } finally {
        await db.unsafe(
          "DROP TRIGGER engineo_test_fail_run_audit ON audit_events; DROP FUNCTION engineo_test_fail_run_audit();",
        );
      }
      const retry = await run((await read()).revision);
      assert.equal(retry.statusCode, 200, retry.body);
      assert.notEqual(retry.json<{ run: { id: string } }>().run.id, firstRunId);
      assert.deepEqual(await counts(), { runs: before.runs + 1, audits: before.audits + 1 });
    });

    await t.test("edits hide stale dates and preserve immutable prior snapshots", async () => {
      await edit("Changed saved package");
      assert.equal((await read()).calculation, null);
      await assert.rejects(
        db`UPDATE schedule_runs SET result_hash=${"0".repeat(64)} WHERE id=${firstRunId}`,
        /append-only/,
      );
      await assert.rejects(db`DELETE FROM schedule_runs WHERE id=${firstRunId}`, /append-only/);
      const rows = await db`SELECT input_bytes FROM schedule_runs WHERE id=${firstRunId}`;
      assert.ok(!String(rows[0]?.input_bytes).includes("Changed saved package"));
      const response = await run((await read()).revision);
      assert.equal(response.statusCode, 200, response.body);
      assert.ok((await read()).calculation);
    });

    async function heldRun(change: () => Promise<unknown>, status: number, error: string) {
      const current = await read();
      const before = await counts();
      gate.current = { entered: deferred(), release: deferred() };
      const waiting = gate.current;
      const responsePromise = run(current.revision);
      try {
        await Promise.race([
          waiting.entered.promise,
          responsePromise.then((response) => {
            throw new Error(`Calculation did not reach its gate: ${response.body}`);
          }),
        ]);
        await change();
      } finally {
        waiting.release.resolve();
        gate.current = null;
      }
      const response = await responsePromise;
      assert.equal(response.statusCode, status, response.body);
      assert.equal(response.json<{ error: string }>().error, error);
      assert.deepEqual(await counts(), before);
    }
    await t.test(
      "a concurrent edit rejects the completed old calculation before persistence",
      async () => {
        await heldRun(() => edit("Edited during calculation"), 409, "revision_conflict");
        assert.equal((await read()).calculation, null);
        const retry = await run((await read()).revision);
        assert.equal(retry.statusCode, 200, retry.body);
      },
    );
    await t.test("permission revocation during calculation cannot commit a result", async () => {
      try {
        await heldRun(
          async () => {
            await db`UPDATE organization_memberships SET role='viewer' WHERE organization_id=${org} AND user_id=${owner}`;
          },
          403,
          "forbidden",
        );
      } finally {
        await db`UPDATE organization_memberships SET role='owner' WHERE organization_id=${org} AND user_id=${owner}`;
      }
    });
    await t.test(
      "session revocation during calculation rejects persistence and a fresh session can retry",
      async () => {
        await heldRun(
          async () => {
            await db`UPDATE auth_sessions SET revoked_at=now() WHERE id=${auth.sessionId}`;
          },
          401,
          "unauthenticated",
        );
        auth = await issueFixtureSession(owner);
        const retry = await run((await read()).revision);
        assert.equal(retry.statusCode, 200, retry.body);
      },
    );
    await t.test("session expiry during calculation cannot persist a result", async () => {
      await heldRun(
        async () => {
          await db`UPDATE auth_sessions SET expires_at=created_at + interval '1 millisecond' WHERE id=${auth.sessionId}`;
        },
        401,
        "unauthenticated",
      );
      auth = await issueFixtureSession(owner);
      assert.equal((await run((await read()).revision)).statusCode, 200);
    });

    async function holdAuditInsert() {
      const entered = deferred();
      const release = deferred();
      let blockerPid = 0;
      const transaction = db.begin(async (sql) => {
        await sql`LOCK TABLE audit_events IN SHARE MODE`;
        const rows = await sql`SELECT pg_backend_pid()::int AS pid`;
        blockerPid = Number(rows[0]?.pid);
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      return {
        release,
        transaction,
        async waitingRequest() {
          const row = await waitForValue(async () => {
            const rows = await db`
              SELECT pid::int AS pid, query FROM pg_stat_activity
              WHERE ${blockerPid} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock'
            `;
            return rows[0];
          }, "Run did not reach the audit insert lock barrier");
          assert.match(String(row.query), /INSERT INTO audit_events/);
          return Number(row.pid);
        },
      };
    }

    await t.test(
      "expiry while the commit-stage audit insert is blocked rolls back both rows",
      async () => {
        const current = await read();
        const before = await counts();
        await db`UPDATE auth_sessions SET expires_at=clock_timestamp() + interval '3 seconds' WHERE id=${auth.sessionId}`;
        const held = await holdAuditInsert();
        const responsePromise = run(current.revision);
        try {
          await held.waitingRequest();
          // The result insert has executed inside the waiting transaction. It must
          // remain invisible, then roll back when the late session check fails.
          assert.deepEqual(await counts(), before);
          await db`
          SELECT pg_sleep(greatest(0, extract(epoch FROM expires_at - clock_timestamp())) + 0.05)
          FROM auth_sessions WHERE id=${auth.sessionId}
        `;
        } finally {
          held.release.resolve();
          await held.transaction;
        }
        const response = await responsePromise;
        assert.equal(response.statusCode, 401, response.body);
        assert.equal(response.json<{ error: string }>().error, "unauthenticated");
        assert.deepEqual(await counts(), before);
        auth = await issueFixtureSession(owner);
        assert.equal((await run((await read()).revision)).statusCode, 200);
      },
    );

    await t.test(
      "real client cancellation during the audit lock wait cannot commit a result",
      async () => {
        const current = await read();
        const before = await counts();
        const address = await app.listen({ host: "127.0.0.1", port: 0 });
        const closed = deferred();
        const observeClose: Parameters<typeof app.server.on>[1] = (request, response) => {
          if (request.method === "POST" && request.url === `${url}/run`)
            response.once("close", closed.resolve);
        };
        app.server.on("request", observeClose);
        const held = await holdAuditInsert();
        const controller = new AbortController();
        let requestPid = 0;
        const responsePromise = fetch(`${address}${url}/run`, {
          method: "POST",
          headers: { ...auth.headers, "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: current.revision }),
          signal: controller.signal,
        });
        try {
          requestPid = await held.waitingRequest();
          controller.abort();
          await assert.rejects(
            responsePromise,
            (error: unknown) => error instanceof Error && error.name === "AbortError",
          );
          await Promise.race([
            closed.promise,
            new Promise<never>((_, reject) => {
              const timeout = setTimeout(
                () => reject(new Error("Server did not observe client cancellation")),
                5_000,
              );
              timeout.unref();
            }),
          ]);
        } finally {
          controller.abort();
          held.release.resolve();
          await held.transaction;
          app.server.off("request", observeClose);
        }
        await waitForValue(async () => {
          const rows = await db`SELECT xact_start FROM pg_stat_activity WHERE pid=${requestPid}`;
          return rows.length === 0 || rows[0]?.xact_start === null ? true : undefined;
        }, "Cancelled run transaction did not finish");
        assert.deepEqual(await counts(), before);
        await app.close();
        app = buildApp({ database: db, scheduleRunner: runner });
        assert.equal((await run((await read()).revision)).statusCode, 200);
      },
    );

    await t.test(
      "cancellation received after the final database check still rolls back",
      async () => {
        const current = await read();
        const before = await counts();
        const result = await real.calculate(current.input);
        const controller = new AbortController();
        const wrapped = new Proxy(db, {
          get(target, property, receiver) {
            if (property !== "begin") return Reflect.get(target, property, receiver);
            return async (callback: (sql: DatabaseExecutor) => Promise<unknown>) =>
              await target.begin(async (sql) => {
                const checked = new Proxy(sql, {
                  apply(query, thisArg, args) {
                    const pending = Reflect.apply(query, thisArg, args);
                    if (
                      Array.isArray(args[0]) &&
                      args[0].join("").includes("expires_at > clock_timestamp()")
                    ) {
                      return (async () => {
                        const rows = await pending;
                        controller.abort();
                        return rows;
                      })();
                    }
                    return pending;
                  },
                });
                return await callback(checked);
              });
          },
        });
        await assert.rejects(
          new ScheduleRunRepository(wrapped).record(
            tenantContext(org, owner, randomUUID()),
            auth.sessionId,
            { ...current, relationshipIds: [] },
            result,
            controller.signal,
          ),
          (error: unknown) => error instanceof Error && error.message === "schedule_cancelled",
        );
        assert.deepEqual(await counts(), before);
      },
    );

    await t.test(
      "concurrent editing and calculation cannot mix read-snapshot revisions or dates",
      async () => {
        const original = await read();
        assert.ok(original.calculation);
        const entered = deferred();
        const release = deferred();
        const pending = db.begin("isolation level repeatable read read only", async (sql) => {
          const paused = new Proxy(sql, {
            apply(query, thisArg, args) {
              const rows = Reflect.apply(query, thisArg, args);
              if (Array.isArray(args[0]) && args[0].join("").includes("FROM projects")) {
                return (async () => {
                  const result = await rows;
                  entered.resolve();
                  await release.promise;
                  return result;
                })();
              }
              return rows;
            },
          });
          return await readPlannerSnapshot(
            paused,
            tenantContext(org, owner, randomUUID()),
            projectId,
            true,
          );
        });
        try {
          await entered.promise;
          await edit("Committed while the old snapshot is held");
          const newRevision = (await read()).revision;
          assert.equal((await run(newRevision)).statusCode, 200);
        } finally {
          release.resolve();
        }
        const observed = await pending;
        assert.ok(observed);
        assert.equal(observed.revision, original.revision);
        assert.deepEqual(observed.input, original.input);
        assert.deepEqual(observed.calculation, original.calculation);
        const current = await read();
        assert.equal(current.revision, original.revision + 1);
        assert.notEqual(current.calculation?.id, original.calculation.id);
        assert.equal(current.calculation?.revision, current.revision);
        assert.equal(current.input.activities[0]?.name, "Committed while the old snapshot is held");
      },
    );

    await t.test(
      "oversized result serialization is rejected before either database insert",
      async () => {
        const current = await read();
        const before = await counts();
        const result = await real.calculate(current.input);
        const activity = result.activities[current.input.activities[0]?.id ?? ""];
        assert.ok(activity);
        // Keep the real engine dates/float. Enlarge nonnumeric cause metadata to
        // exercise a validated custom-runner result at the persistence boundary.
        activity.drivingCauses.push({ kind: "x".repeat(SCHEDULE_JSON_MAX_BYTES) });
        await assert.rejects(
          new ScheduleRunRepository(db).record(
            tenantContext(org, owner, randomUUID()),
            auth.sessionId,
            { ...current, relationshipIds: [] },
            result,
          ),
          (error: unknown) =>
            error instanceof ScheduleEngineError &&
            error.code === "schedule_too_large" &&
            error.statusCode === 422,
        );
        assert.deepEqual(await counts(), before);
      },
    );

    await t.test(
      "valid compact input with oversized canonical bytes is rejected before Rust",
      async () => {
        const current = await read();
        let revision = current.revision;
        const calendar = current.input.calendars[0];
        assert.ok(calendar);
        const exceptions = Array.from({ length: 3_660 }, (_, index) => ({
          date: new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10),
          workingIntervals: [{ start: "08:00", end: "09:00" }],
        }));
        for (let index = 0; index < 55; index++) {
          const response: LightMyRequestResponse = await app.inject({
            method: "POST",
            url: `/organizations/${org}/projects/${projectId}/calendars`,
            headers: auth.headers,
            payload: {
              expectedRevision: revision,
              name: `Large unused ${index}`,
              timeZone: "UTC",
              week: calendar.week,
              exceptions,
            },
          });
          assert.equal(response.statusCode, 201, response.body);
          revision = response.json<{ revision: number }>().revision;
        }
        const large = await read();
        assert.equal(large.revision, revision);
        assert.ok(Buffer.byteLength(JSON.stringify(large.input), "utf8") < SCHEDULE_JSON_MAX_BYTES);
        assert.ok(
          Buffer.byteLength(serializeScheduleInputV1(large.input), "utf8") >
            SCHEDULE_JSON_MAX_BYTES,
        );
        const before = await counts();
        const calls = calculationCalls;
        const response = await run(revision);
        assert.equal(response.statusCode, 422, response.body);
        assert.equal(response.json<{ error: string }>().error, "schedule_too_large");
        assert.equal(calculationCalls, calls);
        assert.deepEqual(await counts(), before);
        // Establish that this admitted calendar data is valid for the real engine;
        // it is the exact durable representation that exceeds the storage limit.
        const validResult = await real.calculate(large.input);
        assert.equal(validResult.projectFinish, current.calculation?.result.projectFinish);
      },
    );
  } finally {
    gate.current?.release.resolve();
    await app.close();
    await db.end({ timeout: 5 });
  }
});
