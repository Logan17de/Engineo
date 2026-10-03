import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { tenantContext } from "./db/tenant-context.js";
import { PlannerRepository } from "./repositories/planner-repository.js";
import { ProjectRepository } from "./repositories/project-repository.js";
import { issueSession } from "./security/session.js";

test("a displayed-session binding cannot execute with another shared-project writer's cookie", {
  skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not configured",
}, async () => {
  const db = createDatabase();
  await migrateDatabase(db);
  const app = buildApp({ database: db });
  const org = randomUUID(),
    first = randomUUID(),
    second = randomUUID();
  try {
    await db`INSERT INTO organizations (id,slug,name) VALUES (${org},${org},'Shared writer fixture')`;
    await db`INSERT INTO users (id,email) VALUES (${first},${`${first}@example.test`}),(${second},${`${second}@example.test`})`;
    await db`INSERT INTO organization_memberships (organization_id,user_id,role) VALUES (${org},${first},'owner'),(${org},${second},'owner')`;
    const context = tenantContext(org, first);
    const project = await new PlannerRepository(db).createProject(context, {
      name: "Shared project",
      code: null,
      description: null,
      plannedStart: "2026-10-05T08:00:00Z",
      timeZone: "UTC",
    });
    const snapshot = await new ProjectRepository(db).plannerSnapshot(context, project.projectId);
    assert.ok(snapshot);
    const sessionA = await issueSession(db, first, `${first}@example.test`, null, undefined);
    const sessionB = await issueSession(db, second, `${second}@example.test`, null, undefined);
    const headers = {
      cookie: `engineo_session=${sessionB.token}; engineo_csrf=${sessionB.csrfToken}`,
      "x-csrf-token": sessionB.csrfToken,
      "x-engineo-session": sessionA.principal.sessionId,
    };
    const url = `/organizations/${org}/projects/${project.projectId}`;
    for (const request of [
      { method: "GET" as const, url: `${url}/schedule` },
      { method: "GET" as const, url: `${url}/schedule/export` },
      {
        method: "POST" as const,
        url: `${url}/schedule/run`,
        payload: { expectedRevision: snapshot.revision },
      },
      {
        method: "PUT" as const,
        url: `${url}/schedule`,
        payload: { expectedRevision: snapshot.revision, input: snapshot.input },
      },
      { method: "POST" as const, url: "/auth/logout" },
    ]) {
      const denied = await app.inject({ ...request, headers });
      assert.equal(denied.statusCode, 409, denied.body);
      assert.equal(denied.json().error, "session_changed");
      assert.equal(denied.headers["set-cookie"], undefined);
    }
    const live = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { cookie: headers.cookie },
    });
    assert.equal(live.statusCode, 200);
    assert.equal(live.json().session.id, sessionB.principal.sessionId);
    assert.equal(live.headers["x-engineo-session"], sessionB.principal.sessionId);
    const allowed = await app.inject({
      method: "PUT",
      url: `${url}/schedule`,
      headers: { ...headers, "x-engineo-session": sessionB.principal.sessionId },
      payload: { expectedRevision: snapshot.revision, input: snapshot.input },
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
    const audits =
      await db`SELECT actor_id FROM audit_events WHERE organization_id=${org} AND action='project.schedule.edit'`;
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.actor_id, second);
  } finally {
    await app.close();
    await db.end({ timeout: 5 });
  }
});
