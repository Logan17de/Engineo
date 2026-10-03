import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ActivityCsvPreviewV1, EngineProjectInputV1 } from "@engineo/contracts";
import { buildApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { tenantContext } from "./db/tenant-context.js";
import { csvHash, exportActivityCsv } from "./interchange/activity-csv.js";
import { PlannerRepository } from "./repositories/planner-repository.js";
import { ProjectRepository } from "./repositories/project-repository.js";
import { issueSession } from "./security/session.js";

test("CSV API authenticates, previews, atomically imports and audits real PostgreSQL data", {
  skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not configured",
}, async (t) => {
  const originalOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = "http://localhost:3000";
  const db = createDatabase();
  await migrateDatabase(db);
  const app = buildApp({ database: db });
  const org = randomUUID(),
    otherOrg = randomUUID(),
    owner = randomUUID(),
    viewer = randomUUID(),
    foreign = randomUUID();
  const context = tenantContext(org, owner, "csv-test");
  const planner = new PlannerRepository(db),
    projects = new ProjectRepository(db);
  try {
    for (const id of [org, otherOrg])
      await db`INSERT INTO organizations (id,slug,name) VALUES (${id},${id},'CSV team')`;
    for (const id of [owner, viewer, foreign])
      await db`INSERT INTO users (id,email) VALUES (${id},${`${id}@example.test`})`;
    await db`INSERT INTO organization_memberships (organization_id,user_id,role) VALUES (${org},${owner},'owner'),(${org},${viewer},'viewer'),(${otherOrg},${foreign},'owner')`;
    const definition = {
      name: "CSV project",
      code: null,
      description: null,
      plannedStart: "2026-10-05T08:00:00Z",
      timeZone: "UTC",
    };
    const project = await planner.createProject(context, definition);
    const otherProject = await planner.createProject(
      tenantContext(otherOrg, foreign, "csv-test"),
      definition,
    );
    await db`INSERT INTO project_memberships (organization_id,project_id,user_id,role) VALUES (${org},${project.projectId},${viewer},'viewer')`;
    const state = await projects.plannerSnapshot(context, project.projectId);
    assert.ok(state);
    state.input.activities = ["First activity", "Omitted activity"].map((name) => ({
      id: randomUUID(),
      name,
      kind: "TASK",
      durationMinutes: 480,
      calendarId: project.calendarId,
      wbsId: project.rootWbsId,
      constraints: [{ type: "START_ON_OR_AFTER", instant: "2026-10-05T08:00:00Z" }],
    }));
    const [first, second] = state.input.activities;
    assert.ok(first && second);
    state.input.relationships = [
      {
        predecessorId: first.id,
        successorId: second.id,
        type: "FS",
        lagMinutes: 0,
      },
    ];
    await planner.replaceSchedule(context, project.projectId, 1, state.input);
    const session = await issueSession(db, owner, `${owner}@example.test`, null, undefined);
    const viewerSession = await issueSession(db, viewer, `${viewer}@example.test`, null, undefined);
    const headersFor = (value: typeof session) => ({
      cookie: `engineo_session=${value.token}; engineo_csrf=${value.csrfToken}`,
      "x-csrf-token": value.csrfToken,
      "x-engineo-session": value.principal.sessionId,
    });
    const headers = headersFor(session),
      viewerHeaders = headersFor(viewerSession);
    const path = `/organizations/${org}/projects/${project.projectId}/activities`;
    const read = async () => {
      const value = await projects.plannerSnapshot(context, project.projectId);
      assert.ok(value);
      return value;
    };
    const initial = await read();
    const edited = structuredClone(initial.input);
    const editedActivity = edited.activities[0];
    assert.ok(editedActivity);
    edited.activities = [editedActivity];
    editedActivity.name = '=HYPERLINK("text")';
    editedActivity.durationMinutes = 960;
    const csv = exportActivityCsv(edited);
    const previewRequest = (text = csv, revision = initial.revision) =>
      app.inject({
        method: "POST",
        url: `${path}/import/preview`,
        headers,
        payload: { csv: text, expectedRevision: revision },
      });
    const previewResponse = await previewRequest();
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = previewResponse.json<ActivityCsvPreviewV1>();
    const applyBody = {
      csv,
      expectedRevision: preview.expectedRevision,
      previewHash: preview.previewHash,
    };
    const apply = () =>
      app.inject({ method: "POST", url: `${path}/import/apply`, headers, payload: applyBody });

    await t.test(
      "export bytes match audit digest and viewer reads remain tenant/session scoped",
      async () => {
        const response = await app.inject({
          method: "GET",
          url: `${path}/export`,
          headers: viewerHeaders,
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.body, exportActivityCsv(initial.input));
        assert.equal(response.headers["cache-control"], "no-store");
        assert.match(String(response.headers["content-type"]), /text\/csv/);
        const audits =
          await db`SELECT payload FROM audit_events WHERE resource_id = ${project.projectId} AND action = 'project.export'`;
        assert.equal(audits.at(-1)?.payload.inputHash, csvHash(response.body));
        assert.equal((await app.inject({ method: "GET", url: `${path}/export` })).statusCode, 401);
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: `${path}/export`,
              headers: { ...headers, "x-engineo-session": randomUUID() },
            })
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await app.inject({
              method: "GET",
              url: `/organizations/${otherOrg}/projects/${otherProject.projectId}/activities/export`,
              headers,
            })
          ).statusCode,
          403,
        );
      },
    );
    await t.test(
      "preview has no side effects; malformed, tampered and unauthorized apply leave data intact",
      async () => {
        assert.equal(preview.changedCount, 1);
        assert.equal(preview.omittedCount, 1);
        assert.deepEqual(await read(), initial);
        for (const mode of ["preview", "apply"]) {
          const payload =
            mode === "preview" ? { csv, expectedRevision: initial.revision } : applyBody;
          for (const denied of [
            {},
            viewerHeaders,
            { ...headers, "x-csrf-token": "wrong" },
            { ...headers, origin: "https://untrusted.example" },
          ]) {
            const response = await app.inject({
              method: "POST",
              url: `${path}/import/${mode}`,
              headers: denied,
              payload,
            });
            assert.ok([401, 403].includes(response.statusCode), response.body);
          }
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url: `/organizations/${otherOrg}/projects/${otherProject.projectId}/activities/import/${mode}`,
                headers,
                payload,
              })
            ).statusCode,
            403,
          );
        }
        assert.equal(
          (await previewRequest(csv.replace(project.rootWbsId, otherProject.rootWbsId))).statusCode,
          422,
        );
        assert.equal(
          (await previewRequest(csv.replace(project.calendarId, otherProject.calendarId)))
            .statusCode,
          422,
        );
        assert.equal(
          (await previewRequest(csv.replace(project.projectId, otherProject.projectId))).statusCode,
          422,
        );
        assert.equal((await previewRequest(csv.replace('"960"', '"1e3"'))).statusCode, 422);
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: `${path}/import/apply`,
              headers,
              payload: { ...applyBody, csv: csv.replace('"960"', '"480"') },
            })
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: `${path}/import/apply`,
              headers,
              payload: { csv, expectedRevision: initial.revision },
            })
          ).statusCode,
          400,
        );
        assert.equal((await previewRequest(csv, initial.revision - 1)).statusCode, 409);
        const unchangedCsv = exportActivityCsv(initial.input),
          unchangedPreview = (await previewRequest(unchangedCsv)).json<ActivityCsvPreviewV1>();
        const noOp = await app.inject({
          method: "POST",
          url: `${path}/import/apply`,
          headers,
          payload: {
            csv: unchangedCsv,
            expectedRevision: initial.revision,
            previewHash: unchangedPreview.previewHash,
          },
        });
        assert.equal(noOp.statusCode, 200);
        assert.equal(noOp.json().changedCount, 0);
        assert.deepEqual(await read(), initial);
        assert.equal(
          (
            await db`SELECT id FROM audit_events WHERE resource_id = ${project.projectId} AND action = 'project.activities.import'`
          ).length,
          0,
        );
      },
    );
    await t.test("apply rechecks permission after preview", async () => {
      await db`UPDATE organization_memberships SET role = 'viewer' WHERE organization_id = ${org} AND user_id = ${owner}`;
      try {
        assert.equal((await apply()).statusCode, 403);
        assert.deepEqual(await read(), initial);
      } finally {
        await db`UPDATE organization_memberships SET role = 'owner' WHERE organization_id = ${org} AND user_id = ${owner}`;
      }
    });
    await t.test("audit failure rolls back changed activities and revision", async () => {
      const constraint = `csv_rollback_${project.projectId.replaceAll("-", "")}`;
      await db.unsafe(
        `ALTER TABLE audit_events ADD CONSTRAINT ${constraint} CHECK (resource_id IS DISTINCT FROM '${project.projectId}'::uuid OR action <> 'project.activities.import')`,
      );
      try {
        const response = await apply();
        assert.equal(response.statusCode, 422, response.body);
        assert.deepEqual(await read(), initial);
      } finally {
        await db.unsafe(`ALTER TABLE audit_events DROP CONSTRAINT ${constraint}`);
      }
    });
    await t.test(
      "concurrent/replayed apply commits once, preserves all non-CSV state and recalculates through Rust",
      async () => {
        const results = await Promise.all([apply(), apply()]);
        assert.deepEqual(results.map((response) => response.statusCode).sort(), [200, 409]);
        assert.equal((await apply()).statusCode, 409);
        const after = await read();
        assert.equal(after.revision, initial.revision + 1);
        const expected: EngineProjectInputV1 = structuredClone(initial.input);
        expected.activities[0] = editedActivity;
        assert.deepEqual(after.input, expected);
        assert.deepEqual(after.relationshipIds, initial.relationshipIds);
        const imports =
          await db`SELECT payload FROM audit_events WHERE resource_id = ${project.projectId} AND action = 'project.activities.import'`;
        assert.equal(imports.length, 1);
        assert.equal(imports[0]?.payload.sourceHash, csvHash(csv));
        assert.equal(imports[0]?.payload.previousRevision, initial.revision);
        const edits =
          await db`SELECT payload FROM audit_events WHERE resource_id = ${project.projectId} AND action = 'project.schedule.edit' AND (payload->>'revision')::int = ${after.revision}`;
        assert.equal(edits.length, 1);
        assert.deepEqual(edits[0]?.payload.before, initial.input);
        assert.deepEqual(edits[0]?.payload.after, expected);
        const run = await app.inject({
          method: "POST",
          url: `${path.replace(/\/activities$/, "")}/schedule/run`,
          headers,
          payload: { expectedRevision: after.revision },
        });
        assert.equal(run.statusCode, 200, run.body);
        assert.equal(Object.keys(run.json().result.activities).length, 2);
      },
    );
  } finally {
    if (originalOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = originalOrigin;
    await app.close();
    await db.end({ timeout: 5 });
  }
});
