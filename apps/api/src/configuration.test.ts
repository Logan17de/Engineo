import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { type EngineProjectInputV1, serializeScheduleInputV1 } from "@engineo/contracts";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { createDatabase, type Database } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { tenantContext } from "./db/tenant-context.js";
import { PlannerRepository } from "./repositories/planner-repository.js";
import { ProjectRepository } from "./repositories/project-repository.js";
import { type IssuedSession, issueSession } from "./security/session.js";

interface Configuration {
  schemaVersion: 1;
  kind: "engineo-project-configuration";
  scope: "schedule";
  input: EngineProjectInputV1;
}
interface Plan {
  planId: string;
  reviewedDigest: string;
  baseRevision: number;
  baseInputHashSha256: string;
  desiredInputHashSha256: string;
  noOp: boolean;
  changes: unknown[];
  expiresAt: string;
}
interface Receipt {
  planId: string;
  organizationId: string;
  projectId: string;
  outcome: "applied" | "no_op" | "cancelled";
  previousRevision: number;
  committedRevision: number;
  baseInputHashSha256: string;
  committedInputHashSha256: string;
  reviewedDigest: string;
  provenanceAuditId: string;
  scheduleEditAuditId: string | null;
}
interface PlanResponse {
  plan: Plan | null;
  planId: string;
  status: "pending" | "expired" | "applied" | "no_op" | "cancelled";
  artifactsAvailable: boolean;
  receipt: Receipt | null;
}
const hash = (input: EngineProjectInputV1) =>
  createHash("sha256").update(serializeScheduleInputV1(input)).digest("hex");
const headersFor = (session: IssuedSession) => ({
  cookie: `engineo_session=${session.token}; engineo_csrf=${session.csrfToken}`,
  "x-csrf-token": session.csrfToken,
  "x-engineo-session": session.principal.sessionId,
});
const inertRunner = {
  async getEngineVersion(): Promise<string> {
    throw new Error("Configuration must not launch or inspect the calculation engine");
  },
  async calculate(): Promise<never> {
    throw new Error("Configuration validation and application do not calculate schedules");
  },
};

function reverseObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => reverseObjectKeys(item)) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseObjectKeys(item)]),
    ) as T;
  return value;
}

async function fixture(db: Database) {
  const organizationId = randomUUID(),
    userId = randomUUID();
  await db`INSERT INTO organizations (id, slug, name)
    VALUES (${organizationId}, ${organizationId}, 'Configuration fixture')`;
  await db`INSERT INTO users (id, email) VALUES (${userId}, ${`${userId}@example.test`})`;
  await db`INSERT INTO organization_memberships (organization_id, user_id, role)
    VALUES (${organizationId}, ${userId}, 'owner')`;
  const context = tenantContext(organizationId, userId, `configuration-${randomUUID()}`);
  const planner = new PlannerRepository(db);
  const project = await planner.createProject(context, {
    name: "Configuration project",
    code: "KEEP-CODE",
    description: "Keep project description",
    plannedStart: "2026-10-05T08:00:00Z",
    timeZone: "UTC",
  });
  const first = await planner.createActivity(context, project.projectId, project.revision, {
    name: "Foundation",
    wbsId: project.rootWbsId,
    calendarId: project.calendarId,
    kind: "TASK",
    durationMinutes: 480,
    constraints: [],
    sortOrder: 20,
  });
  const second = await planner.createActivity(context, project.projectId, first.revision, {
    name: "Frame",
    wbsId: project.rootWbsId,
    calendarId: project.calendarId,
    kind: "TASK",
    durationMinutes: 480,
    constraints: [],
    sortOrder: 10,
  });
  const relationship = await planner.createRelationship(
    context,
    project.projectId,
    second.revision,
    {
      predecessorId: first.id,
      successorId: second.id,
      type: "FS",
      lagMinutes: 0,
    },
  );
  const session = await issueSession(db, userId, `${userId}@example.test`, null, undefined);
  const snapshot = await new ProjectRepository(db).plannerSnapshot(context, project.projectId);
  assert.ok(snapshot);
  const configuration: Configuration = {
    schemaVersion: 1,
    kind: "engineo-project-configuration",
    scope: "schedule",
    input: snapshot.input,
  };
  return {
    organizationId,
    userId,
    context,
    project,
    first,
    second,
    relationship,
    session,
    snapshot,
    configuration,
    headers: headersFor(session),
    url: `/organizations/${organizationId}/projects/${project.projectId}/configuration`,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function createPlan(
  app: FastifyInstance,
  state: Fixture,
  configuration = structuredClone(state.configuration),
  planId: string = randomUUID(),
  expectedRevision = state.snapshot.revision,
): Promise<PlanResponse & { plan: Plan }> {
  const response = await app.inject({
    method: "POST",
    url: `${state.url}/plans`,
    headers: state.headers,
    payload: { planId, expectedRevision, configuration },
  });
  assert.ok(response.statusCode === 200 || response.statusCode === 201, response.body);
  const body = response.json<PlanResponse>();
  assert.ok(body.plan);
  assert.equal(body.planId, planId);
  assert.equal(body.plan.planId, planId);
  return { ...body, plan: body.plan };
}
async function apply(app: FastifyInstance, state: Fixture, plan: Plan) {
  return await app.inject({
    method: "POST",
    url: `${state.url}/plans/${plan.planId}/apply`,
    headers: state.headers,
    payload: { expectedRevision: plan.baseRevision, reviewedDigest: plan.reviewedDigest },
  });
}
async function snapshot(db: Database, state: Fixture) {
  const value = await new ProjectRepository(db).plannerSnapshot(
    state.context,
    state.project.projectId,
  );
  assert.ok(value);
  return value;
}
async function member(
  db: Database,
  state: Fixture,
  organizationRole: "owner" | "admin" | "planner" | "viewer",
  projectRole: "manager" | "planner" | "viewer" | null,
) {
  const userId = randomUUID();
  await db`INSERT INTO users (id,email) VALUES (${userId},${`${userId}@example.test`})`;
  await db`INSERT INTO organization_memberships (organization_id,user_id,role)
    VALUES (${state.organizationId},${userId},${organizationRole})`;
  if (projectRole)
    await db`INSERT INTO project_memberships (organization_id,project_id,user_id,role)
      VALUES (${state.organizationId},${state.project.projectId},${userId},${projectRole})`;
  const session = await issueSession(db, userId, `${userId}@example.test`, null, undefined);
  return { userId, session, headers: headersFor(session) };
}
async function configurationAudits(db: Database, state: Fixture) {
  return await db`SELECT id, action, source, actor_id, payload FROM audit_events
    WHERE organization_id=${state.organizationId} AND resource_id=${state.project.projectId}
      AND (action LIKE '%configuration%' OR action IN ('project.schedule.edit','schedule.edit','project.export'))
    ORDER BY occurred_at,id`;
}

// These are application/API integration tests, independent of a Rust executable.
// Configuring DATABASE_URL requires genuine PostgreSQL; no in-memory substitute.
test("configuration API protects reviewed persistence and preserves native project identity", {
  skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not configured",
  timeout: 120_000,
}, async (t) => {
  const db = createDatabase();
  await migrateDatabase(db);
  const app = buildApp({ database: db, scheduleRunner: inertRunner });
  try {
    await t.test("authorized export is canonical, coherent, private and audited", async () => {
      const state = await fixture(db);
      const before = await configurationAudits(db, state);
      const response = await app.inject({ method: "GET", url: state.url, headers: state.headers });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["x-engineo-session"], state.session.principal.sessionId);
      const body = response.json<{
        schemaVersion: 1;
        revision: number;
        inputHashSha256: string;
        configuration: Configuration;
      }>();
      assert.equal(body.schemaVersion, 1);
      assert.equal(body.revision, state.snapshot.revision);
      assert.equal(body.inputHashSha256, hash(state.snapshot.input));
      assert.equal(hash(body.configuration.input), hash(state.snapshot.input));
      assert.deepEqual(Object.keys(body.configuration).sort(), [
        "input",
        "kind",
        "schemaVersion",
        "scope",
      ]);
      for (const secret of [
        state.session.token,
        state.session.csrfToken,
        "Keep project description",
        "KEEP-CODE",
      ])
        assert.equal(response.body.includes(secret), false);
      const after = await configurationAudits(db, state);
      assert.equal(after.length, before.length + 1);
      assert.equal(after.at(-1)?.actor_id, state.userId);
      assert.equal((await snapshot(db, state)).revision, state.snapshot.revision);
    });

    await t.test(
      "validation normalizes UUIDs and setting instants without mutating or planning",
      async () => {
        const state = await fixture(db);
        const configuration = structuredClone(state.configuration);
        configuration.input.project.id = configuration.input.project.id.toUpperCase();
        configuration.input.project.defaultCalendarId =
          configuration.input.project.defaultCalendarId.toUpperCase();
        for (const calendar of configuration.input.calendars)
          calendar.id = calendar.id.toUpperCase();
        for (const node of configuration.input.wbs) {
          node.id = node.id.toUpperCase();
          if (node.parentId) node.parentId = node.parentId.toUpperCase();
        }
        for (const activity of configuration.input.activities) {
          activity.id = activity.id.toUpperCase();
          activity.wbsId = activity.wbsId.toUpperCase();
          activity.calendarId = activity.calendarId.toUpperCase();
        }
        for (const relationship of configuration.input.relationships) {
          relationship.predecessorId = relationship.predecessorId.toUpperCase();
          relationship.successorId = relationship.successorId.toUpperCase();
        }
        configuration.input.project.plannedStart = "2026-10-05T09:00:00+01:00";
        configuration.input.project.dataDate = "2026-10-05T08:00:00.000Z";
        const activity = configuration.input.activities[0];
        assert.ok(activity);
        activity.constraints = [
          { type: "START_ON_OR_AFTER", instant: "2026-10-05T09:00:00+01:00" },
        ];
        const before = await configurationAudits(db, state);
        const response = await app.inject({
          method: "POST",
          url: `${state.url}/validate`,
          headers: state.headers,
          payload: configuration,
        });
        assert.equal(response.statusCode, 200, response.body);
        const body = response.json<{
          valid: boolean;
          normalizedConfiguration: Configuration;
          desiredInputHashSha256: string;
          calculationChecked: boolean;
        }>();
        assert.equal(body.valid, true);
        assert.equal(body.calculationChecked, false);
        assert.equal(
          body.normalizedConfiguration.input.project.plannedStart,
          "2026-10-05T08:00:00.000Z",
        );
        assert.equal(body.normalizedConfiguration.input.project.id, state.project.projectId);
        assert.equal(
          body.normalizedConfiguration.input.activities.find(
            (a) => a.id === activity.id.toLowerCase(),
          )?.constraints[0]?.instant,
          "2026-10-05T09:00:00+01:00",
        );
        assert.equal(body.desiredInputHashSha256, hash(body.normalizedConfiguration.input));
        assert.deepEqual(await snapshot(db, state), state.snapshot);
        assert.deepEqual(await configurationAudits(db, state), before);
        const plans =
          await db`SELECT count(*)::int AS count FROM project_configuration_plans WHERE project_id=${state.project.projectId}`;
        assert.equal(Number(plans[0]?.count), 0);
      },
    );

    await t.test(
      "every configuration endpoint requires cookies and exact session intent",
      async () => {
        const state = await fixture(db);
        const { plan } = await createPlan(app, state);
        const operations = [
          { method: "GET" as const, url: state.url },
          { method: "POST" as const, url: `${state.url}/validate`, payload: state.configuration },
          {
            method: "POST" as const,
            url: `${state.url}/plans`,
            payload: {
              planId: randomUUID(),
              expectedRevision: state.snapshot.revision,
              configuration: state.configuration,
            },
          },
          { method: "GET" as const, url: `${state.url}/plans/${plan.planId}` },
          {
            method: "POST" as const,
            url: `${state.url}/plans/${plan.planId}/apply`,
            payload: { expectedRevision: plan.baseRevision, reviewedDigest: plan.reviewedDigest },
          },
          {
            method: "POST" as const,
            url: `${state.url}/plans/${plan.planId}/cancel`,
            payload: { reviewedDigest: plan.reviewedDigest },
          },
          { method: "GET" as const, url: `${state.url}/plans/${plan.planId}/receipt` },
        ];
        for (const operation of operations) {
          const anonymous = await app.inject({
            ...operation,
            headers: { "x-engineo-session": state.session.principal.sessionId },
          });
          assert.equal(anonymous.statusCode, 401, `${operation.url}: ${anonymous.body}`);
          const noIntent = {
            cookie: state.headers.cookie,
            "x-csrf-token": state.headers["x-csrf-token"],
          };
          const missing = await app.inject({ ...operation, headers: noIntent });
          assert.equal(missing.statusCode, 409, `${operation.url}: ${missing.body}`);
          assert.equal(missing.json().error, "session_intent_required");
          const substituted = await app.inject({
            ...operation,
            headers: { ...state.headers, "x-engineo-session": randomUUID() },
          });
          assert.equal(substituted.statusCode, 409, `${operation.url}: ${substituted.body}`);
          assert.equal(substituted.json().error, "session_changed");
        }
        assert.deepEqual(await snapshot(db, state), state.snapshot);
      },
    );

    await t.test(
      "all POST operations preserve Origin and double-submit/session CSRF checks",
      async () => {
        const state = await fixture(db);
        const { plan } = await createPlan(app, state);
        const oldOrigin = process.env.APP_ORIGIN;
        process.env.APP_ORIGIN = "https://engineo.example.test";
        try {
          const operations = [
            { url: `${state.url}/validate`, payload: state.configuration },
            {
              url: `${state.url}/plans`,
              payload: {
                planId: randomUUID(),
                expectedRevision: plan.baseRevision,
                configuration: state.configuration,
              },
            },
            {
              url: `${state.url}/plans/${plan.planId}/apply`,
              payload: { expectedRevision: plan.baseRevision, reviewedDigest: plan.reviewedDigest },
            },
            {
              url: `${state.url}/plans/${plan.planId}/cancel`,
              payload: { reviewedDigest: plan.reviewedDigest },
            },
          ];
          for (const operation of operations) {
            const badOrigin = await app.inject({
              method: "POST",
              ...operation,
              headers: { ...state.headers, origin: "https://attacker.example.test" },
            });
            assert.equal(badOrigin.statusCode, 403, badOrigin.body);
            assert.equal(badOrigin.json().error, "origin_not_allowed");
            for (const csrfHeaders of [
              {
                cookie: state.headers.cookie,
                "x-engineo-session": state.session.principal.sessionId,
              },
              { ...state.headers, "x-csrf-token": "unrelated" },
              {
                ...state.headers,
                cookie: `engineo_session=${state.session.token}; engineo_csrf=unrelated`,
                "x-csrf-token": "unrelated",
              },
            ]) {
              const denied = await app.inject({
                method: "POST",
                ...operation,
                headers: csrfHeaders,
              });
              assert.equal(denied.statusCode, 403, denied.body);
              assert.equal(denied.json().error, "csrf_validation_failed");
            }
          }
        } finally {
          if (oldOrigin === undefined) delete process.env.APP_ORIGIN;
          else process.env.APP_ORIGIN = oldOrigin;
        }
        assert.deepEqual(await snapshot(db, state), state.snapshot);
      },
    );

    for (const organizationRole of ["owner", "admin", "planner", "viewer"] as const)
      for (const projectRole of ["manager", "planner", "viewer", null] as const)
        await t.test(
          `role intersection ${organizationRole}/${projectRole ?? "missing"} is enforced`,
          async () => {
            const state = await fixture(db);
            const actor = await member(db, state, organizationRole, projectRole);
            const privileged = organizationRole === "owner" || organizationRole === "admin";
            const canRead = privileged || projectRole !== null;
            const canWrite =
              privileged ||
              (organizationRole === "planner" &&
                (projectRole === "manager" || projectRole === "planner"));
            for (const operation of [
              { method: "GET" as const, url: state.url },
              {
                method: "POST" as const,
                url: `${state.url}/validate`,
                payload: state.configuration,
              },
            ]) {
              const response = await app.inject({ ...operation, headers: actor.headers });
              assert.equal(response.statusCode, canRead ? 200 : 403, response.body);
            }
            const planned = await app.inject({
              method: "POST",
              url: `${state.url}/plans`,
              headers: actor.headers,
              payload: {
                planId: randomUUID(),
                expectedRevision: state.snapshot.revision,
                configuration: state.configuration,
              },
            });
            assert.equal(
              planned.statusCode,
              canWrite ? (planned.statusCode === 201 ? 201 : 200) : 403,
              planned.body,
            );
            assert.deepEqual(await snapshot(db, state), state.snapshot);
          },
        );

    await t.test(
      "tenant, project, actor and new-session substitutions cannot adopt a review",
      async () => {
        const state = await fixture(db),
          foreign = await fixture(db);
        const { plan } = await createPlan(app, state);
        const other = await member(db, state, "owner", null);
        const replacement = await issueSession(
          db,
          state.userId,
          `${state.userId}@example.test`,
          null,
          undefined,
        );
        for (const headers of [other.headers, headersFor(replacement)])
          for (const operation of [
            { method: "GET" as const, url: `${state.url}/plans/${plan.planId}` },
            {
              method: "POST" as const,
              url: `${state.url}/plans/${plan.planId}/apply`,
              payload: { expectedRevision: plan.baseRevision, reviewedDigest: plan.reviewedDigest },
            },
            {
              method: "POST" as const,
              url: `${state.url}/plans/${plan.planId}/cancel`,
              payload: { reviewedDigest: plan.reviewedDigest },
            },
          ]) {
            const denied = await app.inject({ ...operation, headers });
            assert.ok(denied.statusCode === 404, denied.body);
            assert.equal(denied.body.includes(plan.reviewedDigest), false);
          }
        for (const operation of [
          { method: "GET" as const, url: state.url },
          { method: "POST" as const, url: `${state.url}/validate`, payload: state.configuration },
          {
            method: "POST" as const,
            url: `${state.url}/plans`,
            payload: {
              planId: randomUUID(),
              expectedRevision: plan.baseRevision,
              configuration: state.configuration,
            },
          },
          { method: "GET" as const, url: `${state.url}/plans/${plan.planId}` },
          {
            method: "POST" as const,
            url: `${state.url}/plans/${plan.planId}/apply`,
            payload: { expectedRevision: plan.baseRevision, reviewedDigest: plan.reviewedDigest },
          },
          {
            method: "POST" as const,
            url: `${state.url}/plans/${plan.planId}/cancel`,
            payload: { reviewedDigest: plan.reviewedDigest },
          },
          { method: "GET" as const, url: `${state.url}/plans/${plan.planId}/receipt` },
        ]) {
          const denied = await app.inject({ ...operation, headers: foreign.headers });
          assert.equal(denied.statusCode, 403, denied.body);
        }
        const otherProject = await new PlannerRepository(db).createProject(state.context, {
          name: "Same tenant other project",
          code: null,
          description: null,
          plannedStart: "2026-10-05T08:00:00Z",
          timeZone: "UTC",
        });
        const substituted = await app.inject({
          method: "GET",
          url: `/organizations/${state.organizationId}/projects/${otherProject.projectId}/configuration/plans/${plan.planId}`,
          headers: state.headers,
        });
        assert.ok(substituted.statusCode >= 400, substituted.body);
        assert.equal(substituted.body.includes(plan.reviewedDigest), false);
        assert.deepEqual(await snapshot(db, state), state.snapshot);
      },
    );

    await t.test(
      "recursive JSON object-key reversal preserves export hash, no-op identity and exact plan replay",
      async () => {
        const state = await fixture(db),
          read = await app.inject({ method: "GET", url: state.url, headers: state.headers });
        assert.equal(read.statusCode, 200, read.body);
        const exported = read.json<{ configuration: Configuration; inputHashSha256: string }>(),
          reversed = reverseObjectKeys(exported.configuration);
        const rows =
          await db`SELECT id,sort_order,created_at,updated_at FROM activities WHERE project_id=${state.project.projectId} ORDER BY sort_order,id`;
        const validation = await app.inject({
          method: "POST",
          url: `${state.url}/validate`,
          headers: state.headers,
          payload: reversed,
        });
        assert.equal(validation.statusCode, 200, validation.body);
        assert.equal(validation.json().desiredInputHashSha256, exported.inputHashSha256);
        const reviewed = await createPlan(app, state, reversed);
        assert.equal(reviewed.plan.noOp, true);
        assert.deepEqual(reviewed.plan.changes, []);
        assert.equal(reviewed.plan.desiredInputHashSha256, exported.inputHashSha256);
        const replay = await createPlan(app, state, exported.configuration, reviewed.planId);
        assert.deepEqual(replay, reviewed);
        const committed = await apply(app, state, reviewed.plan);
        assert.equal(committed.statusCode, 200, committed.body);
        assert.equal(committed.json<Receipt>().outcome, "no_op");
        assert.deepEqual(
          await db`SELECT id,sort_order,created_at,updated_at FROM activities WHERE project_id=${state.project.projectId} ORDER BY sort_order,id`,
          rows,
        );
        assert.deepEqual(await snapshot(db, state), state.snapshot);
      },
    );

    await t.test(
      "material reordered keys and start/end calendar intervals reconstruct exact native canonical bytes",
      async () => {
        const state = await fixture(db),
          configuration = structuredClone(state.configuration),
          calendarId = randomUUID();
        const original = configuration.input.calendars[0];
        assert.ok(original);
        const calendar = {
          ...structuredClone(original),
          id: calendarId,
          name: "Key-order calendar",
          exceptions: [
            { date: "2026-10-06", workingIntervals: [{ start: "09:00", end: "12:00" }] },
          ],
        };
        for (const day of Object.keys(calendar.week) as Array<keyof typeof calendar.week>)
          calendar.week[day] = calendar.week[day].map((interval) => ({
            start: interval.start,
            end: interval.end,
          }));
        configuration.input.calendars.push(calendar);
        configuration.input.project.defaultCalendarId = calendarId;
        const constraintText = "2026-10-05T09:00:00.000+01:00",
          activity = configuration.input.activities[0],
          node = configuration.input.wbs[0];
        assert.ok(activity && node);
        activity.calendarId = calendarId;
        activity.constraints = [{ type: "START_ON_OR_AFTER", instant: constraintText }];
        node.name = "Reordered native WBS";
        const reordered = reverseObjectKeys(configuration);
        const submittedCalendar = reordered.input.calendars.find(
          (value) => value.id === calendarId,
        );
        assert.ok(submittedCalendar);
        for (const day of Object.keys(submittedCalendar.week) as Array<
          keyof typeof submittedCalendar.week
        >)
          submittedCalendar.week[day] = submittedCalendar.week[day].map((interval) => ({
            start: interval.start,
            end: interval.end,
          }));
        submittedCalendar.exceptions = submittedCalendar.exceptions.map((exception) => ({
          date: exception.date,
          workingIntervals: exception.workingIntervals.map((interval) => ({
            start: interval.start,
            end: interval.end,
          })),
        }));
        const validated = await app.inject({
          method: "POST",
          url: `${state.url}/validate`,
          headers: state.headers,
          payload: reordered,
        });
        assert.equal(validated.statusCode, 200, validated.body);
        const normalized = validated.json<{
          normalizedConfiguration: Configuration;
          desiredInputHashSha256: string;
        }>();
        const { plan } = await createPlan(app, state, reordered);
        assert.equal(plan.noOp, false);
        assert.equal(plan.desiredInputHashSha256, normalized.desiredInputHashSha256);
        const applied = await apply(app, state, plan);
        assert.equal(applied.statusCode, 200, applied.body);
        const persisted = await snapshot(db, state);
        assert.equal(
          serializeScheduleInputV1(persisted.input),
          serializeScheduleInputV1(normalized.normalizedConfiguration.input),
        );
        assert.equal(hash(persisted.input), plan.desiredInputHashSha256);
        assert.equal(
          persisted.input.activities.find((value) => value.id === activity.id)?.constraints[0]
            ?.instant,
          constraintText,
        );
        const exported = await app.inject({
          method: "GET",
          url: state.url,
          headers: state.headers,
        });
        assert.equal(exported.statusCode, 200, exported.body);
        assert.equal(exported.json().inputHashSha256, plan.desiredInputHashSha256);
      },
    );

    await t.test(
      "strict transport rejects duplicate keys, unknown nested fields and replacement apply input",
      async () => {
        const state = await fixture(db);
        const { plan } = await createPlan(app, state);
        const malformed: Record<string, unknown>[] = [
          { ...state.configuration, extra: true },
          { ...state.configuration, schemaVersion: 2 },
          { ...state.configuration, kind: "other" },
          { ...state.configuration, scope: "organization" },
          {
            ...state.configuration,
            input: { ...state.configuration.input, unexpected: { url: "https://example.test" } },
          },
          {
            ...state.configuration,
            input: {
              ...state.configuration.input,
              project: { ...state.configuration.input.project, code: "overwrite" },
            },
          },
        ];
        const tooPrecise = structuredClone(state.configuration);
        tooPrecise.input.project.dataDate = "2026-10-05T08:00:00.0001Z";
        malformed.push({ ...tooPrecise });
        for (const payload of malformed) {
          const denied = await app.inject({
            method: "POST",
            url: `${state.url}/validate`,
            headers: state.headers,
            payload,
          });
          assert.equal(denied.statusCode, 422, denied.body);
          assert.equal(denied.json().error, "configuration_invalid");
        }
        for (const url of [`${state.url}/validate`, `${state.url}/plans`]) {
          const payload = url.endsWith("validate")
            ? `{"schemaVersion":1,"schemaVersion":1,"kind":"engineo-project-configuration","scope":"schedule","input":${JSON.stringify(state.configuration.input)}}`
            : `{"planId":"${randomUUID()}","expectedRevision":${plan.baseRevision},"configuration":${JSON.stringify(state.configuration)},"expectedRevision":${plan.baseRevision}}`;
          const response = await app.inject({
            method: "POST",
            url,
            headers: { ...state.headers, "content-type": "application/json" },
            payload,
          });
          assert.equal(response.statusCode, 422, response.body);
          assert.equal(response.json().error, "configuration_invalid");
        }
        for (const operation of [
          {
            url: `${state.url}/plans`,
            payload: {
              planId: "not-a-uuid",
              expectedRevision: plan.baseRevision,
              configuration: state.configuration,
            },
          },
          {
            url: `${state.url}/plans`,
            payload: {
              planId: randomUUID(),
              expectedRevision: String(plan.baseRevision),
              configuration: state.configuration,
            },
          },
          {
            url: `${state.url}/plans/${plan.planId}/apply`,
            payload: {
              expectedRevision: plan.baseRevision,
              reviewedDigest: plan.reviewedDigest,
              configuration: state.configuration,
            },
          },
          {
            url: `${state.url}/plans/${plan.planId}/apply`,
            payload: {
              expectedRevision: plan.baseRevision,
              reviewedDigest: plan.reviewedDigest,
              input: state.configuration.input,
            },
          },
          {
            url: `${state.url}/plans/${plan.planId}/cancel`,
            payload: { reviewedDigest: plan.reviewedDigest, expectedRevision: plan.baseRevision },
          },
        ]) {
          const response = await app.inject({
            method: "POST",
            ...operation,
            headers: state.headers,
          });
          assert.equal(response.statusCode, 422, response.body);
          assert.equal(response.json().error, "configuration_invalid");
        }
        const oversized = await app.inject({
          method: "POST",
          url: `${state.url}/validate`,
          headers: { ...state.headers, "content-type": "application/json" },
          payload: " ".repeat(1024 * 1024 + 1),
        });
        assert.equal(oversized.statusCode, 413, oversized.body);
        assert.deepEqual(await snapshot(db, state), state.snapshot);
      },
    );

    await t.test(
      "native IDs allocated to another tenant or same-tenant project cannot be imported",
      async () => {
        const state = await fixture(db),
          foreign = await fixture(db);
        const same = await new PlannerRepository(db).createProject(state.context, {
          name: "Other native IDs",
          code: null,
          description: null,
          plannedStart: "2026-10-05T08:00:00Z",
          timeZone: "UTC",
        });
        const ids = [
          {
            calendarId: foreign.project.calendarId,
            wbsId: foreign.project.rootWbsId,
            activityId: foreign.first.id,
          },
          { calendarId: same.calendarId, wbsId: same.rootWbsId, activityId: null },
        ];
        for (const allocated of ids) {
          const calendar = structuredClone(state.configuration);
          const oldCalendar = calendar.input.project.defaultCalendarId;
          const c = calendar.input.calendars.find((c) => c.id === oldCalendar);
          assert.ok(c);
          c.id = allocated.calendarId;
          calendar.input.project.defaultCalendarId = c.id;
          for (const activity of calendar.input.activities)
            if (activity.calendarId === oldCalendar) activity.calendarId = c.id;
          const wbs = structuredClone(state.configuration);
          const node = wbs.input.wbs.find((w) => w.id === state.project.rootWbsId);
          assert.ok(node);
          node.id = allocated.wbsId;
          for (const activity of wbs.input.activities) activity.wbsId = node.id;
          const candidates = [calendar, wbs];
          if (allocated.activityId) {
            const activity = structuredClone(state.configuration);
            const original = activity.input.activities[0];
            assert.ok(original);
            const old = original.id;
            original.id = allocated.activityId;
            for (const edge of activity.input.relationships) {
              if (edge.predecessorId === old) edge.predecessorId = original.id;
              if (edge.successorId === old) edge.successorId = original.id;
            }
            candidates.push(activity);
          }
          for (const configuration of candidates)
            for (const operation of [
              { url: `${state.url}/validate`, payload: configuration },
              {
                url: `${state.url}/plans`,
                payload: {
                  planId: randomUUID(),
                  expectedRevision: state.snapshot.revision,
                  configuration,
                },
              },
            ]) {
              const denied = await app.inject({
                method: "POST",
                ...operation,
                headers: state.headers,
              });
              assert.equal(denied.statusCode, 422, denied.body);
              assert.equal(denied.json().error, "configuration_id_conflict");
            }
        }
        assert.deepEqual(await snapshot(db, state), state.snapshot);
        assert.deepEqual(await snapshot(db, foreign), foreign.snapshot);
      },
    );

    await t.test(
      "complete review, exact plan replay and apply bind revisions, hashes and immutable audits",
      async () => {
        const state = await fixture(db),
          configuration = structuredClone(state.configuration);
        configuration.input.project.name = "Reviewed name";
        const changed = configuration.input.activities.find((a) => a.id === state.first.id);
        assert.ok(changed);
        changed.durationMinutes = 960;
        const planned = await createPlan(app, state, configuration),
          plan = planned.plan;
        assert.equal(planned.status, "pending");
        assert.equal(planned.artifactsAvailable, true);
        assert.equal(planned.receipt, null);
        assert.equal(plan.baseRevision, state.snapshot.revision);
        assert.equal(plan.baseInputHashSha256, hash(state.snapshot.input));
        assert.equal(plan.desiredInputHashSha256, hash(configuration.input));
        assert.match(plan.reviewedDigest, /^[a-f0-9]{64}$/);
        assert.equal(plan.noOp, false);
        assert.ok(plan.changes.length >= 2);
        assert.ok(Date.parse(plan.expiresAt) <= Date.now() + 15 * 60 * 1000);
        assert.ok(Date.parse(plan.expiresAt) <= state.session.principal.expiresAt.getTime());
        const repeated = await createPlan(app, state, configuration, plan.planId);
        assert.deepEqual(repeated, planned);
        const pendingReceipt = await app.inject({
          method: "GET",
          url: `${state.url}/plans/${plan.planId}/receipt`,
          headers: state.headers,
        });
        assert.equal(pendingReceipt.statusCode, 409, pendingReceipt.body);
        assert.equal(pendingReceipt.json().error, "configuration_not_terminal");
        const altered = structuredClone(configuration);
        altered.input.project.name = "Unreviewed";
        const conflict = await app.inject({
          method: "POST",
          url: `${state.url}/plans`,
          headers: state.headers,
          payload: {
            planId: plan.planId,
            expectedRevision: plan.baseRevision,
            configuration: altered,
          },
        });
        assert.equal(conflict.statusCode, 409, conflict.body);
        assert.equal(conflict.json().error, "configuration_idempotency_conflict");
        for (const payload of [
          { expectedRevision: plan.baseRevision, reviewedDigest: "0".repeat(64) },
          { expectedRevision: plan.baseRevision + 1, reviewedDigest: plan.reviewedDigest },
        ]) {
          const denied = await app.inject({
            method: "POST",
            url: `${state.url}/plans/${plan.planId}/apply`,
            headers: state.headers,
            payload,
          });
          assert.equal(denied.statusCode, 409, denied.body);
        }
        assert.deepEqual(await snapshot(db, state), state.snapshot);
        const applied = await apply(app, state, plan);
        assert.equal(applied.statusCode, 200, applied.body);
        const receipt = applied.json<Receipt>();
        assert.equal(receipt.planId, plan.planId);
        assert.equal(receipt.organizationId, state.organizationId);
        assert.equal(receipt.projectId, state.project.projectId);
        assert.equal(receipt.outcome, "applied");
        assert.equal(receipt.previousRevision, plan.baseRevision);
        assert.equal(receipt.committedRevision, plan.baseRevision + 1);
        assert.equal(receipt.baseInputHashSha256, plan.baseInputHashSha256);
        assert.equal(receipt.committedInputHashSha256, plan.desiredInputHashSha256);
        assert.equal(receipt.reviewedDigest, plan.reviewedDigest);
        const persisted = await snapshot(db, state);
        assert.equal(persisted.revision, plan.baseRevision + 1);
        assert.equal(hash(persisted.input), plan.desiredInputHashSha256);
        const metadata =
          await db`SELECT code,description FROM projects WHERE id=${state.project.projectId}`;
        assert.equal(metadata[0]?.code, "KEEP-CODE");
        assert.equal(metadata[0]?.description, "Keep project description");
        const audits =
          await db`SELECT id,action,actor_id,source,payload FROM audit_events WHERE id IN (${receipt.provenanceAuditId},${receipt.scheduleEditAuditId})`;
        assert.equal(audits.length, 2);
        assert.ok(audits.some((a) => a.action === "project.schedule.edit"));
        assert.ok(audits.every((a) => a.actor_id === state.userId && a.source === "api"));
        const edit = audits.find((row) => row.id === receipt.scheduleEditAuditId);
        assert.ok(edit);
        assert.equal(edit.action, "project.schedule.edit");
        assert.deepEqual(edit.payload, {
          schemaVersion: 1,
          kind: "engineo-configuration-schedule-edit",
          operation: "configuration.apply",
          inputHashSerialization: "engineo-schedule-input-v1-canonical",
          planId: plan.planId,
          revision: receipt.committedRevision,
          previousRevision: plan.baseRevision,
          baseInputHashSha256: plan.baseInputHashSha256,
          committedInputHashSha256: plan.desiredInputHashSha256,
          reviewedDigest: plan.reviewedDigest,
          sessionId: state.session.principal.sessionId,
        });
        assert.ok(Buffer.byteLength(JSON.stringify(edit.payload)) < 2048);
        for (const key of ["before", "after", "input", "configuration", "snapshot"])
          assert.equal(key in edit.payload, false);
        const replay = await apply(app, state, plan);
        assert.equal(replay.statusCode, 200, replay.body);
        assert.deepEqual(replay.json(), receipt);
        const readReceipt = await app.inject({
          method: "GET",
          url: `${state.url}/plans/${plan.planId}/receipt`,
          headers: state.headers,
        });
        assert.equal(readReceipt.statusCode, 200, readReceipt.body);
        assert.deepEqual(readReceipt.json(), receipt);
        const after = await app.inject({
          method: "GET",
          url: `${state.url}/plans/${plan.planId}`,
          headers: state.headers,
        });
        assert.equal(after.statusCode, 200, after.body);
        assert.equal(after.json<PlanResponse>().status, "applied");
        assert.deepEqual(after.json<PlanResponse>().receipt, receipt);
        const rows =
          await db`SELECT count(*)::int AS count FROM project_configuration_outcomes WHERE project_id=${state.project.projectId} AND plan_id=${plan.planId}`;
        assert.equal(Number(rows[0]?.count), 1);
      },
    );

    await t.test(
      "array permutations produce no-op receipts without changing revision, IDs, order or timestamps",
      async () => {
        const state = await fixture(db),
          configuration = structuredClone(state.configuration);
        for (const array of [
          configuration.input.activities,
          configuration.input.calendars,
          configuration.input.wbs,
          configuration.input.relationships,
        ])
          array.reverse();
        const before =
          await db`SELECT id,sort_order,created_at,updated_at FROM activities WHERE project_id=${state.project.projectId} ORDER BY sort_order,id`;
        const edges =
          await db`SELECT id,created_at FROM relationships WHERE project_id=${state.project.projectId} ORDER BY id`;
        const auditBefore =
          await db`SELECT count(*)::int AS count FROM audit_events WHERE resource_id=${state.project.projectId} AND action IN ('project.schedule.edit','schedule.edit')`;
        const { plan } = await createPlan(app, state, configuration);
        assert.equal(plan.noOp, true);
        assert.deepEqual(plan.changes, []);
        const result = await apply(app, state, plan);
        assert.equal(result.statusCode, 200, result.body);
        const receipt = result.json<Receipt>();
        assert.equal(receipt.outcome, "no_op");
        assert.equal(receipt.previousRevision, state.snapshot.revision);
        assert.equal(receipt.committedRevision, state.snapshot.revision);
        assert.equal(receipt.scheduleEditAuditId, null);
        assert.deepEqual(await snapshot(db, state), state.snapshot);
        assert.deepEqual(
          await db`SELECT id,sort_order,created_at,updated_at FROM activities WHERE project_id=${state.project.projectId} ORDER BY sort_order,id`,
          before,
        );
        assert.deepEqual(
          await db`SELECT id,created_at FROM relationships WHERE project_id=${state.project.projectId} ORDER BY id`,
          edges,
        );
        assert.deepEqual(
          await db`SELECT count(*)::int AS count FROM audit_events WHERE resource_id=${state.project.projectId} AND action IN ('project.schedule.edit','schedule.edit')`,
          auditBefore,
        );
        const provenance =
          await db`SELECT id FROM audit_events WHERE id=${receipt.provenanceAuditId}`;
        assert.equal(provenance.length, 1);
      },
    );

    await t.test(
      "material reconcile keeps surviving GUI order, creation times and relationship tuple IDs",
      async () => {
        const state = await fixture(db),
          configuration = structuredClone(state.configuration);
        const before =
          await db`SELECT id,sort_order,created_at FROM activities WHERE project_id=${state.project.projectId} ORDER BY sort_order,id`;
        const edges =
          await db`SELECT id,predecessor_id,successor_id,relationship_type,lag_minutes,created_at FROM relationships WHERE project_id=${state.project.projectId} ORDER BY id`;
        configuration.input.activities.reverse();
        const template = configuration.input.activities[0];
        assert.ok(template);
        template.name = "A surviving renamed row";
        const newIds: string[] = [randomUUID(), randomUUID()].sort((a, b) =>
          a.localeCompare(b, "en"),
        );
        for (const id of [...newIds].reverse())
          configuration.input.activities.unshift({
            ...structuredClone(template),
            id,
            name: `New ${id}`,
          });
        const { plan } = await createPlan(app, state, configuration);
        const result = await apply(app, state, plan);
        assert.equal(result.statusCode, 200, result.body);
        const after =
          await db`SELECT id,sort_order,created_at FROM activities WHERE project_id=${state.project.projectId} ORDER BY sort_order,id`;
        assert.deepEqual(
          after.filter((a) => !newIds.includes(String(a.id))),
          [...before],
        );
        assert.deepEqual(
          after.filter((a) => newIds.includes(String(a.id))).map((a) => String(a.id)),
          newIds,
        );
        assert.ok(
          after
            .filter((a) => newIds.includes(String(a.id)))
            .every((a) => Number(a.sort_order) > 20),
        );
        assert.deepEqual(
          await db`SELECT id,predecessor_id,successor_id,relationship_type,lag_minutes,created_at FROM relationships WHERE project_id=${state.project.projectId} ORDER BY id`,
          edges,
        );
        assert.equal(hash((await snapshot(db, state)).input), plan.desiredInputHashSha256);
      },
    );

    await t.test(
      "WBS code swaps and reparenting allow dependent removals in one native transaction",
      async () => {
        const state = await fixture(db),
          configuration = structuredClone(state.configuration);
        const a = randomUUID(),
          b = randomUUID(),
          c = randomUUID(),
          newCalendar = randomUUID();
        const originalCalendar = configuration.input.calendars[0];
        assert.ok(originalCalendar);
        configuration.input.calendars.push({
          ...structuredClone(originalCalendar),
          id: newCalendar,
          name: "Replacement default",
        });
        configuration.input.wbs.push(
          { id: a, parentId: state.project.rootWbsId, code: "2", name: "A", sortOrder: 1 },
          { id: b, parentId: a, code: "3", name: "B", sortOrder: 2 },
          {
            id: c,
            parentId: state.project.rootWbsId,
            code: "4",
            name: "Remove branch",
            sortOrder: 3,
          },
        );
        const movedActivity = configuration.input.activities[0];
        assert.ok(movedActivity);
        movedActivity.wbsId = c;
        const initial = await createPlan(app, state, configuration);
        const first = await apply(app, state, initial.plan);
        assert.equal(first.statusCode, 200, first.body);
        const next = structuredClone(configuration);
        const nodeA = next.input.wbs.find((w) => w.id === a),
          nodeB = next.input.wbs.find((w) => w.id === b);
        assert.ok(nodeA && nodeB);
        nodeA.code = "3";
        nodeB.code = "2";
        nodeA.parentId = b;
        nodeB.parentId = state.project.rootWbsId;
        next.input.wbs = next.input.wbs.filter((w) => w.id !== c);
        next.input.activities = next.input.activities.filter((activity) => activity.wbsId !== c);
        next.input.relationships = [];
        next.input.calendars = next.input.calendars.filter(
          (calendar) => calendar.id === newCalendar,
        );
        next.input.project.defaultCalendarId = newCalendar;
        for (const activity of next.input.activities) activity.calendarId = newCalendar;
        const second = await createPlan(
          app,
          state,
          next,
          randomUUID(),
          first.json<Receipt>().committedRevision,
        );
        const result = await apply(app, state, second.plan);
        assert.equal(result.statusCode, 200, result.body);
        const stored = await snapshot(db, state);
        assert.equal(hash(stored.input), second.plan.desiredInputHashSha256);
        assert.equal(stored.input.wbs.find((w) => w.id === a)?.parentId, b);
        assert.equal(stored.input.wbs.find((w) => w.id === a)?.code, "3");
        assert.equal(stored.input.wbs.find((w) => w.id === b)?.code, "2");
        assert.equal(
          stored.input.wbs.some((w) => w.id === c),
          false,
        );
        assert.equal(
          stored.input.calendars.some((c) => c.id === state.project.calendarId),
          false,
        );
      },
    );

    await t.test(
      "stale revisions and changed canonical bases cannot be rebased or silently replanned",
      async () => {
        for (const bypassRevision of [false, true]) {
          const state = await fixture(db),
            configuration = structuredClone(state.configuration);
          configuration.input.project.name = "Reviewed change";
          const { plan } = await createPlan(app, state, configuration);
          if (bypassRevision)
            await db`UPDATE activities SET duration_minutes=960 WHERE id=${state.first.id}`;
          else
            await new PlannerRepository(db).createActivity(
              state.context,
              state.project.projectId,
              state.snapshot.revision,
              {
                name: "Concurrent edit",
                wbsId: state.project.rootWbsId,
                calendarId: state.project.calendarId,
                kind: "TASK",
                durationMinutes: 60,
                constraints: [],
                sortOrder: 21,
              },
            );
          const before = await snapshot(db, state);
          const result = await apply(app, state, plan);
          assert.equal(result.statusCode, 409, result.body);
          assert.equal(
            result.json().error,
            bypassRevision ? "configuration_base_changed" : "revision_conflict",
          );
          assert.deepEqual(await snapshot(db, state), before);
          const outcomes =
            await db`SELECT count(*)::int AS count FROM project_configuration_outcomes WHERE plan_id=${plan.planId}`;
          assert.equal(Number(outcomes[0]?.count), 0);
        }
      },
    );

    await t.test(
      "matching historical replay survives later edits and same-actor receipt reauthentication",
      async () => {
        const state = await fixture(db),
          configuration = structuredClone(state.configuration);
        configuration.input.project.name = "Applied historical change";
        const { plan } = await createPlan(app, state, configuration);
        const applied = await apply(app, state, plan);
        assert.equal(applied.statusCode, 200, applied.body);
        const receipt = applied.json<Receipt>();
        await new PlannerRepository(db).createActivity(
          state.context,
          state.project.projectId,
          receipt.committedRevision,
          {
            name: "Later edit",
            wbsId: state.project.rootWbsId,
            calendarId: state.project.calendarId,
            kind: "TASK",
            durationMinutes: 60,
            constraints: [],
            sortOrder: 22,
          },
        );
        const before = await snapshot(db, state),
          auditBefore = await configurationAudits(db, state);
        const replay = await apply(app, state, plan);
        assert.equal(replay.statusCode, 200, replay.body);
        assert.deepEqual(replay.json(), receipt);
        const renewed = await issueSession(
          db,
          state.userId,
          `${state.userId}@example.test`,
          null,
          undefined,
        );
        const history = await app.inject({
          method: "GET",
          url: `${state.url}/plans/${plan.planId}/receipt`,
          headers: headersFor(renewed),
        });
        assert.equal(history.statusCode, 200, history.body);
        assert.deepEqual(history.json(), receipt);
        assert.deepEqual(await snapshot(db, state), before);
        assert.deepEqual(await configurationAudits(db, state), auditBefore);
        const other = await member(db, state, "owner", null);
        const denied = await app.inject({
          method: "GET",
          url: `${state.url}/plans/${plan.planId}/receipt`,
          headers: other.headers,
        });
        assert.equal(denied.statusCode, 404, denied.body);
      },
    );

    await t.test(
      "exact pending plans and terminal receipts restore across app and database restart",
      async () => {
        const state = await fixture(db),
          configuration = structuredClone(state.configuration);
        configuration.input.project.name = "Restart-safe";
        const original = await createPlan(app, state, configuration);
        const replicaDb = createDatabase();
        const replica = buildApp({ database: replicaDb, scheduleRunner: inertRunner });
        let receipt: Receipt;
        try {
          const restored = await replica.inject({
            method: "GET",
            url: `${state.url}/plans/${original.planId}`,
            headers: state.headers,
          });
          assert.equal(restored.statusCode, 200, restored.body);
          assert.deepEqual(restored.json(), original);
          const committed = await apply(replica, state, original.plan);
          assert.equal(committed.statusCode, 200, committed.body);
          receipt = committed.json<Receipt>();
        } finally {
          await replica.close();
          await replicaDb.end({ timeout: 5 });
        }
        const restartedDb = createDatabase(),
          restarted = buildApp({ database: restartedDb, scheduleRunner: inertRunner });
        try {
          const restored = await restarted.inject({
            method: "GET",
            url: `${state.url}/plans/${original.planId}/receipt`,
            headers: state.headers,
          });
          assert.equal(restored.statusCode, 200, restored.body);
          assert.deepEqual(restored.json(), receipt);
          const replay = await apply(restarted, state, original.plan);
          assert.equal(replay.statusCode, 200, replay.body);
          assert.deepEqual(replay.json(), receipt);
        } finally {
          await restarted.close();
          await restartedDb.end({ timeout: 5 });
        }
      },
    );

    await t.test(
      "same-plan concurrent apply across API replicas commits one receipt and edit",
      async () => {
        const state = await fixture(db),
          configuration = structuredClone(state.configuration);
        configuration.input.project.name = "One commit";
        const { plan } = await createPlan(app, state, configuration);
        const replicaDb = createDatabase(),
          replica = buildApp({ database: replicaDb, scheduleRunner: inertRunner });
        const before =
          await db`SELECT count(*)::int AS count FROM audit_events WHERE resource_id=${state.project.projectId} AND action IN ('project.schedule.edit','schedule.edit')`;
        try {
          const [first, second] = await Promise.all([
            apply(app, state, plan),
            apply(replica, state, plan),
          ]);
          assert.equal(first.statusCode, 200, first.body);
          assert.equal(second.statusCode, 200, second.body);
          assert.deepEqual(first.json(), second.json());
        } finally {
          await replica.close();
          await replicaDb.end({ timeout: 5 });
        }
        const after =
          await db`SELECT count(*)::int AS count FROM audit_events WHERE resource_id=${state.project.projectId} AND action IN ('project.schedule.edit','schedule.edit')`;
        assert.equal(Number(after[0]?.count), Number(before[0]?.count) + 1);
        assert.equal((await snapshot(db, state)).revision, state.snapshot.revision + 1);
      },
    );

    await t.test("different material plans on one revision cannot both apply", async () => {
      const state = await fixture(db),
        a = structuredClone(state.configuration),
        b = structuredClone(state.configuration);
      a.input.project.name = "Candidate A";
      b.input.project.name = "Candidate B";
      const first = await createPlan(app, state, a),
        second = await createPlan(app, state, b);
      const results = await Promise.all([
        apply(app, state, first.plan),
        apply(app, state, second.plan),
      ]);
      assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
      const rejected = results.find((r) => r.statusCode === 409);
      assert.ok(rejected);
      assert.equal(rejected.json().error, "revision_conflict");
      const persisted = await snapshot(db, state);
      assert.equal(persisted.revision, state.snapshot.revision + 1);
      assert.ok(
        [first.plan.desiredInputHashSha256, second.plan.desiredInputHashSha256].includes(
          hash(persisted.input),
        ),
      );
    });

    await t.test(
      "durable cancel wins against later apply and cannot reuse its plan identity",
      async () => {
        const state = await fixture(db),
          configuration = structuredClone(state.configuration);
        configuration.input.project.name = "Never apply";
        const { plan } = await createPlan(app, state, configuration);
        const cancel = () =>
          app.inject({
            method: "POST",
            url: `${state.url}/plans/${plan.planId}/cancel`,
            headers: state.headers,
            payload: { reviewedDigest: plan.reviewedDigest },
          });
        const cancelled = await cancel();
        assert.equal(cancelled.statusCode, 200, cancelled.body);
        assert.equal(cancelled.json<Receipt>().outcome, "cancelled");
        assert.equal(cancelled.json<Receipt>().committedRevision, null);
        assert.equal(cancelled.json<Receipt>().committedInputHashSha256, null);
        assert.equal(cancelled.json<Receipt>().scheduleEditAuditId, null);
        const replay = await cancel();
        assert.equal(replay.statusCode, 200, replay.body);
        assert.deepEqual(replay.json(), cancelled.json());
        const rejected = await apply(app, state, plan);
        assert.equal(rejected.statusCode, 409, rejected.body);
        assert.equal(rejected.json().error, "configuration_cancelled");
        const reviewed = await app.inject({
          method: "GET",
          url: `${state.url}/plans/${plan.planId}`,
          headers: state.headers,
        });
        assert.equal(reviewed.json<PlanResponse>().status, "cancelled");
        const reused = await createPlan(app, state, configuration, plan.planId);
        assert.equal(reused.status, "cancelled");
        assert.deepEqual(await snapshot(db, state), state.snapshot);
      },
    );

    await t.test(
      "apply-winning cancellation returns committed evidence and never undoes project data",
      async () => {
        const state = await fixture(db),
          configuration = structuredClone(state.configuration);
        configuration.input.project.name = "Application wins";
        const { plan } = await createPlan(app, state, configuration),
          applied = await apply(app, state, plan);
        assert.equal(applied.statusCode, 200, applied.body);
        const cancelled = await app.inject({
          method: "POST",
          url: `${state.url}/plans/${plan.planId}/cancel`,
          headers: state.headers,
          payload: { reviewedDigest: plan.reviewedDigest },
        });
        assert.equal(cancelled.statusCode, 200, cancelled.body);
        assert.deepEqual(cancelled.json(), applied.json());
        assert.equal(hash((await snapshot(db, state)).input), plan.desiredInputHashSha256);
      },
    );
  } finally {
    await app.close();
    await db.end({ timeout: 5 });
  }
});
