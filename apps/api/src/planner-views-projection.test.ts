import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  type PlannerProjectionV1,
  type PlannerViewReceiptV1,
  projectPlannerPresentationV1,
  serializePlannerViewHashPreimageV1,
  serializeScheduleInputV1,
  serializeScheduleResultV1,
} from "@engineo/contracts";
import { createDatabase, type DatabaseExecutor } from "./db/client.js";
import {
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
} from "./planner-views-fixture.test.js";
import { CalculationRepository } from "./repositories/calculation-repository.js";
import { PlannerRepository } from "./repositories/planner-repository.js";
import { PlannerViewRepository } from "./repositories/planner-view-repository.js";
import { ProjectRepository } from "./repositories/project-repository.js";
import { ProcessScheduleRunner } from "./scheduler/runner.js";

test(
  "private view projection consumes coherent saved Rust output without schedule execution",
  databaseTest,
  async (t) => {
    const binaryPath = process.env.ENGINEO_SCHEDULER_BIN;
    assert.ok(binaryPath, "Configured DB integration requires the real release Rust executable");
    const isolated = await isolatedDatabase();
    const { db } = isolated;
    const real = new ProcessScheduleRunner({ binaryPath });
    const engineVersion = await real.getEngineVersion();
    const compatibleReader = {
      getEngineVersion: async () => engineVersion,
      calculate: async () => {
        throw new Error("View projection must not execute Rust");
      },
    };
    const app = appFor(db, compatibleReader);
    try {
      await t.test(
        "exact shared projection parity and immutable schedule/result provenance",
        async () => {
          const state = await fixture(db);
          const stored = await new CalculationRepository(db).finalize(
            state.context,
            state.project.projectId,
            state.session.principal,
            state.snapshot,
            await real.calculate(state.snapshot.input),
            engineVersion,
          );
          assert.ok(stored.result && stored.calculation);
          const before = await scheduleState(db, state);
          const selected = configuration("Critical WBS");
          selected.presentation.critical = "critical";
          selected.presentation.sort = { field: "earlyStart", direction: "desc" };
          selected.presentation.groupBy = "wbs";
          const request = await app.inject({
            method: "POST",
            url: `${state.url}/projection`,
            headers: state.headers,
            payload: { configuration: selected, expectedScheduleRevision: state.revision },
          });
          assertStatus(request);
          assert.equal(request.headers["cache-control"], "no-store");
          const projected = request.json<PlannerProjectionV1>();
          assert.equal(projected.available, true);
          const expected = projectPlannerPresentationV1(
            {
              organizationId: state.organizationId,
              projectId: state.project.projectId,
              scheduleRevision: state.revision,
              inputHashSha256: hash(serializeScheduleInputV1(state.snapshot.input)),
              inputState: "saved",
              currentEngineVersion: engineVersion,
              input: state.snapshot.input,
            },
            {
              verification: "caller-verified-current-engine",
              organizationId: state.organizationId,
              projectId: state.project.projectId,
              metadata: stored.calculation,
              result: stored.result,
            },
            {
              projectionVersion: 1,
              normalizationVersion: 1,
              configHashSha256: hash(serializePlannerViewHashPreimageV1(selected)),
              presentation: selected.presentation,
            },
          );
          assert.deepEqual(projected, expected);
          if (projected.available) {
            assert.equal(
              projected.binding.calculation?.calculationId,
              stored.calculation.calculationId,
            );
            assert.equal(
              projected.binding.calculation?.resultHashSha256,
              stored.calculation.resultHashSha256,
            );
            assert.equal(projected.binding.inputHashSha256, stored.calculation.inputHashSha256);
            assert.equal(projected.binding.scheduleRevision, state.revision);
            assert.equal(projected.binding.inputState, "saved");
            assert.ok(!request.body.includes("earlyFinish"));
            assert.ok(!request.body.includes("totalFloatMinutes"));
            assert.ok(Buffer.byteLength(request.body) <= 4194304);
          }
          const saved = await applyReview(app, state, await createReview(app, state, selected));
          assertStatus(saved);
          const viewId = saved.json<PlannerViewReceiptV1>().viewId;
          const named = await app.inject({
            method: "GET",
            url: `${state.url}/${viewId}/projection?expectedScheduleRevision=${state.revision}`,
            headers: state.headers,
          });
          assertStatus(named);
          assert.deepEqual(named.json(), projected);
          const renamed = configuration("Renamed grouping");
          renamed.presentation.wbsId = state.childWbsId;
          renamed.presentation.groupBy = "wbs";
          const prior = await app.inject({
            method: "POST",
            url: `${state.url}/projection`,
            headers: state.headers,
            payload: { configuration: renamed, expectedScheduleRevision: state.revision },
          });
          assertStatus(prior);
          const direct = prior.json<PlannerProjectionV1>();
          assert.equal(direct.available, true);
          if (direct.available) {
            assert.equal(direct.visibleActivityCount, 1);
            assert.equal(direct.groupCount, 1);
            assert.equal(
              direct.binding.calculation,
              undefined,
              "Input-only views do not advertise result consumption",
            );
          }
          assert.deepEqual(await scheduleState(db, state), before);
        },
      );
      await t.test(
        "corrupt current result hashes fail calculated views while input-only views remain usable",
        async () => {
          const state = await fixture(db);
          const result = await real.calculate(state.snapshot.input);
          const canonical = serializeScheduleInputV1(state.snapshot.input);
          const json = serializeScheduleResultV1(result);
          const audit = (
            await db`SELECT id FROM audit_events WHERE organization_id=${state.organizationId}
        AND resource_id=${state.project.projectId} ORDER BY occurred_at LIMIT 1`
          )[0]?.id;
          assert.ok(audit);
          await db`INSERT INTO schedule_calculations(id,organization_id,project_id,project_revision,
        input_hash_sha256,result_hash_sha256,engine_contract_version,engine_version,input_canonical,result_json,audit_event_id)
        VALUES(${randomUUID()},${state.organizationId},${state.project.projectId},${state.revision},
          ${hash(canonical)},${"a".repeat(64)},1,${engineVersion},${canonical},${json},${String(audit)})`;
          const calculated = configuration();
          calculated.presentation.sort = { field: "totalFloatMinutes", direction: "asc" };
          assertError(
            await app.inject({
              method: "POST",
              url: `${state.url}/projection`,
              headers: state.headers,
              payload: { configuration: calculated, expectedScheduleRevision: state.revision },
            }),
            503,
            "view_integrity_error",
          );
          const inputOnly = await app.inject({
            method: "POST",
            url: `${state.url}/projection`,
            headers: state.headers,
            payload: { configuration: configuration(), expectedScheduleRevision: state.revision },
          });
          assertStatus(inputOnly);
          const projection = inputOnly.json<PlannerProjectionV1>();
          assert.equal(projection.available, true);
          if (projection.available)
            assert.deepEqual(
              projection.rows.filter((row) => row.kind === "activity").map((row) => row.activityId),
              state.activityIds,
            );
        },
      );
      await t.test(
        "deleted direct-WBS references remain private saved records and never widen",
        async () => {
          const state = await fixture(db);
          const selected = configuration("Unused direct WBS");
          selected.presentation.wbsId = state.unusedWbsId;
          const saved = await applyReview(app, state, await createReview(app, state, selected));
          assertStatus(saved);
          const viewId = saved.json<PlannerViewReceiptV1>().viewId;
          await db.begin(async (sql) => {
            await sql`SELECT id FROM projects WHERE id=${state.project.projectId} FOR UPDATE`;
            await sql`DELETE FROM wbs_nodes WHERE id=${state.unusedWbsId} AND project_id=${state.project.projectId}`;
            await sql`UPDATE projects SET revision=revision+1 WHERE id=${state.project.projectId}`;
          });
          state.revision++;
          assertError(
            await app.inject({
              method: "GET",
              url: `${state.url}/${viewId}/projection?expectedScheduleRevision=${state.revision}`,
              headers: state.headers,
            }),
            409,
            "view_reference_stale",
          );
          const retained = await app.inject({
            method: "GET",
            url: `${state.url}/${viewId}`,
            headers: state.headers,
          });
          assertStatus(retained);
          assert.equal(
            retained.json<{ configuration: ReturnType<typeof configuration> }>().configuration
              .presentation.wbsId,
            state.unusedWbsId,
          );
          assertError(
            await app.inject({
              method: "POST",
              url: `${state.url}/projection`,
              headers: state.headers,
              payload: { configuration: selected, expectedScheduleRevision: state.revision },
            }),
            409,
            "view_reference_stale",
          );
          assertError(
            await app.inject({
              method: "POST",
              url: `${state.url}/projection`,
              headers: state.headers,
              payload: {
                configuration: configuration(),
                expectedScheduleRevision: state.revision - 1,
              },
            }),
            409,
            "view_schedule_revision_conflict",
          );
        },
      );
      await t.test(
        "one source transaction excludes schedule writes until current saved projection is complete",
        async () => {
          const state = await fixture(db);
          const stored = await new CalculationRepository(db).finalize(
            state.context,
            state.project.projectId,
            state.session.principal,
            state.snapshot,
            await real.calculate(state.snapshot.input),
            engineVersion,
          );
          assert.ok(stored.calculation);
          const gate = deferred(),
            release = deferred();
          let projectionPid = 0;
          const coordinated = new Proxy(db, {
            get(target, property, receiver) {
              if (property !== "begin") return Reflect.get(target, property, receiver);
              return async (callback: (sql: DatabaseExecutor) => Promise<unknown>) =>
                target.begin(async (sql) => {
                  const executor = new Proxy(sql, {
                    async apply(query, thisArg, args) {
                      const rows = await Reflect.apply(query, thisArg, args);
                      const statement = Array.isArray(args[0]) ? args[0].join(" ") : "";
                      if (/FROM schedule_calculations\b/.test(statement)) {
                        projectionPid = Number((await sql`SELECT pg_backend_pid() AS pid`)[0]?.pid);
                        gate.resolve();
                        await release.promise;
                      }
                      return rows;
                    },
                  });
                  return callback(executor);
                });
            },
          });
          const selected = configuration();
          selected.presentation.critical = "critical";
          const repository = new PlannerViewRepository(coordinated, compatibleReader);
          const projecting = repository.projection(
            state.context,
            state.project.projectId,
            state.session.principal,
            selected,
            state.revision,
          );
          const writer = createDatabase({ ...isolated.config, maxConnections: 1 });
          try {
            await bounded(gate.promise, "Coherent projection must read genuine saved Rust rows");
            const writerPid = Number((await writer`SELECT pg_backend_pid() AS pid`)[0]?.pid);
            const writing = new PlannerRepository(writer).createActivity(
              state.context,
              state.project.projectId,
              state.revision,
              {
                name: "After projection",
                wbsId: state.project.rootWbsId,
                calendarId: state.project.calendarId,
                kind: "TASK",
                durationMinutes: 480,
                constraints: [],
                sortOrder: 3,
              },
            );
            await awaitBlocked(db, writerPid, projectionPid);
            release.resolve();
            const projected = await projecting;
            assert.equal(projected.available, true);
            if (projected.available) {
              assert.equal(projected.binding.scheduleRevision, state.revision);
              assert.equal(
                projected.binding.calculation?.calculationId,
                stored.calculation.calculationId,
              );
            }
            const changed = await writing;
            assert.equal(changed.revision, state.revision + 1);
            assertError(
              await app.inject({
                method: "POST",
                url: `${state.url}/projection`,
                headers: state.headers,
                payload: { configuration: selected, expectedScheduleRevision: changed.revision },
              }),
              409,
              "view_result_required",
            );
          } finally {
            release.resolve();
            await projecting.catch(() => {});
            await writer.end({ timeout: 5 });
          }
        },
      );
      await t.test(
        "empty saved Rust results reject scalar or array activity maps despite matching hashes",
        async () => {
          const empty = async () => {
            const state = await fixture(db);
            for (const id of state.activityIds) {
              const removed = await new PlannerRepository(db).deleteActivity(
                state.context,
                state.project.projectId,
                id,
                state.revision,
              );
              state.revision = removed;
            }
            const snapshot = await new ProjectRepository(db).plannerSnapshot(
              state.context,
              state.project.projectId,
            );
            assert.ok(snapshot);
            assert.equal(snapshot.input.activities.length, 0);
            state.snapshot = snapshot;
            state.activityIds = [];
            return state;
          };
          const calculated = configuration("Empty calculated view");
          calculated.presentation.critical = "critical";
          const valid = await empty();
          const result = await real.calculate(valid.snapshot.input);
          assert.deepEqual(result.activities, {});
          const stored = await new CalculationRepository(db).finalize(
            valid.context,
            valid.project.projectId,
            valid.session.principal,
            valid.snapshot,
            result,
            engineVersion,
          );
          assert.ok(stored.calculation);
          const success = await app.inject({
            method: "POST",
            url: `${valid.url}/projection`,
            headers: valid.headers,
            payload: { configuration: calculated, expectedScheduleRevision: valid.revision },
          });
          assertStatus(success);
          const projection = success.json<PlannerProjectionV1>();
          assert.equal(projection.available, true);
          if (projection.available) {
            assert.deepEqual(projection.rows, []);
            assert.equal(projection.sourceActivityCount, 0);
            assert.equal(projection.visibleActivityCount, 0);
            assert.equal(
              projection.binding.calculation?.calculationId,
              stored.calculation.calculationId,
            );
          }
          for (const activityMap of [7, true, null, []]) {
            const state = await empty();
            const genuine = await real.calculate(state.snapshot.input);
            const canonical = serializeScheduleInputV1(state.snapshot.input);
            const corruptJson = JSON.stringify({ ...genuine, activities: activityMap });
            const audit = (
              await db`SELECT id FROM audit_events WHERE organization_id=${state.organizationId}
            AND resource_id=${state.project.projectId} ORDER BY occurred_at LIMIT 1`
            )[0]?.id;
            assert.ok(audit);
            // Genuine saved input and real Rust result envelope, with only the
            // map damaged. Recomputing its raw hash must not authenticate shape.
            // Insert into a fresh fixture so append-only protections remain active.
            await db`INSERT INTO schedule_calculations(id,organization_id,project_id,project_revision,
            input_hash_sha256,result_hash_sha256,engine_contract_version,engine_version,input_canonical,result_json,audit_event_id)
            VALUES(${randomUUID()},${state.organizationId},${state.project.projectId},${state.revision},
              ${hash(canonical)},${hash(corruptJson)},1,${engineVersion},${canonical},${corruptJson},${String(audit)})`;
            assertError(
              await app.inject({
                method: "POST",
                url: `${state.url}/projection`,
                headers: state.headers,
                payload: { configuration: calculated, expectedScheduleRevision: state.revision },
              }),
              503,
              "view_integrity_error",
            );
            const inputOnly = await app.inject({
              method: "POST",
              url: `${state.url}/projection`,
              headers: state.headers,
              payload: { configuration: configuration(), expectedScheduleRevision: state.revision },
            });
            assertStatus(inputOnly);
            const native = inputOnly.json<PlannerProjectionV1>();
            assert.equal(native.available, true);
            if (native.available) assert.deepEqual(native.rows, []);
          }
        },
      );
    } finally {
      await app.close();
      await isolated.dispose();
    }
  },
);
