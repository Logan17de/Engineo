import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import test from "node:test";
import {
  type EngineProjectInputV1,
  type EngineScheduleResultV1,
  type ScheduleCalculationMetadataV1,
  serializeScheduleInputV1,
  serializeScheduleResultV1,
} from "@engineo/contracts";
import { buildApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { tenantContext } from "./db/tenant-context.js";
import { CalculationRepository } from "./repositories/calculation-repository.js";
import { ProjectRepository } from "./repositories/project-repository.js";
import { ProcessScheduleRunner, ScheduleEngineError } from "./scheduler/runner.js";
import { issueSession } from "./security/session.js";

interface Response {
  revision: number;
  result: EngineScheduleResultV1 | null;
  calculation: ScheduleCalculationMetadataV1 | null;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

test("durable real-Rust results restore after API restart, retain provenance and dedupe across replicas", {
  skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not configured",
}, async (t) => {
  const binaryPath = process.env.ENGINEO_SCHEDULER_BIN;
  assert.ok(binaryPath, "Configured DB integration requires the release Rust bridge");
  await access(binaryPath);
  let db = createDatabase();
  await migrateDatabase(db);
  let app = buildApp({ database: db, scheduleRunner: new ProcessScheduleRunner({ binaryPath }) });
  const org = randomUUID(),
    owner = randomUUID(),
    viewer = randomUUID(),
    foreignOrg = randomUUID(),
    foreign = randomUUID();
  try {
    await db`INSERT INTO organizations (id, slug, name) VALUES (${org}, ${org}, 'Durable'), (${foreignOrg}, ${foreignOrg}, 'Other')`;
    await db`INSERT INTO users (id, email) VALUES (${owner}, ${`${owner}@example.test`}), (${viewer}, ${`${viewer}@example.test`}), (${foreign}, ${`${foreign}@example.test`})`;
    await db`INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (${org}, ${owner}, 'owner'), (${org}, ${viewer}, 'viewer'), (${foreignOrg}, ${foreign}, 'owner')`;
    const auth = await issueSession(db, owner, `${owner}@example.test`, null, undefined);
    const viewAuth = await issueSession(db, viewer, `${viewer}@example.test`, null, undefined);
    const foreignAuth = await issueSession(db, foreign, `${foreign}@example.test`, null, undefined);
    const headers = {
      cookie: `engineo_session=${auth.token}; engineo_csrf=${auth.csrfToken}`,
      "x-csrf-token": auth.csrfToken,
    };
    const viewerHeaders = { cookie: `engineo_session=${viewAuth.token}` };
    const foreignHeaders = { cookie: `engineo_session=${foreignAuth.token}` };
    const create = await app.inject({
      method: "POST",
      url: `/organizations/${org}/projects`,
      headers,
      payload: { name: "Durable", plannedStart: "2026-10-05T08:00:00Z", timeZone: "UTC" },
    });
    assert.equal(create.statusCode, 201, create.body);
    const project = create.json<{ projectId: string; calendarId: string; rootWbsId: string }>();
    const url = `/organizations/${org}/projects/${project.projectId}`;
    await db`INSERT INTO project_memberships (organization_id, project_id, user_id, role) VALUES (${org}, ${project.projectId}, ${viewer}, 'viewer')`;
    const add = await app.inject({
      method: "POST",
      url: `${url}/activities`,
      headers,
      payload: {
        expectedRevision: 1,
        wbsId: project.rootWbsId,
        calendarId: project.calendarId,
        name: "Foundation",
        kind: "TASK",
        durationMinutes: 480,
      },
    });
    assert.equal(add.statusCode, 201, add.body);
    let revision = add.json<{ revision: number }>().revision;
    const read = () => app.inject({ method: "GET", url: `${url}/schedule/result`, headers });
    const run = () =>
      app.inject({
        method: "POST",
        url: `${url}/schedule/run`,
        headers,
        payload: { expectedRevision: revision },
      });

    await t.test("unrun/null behavior and permissions", async () => {
      const empty = await read();
      assert.equal(empty.statusCode, 200, empty.body);
      assert.deepEqual(empty.json(), { revision, result: null, calculation: null });
      assert.equal(empty.headers["cache-control"], "no-store");
      assert.equal(
        (await app.inject({ method: "GET", url: `${url}/schedule/result` })).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: `${url}/schedule/result`,
            headers: foreignHeaders,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: `/organizations/${foreignOrg}/projects/${project.projectId}/schedule/result`,
            headers,
          })
        ).statusCode,
        403,
      );
    });

    let committed: Response;
    await t.test(
      "real result, canonical hashes, atomic audit and repeat request reuse",
      async () => {
        const response = await run();
        assert.equal(response.statusCode, 200, response.body);
        committed = response.json<Response>();
        assert.ok(committed.result && committed.calculation);
        assert.equal(
          Date.parse(committed.result.projectFinish),
          Date.parse("2026-10-05T17:00:00Z"),
        );
        const snapshot = (
          await app.inject({ method: "GET", url: `${url}/schedule`, headers })
        ).json<{ input: EngineProjectInputV1 }>();
        assert.equal(
          committed.calculation.inputHashSha256,
          digest(serializeScheduleInputV1(snapshot.input)),
        );
        assert.equal(
          committed.calculation.resultHashSha256,
          digest(serializeScheduleResultV1(committed.result)),
        );
        assert.equal(committed.calculation.projectRevision, revision);
        assert.equal(committed.calculation.engineContractVersion, 1);
        assert.match(
          committed.calculation.engineVersion,
          /^engineo-scheduling\/0\.1\.0\+source-fnv1a-[a-f0-9]{16}$/,
        );
        const repeated = await run();
        assert.equal(repeated.statusCode, 200, repeated.body);
        assert.deepEqual(repeated.json(), committed);
        const cached = buildApp({
          database: db,
          scheduleRunner: {
            getEngineVersion: async () => committed.calculation?.engineVersion ?? "missing",
            calculate: async () => {
              throw new Error("A completed identical run must be reused without launching Rust");
            },
          },
        });
        try {
          const reused = await cached.inject({
            method: "POST",
            url: `${url}/schedule/run`,
            headers,
            payload: { expectedRevision: revision },
          });
          assert.equal(reused.statusCode, 200, reused.body);
          assert.deepEqual(reused.json(), committed);
        } finally {
          await cached.close();
        }
        const audits =
          await db`SELECT id, payload FROM audit_events WHERE organization_id = ${org} AND resource_id = ${project.projectId} AND action = 'schedule.run'`;
        const rows =
          await db`SELECT id, audit_event_id FROM schedule_calculations WHERE organization_id = ${org} AND project_id = ${project.projectId}`;
        assert.equal(rows.length, 1);
        assert.equal(audits.length, 1);
        assert.equal(rows[0]?.audit_event_id, audits[0]?.id);
        assert.equal(audits[0]?.payload.calculationId, committed.calculation.calculationId);
        assert.deepEqual(
          (
            await app.inject({
              method: "GET",
              url: `${url}/schedule/result`,
              headers: viewerHeaders,
            })
          ).json(),
          committed,
        );
      },
    );

    await t.test(
      "different valid output for the same identity fails closed without rewriting history",
      async () => {
        assert.ok(committed.result && committed.calculation);
        const context = tenantContext(org, owner, randomUUID());
        const snapshot = await new ProjectRepository(db).plannerSnapshot(
          context,
          project.projectId,
        );
        assert.ok(snapshot);
        const altered = structuredClone(committed.result);
        altered.lateProjectFinish = "2026-10-06T17:00:00Z";
        await assert.rejects(
          new CalculationRepository(db).finalize(
            context,
            project.projectId,
            auth.principal,
            snapshot,
            altered,
            committed.calculation.engineVersion,
          ),
          (error: unknown) =>
            error instanceof ScheduleEngineError && error.code === "schedule_result_conflict",
        );
        assert.deepEqual((await read()).json(), committed);
        assert.equal(
          Number(
            (
              await db`SELECT count(*)::int AS count FROM schedule_calculations WHERE project_id = ${project.projectId}`
            )[0]?.count,
          ),
          1,
        );
        assert.equal(
          Number(
            (
              await db`SELECT count(*)::int AS count FROM audit_events WHERE resource_id = ${project.projectId} AND action = 'schedule.run'`
            )[0]?.count,
          ),
          1,
        );
      },
    );

    await t.test("new API and DB connection restore exact immutable result", async () => {
      await app.close();
      await db.end({ timeout: 5 });
      db = createDatabase();
      app = buildApp({ database: db, scheduleRunner: new ProcessScheduleRunner({ binaryPath }) });
      const restored = await read();
      assert.equal(restored.statusCode, 200, restored.body);
      assert.deepEqual(restored.json(), committed);
    });

    await t.test(
      "engine version or revision changes make history unavailable as current",
      async () => {
        const changedEngine = buildApp({
          database: db,
          scheduleRunner: {
            getEngineVersion: async () => "engineo-scheduling/changed-build",
            calculate: async () => {
              throw new Error("GET must not calculate");
            },
          },
        });
        try {
          const stale = await changedEngine.inject({
            method: "GET",
            url: `${url}/schedule/result`,
            headers,
          });
          assert.equal(stale.statusCode, 200, stale.body);
          assert.deepEqual(stale.json(), { revision, result: null, calculation: null });
        } finally {
          await changedEngine.close();
        }
        const snapshot = (
          await app.inject({ method: "GET", url: `${url}/schedule`, headers })
        ).json<{ input: EngineProjectInputV1 }>();
        snapshot.input.project.name = "Edited";
        const edited = await app.inject({
          method: "PUT",
          url: `${url}/schedule`,
          headers,
          payload: { expectedRevision: revision, input: snapshot.input },
        });
        assert.equal(edited.statusCode, 200, edited.body);
        revision++;
        assert.deepEqual((await read()).json(), { revision, result: null, calculation: null });
        assert.equal(
          Number(
            (
              await db`SELECT count(*)::int AS count FROM schedule_calculations WHERE project_id = ${project.projectId}`
            )[0]?.count,
          ),
          1,
        );
      },
    );

    await t.test(
      "two replica-equivalent finalizers commit one immutable result and audit",
      async () => {
        let release: () => void = () => {},
          arrived: () => void = () => {},
          arrivals = 0;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const ready = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        const replicas = [0, 1].map(() => {
          const real = new ProcessScheduleRunner({ binaryPath });
          return buildApp({
            database: db,
            scheduleRunner: {
              getEngineVersion: () => real.getEngineVersion(),
              async calculate(input, signal) {
                const result = await real.calculate(input, signal);
                if (++arrivals === 2) arrived();
                await gate;
                return result;
              },
            },
          });
        });
        const requests = replicas.map((replica) =>
          replica.inject({
            method: "POST",
            url: `${url}/schedule/run`,
            headers,
            payload: { expectedRevision: revision },
          }),
        );
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            ready,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("Both real engines must finish before release")),
                5000,
              );
            }),
          ]);
          release();
          const responses = await Promise.all(requests);
          for (const response of responses) assert.equal(response.statusCode, 200, response.body);
          assert.deepEqual(responses[0]?.json(), responses[1]?.json());
          assert.equal(
            Number(
              (
                await db`SELECT count(*)::int AS count FROM schedule_calculations WHERE project_id = ${project.projectId} AND project_revision = ${revision}`
              )[0]?.count,
            ),
            1,
          );
          assert.equal(
            Number(
              (
                await db`SELECT count(*)::int AS count FROM audit_events WHERE resource_id = ${project.projectId} AND action = 'schedule.run' AND (payload->>'revision')::bigint = ${revision}`
              )[0]?.count,
            ),
            1,
          );
        } finally {
          clearTimeout(timeout);
          release();
          await Promise.allSettled(requests);
          for (const replica of replicas) await replica.close();
        }
      },
    );
    await t.test(
      "database ownership and append-only constraints reject cross-tenant copies and mutation",
      async () => {
        await assert.rejects(
          db`INSERT INTO schedule_calculations
        (id, organization_id, project_id, project_revision, input_hash_sha256, result_hash_sha256,
          engine_contract_version, engine_version, input_canonical, result_json, audit_event_id)
        SELECT ${randomUUID()}, ${foreignOrg}, project_id, project_revision, input_hash_sha256, result_hash_sha256,
          engine_contract_version, engine_version, input_canonical, result_json, audit_event_id
        FROM schedule_calculations WHERE organization_id = ${org} AND project_id = ${project.projectId}
          AND project_revision = ${revision}`,
          (error: unknown) => (error as { code?: string }).code === "23503",
        );
        await assert.rejects(
          db`UPDATE schedule_calculations SET engine_version = 'changed'
        WHERE organization_id = ${org} AND project_id = ${project.projectId}`,
          /append-only/,
        );
        await assert.rejects(
          db`DELETE FROM schedule_calculations
        WHERE organization_id = ${org} AND project_id = ${project.projectId}`,
          /append-only/,
        );
        await assert.rejects(db`TRUNCATE schedule_calculations`, /append-only/);
        assert.equal((await read()).statusCode, 200);
      },
    );

    await t.test(
      "stored invalid result fails integrity checks without leaking its payload",
      async () => {
        const badVersion = "engineo-scheduling/test-corrupt";
        const text = JSON.stringify({ schemaVersion: 1, privatePayload: "not a Rust result" });
        await db`INSERT INTO schedule_calculations
        (id, organization_id, project_id, project_revision, input_hash_sha256, result_hash_sha256,
          engine_contract_version, engine_version, input_canonical, result_json, audit_event_id)
        SELECT ${randomUUID()}, organization_id, project_id, project_revision, input_hash_sha256, ${digest(text)},
          engine_contract_version, ${badVersion}, input_canonical, ${text}, audit_event_id
        FROM schedule_calculations WHERE organization_id = ${org} AND project_id = ${project.projectId}
          AND project_revision = ${revision}`;
        const malformed = buildApp({
          database: db,
          scheduleRunner: {
            getEngineVersion: async () => badVersion,
            calculate: async () => {
              throw new Error("GET must not calculate");
            },
          },
        });
        try {
          const response = await malformed.inject({
            method: "GET",
            url: `${url}/schedule/result`,
            headers,
          });
          assert.equal(response.statusCode, 503, response.body);
          assert.equal(response.json<{ error: string }>().error, "schedule_invalid_output");
          assert.equal(response.body.includes("privatePayload"), false);
        } finally {
          await malformed.close();
        }
      },
    );
  } finally {
    await app.close();
    await db.end({ timeout: 5 });
  }
});
