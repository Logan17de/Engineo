import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  calculatePlannerViewReviewDigestV1,
  type PlannerViewPlanV1,
  type PlannerViewReceiptV1,
} from "@engineo/contracts";
import type { Database } from "./db/client.js";
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
  type Fixture,
  fixture,
  hash,
  headersFor,
  isolatedDatabase,
  scheduleState,
  viewState,
} from "./planner-views-fixture.test.js";
import { PlannerViewRepository } from "./repositories/planner-view-repository.js";
import { issueSession } from "./security/session.js";

const signed = (value: PlannerViewPlanV1): PlannerViewPlanV1 => ({
  review: value.review,
  reviewedDigest: calculatePlannerViewReviewDigestV1(value.review, hash),
});
async function durable(db: Database, state: Fixture) {
  const value = await viewState(db, state);
  const allocation = (rows: typeof value.projectBudget) =>
    rows.map((row) => ({
      configBytes: row.config_bytes,
      configCount: row.config_count,
      receiptBytes: row.receipt_bytes,
      receiptCount: row.receipt_count,
      auditAdmissions: row.audit_admissions,
    }));
  return {
    views: value.views,
    operations: value.operations,
    audits: value.audits,
    projectBudget: allocation(value.projectBudget),
    globalBudget: allocation(value.globalBudget),
  };
}
async function failureTrigger(
  db: Database,
  state: Fixture,
  table:
    | "audit_events"
    | "planner_view_operations"
    | "project_planner_views"
    | "planner_view_storage_budget",
) {
  const name = `view_fault_${randomUUID().replaceAll("-", "")}`;
  const predicate =
    table === "audit_events"
      ? `NEW.action='view.apply' AND NEW.resource_id='${state.project.projectId}'::uuid`
      : table === "planner_view_storage_budget"
        ? "NEW.singleton"
        : `NEW.project_id='${state.project.projectId}'::uuid`;
  await db.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Injected private-view storage failure'; END; $$`);
  await db.unsafe(`CREATE TRIGGER ${name} BEFORE ${table === "planner_view_storage_budget" ? "UPDATE" : "INSERT"}
    ON ${table} FOR EACH ROW WHEN (${predicate}) EXECUTE FUNCTION ${name}()`);
  return async () => {
    await db.unsafe(`DROP TRIGGER ${name} ON ${table}`);
    await db.unsafe(`DROP FUNCTION ${name}()`);
  };
}

test(
  "private view reviews are complete stateless intent and reject every changed binding",
  databaseTest,
  async (t) => {
    const isolated = await isolatedDatabase();
    const { db } = isolated;
    const app = appFor(db);
    try {
      const state = await fixture(db);
      const plan = await createReview(app, state);
      const pristine = await durable(db, state);
      assert.equal(pristine.views.length, 0);
      assert.equal(pristine.operations.length, 0);
      assert.equal(pristine.audits.length, 0);
      assert.equal(plan.review.schemaVersion, 1);
      assert.equal(plan.review.kind, "engineo-planner-view-review");
      assert.equal(plan.review.organizationId, state.organizationId);
      assert.equal(plan.review.projectId, state.project.projectId);
      assert.equal(plan.review.actorId, state.ownerId);
      assert.equal(plan.review.sessionId, state.session.principal.sessionId);
      assert.equal(plan.review.expectedScheduleRevision, state.revision);
      assert.ok(Date.parse(plan.review.expiresAt) - Date.parse(plan.review.issuedAt) <= 900000);
      assert.ok(Date.parse(plan.review.expiresAt) <= state.session.principal.expiresAt.getTime());
      assert.ok(Buffer.byteLength(JSON.stringify(plan)) <= 65536);
      const mutations: Array<[string, (value: Record<string, unknown>) => void]> = [
        [
          "schema",
          (value) => {
            value.schemaVersion = 2;
          },
        ],
        [
          "kind",
          (value) => {
            value.kind = "engineo-project-configuration";
          },
        ],
        [
          "protocol",
          (value) => {
            value.protocolVersion = 2;
          },
        ],
        [
          "projection",
          (value) => {
            value.projectionVersion = 2;
          },
        ],
        [
          "normalization",
          (value) => {
            value.normalizationVersion = 2;
          },
        ],
        [
          "action",
          (value) => {
            value.action = "delete";
          },
        ],
        [
          "view ID",
          (value) => {
            value.viewId = randomUUID();
          },
        ],
        [
          "actor",
          (value) => {
            value.actorId = randomUUID();
          },
        ],
        [
          "session",
          (value) => {
            value.sessionId = randomUUID();
          },
        ],
        [
          "organization",
          (value) => {
            value.organizationId = randomUUID();
          },
        ],
        [
          "project",
          (value) => {
            value.projectId = randomUUID();
          },
        ],
        [
          "view revision",
          (value) => {
            value.expectedViewRevision = 1;
          },
        ],
        [
          "schedule revision",
          (value) => {
            value.expectedScheduleRevision = state.revision + 1;
          },
        ],
        [
          "base hash",
          (value) => {
            value.baseConfigHash = "a".repeat(64);
          },
        ],
        [
          "desired hash",
          (value) => {
            value.desiredConfigHash = "a".repeat(64);
          },
        ],
        [
          "base configuration",
          (value) => {
            value.baseConfiguration = configuration();
          },
        ],
        [
          "desired configuration",
          (value) => {
            value.desiredConfiguration = configuration("Other intent");
          },
        ],
        [
          "window",
          (value) => {
            value.operationWindowId = "2000-01-01";
          },
        ],
        [
          "operation",
          (value) => {
            value.operationId = randomUUID();
          },
        ],
        [
          "issued time",
          (value) => {
            value.issuedAt = "2000-01-01T00:00:00.000Z";
          },
        ],
        [
          "expiry",
          (value) => {
            value.expiresAt = "2099-01-01T00:00:00.000Z";
          },
        ],
        [
          "extra field",
          (value) => {
            value.permission = "project.write";
          },
        ],
      ];
      for (const [name, mutate] of mutations)
        await t.test(`changed ${name}`, async () => {
          const changed = structuredClone(plan);
          mutate(changed.review as unknown as Record<string, unknown>);
          const rejected = await applyReview(app, state, changed);
          assert.ok(
            [409, 422].includes(rejected.statusCode),
            "Any changed reviewed field must be rejected",
          );
          assert.deepEqual(await durable(db, state), pristine);
        });
      for (const key of ["actorId", "sessionId", "organizationId", "projectId"] as const) {
        const forged = structuredClone(plan);
        forged.review[key] = randomUUID();
        assertStatus(await applyReview(app, state, signed(forged)), 409);
      }
      const extended = structuredClone(plan);
      extended.review.expiresAt = new Date(Date.parse(plan.review.issuedAt) + 900001).toISOString();
      assert.throws(() => signed(extended));
      assertStatus(await applyReview(app, state, extended), 422);
      const future = structuredClone(plan);
      future.review.issuedAt = new Date(Date.now() + 60000).toISOString();
      future.review.expiresAt = new Date(Date.now() + 120000).toISOString();
      assertStatus(await applyReview(app, state, signed(future)), 409);
      const response = await applyReview(app, state, plan);
      assertStatus(response);
      assert.equal(response.json<PlannerViewReceiptV1>().outcome, "applied");
    } finally {
      await app.close();
      await isolated.dispose();
    }
  },
);

test(
  "private view replay, duplicate operation claims and independent CAS survive later state",
  databaseTest,
  async (t) => {
    const isolated = await isolatedDatabase();
    const { db } = isolated;
    const first = appFor(db),
      second = appFor(db);
    try {
      const state = await fixture(db);
      const baseline = await scheduleState(db, state);
      const plan = await createReview(first, state);
      const duplicates = await Promise.all([
        applyReview(first, state, plan),
        applyReview(second, state, plan),
      ]);
      for (const response of duplicates) assertStatus(response);
      const created = duplicates[0]?.json<PlannerViewReceiptV1>();
      assert.ok(created);
      assert.deepEqual(duplicates[1]?.json(), created);
      assert.equal((await durable(db, state)).audits.length, 1);
      await t.test(
        "same key with other normalized intent cannot claim original result",
        async () => {
          const changed = structuredClone(plan);
          changed.review.desiredConfiguration = configuration("Changed operation intent");
          // A caller may compute digests. Neither a digest nor valid syntax can bypass key immutability.
          const differentPlan = await createReview(
            first,
            state,
            changed.review.desiredConfiguration,
            state.headers,
            plan.review.operationId,
          );
          assertError(
            await applyReview(first, state, differentPlan),
            409,
            "view_idempotency_conflict",
          );
          assert.equal((await durable(db, state)).audits.length, 1);
        },
      );
      const makeUpdate = async (name: string) => {
        const response = await first.inject({
          method: "POST",
          url: `${state.url}/plan`,
          headers: state.headers,
          payload: {
            action: "update",
            viewId: created.viewId,
            expectedViewRevision: 1,
            expectedScheduleRevision: state.revision,
            operationWindowId: plan.review.operationWindowId,
            operationId: randomUUID(),
            configuration: configuration(name),
          },
        });
        assertStatus(response);
        return response.json<PlannerViewPlanV1>();
      };
      const updates = await Promise.all([makeUpdate("Concurrent A"), makeUpdate("Concurrent B")]);
      const raced = await Promise.all(
        updates.map((review, index) => applyReview(index ? first : second, state, review)),
      );
      assert.deepEqual(raced.map((response) => response.statusCode).sort(), [200, 409]);
      assert.equal((await durable(db, state)).audits.length, 2);
      const deleteResponse = await first.inject({
        method: "POST",
        url: `${state.url}/plan`,
        headers: state.headers,
        payload: {
          action: "delete",
          viewId: created.viewId,
          expectedViewRevision: 2,
          expectedScheduleRevision: state.revision,
          operationWindowId: plan.review.operationWindowId,
          operationId: randomUUID(),
        },
      });
      assertStatus(deleteResponse);
      const deletion = deleteResponse.json<PlannerViewPlanV1>();
      assertStatus(await applyReview(first, state, deletion));
      assert.equal((await durable(db, state)).views.length, 0);
      const historical = await applyReview(second, state, plan);
      assertStatus(historical);
      assert.deepEqual(
        historical.json(),
        created,
        "Exact replay is historical even after deletion",
      );
      assert.equal((await durable(db, state)).audits.length, 3);
      const newSession = await issueSession(
        db,
        state.ownerId,
        `${state.ownerId}@example.test`,
        null,
        undefined,
      );
      const receiptRead = await second.inject({
        method: "GET",
        url: `${state.url}/operations/${plan.review.operationWindowId}/${plan.review.operationId}`,
        headers: headersFor(newSession),
      });
      assertStatus(receiptRead);
      assert.deepEqual(receiptRead.json<{ receipt: PlannerViewReceiptV1 }>().receipt, created);
      assertStatus(await applyReview(second, state, plan, headersFor(newSession)), 409);
      const other = await actor(db, state, "admin", null);
      const hidden = await first.inject({
        method: "GET",
        url: `${state.url}/operations/${plan.review.operationWindowId}/${plan.review.operationId}`,
        headers: other.headers,
      });
      const unknown = await first.inject({
        method: "GET",
        url: `${state.url}/operations/${plan.review.operationWindowId}/${randomUUID()}`,
        headers: other.headers,
      });
      assertStatus(hidden);
      const { operationId: hiddenId, ...hiddenStatus } = hidden.json<{ operationId: string }>();
      const { operationId: unknownId, ...unknownStatus } = unknown.json<{ operationId: string }>();
      void hiddenId;
      void unknownId;
      assert.deepEqual(hiddenStatus, unknownStatus);
      assert.equal(hidden.json<{ status: string }>().status, "not_recorded");
      assert.deepEqual(await scheduleState(db, state), baseline);
    } finally {
      await first.close();
      await second.close();
      await isolated.dispose();
    }
  },
);

test(
  "private view audit, receipt, view and admission failures roll back every durable allocation",
  databaseTest,
  async (t) => {
    const isolated = await isolatedDatabase();
    const { db } = isolated;
    const app = appFor(db);
    try {
      for (const table of [
        "audit_events",
        "planner_view_operations",
        "project_planner_views",
        "planner_view_storage_budget",
      ] as const)
        await t.test(table, async () => {
          const state = await fixture(db);
          const plan = await createReview(app, state);
          const before = await durable(db, state);
          const schedule = await scheduleState(db, state);
          const remove = await failureTrigger(db, state, table);
          try {
            const rejected = await applyReview(app, state, plan);
            assertStatus(rejected, 500);
            assert.deepEqual(rejected.json(), { error: "internal_error" });
            assert.deepEqual(await durable(db, state), before);
            assert.deepEqual(await scheduleState(db, state), schedule);
          } finally {
            await remove();
          }
          const retry = await applyReview(app, state, plan);
          assertStatus(retry);
          assert.equal((await durable(db, state)).operations.length, 1);
          assert.equal((await durable(db, state)).audits.length, 1);
        });
    } finally {
      await app.close();
      await isolated.dispose();
    }
  },
);

test(
  "private view expiry and cancellation are checked again after genuine admission locks",
  databaseTest,
  async (t) => {
    const isolated = await isolatedDatabase();
    const { db } = isolated;
    const app = appFor(db);
    try {
      for (const mode of ["expiry", "cancel"] as const)
        await t.test(mode, async () => {
          const state = await fixture(db);
          if (mode === "expiry") {
            state.session = await issueSession(
              db,
              state.ownerId,
              `${state.ownerId}@example.test`,
              null,
              undefined,
              3,
            );
            state.headers = headersFor(state.session);
          }
          const plan = await createReview(app, state);
          const single = { ...isolated.config, maxConnections: 1 };
          const { createDatabase } = await import("./db/client.js");
          const blocker = createDatabase(single),
            waiter = createDatabase(single);
          const ready = deferred(),
            release = deferred();
          let blockerPid = 0;
          let transaction: Promise<unknown> | undefined;
          try {
            const waiterPid = Number((await waiter`SELECT pg_backend_pid() AS pid`)[0]?.pid);
            transaction = blocker.begin(async (sql) => {
              blockerPid = Number((await sql`SELECT pg_backend_pid() AS pid`)[0]?.pid);
              await sql`SELECT singleton FROM planner_view_storage_budget FOR UPDATE`;
              ready.resolve();
              await release.promise;
            });
            await bounded(
              Promise.race([ready.promise, transaction]),
              "Admission blocker must acquire its independent row lock",
            );
            const controller = new AbortController();
            const repository = new PlannerViewRepository(waiter);
            const applying = repository.apply(
              state.context,
              state.project.projectId,
              state.session.principal,
              plan,
              controller.signal,
            );
            await awaitBlocked(db, waiterPid, blockerPid);
            if (mode === "cancel") controller.abort();
            else
              await new Promise<void>((resolve) =>
                setTimeout(
                  resolve,
                  Math.max(0, state.session.principal.expiresAt.getTime() - Date.now() + 100),
                ),
              );
            release.resolve();
            await assert.rejects(
              applying,
              (error: unknown) =>
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === (mode === "cancel" ? "view_interrupted" : "unauthenticated"),
            );
            assert.equal((await durable(db, state)).views.length, 0);
            assert.equal((await durable(db, state)).operations.length, 0);
            assert.equal((await durable(db, state)).audits.length, 0);
          } finally {
            release.resolve();
            if (transaction) await transaction;
            await Promise.all([blocker.end({ timeout: 5 }), waiter.end({ timeout: 5 })]);
          }
        });
    } finally {
      await app.close();
      await isolated.dispose();
    }
  },
);

test(
  "private view committed receipt recovers lost commit-result delivery after pool restart",
  databaseTest,
  async () => {
    const isolated = await isolatedDatabase();
    const { db } = isolated;
    const healthy = appFor(db);
    let loseOnce = true;
    const disconnected = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "begin") return Reflect.get(target, property, receiver);
        return async (
          callback: (sql: import("./db/client.js").DatabaseExecutor) => Promise<unknown>,
        ) => {
          const value = await target.begin(callback);
          // The genuine transaction has COMMITTED. Only delivery of its result is
          // lost; no query result, receipt, row or transaction outcome is fabricated.
          if (
            loseOnce &&
            typeof value === "object" &&
            value !== null &&
            "kind" in value &&
            value.kind === "engineo-planner-view-receipt"
          ) {
            loseOnce = false;
            throw new Error("Commit-result delivery was lost");
          }
          return value;
        };
      },
    });
    const uncertain = appFor(disconnected);
    try {
      const state = await fixture(db);
      const plan = await createReview(healthy, state);
      assertError(await applyReview(uncertain, state, plan), 500, "internal_error");
      const durableBeforeRecovery = await durable(db, state);
      assert.equal(durableBeforeRecovery.views.length, 1);
      assert.equal(durableBeforeRecovery.operations.length, 1);
      assert.equal(durableBeforeRecovery.audits.length, 1);
      const { createDatabase } = await import("./db/client.js");
      const restartedDb = createDatabase(isolated.config);
      const restarted = appFor(restartedDb);
      try {
        const read = await restarted.inject({
          method: "GET",
          headers: state.headers,
          url: `${state.url}/operations/${plan.review.operationWindowId}/${plan.review.operationId}`,
        });
        assertStatus(read);
        assert.equal(read.json<{ status: string }>().status, "recorded");
        const recovered = read.json<{ receipt: PlannerViewReceiptV1 }>().receipt;
        assert.equal(recovered.outcome, "applied");
        const repeated = await applyReview(restarted, state, plan);
        assertStatus(repeated);
        assert.deepEqual(repeated.json(), recovered);
        assert.deepEqual(await durable(db, state), durableBeforeRecovery);
      } finally {
        await restarted.close();
        await restartedDb.end({ timeout: 5 });
      }
    } finally {
      await healthy.close();
      await uncertain.close();
      await isolated.dispose();
    }
  },
);
