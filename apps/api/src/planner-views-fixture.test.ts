import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { PlannerViewConfigurationV1, PlannerViewPlanV1 } from "@engineo/contracts";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createBrowserDatabase } from "../../../scripts/browser-test-database.mjs";
import { buildApp } from "./app.js";
import { createDatabase, type Database, type DatabaseExecutor } from "./db/client.js";
import { databaseConfigFromEnv } from "./db/config.js";
import { tenantContext } from "./db/tenant-context.js";
import { PlannerRepository } from "./repositories/planner-repository.js";
import { ProjectRepository } from "./repositories/project-repository.js";
import type { ScheduleRunner } from "./scheduler/runner.js";
import type { OrganizationRole, ProjectRole } from "./security/rbac.js";
import { type IssuedSession, issueSession } from "./security/session.js";

process.env.APP_ORIGIN ??= "http://engineo.example.test";

export const databaseTest = {
  skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not configured",
  timeout: 180_000,
};
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const headersFor = (session: IssuedSession) => ({
  cookie: `engineo_session=${session.token}; engineo_csrf=${session.csrfToken}`,
  "x-csrf-token": session.csrfToken,
  "x-engineo-session": session.principal.sessionId,
  origin: process.env.APP_ORIGIN ?? "http://engineo.example.test",
});
export const configuration = (name = "Private view"): PlannerViewConfigurationV1 => ({
  schemaVersion: 1,
  kind: "engineo-planner-view",
  name,
  visibility: "private",
  presentation: {
    search: "",
    kind: "all",
    wbsId: null,
    critical: "all",
    sort: { field: "native", direction: "asc" },
    groupBy: "none",
  },
});
export function assertStatus(response: LightMyRequestResponse, status = 200): void {
  // Do not print a returned configuration/search value in a failing assertion.
  assert.equal(response.statusCode, status, `Unexpected HTTP status (${response.statusCode})`);
}
export function assertError(response: LightMyRequestResponse, status: number, code: string): void {
  assertStatus(response, status);
  assert.equal(response.json<{ error: string }>().error, code);
}

/** Every suite has a TEMPLATE template0 database. Never migrate the source database. */
export async function isolatedDatabase() {
  const config = databaseConfigFromEnv();
  const disposable = await createBrowserDatabase(config.url, (url: string) =>
    createDatabase({ ...config, url }),
  );
  const isolatedConfig = { ...config, url: disposable.env.DATABASE_URL };
  const db = createDatabase(isolatedConfig);
  try {
    const productionMigrations = (await import(
      new URL("../dist/db/migrate.js", import.meta.url).href
    )) as {
      migrateDatabase: (database: Database) => Promise<void>;
    };
    await productionMigrations.migrateDatabase(db);
  } catch (error) {
    await db.end({ timeout: 5 });
    await disposable.dispose();
    throw error;
  }
  return {
    db,
    config: isolatedConfig,
    dispose: async () => {
      await db.end({ timeout: 5 });
      await disposable.dispose();
    },
  };
}

export async function fixture(db: Database) {
  const organizationId = randomUUID(),
    ownerId = randomUUID();
  await db`INSERT INTO organizations(id,slug,name)
    VALUES(${organizationId},${organizationId},'Private view fixture')`;
  await db`INSERT INTO users(id,email) VALUES(${ownerId},${`${ownerId}@example.test`})`;
  await db`INSERT INTO organization_memberships(organization_id,user_id,role)
    VALUES(${organizationId},${ownerId},'owner')`;
  const context = tenantContext(organizationId, ownerId, randomUUID());
  const planner = new PlannerRepository(db);
  const project = await planner.createProject(context, {
    name: "Private view project",
    code: null,
    description: null,
    plannedStart: "2026-10-05T08:00:00Z",
    timeZone: "UTC",
  });
  const child = await planner.createWbs(context, project.projectId, 1, {
    parentId: project.rootWbsId,
    code: "CHILD",
    name: "Child WBS",
    sortOrder: 1,
  });
  const unused = await planner.createWbs(context, project.projectId, child.revision, {
    parentId: project.rootWbsId,
    code: "UNUSED",
    name: "Unused WBS",
    sortOrder: 2,
  });
  let revision = unused.revision;
  const activityIds: string[] = [];
  for (const [index, name] of ["Zulu", "alpha", "Middle"].entries()) {
    const activity = await planner.createActivity(context, project.projectId, revision, {
      name,
      wbsId: index === 2 ? child.id : project.rootWbsId,
      calendarId: project.calendarId,
      kind: "TASK",
      durationMinutes: index === 1 ? 960 : 480,
      constraints: [],
      sortOrder: index,
    });
    activityIds.push(activity.id);
    revision = activity.revision;
  }
  const session = await issueSession(db, ownerId, `${ownerId}@example.test`, null, undefined);
  const snapshot = await new ProjectRepository(db).plannerSnapshot(context, project.projectId);
  assert.ok(snapshot);
  return {
    organizationId,
    ownerId,
    context,
    project,
    childWbsId: child.id,
    unusedWbsId: unused.id,
    activityIds,
    revision,
    session,
    headers: headersFor(session),
    snapshot,
    url: `/organizations/${organizationId}/projects/${project.projectId}/views`,
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function actor(
  db: Database,
  state: Fixture,
  organizationRole: OrganizationRole,
  projectRole: ProjectRole | null,
) {
  const userId = randomUUID();
  await db`INSERT INTO users(id,email) VALUES(${userId},${`${userId}@example.test`})`;
  await db`INSERT INTO organization_memberships(organization_id,user_id,role)
    VALUES(${state.organizationId},${userId},${organizationRole})`;
  if (projectRole)
    await db`INSERT INTO project_memberships(organization_id,project_id,user_id,role)
      VALUES(${state.organizationId},${state.project.projectId},${userId},${projectRole})`;
  const session = await issueSession(db, userId, `${userId}@example.test`, null, undefined);
  return { userId, session, headers: headersFor(session) };
}
export function appFor(db: Database, scheduleRunner?: ScheduleRunner): FastifyInstance {
  return buildApp({
    database: db,
    scheduleRunner: scheduleRunner ?? {
      getEngineVersion: async () => "engineo-view-test/1",
      calculate: async () => {
        throw new Error("A private presentation operation must never calculate a schedule");
      },
    },
  });
}

export async function capability(
  app: FastifyInstance,
  state: Fixture,
  headers = state.headers,
): Promise<{ operationWindowId: string; [key: string]: unknown }> {
  const response = await app.inject({ method: "GET", url: `${state.url}/capabilities`, headers });
  assertStatus(response);
  assert.equal(response.headers["cache-control"], "no-store");
  const value = response.json<{ operationWindowId: string; [key: string]: unknown }>();
  assert.match(value.operationWindowId, /^\d{4}-\d{2}-\d{2}$/);
  return value;
}
export type ReviewEnvelope = PlannerViewPlanV1;
export async function createReview(
  app: FastifyInstance,
  state: Fixture,
  config = configuration(),
  headers = state.headers,
  operationId: string = randomUUID(),
): Promise<ReviewEnvelope> {
  const { operationWindowId } = await capability(app, state, headers);
  const response = await app.inject({
    method: "POST",
    url: `${state.url}/plan`,
    headers,
    payload: {
      action: "create",
      operationWindowId,
      operationId,
      expectedScheduleRevision: state.revision,
      configuration: config,
    },
  });
  assertStatus(response);
  assert.equal(response.headers["cache-control"], "no-store");
  return response.json<ReviewEnvelope>();
}
export async function applyReview(
  app: FastifyInstance,
  state: Fixture,
  review: ReviewEnvelope,
  headers = state.headers,
) {
  return app.inject({ method: "POST", url: `${state.url}/apply`, headers, payload: review });
}
export async function viewState(db: DatabaseExecutor, state: Fixture) {
  return {
    views: await db`SELECT * FROM project_planner_views
      WHERE organization_id=${state.organizationId} AND project_id=${state.project.projectId} ORDER BY id`,
    operations: await db`SELECT * FROM planner_view_operations
      WHERE organization_id=${state.organizationId} AND project_id=${state.project.projectId}
      ORDER BY actor_id,operation_window_id,operation_id`,
    audits: await db`SELECT * FROM audit_events
      WHERE organization_id=${state.organizationId} AND resource_id=${state.project.projectId}
      AND action='view.apply' ORDER BY id`,
    projectBudget: await db`SELECT * FROM planner_view_project_storage
      WHERE organization_id=${state.organizationId} AND project_id=${state.project.projectId}`,
    globalBudget: await db`SELECT * FROM planner_view_storage_budget`,
  };
}
export async function scheduleState(db: DatabaseExecutor, state: Fixture) {
  return {
    projects: await db`SELECT * FROM projects WHERE id=${state.project.projectId}`,
    activities:
      await db`SELECT * FROM activities WHERE project_id=${state.project.projectId} ORDER BY sort_order,id`,
    wbs: await db`SELECT * FROM wbs_nodes WHERE project_id=${state.project.projectId} ORDER BY sort_order,id`,
    calendars:
      await db`SELECT * FROM calendars WHERE project_id=${state.project.projectId} ORDER BY id`,
    settings:
      await db`SELECT * FROM project_schedule_settings WHERE project_id=${state.project.projectId}`,
    relationships:
      await db`SELECT * FROM relationships WHERE project_id=${state.project.projectId} ORDER BY id`,
    calculations:
      await db`SELECT * FROM schedule_calculations WHERE project_id=${state.project.projectId} ORDER BY id`,
    audits: await db`SELECT * FROM audit_events WHERE resource_id=${state.project.projectId}
      AND action<>'view.apply' ORDER BY id`,
  };
}

export function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export async function bounded<T>(
  promise: PromiseLike<T>,
  message: string,
  timeoutMs = 8_000,
): Promise<T> {
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
export async function awaitBlocked(db: Database, waiterPid: number, blockerPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows =
      await db`SELECT ${blockerPid}::int = ANY(pg_blocking_pids(${waiterPid}::int)) AS blocked`;
    if (rows[0]?.blocked === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Private-view operation did not reach the independently held database lock");
}
