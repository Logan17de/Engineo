import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { LightMyRequestResponse } from "fastify";
import { createDatabase, type Database, type DatabaseExecutor } from "./db/client.js";
import {
  actor,
  appFor,
  applyReview,
  assertError,
  assertStatus,
  awaitBlocked,
  bounded,
  configuration,
  createReview,
  databaseTest,
  deferred,
  fixture,
  hash,
  isolatedDatabase,
  scheduleState,
  viewState,
} from "./planner-views-fixture.test.js";
import { PlannerViewRepository } from "./repositories/planner-view-repository.js";

const isError = (code: string) => (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;
function inTransaction(db: Database, sql: DatabaseExecutor): Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "begin")
        return async (callback: (executor: DatabaseExecutor) => Promise<unknown>) =>
          "savepoint" in sql ? sql.savepoint((nested) => callback(nested)) : callback(sql);
      return Reflect.get(target, property, receiver);
    },
  });
}

test(
  "private view active quotas and opaque deterministic pagination use durable admission",
  databaseTest,
  async (t) => {
    const isolated = await isolatedDatabase();
    const { db } = isolated;
    const app = appFor(db);
    try {
      await t.test("20 actor-owned views, private ordering and bounded opaque cursor", async () => {
        const state = await fixture(db);
        const repository = new PlannerViewRepository(db);
        const capability = await repository.capabilities(
          state.context,
          state.project.projectId,
          state.session.principal,
        );
        for (let index = 0; index < 20; index++) {
          const review = await repository.plan(
            state.context,
            state.project.projectId,
            state.session.principal,
            {
              action: "create",
              operationWindowId: capability.operationWindowId,
              operationId: randomUUID(),
              expectedScheduleRevision: state.revision,
              configuration: configuration(`View ${String(19 - index).padStart(2, "0")}`),
            },
          );
          await repository.apply(
            state.context,
            state.project.projectId,
            state.session.principal,
            review,
          );
        }
        const limit = await repository.plan(
          state.context,
          state.project.projectId,
          state.session.principal,
          {
            action: "create",
            operationWindowId: capability.operationWindowId,
            operationId: randomUUID(),
            expectedScheduleRevision: state.revision,
            configuration: configuration("Over quota"),
          },
        );
        await assert.rejects(
          repository.apply(state.context, state.project.projectId, state.session.principal, limit),
          isError("view_capacity"),
        );
        const current = await viewState(db, state);
        assert.equal(current.views.length, 20);
        assert.equal(current.operations.length, 20);
        assert.equal(current.audits.length, 20);
        const pages: Array<{ viewId: string; name: string }> = [];
        let cursor: string | null = null;
        do {
          const response: LightMyRequestResponse = await app.inject({
            method: "GET",
            url: `${state.url}?limit=7${cursor ? `&cursor=${cursor}` : ""}`,
            headers: state.headers,
          });
          assertStatus(response);
          const page: {
            views: Array<{ viewId: string; name: string }>;
            nextCursor: string | null;
          } = response.json();
          assert.ok(page.views.length <= 7);
          if (page.nextCursor) assert.match(page.nextCursor, /^[a-f0-9-]{36}$/);
          pages.push(...page.views);
          cursor = page.nextCursor;
        } while (cursor);
        assert.equal(pages.length, 20);
        assert.equal(new Set(pages.map((view) => view.viewId)).size, 20);
        assert.deepEqual(
          pages.map((view) => view.name),
          Array.from({ length: 20 }, (_, index) => `View ${String(index).padStart(2, "0")}`),
        );
        const admin = await actor(db, state, "admin", null);
        assertError(
          await app.inject({
            method: "GET",
            url: `${state.url}?limit=7&cursor=${pages[0]?.viewId}`,
            headers: admin.headers,
          }),
          404,
          "view_not_found",
        );
        for (const query of ["limit=51", "limit=0", "limit=1.0", "cursor=not-a-uuid", "extra=1"])
          assertStatus(
            await app.inject({
              method: "GET",
              url: `${state.url}?${query}`,
              headers: state.headers,
            }),
            422,
          );
      });
      await t.test("128 project views cannot be admitted concurrently past capacity", async () => {
        const state = await fixture(db);
        const repository = new PlannerViewRepository(db);
        const window = (
          await repository.capabilities(
            state.context,
            state.project.projectId,
            state.session.principal,
          )
        ).operationWindowId;
        for (let group = 0; group < 7; group++) {
          const member = await actor(db, state, "viewer", "viewer");
          const context = { ...state.context, actorId: member.userId };
          const count = group < 6 ? 20 : 7;
          for (let index = 0; index < count; index++) {
            const review = await repository.plan(
              context,
              state.project.projectId,
              member.session.principal,
              {
                action: "create",
                operationWindowId: window,
                operationId: randomUUID(),
                expectedScheduleRevision: state.revision,
                configuration: configuration(`Group ${group} view ${index}`),
              },
            );
            await repository.apply(
              context,
              state.project.projectId,
              member.session.principal,
              review,
            );
          }
        }
        const contenders = await Promise.all(
          [0, 1].map(async (index) => {
            const member = await actor(db, state, "viewer", "viewer");
            const context = { ...state.context, actorId: member.userId };
            const review = await repository.plan(
              context,
              state.project.projectId,
              member.session.principal,
              {
                action: "create",
                operationWindowId: window,
                operationId: randomUUID(),
                expectedScheduleRevision: state.revision,
                configuration: configuration(`Last slot ${index}`),
              },
            );
            return { member, context, review };
          }),
        );
        const results = await Promise.allSettled(
          contenders.map(({ context, member, review }) =>
            new PlannerViewRepository(db).apply(
              context,
              state.project.projectId,
              member.session.principal,
              review,
            ),
          ),
        );
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        const rejected = results.find((result) => result.status === "rejected");
        assert.ok(
          rejected && rejected.status === "rejected" && isError("view_capacity")(rejected.reason),
        );
        const current = await viewState(db, state);
        assert.equal(current.views.length, 128);
        assert.equal(current.operations.length, 128);
        assert.equal(current.audits.length, 128);
        assert.equal(Number(current.projectBudget[0]?.config_count), 128);
      });
    } finally {
      await app.close();
      await isolated.dispose();
    }
  },
);

test(
  "private view storage counters reject direct mutation, missing rows and restored drift",
  databaseTest,
  async (t) => {
    const isolated = await isolatedDatabase();
    const { db } = isolated;
    const app = appFor(db);
    try {
      const state = await fixture(db);
      const plan = await createReview(app, state);
      assertStatus(await applyReview(app, state, plan));
      const pending = await createReview(app, state, configuration("Pending storage probe"));
      const pristine = await viewState(db, state);
      for (const table of ["planner_view_storage_budget", "planner_view_project_storage"]) {
        await assert.rejects(db.unsafe(`UPDATE ${table} SET config_count=config_count+1`));
        await assert.rejects(db.unsafe(`DELETE FROM ${table}`));
        await assert.rejects(db.unsafe(`TRUNCATE ${table}`));
      }
      await assert.rejects(
        db`SELECT engineo_planner_view_adjust_budget(${state.organizationId}::uuid,${state.project.projectId}::uuid,0,0,0,0,0,0,0)`,
      );
      for (const scope of ["global", "project"] as const)
        for (const damage of ["missing", "drift"] as const)
          await t.test(`${scope} ${damage}`, async () => {
            const sentinel = new Error("Rollback disposable corrupted counter fixture");
            await assert.rejects(
              db.begin(async (sql) => {
                const table =
                  scope === "global"
                    ? "planner_view_storage_budget"
                    : "planner_view_project_storage";
                const trigger =
                  scope === "global"
                    ? "planner_view_global_counter_managed"
                    : "planner_view_project_counter_managed";
                // A privileged, disposable restore fixture introduces damage. Restore
                // every production guard BEFORE exercising application admission.
                if (scope === "project") {
                  await sql.unsafe(
                    "ALTER TABLE planner_view_rate_limits DISABLE TRIGGER planner_view_rate_managed",
                  );
                  await sql`UPDATE planner_view_rate_limits SET bucket_start=date_trunc('minute',clock_timestamp()-interval '1 day','UTC'),
            expires_at=date_trunc('minute',clock_timestamp()-interval '1 day','UTC')+interval '1 minute'
            WHERE organization_id=${state.organizationId} AND project_id=${state.project.projectId} AND rate_class='read'`;
                  await sql.unsafe(
                    "ALTER TABLE planner_view_rate_limits ENABLE TRIGGER planner_view_rate_managed",
                  );
                }
                await sql.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
                if (damage === "missing") await sql.unsafe(`DELETE FROM ${table}`);
                else await sql.unsafe(`UPDATE ${table} SET config_bytes=config_bytes+1`);
                await sql.unsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
                const repository = new PlannerViewRepository(inTransaction(db, sql));
                await assert.rejects(
                  repository.apply(
                    state.context,
                    state.project.projectId,
                    state.session.principal,
                    pending,
                  ),
                  isError("view_integrity_error"),
                );
                await assert.rejects(repository.maintain(), isError("view_integrity_error"));
                throw sentinel;
              }),
              (error) => error === sentinel,
            );
            assert.deepEqual(await viewState(db, state), pristine);
          });
    } finally {
      await app.close();
      await isolated.dispose();
    }
  },
);

test(
  "private view closed UTC windows, expired identities and live receipt immutability",
  databaseTest,
  async () => {
    const isolated = await isolatedDatabase();
    const { db } = isolated;
    const app = appFor(db);
    try {
      const state = await fixture(db);
      const plan = await createReview(app, state);
      const today = Date.parse(`${plan.review.operationWindowId}T00:00:00.000Z`);
      const yesterday = new Date(today - 86400000).toISOString().slice(0, 10);
      const expired = new Date(today - 2 * 86400000).toISOString().slice(0, 10);
      const operationId = randomUUID();
      assertError(
        await app.inject({
          method: "POST",
          url: `${state.url}/plan`,
          headers: state.headers,
          payload: {
            action: "create",
            operationWindowId: yesterday,
            operationId,
            expectedScheduleRevision: state.revision,
            configuration: configuration(),
          },
        }),
        409,
        "view_operation_window_closed",
      );
      assertError(
        await app.inject({
          method: "POST",
          url: `${state.url}/plan`,
          headers: state.headers,
          payload: {
            action: "create",
            operationWindowId: expired,
            operationId,
            expectedScheduleRevision: state.revision,
            configuration: configuration(),
          },
        }),
        410,
        "view_operation_expired",
      );
      const closed = await app.inject({
        method: "GET",
        url: `${state.url}/operations/${yesterday}/${operationId}`,
        headers: state.headers,
      });
      assertStatus(closed);
      assert.equal(closed.json<{ status: string }>().status, "not_recorded");
      assert.equal(closed.json<{ absenceDefinitive: boolean }>().absenceDefinitive, true);
      assert.equal(closed.json<{ windowClosed: boolean }>().windowClosed, true);
      assertError(
        await app.inject({
          method: "GET",
          url: `${state.url}/operations/${expired}/${operationId}`,
          headers: state.headers,
        }),
        410,
        "view_operation_expired",
      );
      const sameUuid = await createReview(
        app,
        state,
        configuration("New window identity"),
        state.headers,
        operationId,
      );
      assertStatus(await applyReview(app, state, sameUuid));
      const before = await viewState(db, state);
      for (const statement of [
        "UPDATE planner_view_operations SET receipt_json=receipt_json",
        "DELETE FROM planner_view_operations",
        "TRUNCATE planner_view_operations",
      ])
        await assert.rejects(db.unsafe(statement));
      await db.begin(async (sql) => {
        await sql`SELECT set_config('engineo.planner_view_maintenance_delete','{}',true)`;
        await assert.rejects(
          sql.savepoint(async (nested) => nested`DELETE FROM planner_view_operations`),
        );
      });
      const repository = new PlannerViewRepository(db);
      for (const result of await Promise.all([
        repository.maintain(),
        new PlannerViewRepository(db).maintain(),
      ])) {
        assert.equal(result.batchLimit, 64);
        assert.equal(result.removedOperations, 0, "Live/admissible windows cannot be pruned");
        assert.ok(result.removedOperations + result.removedRateRows <= 64);
      }
      assert.deepEqual((await viewState(db, state)).operations, before.operations);
      assert.deepEqual((await viewState(db, state)).audits, before.audits);
    } finally {
      await app.close();
      await isolated.dispose();
    }
  },
);

test(
  "private view byte and lifetime audit ceilings fail atomically without unbounded allocations",
  databaseTest,
  async (t) => {
    const isolated = await isolatedDatabase();
    const { db } = isolated;
    const app = appFor(db);
    try {
      for (const ceiling of [
        "global-config",
        "project-config",
        "project-total",
        "lifetime-audit",
      ] as const)
        await t.test(ceiling, async () => {
          const state = await fixture(db);
          const plan = await createReview(app, state);
          const before = await viewState(db, state);
          const sentinel = new Error("Rollback bounded capacity fixture");
          await assert.rejects(
            db.begin(async (sql) => {
              // This disposable privileged fixture reserves the exact product ceiling
              // without allocating 64 MiB/100,000 append-only rows. Production guards
              // are re-enabled and coherent hashes restored before the API is exercised.
              await sql.unsafe(
                "ALTER TABLE planner_view_storage_budget DISABLE TRIGGER planner_view_global_counter_managed",
              );
              await sql.unsafe(
                "ALTER TABLE planner_view_project_storage DISABLE TRIGGER planner_view_project_counter_managed",
              );
              if (ceiling === "global-config")
                await sql`UPDATE planner_view_storage_budget SET config_bytes=67108864 WHERE singleton`;
              if (ceiling === "project-config") {
                await sql`UPDATE planner_view_project_storage SET config_bytes=1048576 WHERE project_id=${state.project.projectId}`;
                await sql`UPDATE planner_view_storage_budget SET config_bytes=config_bytes+1048576 WHERE singleton`;
              }
              if (ceiling === "project-total") {
                const count =
                  await sql`UPDATE planner_view_project_storage SET receipt_bytes=4194304-config_bytes-rate_bytes-256
            WHERE project_id=${state.project.projectId} RETURNING receipt_bytes`;
                await sql`UPDATE planner_view_storage_budget SET receipt_bytes=receipt_bytes+${String(count[0]?.receipt_bytes)}::bigint WHERE singleton`;
              }
              if (ceiling === "lifetime-audit")
                await sql`UPDATE planner_view_storage_budget SET audit_admissions=100000 WHERE singleton`;
              await sql`UPDATE planner_view_storage_budget SET state_hash_sha256=engineo_planner_view_counter_hash('global',
          config_bytes,config_count,receipt_bytes,receipt_count,rate_bytes,rate_count,audit_admissions,scope_bytes,scope_count,operation_window_high_water) WHERE singleton`;
              await sql`UPDATE planner_view_project_storage SET state_hash_sha256=engineo_planner_view_counter_hash(
          organization_id::text||'/'||project_id::text,config_bytes,config_count,receipt_bytes,receipt_count,rate_bytes,rate_count,audit_admissions)
          WHERE project_id=${state.project.projectId}`;
              await sql.unsafe(
                "ALTER TABLE planner_view_project_storage ENABLE TRIGGER planner_view_project_counter_managed",
              );
              await sql.unsafe(
                "ALTER TABLE planner_view_storage_budget ENABLE TRIGGER planner_view_global_counter_managed",
              );
              await assert.rejects(
                new PlannerViewRepository(inTransaction(db, sql)).apply(
                  state.context,
                  state.project.projectId,
                  state.session.principal,
                  plan,
                ),
                isError("view_capacity"),
              );
              assert.equal(
                Number(
                  (
                    await sql`SELECT count(*)::int AS n FROM project_planner_views WHERE project_id=${state.project.projectId}`
                  )[0]?.n,
                ),
                0,
              );
              assert.equal(
                Number(
                  (
                    await sql`SELECT count(*)::int AS n FROM planner_view_operations WHERE project_id=${state.project.projectId}`
                  )[0]?.n,
                ),
                0,
              );
              assert.equal(
                Number(
                  (
                    await sql`SELECT count(*)::int AS n FROM audit_events WHERE resource_id=${state.project.projectId} AND action='view.apply'`
                  )[0]?.n,
                ),
                0,
              );
              throw sentinel;
            }),
            (error) => error === sentinel,
          );
          assert.deepEqual(await viewState(db, state), before);
        });
    } finally {
      await app.close();
      await isolated.dispose();
    }
  },
);

test(
  "private view expired receipt cleanup is bounded to64 across concurrent maintainers",
  databaseTest,
  async () => {
    const isolated = await isolatedDatabase();
    const { db } = isolated;
    try {
      const state = await fixture(db);
      const repository = new PlannerViewRepository(db);
      const window = (
        await repository.capabilities(
          state.context,
          state.project.projectId,
          state.session.principal,
        )
      ).operationWindowId;
      for (const operations of [40, 30]) {
        const member = await actor(db, state, "viewer", "viewer");
        const context = { ...state.context, actorId: member.userId };
        const selected = configuration("Retention fixture");
        const initial = await repository.plan(
          context,
          state.project.projectId,
          member.session.principal,
          {
            action: "create",
            operationWindowId: window,
            operationId: randomUUID(),
            expectedScheduleRevision: state.revision,
            configuration: selected,
          },
        );
        const created = await repository.apply(
          context,
          state.project.projectId,
          member.session.principal,
          initial,
        );
        for (let index = 1; index < operations; index++) {
          const review = await repository.plan(
            context,
            state.project.projectId,
            member.session.principal,
            {
              action: "update",
              operationWindowId: window,
              operationId: randomUUID(),
              expectedScheduleRevision: state.revision,
              viewId: created.viewId,
              expectedViewRevision: 1,
              configuration: selected,
            },
          );
          const unchanged = await repository.apply(
            context,
            state.project.projectId,
            member.session.principal,
            review,
          );
          assert.equal(unchanged.outcome, "no_op");
        }
      }
      const oldWindow = new Date(Date.parse(`${window}T00:00:00.000Z`) - 3 * 86400000)
        .toISOString()
        .slice(0, 10);
      const recordedAt = `${oldWindow}T12:00:00.000Z`;
      const keepUntil = new Date(
        Date.parse(`${oldWindow}T00:00:00.000Z`) + 2 * 86400000,
      ).toISOString();
      await db.begin(async (sql) => {
        // Simulate restored historical storage with an elapsed retention horizon.
        // Byte lengths/counts are unchanged and guards are restored before cleanup.
        await sql.unsafe(
          "ALTER TABLE planner_view_operations DISABLE TRIGGER planner_view_operation_managed",
        );
        await sql.unsafe("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update");
        const rows =
          await sql`SELECT receipt_json,audit_event_id,operation_id FROM planner_view_operations WHERE project_id=${state.project.projectId}`;
        for (const row of rows) {
          const original = String(row.receipt_json);
          const value = JSON.parse(original) as { operationWindowId: string; recordedAt: string };
          value.operationWindowId = oldWindow;
          value.recordedAt = recordedAt;
          const changed = JSON.stringify(value);
          assert.equal(Buffer.byteLength(changed), Buffer.byteLength(original));
          await sql`UPDATE planner_view_operations SET operation_window_id=${oldWindow}::date,recorded_at=${recordedAt},keep_until=${keepUntil},
          receipt_json=${changed},receipt_hash_sha256=${hash(changed)} WHERE project_id=${state.project.projectId} AND operation_id=${String(row.operation_id)}`;
          await sql`UPDATE audit_events SET payload=jsonb_set(payload,'{operationWindowId}',to_jsonb(${oldWindow}::text))
          WHERE id=${String(row.audit_event_id)}`;
        }
        await sql.unsafe("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update");
        await sql.unsafe(
          "ALTER TABLE planner_view_operations ENABLE TRIGGER planner_view_operation_managed",
        );
      });
      const temporaryApp = appFor(db);
      let live: Awaited<ReturnType<typeof createReview>>;
      try {
        live = await createReview(temporaryApp, state, configuration("Live receipt remains"));
      } finally {
        await temporaryApp.close();
      }
      await repository.apply(state.context, state.project.projectId, state.session.principal, live);
      const before = await viewState(db, state);
      assert.equal(before.operations.length, 71);
      const results = await Promise.all([
        repository.maintain(),
        new PlannerViewRepository(db).maintain(),
      ]);
      assert.equal(
        results.reduce((total, result) => total + result.removedOperations, 0),
        70,
      );
      for (const result of results)
        assert.ok(result.removedOperations + result.removedRateRows <= 64);
      assert.ok(results.some((result) => result.removedOperations === 64));
      const after = await viewState(db, state);
      assert.equal(after.operations.length, 1);
      assert.equal(String(after.operations[0]?.operation_id), live.review.operationId);
      assert.deepEqual(after.views, before.views);
      assert.deepEqual(after.audits, before.audits);
      assert.equal(Number(after.projectBudget[0]?.receipt_count), 1);
      assert.equal(
        Number(after.projectBudget[0]?.audit_admissions),
        71,
        "Retention does not reset lifetime append-only audit admissions",
      );
      const remainingBytes = Number(after.operations[0]?.byte_count);
      assert.equal(Number(after.projectBudget[0]?.receipt_bytes), remainingBytes);
      assert.equal(Number(after.globalBudget[0]?.receipt_bytes), remainingBytes);
      const replay = await repository.apply(
        state.context,
        state.project.projectId,
        state.session.principal,
        live,
      );
      assert.equal(replay.operationId, live.review.operationId);
    } finally {
      await isolated.dispose();
    }
  },
);

async function clockDefinition(db: Database): Promise<string> {
  const rows =
    await db`SELECT pg_get_functiondef('engineo_planner_view_current_utc_day()'::regprocedure) AS definition`;
  const definition = rows[0]?.definition;
  assert.equal(typeof definition, "string");
  assert.ok(String(definition).includes("clock_timestamp()"));
  return String(definition);
}
async function fixtureClock(db: Database, expression: string): Promise<void> {
  // This affects only a generated disposable database. No system/server clock,
  // settings, configuration override or production trigger is changed.
  await db.unsafe(`CREATE OR REPLACE FUNCTION engineo_planner_view_current_utc_day()
    RETURNS date LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT ${expression} $$`);
}

test(
  "private view day checkpoint fences absent identities after a restored clock regression",
  databaseTest,
  async () => {
    const isolated = await isolatedDatabase();
    const { db } = isolated;
    const app = appFor(db);
    try {
      const state = await fixture(db);
      const absent = await createReview(app, state, configuration("Absent checkpoint operation"));
      const recordedPlan = await createReview(
        app,
        state,
        configuration("Retained checkpoint receipt"),
      );
      assertStatus(await applyReview(app, state, recordedPlan));
      const before = await viewState(db, state);
      const beforeSchedule = await scheduleState(db, state);
      const beforeRates =
        await db`SELECT * FROM planner_view_rate_limits ORDER BY organization_id,project_id,rate_class,subject_key,bucket_start`;
      const productionDefinition = await clockDefinition(db);
      const clock = await db`SELECT engineo_planner_view_current_utc_day()::text AS today,
      (engineo_planner_view_current_utc_day()+1)::text AS tomorrow`;
      const today = String(clock[0]?.today),
        tomorrow = String(clock[0]?.tomorrow);
      assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(tomorrow, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(absent.review.operationWindowId, today);
      await assert.rejects(
        db`UPDATE planner_view_storage_budget SET operation_window_high_water=operation_window_high_water WHERE singleton`,
        isError("P0003"),
      );

      // Genuine same-day waiting is allowed. The fence orders UTC days only;
      // successful requests do not require strictly increasing milliseconds.
      const blocker = createDatabase({ ...isolated.config, maxConnections: 1 });
      const waiter = createDatabase({ ...isolated.config, maxConnections: 1 });
      const ready = deferred(),
        release = deferred();
      let blockerPid = 0;
      let held: Promise<unknown> | undefined;
      let waiting: Promise<unknown> | undefined;
      try {
        const waiterPid = Number((await waiter`SELECT pg_backend_pid() AS pid`)[0]?.pid);
        held = blocker.begin(async (sql) => {
          blockerPid = Number((await sql`SELECT pg_backend_pid() AS pid`)[0]?.pid);
          await sql`SELECT engineo_planner_view_lock_storage(NULL,NULL)`;
          ready.resolve();
          await release.promise;
        });
        await bounded(
          Promise.race([ready.promise, held]),
          "Same-day checkpoint lock holder must be ready",
        );
        waiting = waiter.begin(
          async (sql) => sql`SELECT engineo_planner_view_lock_storage(NULL,NULL)`,
        );
        await awaitBlocked(db, waiterPid, blockerPid);
        release.resolve();
        await held;
        await waiting;
        assert.deepEqual(await viewState(db, state), before);
      } finally {
        release.resolve();
        if (held) await held;
        if (waiting) await waiting;
        await Promise.all([blocker.end({ timeout: 5 }), waiter.end({ timeout: 5 })]);
      }

      try {
        await fixtureClock(db, `DATE '${tomorrow}'`);
        // Advance via the normal guarded clock-only transition, with no trigger
        // bypass and no phantom project-budget/rate allocation.
        await db`SELECT engineo_planner_view_lock_storage(NULL,NULL)`;
      } finally {
        await db.unsafe(productionDefinition);
      }
      assert.equal(await clockDefinition(db), productionDefinition);
      const checkpoint =
        await db`SELECT operation_window_high_water::text AS day FROM planner_view_storage_budget WHERE singleton`;
      assert.equal(checkpoint[0]?.day, tomorrow);
      const fenced = await viewState(db, state);
      const withoutClock = (rows: typeof fenced.globalBudget) =>
        rows.map((row) => {
          const {
            operation_window_high_water: day,
            state_hash_sha256: digest,
            ...allocation
          } = row;
          void day;
          void digest;
          return allocation;
        });
      assert.deepEqual(withoutClock(fenced.globalBudget), withoutClock(before.globalBudget));
      assert.deepEqual(fenced.projectBudget, before.projectBudget);
      assert.deepEqual(fenced.views, before.views);
      assert.deepEqual(fenced.operations, before.operations);
      assert.deepEqual(fenced.audits, before.audits);
      assert.deepEqual(
        await db`SELECT * FROM planner_view_rate_limits ORDER BY organization_id,project_id,rate_class,subject_key,bucket_start`,
        beforeRates,
      );
      await assert.rejects(
        db`SELECT engineo_planner_view_lock_storage(NULL,NULL)`,
        isError("P0003"),
      );
      await assert.rejects(
        db`UPDATE planner_view_storage_budget SET operation_window_high_water=${today}::date WHERE singleton`,
        isError("P0003"),
      );
      await db.begin(async (sql) => {
        await sql`SELECT set_config('engineo.planner_view_counter_transition',${JSON.stringify({ kind: "clock", utcDay: today })},true)`;
        await assert.rejects(
          sql.savepoint(
            async (nested) => nested`UPDATE planner_view_storage_budget
        SET operation_window_high_water=${today}::date WHERE singleton`,
          ),
          isError("P0003"),
        );
      });
      const repository = new PlannerViewRepository(db);
      assertError(await applyReview(app, state, absent), 503, "view_integrity_error");
      assertError(
        await app.inject({
          method: "GET",
          headers: state.headers,
          url: `${state.url}/operations/${absent.review.operationWindowId}/${absent.review.operationId}`,
        }),
        503,
        "view_integrity_error",
      );
      // Existing retained history is blocked consistently too; a backward day
      // never turns absence after pruning into authorization to execute anew.
      assertError(await applyReview(app, state, recordedPlan), 503, "view_integrity_error");
      assertError(
        await app.inject({
          method: "GET",
          headers: state.headers,
          url: `${state.url}/operations/${recordedPlan.review.operationWindowId}/${recordedPlan.review.operationId}`,
        }),
        503,
        "view_integrity_error",
      );
      await assert.rejects(repository.maintain(), isError("view_integrity_error"));
      assert.deepEqual(await viewState(db, state), fenced);
      assert.deepEqual(
        await db`SELECT * FROM planner_view_rate_limits ORDER BY organization_id,project_id,rate_class,subject_key,bucket_start`,
        beforeRates,
      );
      assert.deepEqual(await scheduleState(db, state), beforeSchedule);
    } finally {
      await app.close();
      await isolated.dispose();
    }
  },
);

test(
  "private view null and nonfinite trusted clock samples fail before any allocation",
  databaseTest,
  async (t) => {
    const isolated = await isolatedDatabase();
    const { db } = isolated;
    const app = appFor(db);
    try {
      const state = await fixture(db);
      const pending = await createReview(app, state);
      const before = await viewState(db, state);
      const rates =
        await db`SELECT * FROM planner_view_rate_limits ORDER BY organization_id,project_id,rate_class,subject_key,bucket_start`;
      const productionDefinition = await clockDefinition(db);
      for (const expression of ["NULL::date", "'infinity'::date", "'-infinity'::date"])
        await t.test(expression, async () => {
          try {
            await fixtureClock(db, expression);
            await assert.rejects(
              db`SELECT engineo_planner_view_lock_storage(NULL,NULL)`,
              isError("P0003"),
            );
            assertError(await applyReview(app, state, pending), 503, "view_integrity_error");
            await assert.rejects(
              new PlannerViewRepository(db).maintain(),
              isError("view_integrity_error"),
            );
            assert.deepEqual(await viewState(db, state), before);
            assert.deepEqual(
              await db`SELECT * FROM planner_view_rate_limits ORDER BY organization_id,project_id,rate_class,subject_key,bucket_start`,
              rates,
            );
          } finally {
            await db.unsafe(productionDefinition);
          }
          assert.equal(await clockDefinition(db), productionDefinition);
        });
    } finally {
      await app.close();
      await isolated.dispose();
    }
  },
);
