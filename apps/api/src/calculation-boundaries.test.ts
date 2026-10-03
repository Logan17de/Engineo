import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { EngineScheduleResultV1 } from "@engineo/contracts";
import { buildApp } from "./app.js";
import { createDatabase, type Database, type DatabaseExecutor } from "./db/client.js";
import { databaseConfigFromEnv } from "./db/config.js";
import { migrateDatabase } from "./db/migrate.js";
import { tenantContext } from "./db/tenant-context.js";
import {
  CalculationAccessError,
  CalculationRepository,
} from "./repositories/calculation-repository.js";
import { PlannerRepository } from "./repositories/planner-repository.js";
import { ProjectRepository } from "./repositories/project-repository.js";
import {
  ProcessScheduleRunner,
  SCHEDULE_MAX_BYTES,
  ScheduleEngineError,
  type ScheduleRunner,
} from "./scheduler/runner.js";
import { issueSession } from "./security/session.js";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: PromiseLike<T>, message: string, timeoutMs = 4_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(db: Database) {
  const organizationId = randomUUID(),
    ownerId = randomUUID(),
    userId = randomUUID();
  await db`INSERT INTO organizations (id, slug, name)
    VALUES (${organizationId}, ${organizationId}, 'Calculation boundaries')`;
  await db`INSERT INTO users (id, email)
    VALUES (${ownerId}, ${`${ownerId}@example.test`}), (${userId}, ${`${userId}@example.test`})`;
  await db`INSERT INTO organization_memberships (organization_id, user_id, role)
    VALUES (${organizationId}, ${ownerId}, 'owner'), (${organizationId}, ${userId}, 'planner')`;
  const ownerContext = tenantContext(organizationId, ownerId, `fixture-${randomUUID()}`);
  const context = tenantContext(organizationId, userId, `calculation-${randomUUID()}`);
  const planner = new PlannerRepository(db);
  const project = await planner.createProject(ownerContext, {
    name: "Calculation boundary project",
    code: null,
    description: null,
    plannedStart: "2026-10-05T08:00:00Z",
    timeZone: "UTC",
  });
  const activity = await planner.createActivity(ownerContext, project.projectId, 1, {
    name: "Real Rust activity",
    wbsId: project.rootWbsId,
    calendarId: project.calendarId,
    kind: "TASK",
    durationMinutes: 480,
    constraints: [],
    sortOrder: 0,
  });
  await db`INSERT INTO project_memberships (organization_id, project_id, user_id, role)
    VALUES (${organizationId}, ${project.projectId}, ${userId}, 'planner')`;
  const session = await issueSession(db, userId, `${userId}@example.test`, null, undefined);
  const snapshot = await new ProjectRepository(db).plannerSnapshot(context, project.projectId);
  assert.ok(snapshot);
  const headers = {
    cookie: `engineo_session=${session.token}; engineo_csrf=${session.csrfToken}`,
    "x-csrf-token": session.csrfToken,
  };
  return {
    organizationId,
    userId,
    context,
    project,
    activity,
    session,
    snapshot,
    headers,
    url: `/organizations/${organizationId}/projects/${project.projectId}`,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function resultGate(real: ProcessScheduleRunner) {
  const ready = deferred(),
    release = deferred();
  const runner: ScheduleRunner = {
    getEngineVersion: () => real.getEngineVersion(),
    async calculate(input, signal) {
      // Only result delivery is delayed. The snapshot and calculated output are
      // genuine PostgreSQL/Rust data, and identity is still read from the binary.
      const result = await real.calculate(input, signal);
      ready.resolve();
      await release.promise;
      return result;
    },
  };
  return { runner, ready: ready.promise, release: release.resolve };
}

async function assertNoRun(db: Database, state: Fixture): Promise<void> {
  const calculations = await db`SELECT count(*)::int AS count FROM schedule_calculations
    WHERE organization_id = ${state.organizationId} AND project_id = ${state.project.projectId}`;
  const audits = await db`SELECT count(*)::int AS count FROM audit_events
    WHERE organization_id = ${state.organizationId} AND resource_id = ${state.project.projectId}
      AND action = 'schedule.run'`;
  assert.equal(Number(calculations[0]?.count), 0, "No rejected calculation may be retained");
  assert.equal(Number(audits[0]?.count), 0, "No rejected calculation may append a run audit");
}

async function awaitBlocked(db: Database, waiterPid: number, blockerPid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const rows =
      await db`SELECT ${blockerPid}::int = ANY(pg_blocking_pids(${waiterPid}::int)) AS blocked`;
    if (rows[0]?.blocked === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Finalizer must reach the independently held PostgreSQL lock");
}

async function withFinalizerLock(
  db: Database,
  state: Fixture,
  acquire: (lockDb: DatabaseExecutor) => Promise<void>,
  action: (
    repository: CalculationRepository,
    finalizerPid: number,
    blockerPid: number,
    release: () => void,
  ) => Promise<void>,
): Promise<void> {
  // Separate single-connection pools give the test known backend PIDs without
  // intercepting or replacing any repository SQL or transaction results.
  const config = { ...databaseConfigFromEnv(), maxConnections: 1 };
  const lockDb = createDatabase(config),
    finalizerDb = createDatabase(config);
  const locked = deferred(),
    release = deferred();
  let blockerPid = 0;
  let lockTransaction: Promise<unknown> | undefined;
  try {
    const finalizerRows = await finalizerDb`SELECT pg_backend_pid() AS pid`;
    const finalizerPid = Number(finalizerRows[0]?.pid);
    assert.ok(finalizerPid > 0);
    lockTransaction = lockDb.begin(async (sql) => {
      const rows = await sql`SELECT pg_backend_pid() AS pid`;
      blockerPid = Number(rows[0]?.pid);
      await acquire(sql);
      locked.resolve();
      await release.promise;
    });
    await bounded(
      Promise.race([locked.promise, lockTransaction]),
      "Independent lock holder must acquire its lock",
    );
    assert.ok(blockerPid > 0);
    await action(new CalculationRepository(finalizerDb), finalizerPid, blockerPid, release.resolve);
    await assertNoRun(db, state);
  } finally {
    release.resolve();
    try {
      if (lockTransaction) await lockTransaction;
    } finally {
      await Promise.all([lockDb.end({ timeout: 5 }), finalizerDb.end({ timeout: 5 })]);
    }
  }
}

async function projectTrigger(
  db: Database,
  state: Fixture,
  table: "audit_events" | "schedule_calculations",
  body: string,
): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll("-", "");
  const name = `calculation_boundary_${suffix}`;
  const condition =
    table === "audit_events"
      ? `NEW.action = 'schedule.run' AND NEW.resource_id = '${state.project.projectId}'::uuid`
      : `NEW.project_id = '${state.project.projectId}'::uuid`;
  await db.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN ${body} RETURN NEW; END; $$`);
  try {
    await db.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table}
      FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION ${name}()`);
  } catch (error) {
    await db.unsafe(`DROP FUNCTION ${name}()`);
    throw error;
  }
  return async () => {
    await db.unsafe(`DROP TRIGGER ${name} ON ${table}`);
    await db.unsafe(`DROP FUNCTION ${name}()`);
  };
}

test("durable calculation boundaries use actual PostgreSQL and the release Rust engine", {
  skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not configured",
  timeout: 90_000,
}, async (t) => {
  // Configuring PostgreSQL opts into the real-engine requirement. A missing
  // or incompatible executable is a failure, never a silent integration skip.
  assert.ok(process.env.ENGINEO_SCHEDULER_BIN, "ENGINEO_SCHEDULER_BIN is required");
  const db = createDatabase();
  const real = new ProcessScheduleRunner({ binaryPath: process.env.ENGINEO_SCHEDULER_BIN });
  try {
    await migrateDatabase(db);
    const engineVersion = await real.getEngineVersion();
    await t.test(
      "a missing locked membership cannot be rescued by a concurrently inserted grant",
      async () => {
        const state = await fixture(db);
        const repository = new CalculationRepository(db);
        const stored = await repository.finalize(
          state.context,
          state.project.projectId,
          state.session.principal,
          state.snapshot,
          await real.calculate(state.snapshot.input),
          engineVersion,
        );
        assert.ok(stored.result);
        assert.ok(stored.calculation);
        await db`DELETE FROM project_memberships
          WHERE organization_id = ${state.organizationId} AND project_id = ${state.project.projectId}
            AND user_id = ${state.userId}`;
        const read = deferred(),
          release = deferred();
        let gatedReads = 0;
        const coordinatedDb = new Proxy(db, {
          get(target, property, receiver) {
            if (property !== "begin") return Reflect.get(target, property, receiver);
            return async (callback: (sql: DatabaseExecutor) => Promise<unknown>) =>
              await target.begin(async (sql) => {
                const coordinatedSql = new Proxy(sql, {
                  async apply(query, thisArg, args) {
                    const rows = await Reflect.apply(query, thisArg, args);
                    const statement = Array.isArray(args[0]) ? args[0].join(" ") : "";
                    if (
                      /FROM project_memberships\b/.test(statement) &&
                      /FOR SHARE\b/.test(statement)
                    ) {
                      // Delay delivery of the genuine empty SELECT, after the
                      // project FOR SHARE lock has already been acquired. No
                      // rows are fabricated, replaced, or removed by this gate.
                      assert.equal(rows.length, 0);
                      gatedReads++;
                      read.resolve();
                      await release.promise;
                    }
                    return rows;
                  },
                });
                return await callback(coordinatedSql);
              });
          },
        });
        const grantDb = createDatabase({ ...databaseConfigFromEnv(), maxConnections: 1 });
        const pending = new CalculationRepository(coordinatedDb).current(
          state.context,
          state.project.projectId,
          state.session.principal,
          engineVersion,
        );
        const rejected = assert.rejects(
          pending,
          (error: unknown) => error instanceof CalculationAccessError && error.statusCode === 403,
        );
        try {
          await bounded(read.promise, "GET must complete its genuine empty membership SELECT");
          // This independent connection really commits the grant while GET
          // holds project FOR SHARE. The FK's KEY SHARE lock is compatible.
          await bounded(
            grantDb`INSERT INTO project_memberships (organization_id, project_id, user_id, role)
              VALUES (${state.organizationId}, ${state.project.projectId}, ${state.userId}, 'planner')`,
            "The concurrent grant must commit before the empty SELECT is released",
          );
          const rows = await grantDb`SELECT role FROM project_memberships
            WHERE organization_id = ${state.organizationId} AND project_id = ${state.project.projectId}
              AND user_id = ${state.userId}`;
          assert.equal(rows[0]?.role, "planner");
        } finally {
          release.resolve();
          try {
            await rejected;
          } finally {
            await grantDb.end({ timeout: 5 });
          }
        }
        assert.equal(gatedReads, 1);
        // The result really exists and the committed grant authorizes a fresh
        // read. It cannot retroactively authorize the older unlocked lookup.
        const fresh = await repository.current(
          state.context,
          state.project.projectId,
          state.session.principal,
          engineVersion,
        );
        assert.deepEqual(fresh, stored);
        const audits = await db`SELECT count(*)::int AS count FROM audit_events
          WHERE organization_id = ${state.organizationId} AND resource_id = ${state.project.projectId}
            AND action = 'schedule.run'`;
        assert.equal(Number(audits[0]?.count), 1);
      },
    );

    const accessChanges: Array<{
      name: string;
      status: 401 | 403;
      change: (state: Fixture) => Promise<unknown>;
    }> = [
      {
        name: "session revoked after Rust completes cannot retain a result",
        status: 401,
        change: (state) => db`UPDATE auth_sessions SET revoked_at = clock_timestamp()
            WHERE id = ${state.session.principal.sessionId}`,
      },
      {
        name: "session expired after Rust completes cannot retain a result",
        status: 401,
        change: (state) => db`UPDATE auth_sessions
            SET created_at = clock_timestamp() - interval '1 day',
                expires_at = clock_timestamp() - interval '1 second'
            WHERE id = ${state.session.principal.sessionId}`,
      },
      {
        name: "organization membership removed after Rust completes is rechecked",
        status: 403,
        change: (state) => db`DELETE FROM organization_memberships
            WHERE organization_id = ${state.organizationId} AND user_id = ${state.userId}`,
      },
      {
        name: "project membership removed after Rust completes is rechecked",
        status: 403,
        change: (state) => db`DELETE FROM project_memberships
            WHERE organization_id = ${state.organizationId} AND project_id = ${state.project.projectId}
              AND user_id = ${state.userId}`,
      },
      {
        name: "organization role downgraded after Rust completes is rechecked",
        status: 403,
        change: (state) => db`UPDATE organization_memberships SET role = 'viewer'
            WHERE organization_id = ${state.organizationId} AND user_id = ${state.userId}`,
      },
      {
        name: "project role downgraded after Rust completes is rechecked",
        status: 403,
        change: (state) => db`UPDATE project_memberships SET role = 'viewer'
            WHERE organization_id = ${state.organizationId} AND project_id = ${state.project.projectId}
              AND user_id = ${state.userId}`,
      },
    ];

    for (const boundary of accessChanges) {
      await t.test(boundary.name, async () => {
        const state = await fixture(db);
        const gate = resultGate(real);
        const app = buildApp({ database: db, scheduleRunner: gate.runner });
        const pending = app.inject({
          method: "POST",
          url: `${state.url}/schedule/run`,
          headers: state.headers,
          payload: { expectedRevision: state.snapshot.revision },
        });
        try {
          await bounded(gate.ready, "Real Rust calculation must reach the result gate");
          await boundary.change(state);
          gate.release();
          const response = await pending;
          assert.equal(response.statusCode, boundary.status, response.body);
          assert.equal(
            response.json<{ error: string }>().error,
            boundary.status === 401 ? "unauthenticated" : "forbidden",
          );
          await assertNoRun(db, state);
        } finally {
          gate.release();
          await pending;
          await app.close();
        }
      });
    }

    for (const bypassRevision of [false, true]) {
      await t.test(
        bypassRevision
          ? "current canonical input is compared even when a direct edit did not bump revision"
          : "a concurrent committed API edit rejects the delayed older result",
        async () => {
          const state = await fixture(db);
          const gate = resultGate(real);
          const app = buildApp({ database: db, scheduleRunner: gate.runner });
          const pending = app.inject({
            method: "POST",
            url: `${state.url}/schedule/run`,
            headers: state.headers,
            payload: { expectedRevision: state.snapshot.revision },
          });
          try {
            await bounded(gate.ready, "Real Rust calculation must reach the result gate");
            if (bypassRevision) {
              await db`UPDATE activities SET duration_minutes = 960 WHERE id = ${state.activity.id}`;
            } else {
              const input = structuredClone(state.snapshot.input);
              const activity = input.activities[0];
              assert.ok(activity);
              activity.durationMinutes = 960;
              const edit = await app.inject({
                method: "PUT",
                url: `${state.url}/schedule`,
                headers: state.headers,
                payload: { expectedRevision: state.snapshot.revision, input },
              });
              assert.equal(edit.statusCode, 200, edit.body);
            }
            gate.release();
            const response = await pending;
            assert.equal(response.statusCode, 409, response.body);
            assert.equal(response.json<{ error: string }>().error, "revision_conflict");
            const current = await new ProjectRepository(db).plannerSnapshot(
              state.context,
              state.project.projectId,
            );
            assert.equal(current?.revision, state.snapshot.revision + (bypassRevision ? 0 : 1));
            await assertNoRun(db, state);
          } finally {
            gate.release();
            await pending;
            await app.close();
          }
        },
      );
    }

    for (const oversized of [false, true]) {
      await t.test(
        oversized
          ? "an oversized injected runner result cannot cross the durable storage boundary"
          : "a malformed injected runner result cannot cross the durable storage boundary",
        async () => {
          const state = await fixture(db);
          const runner: ScheduleRunner = {
            getEngineVersion: () => real.getEngineVersion(),
            async calculate(input, signal) {
              const result = await real.calculate(input, signal);
              if (oversized) {
                const activity = Object.values(result.activities)[0];
                assert.ok(activity);
                activity.drivingCauses.push({ kind: "x".repeat(SCHEDULE_MAX_BYTES) });
              } else {
                result.activities = {};
              }
              return result;
            },
          };
          const app = buildApp({ database: db, scheduleRunner: runner });
          try {
            const response = await app.inject({
              method: "POST",
              url: `${state.url}/schedule/run`,
              headers: state.headers,
              payload: { expectedRevision: state.snapshot.revision },
            });
            assert.equal(response.statusCode, 503, response.body);
            assert.equal(response.headers["retry-after"], "1");
            assert.equal(
              response.json<{ error: string }>().error,
              oversized ? "schedule_output_limit" : "schedule_invalid_output",
            );
            await assertNoRun(db, state);
          } finally {
            await app.close();
          }
        },
      );
    }

    await t.test(
      "cancellation while waiting on a project lock retains neither result nor audit",
      async () => {
        const state = await fixture(db);
        const result = await real.calculate(state.snapshot.input);
        const controller = new AbortController();
        await withFinalizerLock(
          db,
          state,
          async (sql) => {
            await sql`SELECT id FROM projects WHERE id = ${state.project.projectId} FOR UPDATE`;
          },
          async (repository, finalizerPid, blockerPid, release) => {
            const pending = repository.finalize(
              state.context,
              state.project.projectId,
              state.session.principal,
              state.snapshot,
              result,
              engineVersion,
              controller.signal,
            );
            // Attach the rejection assertion before releasing the lock, so even
            // an immediate transaction failure cannot be an unhandled rejection.
            const rejected = assert.rejects(
              pending,
              (error: unknown) =>
                error instanceof ScheduleEngineError && error.code === "schedule_cancelled",
            );
            try {
              await awaitBlocked(db, finalizerPid, blockerPid);
              controller.abort();
            } finally {
              release();
              await rejected;
            }
          },
        );
      },
    );

    await t.test(
      "session wall-clock expiry is rechecked after waiting on a project lock",
      async () => {
        const state = await fixture(db);
        const result = await real.calculate(state.snapshot.input);
        await withFinalizerLock(
          db,
          state,
          async (sql) => {
            await sql`SELECT id FROM projects WHERE id = ${state.project.projectId} FOR UPDATE`;
          },
          async (repository, finalizerPid, blockerPid, release) => {
            await db`UPDATE auth_sessions
              SET created_at = clock_timestamp() - interval '1 day',
                  expires_at = clock_timestamp() + interval '2 seconds'
              WHERE id = ${state.session.principal.sessionId}`;
            const pending = repository.finalize(
              state.context,
              state.project.projectId,
              state.session.principal,
              state.snapshot,
              result,
              engineVersion,
            );
            const rejected = assert.rejects(
              pending,
              (error: unknown) =>
                error instanceof CalculationAccessError && error.statusCode === 401,
            );
            try {
              await awaitBlocked(db, finalizerPid, blockerPid);
              const deadline = Date.now() + 3_000;
              let expired = false;
              while (Date.now() < deadline && !expired) {
                const rows = await db`SELECT expires_at <= clock_timestamp() AS expired
                  FROM auth_sessions WHERE id = ${state.session.principal.sessionId}`;
                expired = rows[0]?.expired === true;
                if (!expired) await new Promise<void>((resolve) => setTimeout(resolve, 10));
              }
              assert.equal(
                expired,
                true,
                "The real session must expire before the lock is released",
              );
            } finally {
              release();
              await rejected;
            }
          },
        );
      },
    );

    for (const table of ["audit_events", "schedule_calculations"] as const) {
      await t.test(
        `${table} insertion failure atomically rolls back both durable records`,
        async () => {
          const state = await fixture(db);
          const removeTrigger = await projectTrigger(
            db,
            state,
            table,
            "RAISE EXCEPTION 'intentional calculation boundary failure';",
          );
          const app = buildApp({ database: db, scheduleRunner: real });
          try {
            const response = await app.inject({
              method: "POST",
              url: `${state.url}/schedule/run`,
              headers: state.headers,
              payload: { expectedRevision: state.snapshot.revision },
            });
            assert.equal(response.statusCode, 500, response.body);
            assert.equal(response.json<{ error: string }>().error, "internal_error");
            await assertNoRun(db, state);
          } finally {
            await removeTrigger();
            await app.close();
          }
        },
      );
    }

    await t.test(
      "cancellation during calculation INSERT rolls back the already inserted audit",
      async () => {
        const state = await fixture(db);
        const result: EngineScheduleResultV1 = await real.calculate(state.snapshot.input);
        const controller = new AbortController();
        const lockKey = Number.parseInt(state.project.projectId.slice(0, 8), 16) & 0x7fffffff;
        const removeTrigger = await projectTrigger(
          db,
          state,
          "schedule_calculations",
          `PERFORM pg_advisory_xact_lock(19478123, ${lockKey});`,
        );
        try {
          await withFinalizerLock(
            db,
            state,
            async (sql) => {
              await sql`SELECT pg_advisory_xact_lock(19478123, ${lockKey})`;
            },
            async (repository, finalizerPid, blockerPid, release) => {
              const pending = repository.finalize(
                state.context,
                state.project.projectId,
                state.session.principal,
                state.snapshot,
                result,
                engineVersion,
                controller.signal,
              );
              const rejected = assert.rejects(
                pending,
                (error: unknown) =>
                  error instanceof ScheduleEngineError && error.code === "schedule_cancelled",
              );
              try {
                await awaitBlocked(db, finalizerPid, blockerPid);
                // The INSERT trigger can only be reached after appendAuditEvent
                // has succeeded inside this same genuine database transaction.
                controller.abort();
              } finally {
                release();
                await rejected;
              }
            },
          );
        } finally {
          await removeTrigger();
        }
      },
    );
  } finally {
    await db.end({ timeout: 5 });
  }
});
