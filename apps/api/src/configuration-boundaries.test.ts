import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import test from "node:test";
import {
  type ProjectConfigurationPlanV1,
  type ProjectConfigurationV1,
  serializeScheduleInputV1,
} from "@engineo/contracts";
import { buildApp } from "./app.js";
import { createDatabase, type Database, type DatabaseExecutor } from "./db/client.js";
import { databaseConfigFromEnv } from "./db/config.js";
import { migrateDatabase } from "./db/migrate.js";
import { tenantContext } from "./db/tenant-context.js";
import {
  CONFIGURATION_MAINTENANCE_BATCH,
  ConfigurationError,
  ConfigurationRepository,
} from "./repositories/configuration-repository.js";
import { PlannerRepository } from "./repositories/planner-repository.js";
import { ProcessScheduleRunner } from "./scheduler/runner.js";
import { ProjectRepository } from "./repositories/project-repository.js";
import { issueSession } from "./security/session.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const instant = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: PromiseLike<T>, message: string, timeoutMs = 6_000): Promise<T> {
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
  await db`INSERT INTO organizations(id,slug,name) VALUES(${organizationId},${organizationId},'Configuration boundary')`;
  await db`INSERT INTO users(id,email) VALUES(${ownerId},${`${ownerId}@example.test`}),(${userId},${`${userId}@example.test`})`;
  await db`INSERT INTO organization_memberships(organization_id,user_id,role)
    VALUES(${organizationId},${ownerId},'owner'),(${organizationId},${userId},'planner')`;
  const ownerContext = tenantContext(organizationId, ownerId, randomUUID());
  const context = tenantContext(organizationId, userId, randomUUID());
  const planner = new PlannerRepository(db);
  const project = await planner.createProject(ownerContext, {
    name: "Boundary project",
    code: null,
    description: null,
    plannedStart: "2026-10-05T08:00:00Z",
    timeZone: "UTC",
  });
  const activity = await planner.createActivity(ownerContext, project.projectId, 1, {
    name: "Boundary activity",
    wbsId: project.rootWbsId,
    calendarId: project.calendarId,
    kind: "TASK",
    durationMinutes: 480,
    constraints: [],
    sortOrder: 0,
  });
  await db`INSERT INTO project_memberships(organization_id,project_id,user_id,role)
    VALUES(${organizationId},${project.projectId},${userId},'planner')`;
  const session = await issueSession(db, userId, `${userId}@example.test`, null, undefined);
  const snapshot = await new ProjectRepository(db).plannerSnapshot(context, project.projectId);
  assert.ok(snapshot);
  const configuration: ProjectConfigurationV1 = {
    schemaVersion: 1,
    kind: "engineo-project-configuration",
    scope: "schedule",
    input: structuredClone(snapshot.input),
  };
  const headers = {
    cookie: `engineo_session=${session.token}; engineo_csrf=${session.csrfToken}`,
    "x-csrf-token": session.csrfToken,
    "x-engineo-session": session.principal.sessionId,
  };
  const initialScheduleAuditIds = (
    await db`SELECT id FROM audit_events WHERE organization_id=${organizationId} AND resource_id=${project.projectId} AND action IN ('project.schedule.edit','schedule.edit') ORDER BY id`
  ).map((row) => String(row.id));
  return {
    initialScheduleAuditIds,
    organizationId,
    ownerId,
    userId,
    context,
    ownerContext,
    project,
    activity,
    session,
    snapshot,
    configuration,
    headers,
    url: `/organizations/${organizationId}/projects/${project.projectId}/configuration`,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function createPlan(
  db: Database,
  state: Fixture,
  noOp = false,
): Promise<ProjectConfigurationPlanV1> {
  const configuration = structuredClone(state.configuration);
  if (!noOp) {
    const activity = configuration.input.activities[0];
    assert.ok(activity);
    activity.durationMinutes = 960;
  }
  const response = await new ConfigurationRepository(db).plan(
    state.context,
    state.project.projectId,
    state.session.principal,
    { planId: randomUUID(), expectedRevision: state.snapshot.revision, configuration },
  );
  assert.ok(response.plan);
  return response.plan;
}
function apply(
  repository: ConfigurationRepository,
  state: Fixture,
  plan: ProjectConfigurationPlanV1,
  signal?: AbortSignal,
) {
  return repository.apply(
    state.context,
    state.project.projectId,
    state.session.principal,
    plan.planId,
    { expectedRevision: plan.baseRevision, reviewedDigest: plan.reviewedDigest },
    signal,
  );
}
async function assertRolledBack(db: Database, state: Fixture, planId?: string) {
  const snapshot = await new ProjectRepository(db).plannerSnapshot(
    state.context,
    state.project.projectId,
  );
  assert.deepEqual(
    snapshot,
    state.snapshot,
    "Rejected configuration must preserve the complete original schedule",
  );
  const audits =
    await db`SELECT id,action FROM audit_events WHERE organization_id=${state.organizationId} AND resource_id=${state.project.projectId}
    AND action IN ('configuration.apply','configuration.cancel','project.schedule.edit','schedule.edit') ORDER BY id`;
  assert.deepEqual(
    audits.map((row) => String(row.id)),
    state.initialScheduleAuditIds,
    "Rejected configuration must preserve original edit audits and retain no terminal/new edit audits",
  );
  const outcomes =
    await db`SELECT plan_id FROM project_configuration_outcomes WHERE project_id=${state.project.projectId}`;
  assert.equal(outcomes.length, 0, "Rejected configuration must not retain a terminal receipt");
  if (planId) {
    const plans =
      await db`SELECT id FROM project_configuration_plans WHERE project_id=${state.project.projectId} AND id=${planId}`;
    assert.equal(plans.length, 1);
  }
}
async function awaitBlocked(db: Database, waiterPid: number, blockerPid: number) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const rows =
      await db`SELECT ${blockerPid}::int = ANY(pg_blocking_pids(${waiterPid}::int)) AS blocked`;
    if (rows[0]?.blocked === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Repository must reach the independent PostgreSQL lock");
}
async function withRepositoryLock(
  _db: Database,
  acquire: (sql: DatabaseExecutor) => Promise<void>,
  action: (
    repository: ConfigurationRepository,
    waiterPid: number,
    blockerPid: number,
    release: () => void,
  ) => Promise<void>,
) {
  const config = { ...databaseConfigFromEnv(), maxConnections: 1 };
  const lockDb = createDatabase(config),
    workerDb = createDatabase(config);
  const locked = deferred(),
    release = deferred();
  let blockerPid = 0,
    transaction: Promise<unknown> | undefined;
  try {
    const pid = Number((await workerDb`SELECT pg_backend_pid() AS pid`)[0]?.pid);
    assert.ok(pid > 0);
    transaction = lockDb.begin(async (sql) => {
      blockerPid = Number((await sql`SELECT pg_backend_pid() AS pid`)[0]?.pid);
      await acquire(sql);
      locked.resolve();
      await release.promise;
    });
    await bounded(
      Promise.race([locked.promise, transaction]),
      "Lock holder must acquire its real database lock",
    );
    await action(new ConfigurationRepository(workerDb), pid, blockerPid, release.resolve);
  } finally {
    release.resolve();
    try {
      if (transaction) await transaction;
    } finally {
      await Promise.all([lockDb.end({ timeout: 5 }), workerDb.end({ timeout: 5 })]);
    }
  }
}
async function trigger(
  db: Database,
  state: Fixture,
  table:
    | "audit_events"
    | "project_configuration_outcomes"
    | "project_configuration_plans"
    | "project_configuration_artifacts"
    | "activities",
  body: string,
  action?: string,
  event: "INSERT" | "DELETE" | "UPDATE" = "INSERT",
  timing: "BEFORE" | "AFTER" = "BEFORE",
) {
  const name = `configuration_test_${randomUUID().replaceAll("-", "")}`;
  const record = event === "DELETE" ? "OLD" : "NEW";
  const condition =
    table === "audit_events"
      ? `${record}.resource_id='${state.project.projectId}'::uuid${action ? ` AND ${record}.action='${action}'` : ""}`
      : `${record}.project_id='${state.project.projectId}'::uuid`;
  await db.unsafe(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN ${record}; END; $$`,
  );
  try {
    await db.unsafe(
      `CREATE TRIGGER ${name} ${timing} ${event} ON ${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION ${name}()`,
    );
  } catch (error) {
    await db.unsafe(`DROP FUNCTION ${name}()`);
    throw error;
  }
  return async () => {
    await db.unsafe(`DROP TRIGGER ${name} ON ${table}`);
    await db.unsafe(`DROP FUNCTION ${name}()`);
  };
}
function isError(code: string, statusCode?: number) {
  return (error: unknown) =>
    error instanceof ConfigurationError &&
    error.code === code &&
    (statusCode === undefined || error.statusCode === statusCode);
}

// A disposable privileged fixture may deliberately simulate damaged storage.
// Restore the production immutability trigger before exercising the application.
async function alterStored(
  db: Database,
  table:
    | "project_configuration_artifacts"
    | "project_configuration_plans"
    | "project_configuration_outcomes",
  action: (sql: DatabaseExecutor) => Promise<void>,
) {
  const name =
    table === "project_configuration_artifacts"
      ? "configuration_artifacts_no_update"
      : table === "project_configuration_plans"
        ? "configuration_plans_no_mutation"
        : "configuration_outcomes_no_mutation";
  await db.begin(async (sql) => {
    await sql.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${name}`);
    await action(sql);
    if (table === "project_configuration_artifacts") {
      // Corrupt bytes deliberately, but keep allocation accounting coherent so
      // the fixture does not poison unrelated admissions after this test.
      await sql.unsafe(
        "ALTER TABLE project_configuration_storage_budget DISABLE TRIGGER configuration_global_counter_managed",
      );
      await sql.unsafe(
        "ALTER TABLE project_configuration_project_storage DISABLE TRIGGER configuration_project_counter_managed",
      );
      await sql`UPDATE project_configuration_storage_budget SET used_bytes=s.bytes,artifact_count=s.count,
        state_hash_sha256=engineo_configuration_counter_hash('global',s.bytes,s.count)
        FROM (SELECT COALESCE(sum(byte_count),0)::bigint AS bytes,count(*)::bigint AS count FROM project_configuration_artifacts) s WHERE singleton`;
      await sql`UPDATE project_configuration_project_storage p SET used_bytes=s.bytes,artifact_count=s.count,
        state_hash_sha256=engineo_configuration_counter_hash(p.organization_id::text||'/'||p.project_id::text,s.bytes,s.count)
        FROM (SELECT p2.organization_id,p2.project_id,COALESCE(sum(a.byte_count),0)::bigint AS bytes,count(a.plan_id)::bigint AS count
          FROM project_configuration_project_storage p2 LEFT JOIN project_configuration_artifacts a ON a.organization_id=p2.organization_id AND a.project_id=p2.project_id GROUP BY p2.organization_id,p2.project_id) s
        WHERE p.organization_id=s.organization_id AND p.project_id=s.project_id`;
      await sql.unsafe(
        "ALTER TABLE project_configuration_project_storage ENABLE TRIGGER configuration_project_counter_managed",
      );
      await sql.unsafe(
        "ALTER TABLE project_configuration_storage_budget ENABLE TRIGGER configuration_global_counter_managed",
      );
    }
    await sql.unsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${name}`);
  });
}
async function shortenPlanExpiry(
  db: Database,
  plan: ProjectConfigurationPlanV1,
  seconds = 2,
): Promise<ProjectConfigurationPlanV1> {
  const time =
    await db`SELECT date_trunc('milliseconds',clock_timestamp())+${seconds}::int*interval '1 second' AS expires_at`;
  const expiresAt = instant(time[0]?.expires_at);
  const { reviewedDigest: _old, ...review } = plan;
  const updated = { ...review, expiresAt };
  const reviewJson = JSON.stringify(updated),
    reviewedDigest = hash(reviewJson);
  await db.begin(async (sql) => {
    await sql.unsafe(
      "ALTER TABLE project_configuration_plans DISABLE TRIGGER configuration_plans_no_mutation",
    );
    await sql.unsafe(
      "ALTER TABLE project_configuration_artifacts DISABLE TRIGGER configuration_artifacts_no_update",
    );
    await sql`UPDATE project_configuration_plans SET expires_at=${expiresAt},reviewed_digest=${reviewedDigest}
      WHERE organization_id=${plan.organizationId} AND project_id=${plan.projectId} AND id=${plan.planId}`;
    await sql`UPDATE project_configuration_artifacts SET review_json=${reviewJson}
      WHERE organization_id=${plan.organizationId} AND project_id=${plan.projectId} AND plan_id=${plan.planId}`;
    await sql.unsafe(
      "ALTER TABLE project_configuration_artifacts ENABLE TRIGGER configuration_artifacts_no_update",
    );
    await sql.unsafe(
      "ALTER TABLE project_configuration_plans ENABLE TRIGGER configuration_plans_no_mutation",
    );
  });
  return { ...updated, reviewedDigest };
}
async function expireArtifacts(db: Database, planIds: string[]): Promise<void> {
  // Advance the persisted retention fixture, never the application's clock.
  // Terminal evidence/digests stay unchanged; the heavy review will be collected.
  await db.begin(async (sql) => {
    await sql.unsafe(
      "ALTER TABLE project_configuration_plans DISABLE TRIGGER configuration_plans_no_mutation",
    );
    await sql.unsafe(
      "ALTER TABLE project_configuration_artifacts DISABLE TRIGGER configuration_artifacts_no_update",
    );
    await sql`UPDATE project_configuration_plans SET created_at=created_at-interval '26 hours',
      expires_at=expires_at-interval '26 hours',artifacts_keep_until=artifacts_keep_until-interval '26 hours'
      WHERE id IN ${sql(planIds)}`;
    await sql`UPDATE project_configuration_artifacts SET keep_until=keep_until-interval '26 hours'
      WHERE plan_id IN ${sql(planIds)}`;
    await sql.unsafe(
      "ALTER TABLE project_configuration_artifacts ENABLE TRIGGER configuration_artifacts_no_update",
    );
    await sql.unsafe(
      "ALTER TABLE project_configuration_plans ENABLE TRIGGER configuration_plans_no_mutation",
    );
  });
}

async function insertMaximumStorageFixture(
  sql: DatabaseExecutor,
  state: Fixture,
  totalBytes = 33554432,
): Promise<string> {
  // Exercise SQL product limits using real retained text, rather than counterfeit
  // counters. Padding stays valid JSON and is included in every stored SHA-256.
  // This admission fixture is not claimed to be an application-normalized review.
  const planId = randomUUID(),
    auditId = randomUUID(),
    canonical = serializeScheduleInputV1(state.configuration.input);
  const review = JSON.stringify({
    schemaVersion: 1,
    planId,
    organizationId: state.organizationId,
    projectId: state.project.projectId,
  });
  const canonicalBytes = Buffer.byteLength(canonical),
    reviewMinimum = Buffer.byteLength(review);
  assert.ok(totalBytes >= 2 * canonicalBytes + 2 + reviewMinimum && totalBytes <= 33554432);
  const pairBytes = Math.min(4194304, Math.floor((totalBytes - 2 - reviewMinimum) / 2));
  const diffBytes = Math.min(8388608, totalBytes - 2 * pairBytes - reviewMinimum);
  const reviewBytes = totalBytes - 2 * pairBytes - diffBytes;
  assert.ok(
    pairBytes >= canonicalBytes &&
      diffBytes >= 2 &&
      reviewBytes >= reviewMinimum &&
      reviewBytes <= 16777216,
  );
  const row = (
    await sql`SELECT
    encode(sha256(convert_to(${canonical}||repeat(' ',${pairBytes}-octet_length(${canonical})), 'UTF8')),'hex') AS input_hash,
    encode(sha256(convert_to(${review}||repeat(' ',${reviewBytes}-octet_length(${review})), 'UTF8')),'hex') AS review_hash,
    date_trunc('milliseconds',clock_timestamp()) AS created_at`
  )[0];
  assert.ok(row);
  const createdAt = instant(row.created_at);
  const payload = JSON.stringify({
    planId,
    sessionId: state.session.principal.sessionId,
    reviewedDigest: String(row.review_hash),
    revision: state.snapshot.revision,
    baseInputHash: String(row.input_hash),
    desiredInputHash: String(row.input_hash),
    noOp: true,
  });
  await sql`INSERT INTO audit_events(id,organization_id,actor_type,actor_id,action,resource_type,resource_id,source,payload)
    VALUES(${auditId},${state.organizationId},'user',${state.userId},'configuration.plan','project',${state.project.projectId},'api',${payload}::text::jsonb)`;
  await sql`INSERT INTO project_configuration_plans(organization_id,project_id,id,actor_id,session_id,
    protocol_version,configuration_version,normalization_version,base_revision,base_input_hash_sha256,desired_input_hash_sha256,
    request_hash_sha256,reviewed_digest,no_op,created_at,expires_at,artifacts_keep_until,plan_audit_id)
    VALUES(${state.organizationId},${state.project.projectId},${planId},${state.userId},${state.session.principal.sessionId},1,1,1,
      ${state.snapshot.revision},${String(row.input_hash)},${String(row.input_hash)},${"0".repeat(64)},${String(row.review_hash)},true,
      ${createdAt},${createdAt}::timestamptz+interval '15 minutes',${createdAt}::timestamptz+interval '24 hours',${auditId})`;
  await sql`INSERT INTO project_configuration_artifacts(organization_id,project_id,plan_id,base_canonical,candidate_canonical,diff_json,review_json,keep_until)
    VALUES(${state.organizationId},${state.project.projectId},${planId},
      ${canonical}||repeat(' ',${pairBytes}-octet_length(${canonical})),
      ${canonical}||repeat(' ',${pairBytes}-octet_length(${canonical})),
      '[]'||repeat(' ',${diffBytes}-2),${review}||repeat(' ',${reviewBytes}-octet_length(${review})),
      ${createdAt}::timestamptz+interval '24 hours')`;
  return planId;
}

function isSqlCounterIntegrity(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "P0003";
}
function transactionDatabase(db: Database, sql: DatabaseExecutor): Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "begin")
        return async (callback: (transaction: DatabaseExecutor) => Promise<unknown>) =>
          callback(sql);
      return Reflect.get(target, property, receiver);
    },
  });
}
function explainNodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(explainNodes);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [
      ...(typeof record["Node Type"] === "string" ? [record] : []),
      ...Object.values(record).flatMap(explainNodes),
    ];
  }
  return [];
}

async function waitExpiry(
  db: Database,
  table: "auth_sessions" | "project_configuration_plans",
  id: string,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.unsafe(
      `SELECT expires_at<=clock_timestamp() AS expired FROM ${table} WHERE id=$1`,
      [id],
    );
    if (rows[0]?.expired === true) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The real wall clock must pass persisted expiry before releasing the lock");
}

// Every gate below delays real SQL or holds a genuine independent PostgreSQL
// lock. None fabricates authentication rows, revision reads or committed data.
test("configuration transaction boundaries use genuine PostgreSQL locks and durable artifacts", {
  skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not configured",
  timeout: 360_000,
}, async (t) => {
  const db = createDatabase();
  await migrateDatabase(db);
  try {
    await t.test(
      "missing locked membership cannot be rescued by a later committed grant",
      async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state),
          ready = deferred(),
          release = deferred();
        await db`DELETE FROM project_memberships WHERE organization_id=${state.organizationId} AND project_id=${state.project.projectId} AND user_id=${state.userId}`;
        let gated = 0;
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
                      assert.equal(rows.length, 0);
                      gated++;
                      ready.resolve();
                      await release.promise;
                    }
                    return rows;
                  },
                });
                return await callback(coordinatedSql);
              });
          },
        });
        const pending = new ConfigurationRepository(coordinatedDb).getPlan(
          state.context,
          state.project.projectId,
          state.session.principal,
          plan.planId,
        );
        const rejected = assert.rejects(pending, isError("forbidden", 403));
        try {
          await bounded(
            ready.promise,
            "Read must deliver its genuinely empty locked membership SELECT",
          );
          await bounded(
            db`INSERT INTO project_memberships(organization_id,project_id,user_id,role)
          VALUES(${state.organizationId},${state.project.projectId},${state.userId},'planner')`,
            "Concurrent membership grant must commit",
          );
        } finally {
          release.resolve();
          await rejected;
        }
        assert.equal(gated, 1);
        await assertRolledBack(db, state, plan.planId);
        const fresh = await apply(new ConfigurationRepository(db), state, plan);
        assert.equal(fresh.outcome, "applied");
      },
    );

    const races: Array<{
      name: string;
      code: string;
      status: number;
      acquire: (sql: DatabaseExecutor, state: Fixture) => Promise<void>;
    }> = [
      {
        name: "session revocation committed before the locked session read",
        code: "unauthenticated",
        status: 401,
        acquire: async (sql, state) => {
          await sql`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=${state.session.principal.sessionId}`;
        },
      },
      {
        name: "session expiry committed before the locked session read",
        code: "unauthenticated",
        status: 401,
        acquire: async (sql, state) => {
          await sql`UPDATE auth_sessions SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 second' WHERE id=${state.session.principal.sessionId}`;
        },
      },
      {
        name: "organization membership deletion while authorization is blocked",
        code: "forbidden",
        status: 403,
        acquire: async (sql, state) => {
          await sql`DELETE FROM organization_memberships WHERE organization_id=${state.organizationId} AND user_id=${state.userId}`;
        },
      },
      {
        name: "organization role downgrade while authorization is blocked",
        code: "forbidden",
        status: 403,
        acquire: async (sql, state) => {
          await sql`UPDATE organization_memberships SET role='viewer' WHERE organization_id=${state.organizationId} AND user_id=${state.userId}`;
        },
      },
      {
        name: "project membership deletion while authorization is blocked",
        code: "forbidden",
        status: 403,
        acquire: async (sql, state) => {
          await sql`DELETE FROM project_memberships WHERE organization_id=${state.organizationId} AND project_id=${state.project.projectId} AND user_id=${state.userId}`;
        },
      },
      {
        name: "project role downgrade while authorization is blocked",
        code: "forbidden",
        status: 403,
        acquire: async (sql, state) => {
          await sql`UPDATE project_memberships SET role='viewer' WHERE organization_id=${state.organizationId} AND project_id=${state.project.projectId} AND user_id=${state.userId}`;
        },
      },
    ];
    for (const race of races)
      await t.test(race.name, async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state);
        await withRepositoryLock(
          db,
          (sql) => race.acquire(sql, state),
          async (repository, pid, blocker, release) => {
            const pending = apply(repository, state, plan),
              rejected = assert.rejects(pending, isError(race.code, race.status));
            try {
              await awaitBlocked(db, pid, blocker);
            } finally {
              release();
              await rejected;
            }
          },
        );
        await assertRolledBack(db, state, plan.planId);
      });

    await t.test(
      "session wall-clock expiry is rechecked after actual project-lock blocking",
      async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state);
        await db`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=${state.session.principal.sessionId}`;
        await withRepositoryLock(
          db,
          async (sql) => {
            await sql`SELECT id FROM projects WHERE id=${state.project.projectId} FOR UPDATE`;
          },
          async (repository, pid, blocker, release) => {
            const rejected = assert.rejects(
              apply(repository, state, plan),
              isError("unauthenticated", 401),
            );
            try {
              await awaitBlocked(db, pid, blocker);
              await waitExpiry(db, "auth_sessions", state.session.principal.sessionId);
            } finally {
              release();
              await rejected;
            }
          },
        );
        await assertRolledBack(db, state, plan.planId);
      },
    );

    await t.test(
      "plan wall-clock expiry is rechecked after actual project-lock blocking",
      async () => {
        const state = await fixture(db),
          plan = await shortenPlanExpiry(db, await createPlan(db, state));
        await withRepositoryLock(
          db,
          async (sql) => {
            await sql`SELECT id FROM projects WHERE id=${state.project.projectId} FOR UPDATE`;
          },
          async (repository, pid, blocker, release) => {
            const rejected = assert.rejects(
              apply(repository, state, plan),
              isError("configuration_expired", 409),
            );
            try {
              await awaitBlocked(db, pid, blocker);
              await waitExpiry(db, "project_configuration_plans", plan.planId);
            } finally {
              release();
              await rejected;
            }
          },
        );
        await assertRolledBack(db, state, plan.planId);
      },
    );

    await t.test(
      "abort while waiting on the project lock rolls back without terminal evidence",
      async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state),
          controller = new AbortController();
        await withRepositoryLock(
          db,
          async (sql) => {
            await sql`SELECT id FROM projects WHERE id=${state.project.projectId} FOR UPDATE`;
          },
          async (repository, pid, blocker, release) => {
            const rejected = assert.rejects(
              apply(repository, state, plan, controller.signal),
              isError("configuration_interrupted", 409),
            );
            try {
              await awaitBlocked(db, pid, blocker);
              controller.abort();
            } finally {
              release();
              await rejected;
            }
          },
        );
        await assertRolledBack(db, state, plan.planId);
      },
    );

    for (const boundary of [
      {
        table: "audit_events" as const,
        action: "project.schedule.edit",
        name: "schedule-edit audit",
      },
      {
        table: "audit_events" as const,
        action: "configuration.apply",
        name: "configuration provenance audit",
      },
      {
        table: "project_configuration_outcomes" as const,
        action: undefined,
        name: "terminal receipt",
      },
    ])
      await t.test(
        `${boundary.name} failure rolls back schedule, revision and all terminal records`,
        async () => {
          const state = await fixture(db),
            plan = await createPlan(db, state);
          const remove = await trigger(
            db,
            state,
            boundary.table,
            "RAISE EXCEPTION 'intentional configuration rollback test';",
            boundary.action,
          );
          try {
            await assert.rejects(apply(new ConfigurationRepository(db), state, plan));
          } finally {
            await remove();
          }
          await assertRolledBack(db, state, plan.planId);
          const retry = await apply(new ConfigurationRepository(db), state, plan);
          assert.equal(retry.outcome, "applied");
        },
      );

    for (const noOp of [false, true])
      await t.test(
        `${noOp ? "no-op" : "material"} abort during outcome INSERT rolls back already written audits`,
        async () => {
          const state = await fixture(db),
            plan = await createPlan(db, state, noOp),
            controller = new AbortController();
          const key = Number.parseInt(state.project.projectId.slice(0, 8), 16) & 0x7fffffff;
          const remove = await trigger(
            db,
            state,
            "project_configuration_outcomes",
            `PERFORM pg_advisory_xact_lock(19478243,${key});`,
          );
          try {
            await withRepositoryLock(
              db,
              async (sql) => {
                await sql`SELECT pg_advisory_xact_lock(19478243,${key})`;
              },
              async (repository, pid, blocker, release) => {
                const rejected = assert.rejects(
                  apply(repository, state, plan, controller.signal),
                  isError("configuration_interrupted", 409),
                );
                try {
                  await awaitBlocked(db, pid, blocker);
                  controller.abort();
                } finally {
                  release();
                  await rejected;
                }
              },
            );
          } finally {
            await remove();
          }
          await assertRolledBack(db, state, plan.planId);
        },
      );

    await t.test(
      "expiry during terminal INSERT rolls back schedule and already inserted audits",
      async () => {
        const state = await fixture(db),
          plan = await shortenPlanExpiry(db, await createPlan(db, state)),
          key = Number.parseInt(state.project.projectId.slice(0, 8), 16) & 0x7fffffff;
        const remove = await trigger(
          db,
          state,
          "project_configuration_outcomes",
          `PERFORM pg_advisory_xact_lock(19478244,${key});`,
        );
        try {
          await withRepositoryLock(
            db,
            async (sql) => {
              await sql`SELECT pg_advisory_xact_lock(19478244,${key})`;
            },
            async (repository, pid, blocker, release) => {
              const rejected = assert.rejects(
                apply(repository, state, plan),
                isError("configuration_expired", 409),
              );
              try {
                await awaitBlocked(db, pid, blocker);
                await waitExpiry(db, "project_configuration_plans", plan.planId);
              } finally {
                release();
                await rejected;
              }
            },
          );
        } finally {
          await remove();
        }
        await assertRolledBack(db, state, plan.planId);
      },
    );

    await t.test(
      "persisted-target reconstruction detects a native writer trigger and rolls back",
      async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state);
        const remove = await trigger(
          db,
          state,
          "activities",
          "NEW.name := NEW.name || ' changed by database trigger';",
          undefined,
          "UPDATE",
        );
        try {
          await assert.rejects(
            apply(new ConfigurationRepository(db), state, plan),
            isError("configuration_integrity_error", 503),
          );
        } finally {
          await remove();
        }
        await assertRolledBack(db, state, plan.planId);
      },
    );

    for (const artifact of [
      "base_canonical",
      "candidate_canonical",
      "diff_json",
      "review_json",
    ] as const)
      await t.test(`corrupt ${artifact} fails closed before any mutation`, async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state);
        await alterStored(db, "project_configuration_artifacts", async (sql) => {
          const row = (
            await sql`SELECT * FROM project_configuration_artifacts WHERE plan_id=${plan.planId}`
          )[0];
          assert.ok(row);
          const text = String(row[artifact]);
          // Whitespace preserves valid JSON and native checks while violating
          // the reviewed exact bytes. This is genuine stored corruption.
          await sql.unsafe(
            `UPDATE project_configuration_artifacts SET ${artifact}=$1 WHERE plan_id=$2`,
            [`${text} `, plan.planId],
          );
        });
        const repository = new ConfigurationRepository(db);
        await assert.rejects(
          repository.getPlan(
            state.context,
            state.project.projectId,
            state.session.principal,
            plan.planId,
          ),
          isError("configuration_integrity_error", 503),
        );
        await assert.rejects(
          apply(repository, state, plan),
          isError("configuration_integrity_error", 503),
        );
        await assertRolledBack(db, state, plan.planId);
      });

    for (const field of [
      "request_hash_sha256",
      "reviewed_digest",
      "desired_input_hash_sha256",
    ] as const)
      await t.test(`corrupt plan ${field} cannot be read or applied`, async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state);
        await alterStored(db, "project_configuration_plans", async (sql) => {
          await sql.unsafe(`UPDATE project_configuration_plans SET ${field}=$1 WHERE id=$2`, [
            "0".repeat(64),
            plan.planId,
          ]);
        });
        await assert.rejects(
          new ConfigurationRepository(db).getPlan(
            state.context,
            state.project.projectId,
            state.session.principal,
            plan.planId,
          ),
          isError("configuration_integrity_error", 503),
        );
        await assertRolledBack(db, state, plan.planId);
      });

    for (const field of ["receipt_json", "receipt_hash_sha256"] as const)
      await t.test(
        `corrupt terminal ${field} cannot produce a successful replay or receipt`,
        async () => {
          const state = await fixture(db),
            plan = await createPlan(db, state),
            repository = new ConfigurationRepository(db);
          const originalReceipt = await apply(repository, state, plan);
          const before = await new ProjectRepository(db).plannerSnapshot(
            state.context,
            state.project.projectId,
          );
          if (field === "receipt_hash_sha256") {
            await assert.rejects(
              alterStored(db, "project_configuration_outcomes", async (sql) => {
                await sql`UPDATE project_configuration_outcomes SET receipt_hash_sha256=${"0".repeat(64)} WHERE plan_id=${plan.planId}`;
              }),
              (error) =>
                !!error && typeof error === "object" && "code" in error && error.code === "23514",
            );
            assert.deepEqual(
              await repository.receipt(
                state.context,
                state.project.projectId,
                state.session.principal,
                plan.planId,
              ),
              originalReceipt,
            );
            assert.deepEqual(await apply(repository, state, plan), originalReceipt);
            return;
          }
          await alterStored(db, "project_configuration_outcomes", async (sql) => {
            const row = (
              await sql`SELECT receipt_json FROM project_configuration_outcomes WHERE plan_id=${plan.planId}`
            )[0];
            assert.ok(row);
            const corrupted = `${String(row.receipt_json)} `;
            // SQL checks raw SHA-256; the application additionally checks exact
            // receipt serialization and metadata against the immutable outcome.
            await sql`UPDATE project_configuration_outcomes SET receipt_json=${corrupted},receipt_hash_sha256=${hash(corrupted)} WHERE plan_id=${plan.planId}`;
          });
          await assert.rejects(
            repository.receipt(
              state.context,
              state.project.projectId,
              state.session.principal,
              plan.planId,
            ),
            isError("configuration_integrity_error", 503),
          );
          await assert.rejects(
            apply(repository, state, plan),
            isError("configuration_integrity_error", 503),
          );
          assert.deepEqual(
            await new ProjectRepository(db).plannerSnapshot(state.context, state.project.projectId),
            before,
          );
          assert.equal(
            (
              await db`SELECT plan_id FROM project_configuration_outcomes WHERE plan_id=${plan.planId}`
            ).length,
            1,
          );
        },
      );

    await t.test(
      "missing live review returns explicit artifact-unavailable and still permits durable cancellation",
      async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state),
          repository = new ConfigurationRepository(db);
        await alterStored(db, "project_configuration_artifacts", async (sql) => {
          await sql`UPDATE project_configuration_artifacts SET keep_until=clock_timestamp()-interval '1 second' WHERE plan_id=${plan.planId}`;
        });
        await db`DELETE FROM project_configuration_artifacts WHERE plan_id=${plan.planId}`;
        await assert.rejects(
          apply(repository, state, plan),
          isError("configuration_artifact_unavailable", 410),
        );
        await assertRolledBack(db, state, plan.planId);
        const read = await repository.getPlan(
          state.context,
          state.project.projectId,
          state.session.principal,
          plan.planId,
        );
        assert.equal(read.plan, null);
        assert.equal(read.artifactsAvailable, false);
        assert.equal(read.status, "pending");
        const cancelled = await repository.cancel(
          state.context,
          state.project.projectId,
          state.session.principal,
          plan.planId,
          { reviewedDigest: plan.reviewedDigest },
        );
        assert.equal(cancelled.outcome, "cancelled");
        assert.equal(cancelled.committedRevision, null);
        assert.equal(cancelled.committedInputHashSha256, null);
        assert.deepEqual(
          await repository.receipt(
            state.context,
            state.project.projectId,
            state.session.principal,
            plan.planId,
          ),
          cancelled,
        );
      },
    );

    await t.test(
      "cancellation audit and outcome SQL failures preserve a pending unapplied plan",
      async () => {
        for (const target of [
          { table: "audit_events" as const, action: "configuration.cancel" },
          { table: "project_configuration_outcomes" as const, action: undefined },
        ]) {
          const state = await fixture(db),
            plan = await createPlan(db, state),
            repository = new ConfigurationRepository(db);
          const remove = await trigger(
            db,
            state,
            target.table,
            "RAISE EXCEPTION 'intentional cancellation rollback';",
            target.action,
          );
          try {
            await assert.rejects(
              repository.cancel(
                state.context,
                state.project.projectId,
                state.session.principal,
                plan.planId,
                { reviewedDigest: plan.reviewedDigest },
              ),
            );
          } finally {
            await remove();
          }
          await assertRolledBack(db, state, plan.planId);
          const retry = await repository.cancel(
            state.context,
            state.project.projectId,
            state.session.principal,
            plan.planId,
            { reviewedDigest: plan.reviewedDigest },
          );
          assert.equal(retry.outcome, "cancelled");
        }
      },
    );

    await t.test(
      "abort during cancellation outcome insertion removes its already written cancellation audit",
      async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state),
          controller = new AbortController(),
          key = Number.parseInt(state.project.projectId.slice(0, 8), 16) & 0x7fffffff;
        const remove = await trigger(
          db,
          state,
          "project_configuration_outcomes",
          `PERFORM pg_advisory_xact_lock(19478245,${key});`,
        );
        try {
          await withRepositoryLock(
            db,
            async (sql) => {
              await sql`SELECT pg_advisory_xact_lock(19478245,${key})`;
            },
            async (repository, pid, blocker, release) => {
              const rejected = assert.rejects(
                repository.cancel(
                  state.context,
                  state.project.projectId,
                  state.session.principal,
                  plan.planId,
                  { reviewedDigest: plan.reviewedDigest },
                  controller.signal,
                ),
                isError("configuration_interrupted", 409),
              );
              try {
                await awaitBlocked(db, pid, blocker);
                controller.abort();
              } finally {
                release();
                await rejected;
              }
            },
          );
        } finally {
          await remove();
        }
        await assertRolledBack(db, state, plan.planId);
      },
    );

    await t.test(
      "submillisecond persisted project settings fail closed instead of truncating export",
      async () => {
        const state = await fixture(db);
        await db`UPDATE project_schedule_settings SET data_date='2026-10-05T08:00:00.000001Z' WHERE project_id=${state.project.projectId}`;
        const repository = new ConfigurationRepository(db);
        await assert.rejects(
          repository.read(state.context, state.project.projectId, state.session.principal),
          isError("configuration_integrity_error", 503),
        );
        await assert.rejects(
          repository.plan(state.context, state.project.projectId, state.session.principal, {
            planId: randomUUID(),
            expectedRevision: state.snapshot.revision,
            configuration: state.configuration,
          }),
          isError("configuration_integrity_error", 503),
        );
      },
    );

    await t.test(
      "native UUID allocated after review is rechecked before any schedule mutation",
      async () => {
        const state = await fixture(db),
          foreign = await fixture(db),
          configuration = structuredClone(state.configuration);
        const template = configuration.input.activities[0];
        assert.ok(template);
        const id = randomUUID();
        configuration.input.activities.push({
          ...structuredClone(template),
          id,
          name: "Reviewed new native ID",
        });
        const repository = new ConfigurationRepository(db),
          response = await repository.plan(
            state.context,
            state.project.projectId,
            state.session.principal,
            { planId: randomUUID(), expectedRevision: state.snapshot.revision, configuration },
          );
        assert.ok(response.plan);
        await db`INSERT INTO activities(id,organization_id,project_id,wbs_id,calendar_id,name,kind,duration_minutes,constraints,sort_order)
        VALUES(${id},${foreign.organizationId},${foreign.project.projectId},${foreign.project.rootWbsId},${foreign.project.calendarId},'Allocated after review','TASK',480,'[]'::jsonb,1)`;
        await assert.rejects(
          apply(repository, state, response.plan),
          isError("configuration_id_conflict", 422),
        );
        await assertRolledBack(db, state, response.plan.planId);
        const retained = await db`SELECT organization_id,project_id FROM activities WHERE id=${id}`;
        assert.equal(retained[0]?.organization_id, foreign.organizationId);
        assert.equal(retained[0]?.project_id, foreign.project.projectId);
      },
    );

    await t.test(
      "completed replay and historical receipts survive TTL, collected reviews and later unsupported current input",
      async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state, true),
          repository = new ConfigurationRepository(db);
        const receipt = await apply(repository, state, plan);
        assert.equal(receipt.outcome, "no_op");
        await expireArtifacts(db, [plan.planId]);
        assert.equal(await repository.maintainArtifacts(), 1);
        await db`UPDATE project_schedule_settings SET data_date='2026-10-05T08:00:00.000001Z' WHERE project_id=${state.project.projectId}`;
        await assert.rejects(
          repository.read(state.context, state.project.projectId, state.session.principal),
          isError("configuration_integrity_error", 503),
        );
        assert.deepEqual(
          await repository.receipt(
            state.context,
            state.project.projectId,
            state.session.principal,
            plan.planId,
          ),
          receipt,
        );
        assert.deepEqual(await apply(repository, state, plan), receipt);
        const reviewed = await repository.getPlan(
          state.context,
          state.project.projectId,
          state.session.principal,
          plan.planId,
        );
        assert.equal(reviewed.plan, null);
        assert.equal(reviewed.artifactsAvailable, false);
        assert.equal(reviewed.status, "no_op");
        assert.deepEqual(reviewed.receipt, receipt);
        await db`UPDATE project_memberships SET role='viewer' WHERE organization_id=${state.organizationId} AND project_id=${state.project.projectId} AND user_id=${state.userId}`;
        assert.deepEqual(
          await repository.receipt(
            state.context,
            state.project.projectId,
            state.session.principal,
            plan.planId,
          ),
          receipt,
        );
        await assert.rejects(apply(repository, state, plan), isError("forbidden", 403));
        await assert.rejects(
          repository.cancel(
            state.context,
            state.project.projectId,
            state.session.principal,
            plan.planId,
            { reviewedDigest: plan.reviewedDigest },
          ),
          isError("forbidden", 403),
        );
        await db`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=${state.session.principal.sessionId}`;
        await assert.rejects(
          repository.receipt(
            state.context,
            state.project.projectId,
            state.session.principal,
            plan.planId,
          ),
          isError("unauthenticated", 401),
        );
      },
    );

    await t.test(
      "same-plan concurrent creation returns one immutable review and reserves bytes once",
      async () => {
        const state = await fixture(db),
          repository = new ConfigurationRepository(db),
          planId = randomUUID();
        const request = {
          planId,
          expectedRevision: state.snapshot.revision,
          configuration: state.configuration,
        };
        const [a, b] = await Promise.all([
          repository.plan(state.context, state.project.projectId, state.session.principal, request),
          repository.plan(state.context, state.project.projectId, state.session.principal, request),
        ]);
        assert.deepEqual(a, b);
        assert.equal(
          (await db`SELECT id FROM project_configuration_plans WHERE id=${planId}`).length,
          1,
        );
        const artifacts =
          await db`SELECT byte_count FROM project_configuration_artifacts WHERE plan_id=${planId}`;
        const storage =
          await db`SELECT used_bytes FROM project_configuration_project_storage WHERE project_id=${state.project.projectId}`;
        assert.equal(artifacts.length, 1);
        assert.equal(Number(storage[0]?.used_bytes), Number(artifacts[0]?.byte_count));
        assert.equal(
          (
            await db`SELECT id FROM audit_events WHERE resource_id=${state.project.projectId} AND action='configuration.plan'`
          ).length,
          1,
        );
      },
    );

    await t.test(
      "concurrent new-plan admission never crosses the eight-plan actor limit",
      async () => {
        const state = await fixture(db),
          repository = new ConfigurationRepository(db);
        for (let i = 0; i < 7; i++) await createPlan(db, state);
        const contenders = await Promise.allSettled([createPlan(db, state), createPlan(db, state)]);
        assert.equal(contenders.filter((r) => r.status === "fulfilled").length, 1);
        const rejected = contenders.find((r) => r.status === "rejected");
        assert.ok(rejected && rejected.status === "rejected");
        assert.ok(isError("configuration_capacity", 429)(rejected.reason));
        assert.equal(
          (
            await db`SELECT id FROM project_configuration_plans WHERE project_id=${state.project.projectId}`
          ).length,
          8,
        );
        const existingRow = (
          await db`SELECT id FROM project_configuration_plans WHERE project_id=${state.project.projectId} LIMIT 1`
        )[0];
        assert.ok(existingRow);
        const existing = (
          await repository.getPlan(
            state.context,
            state.project.projectId,
            state.session.principal,
            String(existingRow.id),
          )
        ).plan;
        assert.ok(existing);
        const replay = await repository.plan(
          state.context,
          state.project.projectId,
          state.session.principal,
          {
            planId: existing.planId,
            expectedRevision: existing.baseRevision,
            configuration: existing.configuration,
          },
        );
        assert.equal(replay.planId, existing.planId);
        await repository.cancel(
          state.context,
          state.project.projectId,
          state.session.principal,
          existing.planId,
          { reviewedDigest: existing.reviewedDigest },
        );
        await createPlan(db, state);
        assert.equal(
          (
            await db`SELECT id FROM project_configuration_plans WHERE project_id=${state.project.projectId}`
          ).length,
          9,
        );
      },
    );

    await t.test(
      "project-wide admission caps pending plans at thirty-two across actors",
      async () => {
        const state = await fixture(db),
          repository = new ConfigurationRepository(db);
        for (let actor = 0; actor < 4; actor++) {
          const userId = randomUUID();
          await db`INSERT INTO users(id,email) VALUES(${userId},${`${userId}@example.test`})`;
          await db`INSERT INTO organization_memberships(organization_id,user_id,role) VALUES(${state.organizationId},${userId},'planner')`;
          await db`INSERT INTO project_memberships(organization_id,project_id,user_id,role) VALUES(${state.organizationId},${state.project.projectId},${userId},'planner')`;
          const session = await issueSession(db, userId, `${userId}@example.test`, null, undefined),
            context = tenantContext(state.organizationId, userId);
          for (let i = 0; i < 8; i++)
            await repository.plan(context, state.project.projectId, session.principal, {
              planId: randomUUID(),
              expectedRevision: state.snapshot.revision,
              configuration: state.configuration,
            });
        }
        await assert.rejects(createPlan(db, state), isError("configuration_capacity", 429));
        assert.equal(
          (
            await db`SELECT id FROM project_configuration_plans WHERE project_id=${state.project.projectId}`
          ).length,
          32,
        );
      },
    );

    await t.test(
      "shared SQL creation rate counts terminal plans and allows exact identity replay",
      async () => {
        const state = await fixture(db),
          repository = new ConfigurationRepository(db);
        let last: ProjectConfigurationPlanV1 | undefined;
        for (let i = 0; i < 60; i++) {
          last = await createPlan(db, state, true);
          await repository.cancel(
            state.context,
            state.project.projectId,
            state.session.principal,
            last.planId,
            { reviewedDigest: last.reviewedDigest },
          );
        }
        assert.ok(last);
        await assert.rejects(createPlan(db, state, true), isError("configuration_rate_limit", 429));
        const replay = await repository.plan(
          state.context,
          state.project.projectId,
          state.session.principal,
          {
            planId: last.planId,
            expectedRevision: last.baseRevision,
            configuration: last.configuration,
          },
        );
        assert.equal(replay.status, "cancelled");
        assert.equal(
          (
            await db`SELECT id FROM project_configuration_plans WHERE project_id=${state.project.projectId}`
          ).length,
          60,
        );
      },
    );

    for (const scope of ["global", "project"] as const)
      await t.test(
        `${scope} accounting drift fails closed and rolls back identity, artifact and audit`,
        async () => {
          const state = await fixture(db),
            repository = new ConfigurationRepository(db),
            planId = randomUUID();
          // Hold the counter change and failing admission in one transaction on a
          // genuine database connection, then roll back the fixture counter change.
          // This avoids allocating hundreds of MiB just to test the product ceiling.
          const abort = new Error("rollback test counter reservation");
          await assert.rejects(
            db.begin(async (sql) => {
              if (scope === "global") {
                await sql.unsafe(
                  "ALTER TABLE project_configuration_storage_budget DISABLE TRIGGER configuration_global_counter_managed",
                );
                await sql`UPDATE project_configuration_storage_budget SET used_bytes=1073741824 WHERE singleton`;
                await sql.unsafe(
                  "ALTER TABLE project_configuration_storage_budget ENABLE TRIGGER configuration_global_counter_managed",
                );
              } else {
                await sql.unsafe(
                  "ALTER TABLE project_configuration_project_storage DISABLE TRIGGER configuration_project_counter_managed",
                );
                await sql`INSERT INTO project_configuration_project_storage(organization_id,project_id,used_bytes,artifact_count,state_hash_sha256)
                  VALUES(${state.organizationId},${state.project.projectId},134217728,0,engineo_configuration_counter_hash(${state.organizationId}||'/'||${state.project.projectId},0,0))`;
                await sql.unsafe(
                  "ALTER TABLE project_configuration_project_storage ENABLE TRIGGER configuration_project_counter_managed",
                );
              }
              const transactionDb = new Proxy(db, {
                get(target, property, receiver) {
                  if (property === "begin")
                    return async (callback: (transaction: DatabaseExecutor) => Promise<unknown>) =>
                      callback(sql);
                  return Reflect.get(target, property, receiver);
                },
              });
              await assert.rejects(
                new ConfigurationRepository(transactionDb).plan(
                  state.context,
                  state.project.projectId,
                  state.session.principal,
                  {
                    planId,
                    expectedRevision: state.snapshot.revision,
                    configuration: state.configuration,
                  },
                ),
                isError("configuration_integrity_error", 503),
              );
              throw abort;
            }),
            (error) => error === abort,
          );
          assert.equal(
            (
              await db`SELECT id FROM project_configuration_plans WHERE project_id=${state.project.projectId}`
            ).length,
            0,
          );
          assert.equal(
            (
              await db`SELECT plan_id FROM project_configuration_artifacts WHERE project_id=${state.project.projectId}`
            ).length,
            0,
          );
          assert.equal(
            (
              await db`SELECT id FROM audit_events WHERE resource_id=${state.project.projectId} AND action='configuration.plan'`
            ).length,
            0,
          );
          const valid = await repository.plan(
            state.context,
            state.project.projectId,
            state.session.principal,
            {
              planId,
              expectedRevision: state.snapshot.revision,
              configuration: state.configuration,
            },
          );
          assert.equal(valid.status, "pending");
        },
      );

    await t.test(
      "managed counters reject direct resets, rekeys, deletes, inserts and truncation",
      async () => {
        const state = await fixture(db);
        await createPlan(db, state, true);
        const global = await db`SELECT * FROM project_configuration_storage_budget`,
          project =
            await db`SELECT * FROM project_configuration_project_storage WHERE project_id=${state.project.projectId}`;
        for (const operation of [
          () =>
            db`UPDATE project_configuration_storage_budget SET used_bytes=0,artifact_count=0,state_hash_sha256=engineo_configuration_counter_hash('global',0,0) WHERE singleton`,
          () => db`UPDATE project_configuration_storage_budget SET singleton=false WHERE singleton`,
          () => db`DELETE FROM project_configuration_storage_budget WHERE singleton`,
          () => db`INSERT INTO project_configuration_storage_budget DEFAULT VALUES`,
          () => db.unsafe("TRUNCATE project_configuration_storage_budget"),
          () =>
            db`UPDATE project_configuration_project_storage SET used_bytes=0,artifact_count=0,state_hash_sha256=engineo_configuration_counter_hash(organization_id::text||'/'||project_id::text,0,0) WHERE project_id=${state.project.projectId}`,
          () =>
            db`UPDATE project_configuration_project_storage SET organization_id=${randomUUID()} WHERE project_id=${state.project.projectId}`,
          () =>
            db`UPDATE project_configuration_project_storage SET project_id=${randomUUID()} WHERE project_id=${state.project.projectId}`,
          () =>
            db`DELETE FROM project_configuration_project_storage WHERE project_id=${state.project.projectId}`,
          () =>
            db`INSERT INTO project_configuration_project_storage(organization_id,project_id,used_bytes,artifact_count,state_hash_sha256) VALUES(${state.organizationId},${state.project.projectId},0,0,engineo_configuration_counter_hash(${state.organizationId}||'/'||${state.project.projectId},0,0))`,
          () => db.unsafe("TRUNCATE project_configuration_project_storage"),
        ])
          await assert.rejects(operation(), isSqlCounterIntegrity);
        assert.deepEqual(await db`SELECT * FROM project_configuration_storage_budget`, global);
        assert.deepEqual(
          await db`SELECT * FROM project_configuration_project_storage WHERE project_id=${state.project.projectId}`,
          project,
        );
        const remove = await trigger(
          db,
          state,
          "activities",
          `PERFORM set_config('engineo.configuration_counter_transition','${JSON.stringify({ operation: "INSERT", organizationId: state.organizationId, projectId: state.project.projectId, planId: randomUUID(), deltaBytes: 5 })}',true); UPDATE project_configuration_storage_budget SET used_bytes=used_bytes+5,artifact_count=artifact_count+1,state_hash_sha256=engineo_configuration_counter_hash('global',used_bytes+5,artifact_count+1) WHERE singleton;`,
        );
        const id = randomUUID();
        try {
          await assert.rejects(
            db`INSERT INTO activities(id,organization_id,project_id,wbs_id,calendar_id,name,kind,duration_minutes,constraints,sort_order) VALUES(${id},${state.organizationId},${state.project.projectId},${state.project.rootWbsId},${state.project.calendarId},'Alternative trigger','TASK',60,'[]'::jsonb,1)`,
            isSqlCounterIntegrity,
          );
        } finally {
          await remove();
        }
        assert.equal((await db`SELECT id FROM activities WHERE id=${id}`).length, 0);
        assert.deepEqual(await db`SELECT * FROM project_configuration_storage_budget`, global);
      },
    );

    for (const scope of ["global", "project"] as const)
      for (const field of ["used_bytes", "artifact_count"] as const)
        await t.test(
          `${scope} stale ${field} hash rejects admission and rolls back exactly`,
          async () => {
            const state = await fixture(db);
            await createPlan(db, state, true);
            const planId = randomUUID(),
              table =
                scope === "global"
                  ? "project_configuration_storage_budget"
                  : "project_configuration_project_storage",
              guard =
                scope === "global"
                  ? "configuration_global_counter_managed"
                  : "configuration_project_counter_managed",
              before = await db.unsafe(`SELECT * FROM ${table}`),
              abort = new Error("rollback stale counter fixture");
            await assert.rejects(
              db.begin(async (sql) => {
                await sql.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${guard}`);
                await sql.unsafe(
                  `UPDATE ${table} SET ${field}=${field}+1 WHERE ${scope === "global" ? "singleton" : "project_id=$1"}`,
                  scope === "global" ? [] : [state.project.projectId],
                );
                await sql.unsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${guard}`);
                await assert.rejects(
                  sql.savepoint(async (nested) => {
                    await new ConfigurationRepository(transactionDatabase(db, nested)).plan(
                      state.context,
                      state.project.projectId,
                      state.session.principal,
                      {
                        planId,
                        expectedRevision: state.snapshot.revision,
                        configuration: state.configuration,
                      },
                    );
                  }),
                  isError("configuration_integrity_error", 503),
                );
                assert.equal(
                  (await sql`SELECT id FROM project_configuration_plans WHERE id=${planId}`).length,
                  0,
                );
                assert.equal(
                  (
                    await sql`SELECT id FROM audit_events WHERE resource_id=${state.project.projectId} AND action='configuration.plan'`
                  ).length,
                  1,
                );
                throw abort;
              }),
              (error) => error === abort,
            );
            assert.deepEqual(await db.unsafe(`SELECT * FROM ${table}`), before);
          },
        );

    for (const scope of ["global", "project"] as const)
      for (const release of [false, true])
        await t.test(
          `missing nonempty ${scope} counter fails ${release ? "retention release" : "new admission"} closed with503`,
          async () => {
            const state = await fixture(db),
              plan = await createPlan(db, state, true),
              table =
                scope === "global"
                  ? "project_configuration_storage_budget"
                  : "project_configuration_project_storage",
              guard =
                scope === "global"
                  ? "configuration_global_counter_managed"
                  : "configuration_project_counter_managed",
              planId = randomUUID(),
              abort = new Error("rollback missing counter fixture");
            if (release) {
              await new ConfigurationRepository(db).cancel(
                state.context,
                state.project.projectId,
                state.session.principal,
                plan.planId,
                { reviewedDigest: plan.reviewedDigest },
              );
              await expireArtifacts(db, [plan.planId]);
            }
            const global = await db`SELECT * FROM project_configuration_storage_budget`,
              project =
                await db`SELECT * FROM project_configuration_project_storage WHERE project_id=${state.project.projectId}`;
            await assert.rejects(
              db.begin(async (sql) => {
                await sql.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${guard}`);
                await sql.unsafe(
                  `DELETE FROM ${table} WHERE ${scope === "global" ? "singleton" : "project_id=$1"}`,
                  scope === "global" ? [] : [state.project.projectId],
                );
                await sql.unsafe(`ALTER TABLE ${table} ENABLE TRIGGER ${guard}`);
                await assert.rejects(
                  sql.savepoint(async (nested) => {
                    const repository = new ConfigurationRepository(transactionDatabase(db, nested));
                    if (release)
                      await repository.read(
                        state.context,
                        state.project.projectId,
                        state.session.principal,
                      );
                    else
                      await repository.plan(
                        state.context,
                        state.project.projectId,
                        state.session.principal,
                        {
                          planId,
                          expectedRevision: state.snapshot.revision,
                          configuration: state.configuration,
                        },
                      );
                  }),
                  isError("configuration_integrity_error", 503),
                );
                assert.equal(
                  (
                    await sql`SELECT plan_id FROM project_configuration_artifacts WHERE plan_id=${plan.planId}`
                  ).length,
                  1,
                );
                assert.equal(
                  (await sql`SELECT id FROM project_configuration_plans WHERE id=${planId}`).length,
                  0,
                );
                throw abort;
              }),
              (error) => error === abort,
            );
            assert.deepEqual(await db`SELECT * FROM project_configuration_storage_budget`, global);
            assert.deepEqual(
              await db`SELECT * FROM project_configuration_project_storage WHERE project_id=${state.project.projectId}`,
              project,
            );
            if (release) assert.equal(await new ConfigurationRepository(db).maintainArtifacts(), 1);
          },
        );

    for (const table of [
      "audit_events",
      "project_configuration_plans",
      "project_configuration_artifacts",
    ] as const)
      await t.test(
        `${table} insert failure rolls back plan audit and byte reservations`,
        async () => {
          const state = await fixture(db),
            planId = randomUUID();
          const globalBefore =
            await db`SELECT used_bytes FROM project_configuration_storage_budget WHERE singleton`;
          const remove = await trigger(
            db,
            state,
            table,
            "RAISE EXCEPTION 'intentional plan creation boundary';",
            table === "audit_events" ? "configuration.plan" : undefined,
          );
          try {
            await assert.rejects(
              new ConfigurationRepository(db).plan(
                state.context,
                state.project.projectId,
                state.session.principal,
                {
                  planId,
                  expectedRevision: state.snapshot.revision,
                  configuration: state.configuration,
                },
              ),
            );
          } finally {
            await remove();
          }
          assert.equal(
            (await db`SELECT id FROM project_configuration_plans WHERE id=${planId}`).length,
            0,
          );
          assert.equal(
            (await db`SELECT plan_id FROM project_configuration_artifacts WHERE plan_id=${planId}`)
              .length,
            0,
          );
          assert.equal(
            (
              await db`SELECT id FROM audit_events WHERE resource_id=${state.project.projectId} AND action='configuration.plan'`
            ).length,
            0,
          );
          assert.deepEqual(
            await db`SELECT used_bytes FROM project_configuration_storage_budget WHERE singleton`,
            globalBefore,
          );
        },
      );

    await t.test(
      "cancel/apply concurrent contenders serialize to one durable outcome",
      async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state),
          repository = new ConfigurationRepository(db);
        const results = await Promise.allSettled([
          apply(repository, state, plan),
          repository.cancel(
            state.context,
            state.project.projectId,
            state.session.principal,
            plan.planId,
            { reviewedDigest: plan.reviewedDigest },
          ),
        ]);
        const receipt = await repository.receipt(
          state.context,
          state.project.projectId,
          state.session.principal,
          plan.planId,
        );
        assert.equal(
          (
            await db`SELECT plan_id FROM project_configuration_outcomes WHERE plan_id=${plan.planId}`
          ).length,
          1,
        );
        for (const result of results) {
          if (result.status === "fulfilled") assert.deepEqual(result.value, receipt);
          else {
            assert.equal(receipt.outcome, "cancelled");
            assert.ok(isError("configuration_cancelled", 409)(result.reason));
          }
        }
        const stored = await new ProjectRepository(db).plannerSnapshot(
          state.context,
          state.project.projectId,
        );
        assert.ok(stored);
        assert.equal(
          stored.revision,
          state.snapshot.revision + (receipt.outcome === "applied" ? 1 : 0),
        );
        assert.equal(
          hash(serializeScheduleInputV1(stored.input)),
          receipt.outcome === "applied" ? plan.desiredInputHashSha256 : plan.baseInputHashSha256,
        );
      },
    );

    await t.test(
      "real HTTP rejects malformed original UTF-8 bytes and escaped lone surrogates",
      async () => {
        const state = await fixture(db),
          app = buildApp({ database: db });
        try {
          const origin = await app.listen({ host: "127.0.0.1", port: 0 });
          const send = (url: string, body: Buffer) =>
            bounded(
              new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
                const request = httpRequest(
                  origin + url,
                  {
                    method: "POST",
                    headers: {
                      ...state.headers,
                      "content-type": "application/json; charset=utf-8",
                      "content-length": body.length,
                    },
                  },
                  (response) => {
                    const chunks: Buffer[] = [];
                    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
                    response.on("error", reject);
                    response.on("end", () =>
                      resolve({
                        statusCode: response.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString("utf8"),
                      }),
                    );
                  },
                );
                request.on("error", reject);
                request.end(body);
              }),
              "The actual HTTP parser must return a bounded response",
            );
          const original = Buffer.from(JSON.stringify(state.configuration));
          const target = Buffer.from("Boundary project"),
            at = original.indexOf(target);
          assert.ok(at >= 0);
          const malformed = Buffer.concat([
            original.subarray(0, at),
            Buffer.from([0xc3, 0x28]),
            original.subarray(at + target.length),
          ]);
          const surrogate = structuredClone(state.configuration);
          surrogate.input.project.name = "\ud800";
          const escaped = Buffer.from(JSON.stringify(surrogate));
          assert.ok(escaped.toString("utf8").includes("\\ud800"));
          for (const body of [malformed, escaped]) {
            const response = await send(`${state.url}/validate`, body);
            assert.equal(response.statusCode, 422, response.body);
            assert.equal(JSON.parse(response.body).error, "configuration_invalid");
            assert.equal(response.body.includes(state.session.token), false);
            assert.equal(response.body.includes(state.session.csrfToken), false);
          }
          assert.deepEqual(
            await new ProjectRepository(db).plannerSnapshot(state.context, state.project.projectId),
            state.snapshot,
          );
          assert.equal(
            (
              await db`SELECT id FROM project_configuration_plans WHERE project_id=${state.project.projectId}`
            ).length,
            0,
          );
        } finally {
          await app.close();
        }
      },
    );

    await t.test(
      "dropped post-commit HTTP response remains recoverable by known plan identity",
      async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state),
          app = buildApp({ database: db });
        const dropped = deferred();
        app.addHook("onSend", async (request, reply, payload) => {
          if (
            request.url === `${state.url}/plans/${plan.planId}/apply` &&
            reply.statusCode === 200
          ) {
            request.raw.socket.destroy();
            dropped.resolve();
          }
          return payload;
        });
        try {
          const origin = await app.listen({ host: "127.0.0.1", port: 0 });
          const body = JSON.stringify({
            expectedRevision: plan.baseRevision,
            reviewedDigest: plan.reviewedDigest,
          });
          const disconnected = new Promise<void>((resolve, reject) => {
            const request = httpRequest(
              `${origin}${state.url}/plans/${plan.planId}/apply`,
              {
                method: "POST",
                headers: {
                  ...state.headers,
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(body),
                },
              },
              (response) => {
                response.resume();
                response.on("end", () =>
                  reject(new Error("The response must actually be dropped")),
                );
              },
            );
            request.on("error", () => resolve());
            request.end(body);
          });
          await bounded(dropped.promise, "The genuine HTTP request must commit and reach onSend");
          await bounded(disconnected, "Client must observe a dropped response");
        } finally {
          await app.close();
        }
        const restartedDb = createDatabase();
        try {
          const repository = new ConfigurationRepository(restartedDb);
          const receipt = await repository.receipt(
            state.context,
            state.project.projectId,
            state.session.principal,
            plan.planId,
          );
          assert.equal(receipt.outcome, "applied");
          const replay = await apply(repository, state, plan);
          assert.deepEqual(replay, receipt);
          assert.equal(
            (
              await restartedDb`SELECT plan_id FROM project_configuration_outcomes WHERE plan_id=${plan.planId}`
            ).length,
            1,
          );
          assert.equal(
            (
              await restartedDb`SELECT id FROM audit_events WHERE resource_id=${state.project.projectId} AND action='configuration.apply'`
            ).length,
            1,
          );
        } finally {
          await restartedDb.end({ timeout: 5 });
        }
      },
    );
    await t.test(
      "actual bounded artifacts fill the 128 MiB project ceiling and reject another API admission",
      async () => {
        const state = await fixture(db),
          before =
            await db`SELECT used_bytes FROM project_configuration_storage_budget WHERE singleton`;
        const abort = new Error("rollback large storage fixture");
        await assert.rejects(
          db.begin(async (sql) => {
            for (let i = 0; i < 4; i++) await insertMaximumStorageFixture(sql, state);
            const rows =
              await sql`SELECT sum(byte_count)::bigint AS bytes,count(*)::int AS count FROM project_configuration_artifacts WHERE project_id=${state.project.projectId}`;
            assert.equal(Number(rows[0]?.bytes), 134217728);
            assert.equal(Number(rows[0]?.count), 4);
            const counter =
              await sql`SELECT used_bytes FROM project_configuration_project_storage WHERE project_id=${state.project.projectId}`;
            assert.equal(Number(counter[0]?.used_bytes), 134217728);
            await assert.rejects(
              sql.savepoint(async (nested) => {
                const transactionDb = new Proxy(db, {
                  get(target, property, receiver) {
                    if (property === "begin")
                      return async (
                        callback: (transaction: DatabaseExecutor) => Promise<unknown>,
                      ) => callback(nested);
                    return Reflect.get(target, property, receiver);
                  },
                });
                await new ConfigurationRepository(transactionDb).plan(
                  state.context,
                  state.project.projectId,
                  state.session.principal,
                  {
                    planId: randomUUID(),
                    expectedRevision: state.snapshot.revision,
                    configuration: state.configuration,
                  },
                );
              }),
              isError("configuration_capacity", 429),
            );
            assert.equal(
              (
                await sql`SELECT id FROM project_configuration_plans WHERE project_id=${state.project.projectId}`
              ).length,
              4,
            );
            throw abort;
          }),
          (error) => error === abort,
        );
        assert.deepEqual(
          await db`SELECT used_bytes FROM project_configuration_storage_budget WHERE singleton`,
          before,
        );
        assert.equal(
          (
            await db`SELECT id FROM project_configuration_plans WHERE project_id=${state.project.projectId}`
          ).length,
          0,
        );
      },
    );

    await t.test(
      "actual logical artifacts independently fill the global 1 GiB ceiling across eight projects",
      async () => {
        const states: Fixture[] = [];
        for (let i = 0; i < 8; i++) states.push(await fixture(db));
        const before = Number(
          (await db`SELECT used_bytes FROM project_configuration_storage_budget WHERE singleton`)[0]
            ?.used_bytes,
        );
        assert.ok(before >= 0 && before < 1073741824);
        const abort = new Error("rollback global storage fixture");
        await assert.rejects(
          db.begin(async (sql) => {
            let remaining = 1073741824 - before,
              allocations = 0;
            for (const state of states) {
              let projectBytes = 0;
              while (remaining > 0 && projectBytes < 134217728) {
                let bytes = Math.min(33554432, remaining, 134217728 - projectBytes);
                if (remaining > bytes && remaining - bytes < 16384) bytes -= 16384;
                await insertMaximumStorageFixture(sql, state, bytes);
                remaining -= bytes;
                projectBytes += bytes;
                allocations++;
              }
            }
            assert.equal(remaining, 0);
            assert.ok(allocations <= 33);
            const row = (
              await sql`SELECT (SELECT used_bytes FROM project_configuration_storage_budget WHERE singleton) AS recorded,(SELECT sum(byte_count) FROM project_configuration_artifacts) AS actual`
            )[0];
            assert.ok(row);
            assert.equal(Number(row.recorded), 1073741824);
            assert.equal(Number(row.actual), 1073741824);
            const state = states.at(-1);
            assert.ok(state);
            await assert.rejects(
              sql.savepoint(async (nested) => {
                const transactionDb = new Proxy(db, {
                  get(target, property, receiver) {
                    if (property === "begin")
                      return async (
                        callback: (transaction: DatabaseExecutor) => Promise<unknown>,
                      ) => callback(nested);
                    return Reflect.get(target, property, receiver);
                  },
                });
                await new ConfigurationRepository(transactionDb).plan(
                  state.context,
                  state.project.projectId,
                  state.session.principal,
                  {
                    planId: randomUUID(),
                    expectedRevision: state.snapshot.revision,
                    configuration: state.configuration,
                  },
                );
              }),
              isError("configuration_capacity", 429),
            );
            throw abort;
          }),
          (error) => error === abort,
        );
        assert.equal(
          Number(
            (
              await db`SELECT used_bytes FROM project_configuration_storage_budget WHERE singleton`
            )[0]?.used_bytes,
          ),
          before,
        );
        for (const state of states)
          assert.equal(
            (
              await db`SELECT id FROM project_configuration_plans WHERE project_id=${state.project.projectId}`
            ).length,
            0,
          );
      },
    );

    await t.test(
      "cross-project concurrent admission preserves exact generated-byte accounting",
      async () => {
        const states = [await fixture(db), await fixture(db), await fixture(db)];
        const before = Number(
          (await db`SELECT used_bytes FROM project_configuration_storage_budget WHERE singleton`)[0]
            ?.used_bytes,
        );
        const results = await bounded(
          Promise.all(
            states.flatMap((state) => Array.from({ length: 6 }, () => createPlan(db, state, true))),
          ),
          "Concurrent project admissions must finish without a lock-order deadlock",
          20_000,
        );
        assert.equal(results.length, 18);
        const allocations =
          await db`SELECT project_id,sum(byte_count) AS bytes,count(*)::int AS count FROM project_configuration_artifacts WHERE project_id IN ${db(states.map((state) => state.project.projectId))} GROUP BY project_id`;
        assert.equal(allocations.length, 3);
        let added = 0;
        for (const allocation of allocations) {
          assert.equal(Number(allocation.count), 6);
          added += Number(allocation.bytes);
          assert.equal(
            Number(
              (
                await db`SELECT used_bytes FROM project_configuration_project_storage WHERE project_id=${String(allocation.project_id)}`
              )[0]?.used_bytes,
            ),
            Number(allocation.bytes),
          );
        }
        const global = Number(
          (await db`SELECT used_bytes FROM project_configuration_storage_budget WHERE singleton`)[0]
            ?.used_bytes,
        );
        assert.equal(global, before + added);
        assert.equal(
          global,
          Number(
            (await db`SELECT sum(byte_count) AS bytes FROM project_configuration_artifacts`)[0]
              ?.bytes,
          ),
        );
      },
    );

    await t.test(
      "retention maintenance deletes at most 64 heavy reviews and preserves all compact receipts and identities",
      async () => {
        const states = [await fixture(db), await fixture(db)],
          repository = new ConfigurationRepository(db);
        const records: Array<{
          state: Fixture;
          plan: ProjectConfigurationPlanV1;
          receipt: Awaited<ReturnType<ConfigurationRepository["cancel"]>>;
        }> = [];
        for (const state of states)
          for (let i = 0; i < 40; i++) {
            const plan = await createPlan(db, state, true);
            const receipt = await repository.cancel(
              state.context,
              state.project.projectId,
              state.session.principal,
              plan.planId,
              { reviewedDigest: plan.reviewedDigest },
            );
            records.push({ state, plan, receipt });
          }
        const before = Number(
          (await db`SELECT used_bytes FROM project_configuration_storage_budget WHERE singleton`)[0]
            ?.used_bytes,
        );
        const bytes = Number(
          (
            await db`SELECT sum(byte_count) AS bytes FROM project_configuration_artifacts WHERE plan_id IN ${db(records.map((r) => r.plan.planId))}`
          )[0]?.bytes,
        );
        await expireArtifacts(
          db,
          records.map((r) => r.plan.planId),
        );
        assert.equal(await repository.maintainArtifacts(), CONFIGURATION_MAINTENANCE_BATCH);
        assert.equal(
          (
            await db`SELECT plan_id FROM project_configuration_artifacts WHERE plan_id IN ${db(records.map((r) => r.plan.planId))}`
          ).length,
          16,
        );
        assert.equal(await repository.maintainArtifacts(), 16);
        assert.equal(await repository.maintainArtifacts(), 0);
        assert.equal(
          Number(
            (
              await db`SELECT used_bytes FROM project_configuration_storage_budget WHERE singleton`
            )[0]?.used_bytes,
          ),
          before - bytes,
        );
        for (const state of states) {
          assert.equal(
            (
              await db`SELECT id FROM project_configuration_plans WHERE project_id=${state.project.projectId}`
            ).length,
            40,
          );
          assert.equal(
            (
              await db`SELECT plan_id FROM project_configuration_outcomes WHERE project_id=${state.project.projectId}`
            ).length,
            40,
          );
          assert.equal(
            Number(
              (
                await db`SELECT used_bytes FROM project_configuration_project_storage WHERE project_id=${state.project.projectId}`
              )[0]?.used_bytes,
            ),
            0,
          );
        }
        for (const record of [records[0], records.at(-1)]) {
          assert.ok(record);
          const { state, plan, receipt } = record;
          assert.deepEqual(
            await repository.receipt(
              state.context,
              state.project.projectId,
              state.session.principal,
              plan.planId,
            ),
            receipt,
          );
          const restored = await repository.getPlan(
            state.context,
            state.project.projectId,
            state.session.principal,
            plan.planId,
          );
          assert.equal(restored.plan, null);
          assert.equal(restored.artifactsAvailable, false);
          assert.equal(restored.status, "cancelled");
          assert.deepEqual(restored.receipt, receipt);
          const replay = await repository.plan(
            state.context,
            state.project.projectId,
            state.session.principal,
            {
              planId: plan.planId,
              expectedRevision: plan.baseRevision,
              configuration: plan.configuration,
            },
          );
          assert.equal(replay.plan, null);
          assert.equal(replay.status, "cancelled");
          const changed = structuredClone(plan.configuration);
          changed.input.project.name = "Reuse erased history";
          await assert.rejects(
            repository.plan(state.context, state.project.projectId, state.session.principal, {
              planId: plan.planId,
              expectedRevision: plan.baseRevision,
              configuration: changed,
            }),
            isError("configuration_idempotency_conflict", 409),
          );
        }
      },
    );

    await t.test(
      "cleanup SQL failure rolls back deletes and byte release and prevents fail-open admission",
      async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state, true),
          repository = new ConfigurationRepository(db);
        await repository.cancel(
          state.context,
          state.project.projectId,
          state.session.principal,
          plan.planId,
          { reviewedDigest: plan.reviewedDigest },
        );
        await expireArtifacts(db, [plan.planId]);
        const before =
          await db`SELECT used_bytes FROM project_configuration_storage_budget WHERE singleton`;
        const remove = await trigger(
          db,
          state,
          "project_configuration_artifacts",
          "RAISE EXCEPTION 'intentional cleanup failure';",
          undefined,
          "DELETE",
          "AFTER",
        );
        try {
          await assert.rejects(repository.maintainArtifacts());
          await assert.rejects(
            repository.plan(state.context, state.project.projectId, state.session.principal, {
              planId: randomUUID(),
              expectedRevision: state.snapshot.revision,
              configuration: state.configuration,
            }),
          );
          assert.equal(
            (
              await db`SELECT plan_id FROM project_configuration_artifacts WHERE plan_id=${plan.planId}`
            ).length,
            1,
          );
          assert.deepEqual(
            await db`SELECT used_bytes FROM project_configuration_storage_budget WHERE singleton`,
            before,
          );
          assert.equal(
            (
              await db`SELECT id FROM project_configuration_plans WHERE project_id=${state.project.projectId}`
            ).length,
            1,
          );
        } finally {
          await remove();
        }
        assert.equal(await repository.maintainArtifacts(), 1);
      },
    );

    await t.test(
      "maintenance skips independently locked retained artifacts without blocking",
      async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state, true),
          repository = new ConfigurationRepository(db);
        await repository.cancel(
          state.context,
          state.project.projectId,
          state.session.principal,
          plan.planId,
          { reviewedDigest: plan.reviewedDigest },
        );
        await expireArtifacts(db, [plan.planId]);
        await withRepositoryLock(
          db,
          async (sql) => {
            await sql`SELECT plan_id FROM project_configuration_artifacts WHERE plan_id=${plan.planId} FOR UPDATE`;
          },
          async (worker, _pid, _blocker, release) => {
            try {
              assert.equal(
                await bounded(
                  worker.maintainArtifacts(),
                  "SKIP LOCKED cleanup must finish without waiting",
                  1_000,
                ),
                0,
              );
            } finally {
              release();
            }
          },
        );
        assert.equal(await repository.maintainArtifacts(), 1);
        assert.equal(
          (
            await db`SELECT plan_id FROM project_configuration_outcomes WHERE plan_id=${plan.planId}`
          ).length,
          1,
        );
      },
    );

    await t.test(
      "concurrent maintenance, live readers and different-project admission share one safe counter order",
      async () => {
        const liveState = await fixture(db),
          expiredState = await fixture(db),
          newState = await fixture(db),
          repository = new ConfigurationRepository(db);
        const live = await createPlan(db, liveState, true),
          expired: ProjectConfigurationPlanV1[] = [];
        for (let i = 0; i < 5; i++) {
          const plan = await createPlan(db, expiredState, true);
          await repository.cancel(
            expiredState.context,
            expiredState.project.projectId,
            expiredState.session.principal,
            plan.planId,
            { reviewedDigest: plan.reviewedDigest },
          );
          expired.push(plan);
        }
        await expireArtifacts(
          db,
          expired.map((plan) => plan.planId),
        );
        await withRepositoryLock(
          db,
          async (sql) => {
            await sql`SELECT plan_id FROM project_configuration_artifacts WHERE plan_id=${live.planId} FOR SHARE`;
          },
          async (worker, _pid, _blocker, release) => {
            try {
              const [removed, read, created] = await bounded(
                Promise.all([
                  worker.maintainArtifacts(),
                  repository.getPlan(
                    liveState.context,
                    liveState.project.projectId,
                    liveState.session.principal,
                    live.planId,
                  ),
                  createPlan(db, newState, true),
                ]),
                "Maintenance/read/admission must finish under the live artifact reader lock",
                15_000,
              );
              assert.ok(removed >= 0 && removed <= 5);
              assert.equal(read.planId, live.planId);
              assert.ok(read.plan);
              assert.equal(read.status, "pending");
              assert.equal(created.projectId, newState.project.projectId);
            } finally {
              release();
            }
          },
        );
        assert.equal(
          (
            await db`SELECT plan_id FROM project_configuration_artifacts WHERE project_id=${expiredState.project.projectId}`
          ).length,
          0,
        );
        assert.equal(
          (
            await db`SELECT plan_id FROM project_configuration_artifacts WHERE plan_id=${live.planId}`
          ).length,
          1,
        );
        const totals = (
          await db`SELECT (SELECT used_bytes FROM project_configuration_storage_budget WHERE singleton) AS recorded,(SELECT sum(byte_count) FROM project_configuration_artifacts) AS actual`
        )[0];
        assert.ok(totals);
        assert.equal(Number(totals.recorded), Number(totals.actual));
      },
    );

    await t.test(
      "migration enforces immutable identities, outcomes, retained review bytes and audit history",
      async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state, true),
          repository = new ConfigurationRepository(db);
        const receipt = await apply(repository, state, plan);
        for (const operation of [
          () =>
            db`UPDATE project_configuration_plans SET reviewed_digest=${"0".repeat(64)} WHERE id=${plan.planId}`,
          () => db`DELETE FROM project_configuration_plans WHERE id=${plan.planId}`,
          () =>
            db`UPDATE project_configuration_outcomes SET receipt_hash_sha256=${"0".repeat(64)} WHERE plan_id=${plan.planId}`,
          () => db`DELETE FROM project_configuration_outcomes WHERE plan_id=${plan.planId}`,
          () =>
            db`UPDATE project_configuration_artifacts SET diff_json='[]' WHERE plan_id=${plan.planId}`,
          () => db`DELETE FROM project_configuration_artifacts WHERE plan_id=${plan.planId}`,
          () => db`DELETE FROM audit_events WHERE id=${receipt.provenanceAuditId}`,
        ])
          await assert.rejects(operation());
        for (const statement of [
          "TRUNCATE project_configuration_artifacts",
          "TRUNCATE project_configuration_outcomes",
          "TRUNCATE project_configuration_plans,project_configuration_outcomes,project_configuration_artifacts",
        ])
          await assert.rejects(db.unsafe(statement));
        assert.deepEqual(
          await repository.receipt(
            state.context,
            state.project.projectId,
            state.session.principal,
            plan.planId,
          ),
          receipt,
        );
        assert.equal(
          (
            await db`SELECT plan_id FROM project_configuration_artifacts WHERE plan_id=${plan.planId}`
          ).length,
          1,
        );
      },
    );

    await t.test(
      "migration composite references and strict audit bindings prevent cross-project evidence substitution",
      async () => {
        const state = await fixture(db),
          other = await fixture(db),
          plan = await createPlan(db, state, true),
          repository = new ConfigurationRepository(db);
        const receipt = await apply(repository, state, plan);
        const newId = randomUUID();
        for (const replacement of [
          {
            actorId: other.userId,
            sessionId: state.session.principal.sessionId,
            organizationId: state.organizationId,
            projectId: state.project.projectId,
          },
          {
            actorId: state.userId,
            sessionId: state.session.principal.sessionId,
            organizationId: other.organizationId,
            projectId: state.project.projectId,
          },
          {
            actorId: state.userId,
            sessionId: state.session.principal.sessionId,
            organizationId: state.organizationId,
            projectId: other.project.projectId,
          },
        ])
          await assert.rejects(db`INSERT INTO project_configuration_plans(organization_id,project_id,id,actor_id,session_id,protocol_version,configuration_version,normalization_version,base_revision,base_input_hash_sha256,desired_input_hash_sha256,request_hash_sha256,reviewed_digest,no_op,created_at,expires_at,artifacts_keep_until,plan_audit_id)
        SELECT ${replacement.organizationId},${replacement.projectId},${newId},${replacement.actorId},${replacement.sessionId},protocol_version,configuration_version,normalization_version,base_revision,base_input_hash_sha256,desired_input_hash_sha256,request_hash_sha256,reviewed_digest,no_op,created_at,expires_at,artifacts_keep_until,plan_audit_id FROM project_configuration_plans WHERE id=${plan.planId}`);
        await assert.rejects(db`INSERT INTO project_configuration_artifacts(organization_id,project_id,plan_id,base_canonical,candidate_canonical,diff_json,review_json,keep_until)
        SELECT ${other.organizationId},${other.project.projectId},plan_id,base_canonical,candidate_canonical,diff_json,review_json,keep_until FROM project_configuration_artifacts WHERE plan_id=${plan.planId}`);
        const unboundPlan = await createPlan(db, state, true);
        await assert.rejects(db`INSERT INTO project_configuration_outcomes(organization_id,project_id,plan_id,outcome,previous_revision,committed_revision,base_input_hash_sha256,committed_input_hash_sha256,reviewed_digest,provenance_audit_id,schedule_edit_audit_id,recorded_at,receipt_json,receipt_hash_sha256)
        SELECT organization_id,project_id,${unboundPlan.planId},outcome,previous_revision,committed_revision,base_input_hash_sha256,committed_input_hash_sha256,${unboundPlan.reviewedDigest},provenance_audit_id,schedule_edit_audit_id,recorded_at,receipt_json,receipt_hash_sha256 FROM project_configuration_outcomes WHERE plan_id=${plan.planId}`);
        assert.deepEqual(
          await repository.receipt(
            state.context,
            state.project.projectId,
            state.session.principal,
            plan.planId,
          ),
          receipt,
        );
        await migrateDatabase(db); // Exact checksum replay remains idempotent.
      },
    );
    await t.test(
      "millisecond schedule settings preserve material review, native reads, exports and real Rust input provenance",
      async () => {
        const binaryPath = process.env.ENGINEO_SCHEDULER_BIN;
        assert.ok(
          binaryPath,
          "Configured PostgreSQL millisecond parity requires the release Rust bridge",
        );
        const state = await fixture(db),
          configuration = structuredClone(state.configuration);
        configuration.input.project.plannedStart = "2026-10-05T08:00:00.123Z";
        configuration.input.project.dataDate = "2026-10-05T08:00:00.456Z";
        configuration.input.project.requiredFinish = "2026-10-07T17:00:00.789Z";
        configuration.input.scheduleOptions.projectFinishPolicy = "REQUIRED_FINISH";
        const repository = new ConfigurationRepository(db),
          reviewed = await repository.plan(
            state.context,
            state.project.projectId,
            state.session.principal,
            { planId: randomUUID(), expectedRevision: state.snapshot.revision, configuration },
          );
        assert.ok(reviewed.plan);
        assert.equal(reviewed.plan.noOp, false);
        const receipt = await apply(repository, state, reviewed.plan);
        assert.equal(receipt.outcome, "applied");
        const snapshot = await new ProjectRepository(db).plannerSnapshot(
          state.context,
          state.project.projectId,
        );
        assert.ok(snapshot);
        assert.equal(snapshot.input.project.plannedStart, configuration.input.project.plannedStart);
        assert.equal(snapshot.input.project.dataDate, configuration.input.project.dataDate);
        assert.equal(
          snapshot.input.project.requiredFinish,
          configuration.input.project.requiredFinish,
        );
        const canonical = serializeScheduleInputV1(snapshot.input);
        assert.equal(hash(canonical), reviewed.plan.desiredInputHashSha256);
        assert.equal(receipt.committedInputHashSha256, hash(canonical));
        const stored = (
          await db`SELECT planned_start,data_date,required_finish FROM project_schedule_settings WHERE project_id=${state.project.projectId}`
        )[0];
        assert.ok(stored);
        assert.equal(instant(stored.planned_start), configuration.input.project.plannedStart);
        assert.equal(instant(stored.data_date), configuration.input.project.dataDate);
        assert.equal(instant(stored.required_finish), configuration.input.project.requiredFinish);
        const app = buildApp({
          database: db,
          scheduleRunner: new ProcessScheduleRunner({ binaryPath }),
        });
        try {
          const projectUrl = `/organizations/${state.organizationId}/projects/${state.project.projectId}`;
          const read = await app.inject({
            method: "GET",
            url: `${projectUrl}/schedule`,
            headers: state.headers,
          });
          assert.equal(read.statusCode, 200, read.body);
          assert.equal(
            hash(serializeScheduleInputV1(read.json<{ input: typeof snapshot.input }>().input)),
            hash(canonical),
          );
          const exported = await app.inject({
            method: "GET",
            url: `${projectUrl}/schedule/export`,
            headers: state.headers,
          });
          assert.equal(exported.statusCode, 200, exported.body);
          assert.equal(exported.body, canonical);
          const configured = await app.inject({
            method: "GET",
            url: state.url,
            headers: state.headers,
          });
          assert.equal(configured.statusCode, 200, configured.body);
          assert.equal(configured.json().inputHashSha256, hash(canonical));
          assert.deepEqual(configured.json().configuration.input.project, snapshot.input.project);
          const calculated = await app.inject({
            method: "POST",
            url: `${projectUrl}/schedule/run`,
            headers: state.headers,
            payload: { expectedRevision: receipt.committedRevision },
          });
          assert.equal(calculated.statusCode, 200, calculated.body);
          const body = calculated.json<{
            calculation: { inputHashSha256: string; projectRevision: number };
            result: unknown;
          }>();
          assert.ok(body.result);
          assert.equal(body.calculation.inputHashSha256, hash(canonical));
          assert.equal(body.calculation.projectRevision, receipt.committedRevision);
          const evidence =
            await db`SELECT input_canonical,input_hash_sha256,project_revision FROM schedule_calculations WHERE project_id=${state.project.projectId}`;
          assert.equal(evidence.length, 1);
          assert.equal(evidence[0]?.input_canonical, canonical);
          assert.equal(evidence[0]?.input_hash_sha256, hash(canonical));
          assert.equal(Number(evidence[0]?.project_revision), receipt.committedRevision);
        } finally {
          await app.close();
        }
      },
    );

    await t.test(
      "legacy zero-millisecond calculations stay immutable history and cannot be reused for corrected native instants",
      async () => {
        const binaryPath = process.env.ENGINEO_SCHEDULER_BIN;
        assert.ok(binaryPath, "Historical millisecond-key parity requires the release Rust bridge");
        const state = await fixture(db),
          projectUrl = `/organizations/${state.organizationId}/projects/${state.project.projectId}`;
        // Simulate the historical reader bug in a disposable fixture. Start with
        // a genuine .000 schedule/result, then alter only its native instants at
        // the same revision. No migration or production rewriting is performed.
        await db`UPDATE project_schedule_settings SET planned_start='2026-10-05T08:00:00.000Z',data_date='2026-10-05T08:00:00.000Z',required_finish='2026-10-07T17:00:00.000Z',project_finish_policy='REQUIRED_FINISH' WHERE project_id=${state.project.projectId}`;
        const initial = await new ProjectRepository(db).plannerSnapshot(
          state.context,
          state.project.projectId,
        );
        assert.ok(initial);
        const oldCanonical = serializeScheduleInputV1(initial.input),
          oldHash = hash(oldCanonical);
        const projectBefore = await db`SELECT * FROM projects WHERE id=${state.project.projectId}`;
        const app = buildApp({
          database: db,
          scheduleRunner: new ProcessScheduleRunner({ binaryPath }),
        });
        try {
          const run = () =>
            app.inject({
              method: "POST",
              url: `${projectUrl}/schedule/run`,
              headers: state.headers,
              payload: { expectedRevision: initial.revision },
            });
          const oldRun = await run();
          assert.equal(oldRun.statusCode, 200, oldRun.body);
          assert.equal(oldRun.json().calculation.inputHashSha256, oldHash);
          const oldRows =
            await db`SELECT * FROM schedule_calculations WHERE project_id=${state.project.projectId} AND input_hash_sha256=${oldHash}`;
          assert.equal(oldRows.length, 1);
          const oldRow = oldRows[0];
          assert.ok(oldRow);
          assert.equal(oldRow.input_canonical, oldCanonical);
          const oldAudits =
            await db`SELECT * FROM audit_events WHERE id=${String(oldRow.audit_event_id)}`;
          assert.equal(oldAudits.length, 1);
          await db`UPDATE project_schedule_settings SET planned_start='2026-10-05T08:00:00.123Z',data_date='2026-10-05T08:00:00.456Z',required_finish='2026-10-07T17:00:00.789Z' WHERE project_id=${state.project.projectId}`;
          const corrected = await new ProjectRepository(db).plannerSnapshot(
            state.context,
            state.project.projectId,
          );
          assert.ok(corrected);
          assert.equal(corrected.revision, initial.revision);
          assert.equal(corrected.input.project.plannedStart, "2026-10-05T08:00:00.123Z");
          assert.equal(corrected.input.project.dataDate, "2026-10-05T08:00:00.456Z");
          assert.equal(corrected.input.project.requiredFinish, "2026-10-07T17:00:00.789Z");
          const correctedCanonical = serializeScheduleInputV1(corrected.input),
            correctedHash = hash(correctedCanonical);
          assert.notEqual(correctedHash, oldHash);
          const current = await app.inject({
            method: "GET",
            url: `${projectUrl}/schedule/result`,
            headers: state.headers,
          });
          assert.equal(current.statusCode, 200, current.body);
          assert.deepEqual(current.json(), {
            revision: initial.revision,
            result: null,
            calculation: null,
          });
          const fresh = await run();
          assert.equal(fresh.statusCode, 200, fresh.body);
          assert.equal(fresh.json().calculation.inputHashSha256, correctedHash);
          assert.equal(fresh.json().calculation.projectRevision, initial.revision);
          assert.notEqual(
            fresh.json().calculation.calculationId,
            oldRun.json().calculation.calculationId,
          );
          const retained =
            await db`SELECT input_canonical,input_hash_sha256 FROM schedule_calculations WHERE project_id=${state.project.projectId} ORDER BY input_hash_sha256`;
          assert.equal(retained.length, 2);
          assert.ok(
            retained.some(
              (row) =>
                row.input_hash_sha256 === correctedHash &&
                row.input_canonical === correctedCanonical,
            ),
          );
          assert.deepEqual(
            await db`SELECT * FROM schedule_calculations WHERE project_id=${state.project.projectId} AND input_hash_sha256=${oldHash}`,
            oldRows,
          );
          assert.deepEqual(
            await db`SELECT * FROM audit_events WHERE id=${String(oldRow.audit_event_id)}`,
            oldAudits,
          );
          assert.deepEqual(
            await db`SELECT * FROM projects WHERE id=${state.project.projectId}`,
            projectBefore,
          );
          const after = await new ProjectRepository(db).plannerSnapshot(
            state.context,
            state.project.projectId,
          );
          assert.deepEqual(after, corrected);
        } finally {
          await app.close();
        }
      },
    );

    await t.test(
      "repeated plans use one materialized wall-clock stamp for exact TTL and session caps",
      async () => {
        const state = await fixture(db),
          statements: string[] = [];
        const observed = new Proxy(db, {
          get(target, property, receiver) {
            if (property !== "begin") return Reflect.get(target, property, receiver);
            return async (callback: (sql: DatabaseExecutor) => Promise<unknown>) =>
              target.begin(async (sql) => {
                const observedSql = new Proxy(sql, {
                  async apply(query, thisArg, args) {
                    const statement = Array.isArray(args[0]) ? args[0].join(" ") : "";
                    if (/WITH stamp AS MATERIALIZED/.test(statement)) statements.push(statement);
                    return Reflect.apply(query, thisArg, args);
                  },
                });
                return callback(observedSql);
              });
          },
        });
        const repository = new ConfigurationRepository(observed);
        const short = await issueSession(
          db,
          state.userId,
          `${state.userId}@example.test`,
          null,
          undefined,
          120,
        );
        for (const session of [state.session, short])
          for (let i = 0; i < 12; i++) {
            const response = await repository.plan(
              state.context,
              state.project.projectId,
              session.principal,
              {
                planId: randomUUID(),
                expectedRevision: state.snapshot.revision,
                configuration: state.configuration,
              },
            );
            assert.ok(response.plan);
            const plan = response.plan,
              created = Date.parse(plan.createdAt),
              expires = Date.parse(plan.expiresAt);
            assert.equal(
              expires,
              Math.min(created + 15 * 60 * 1000, session.principal.expiresAt.getTime()),
            );
            assert.ok(expires > created && expires - created <= 15 * 60 * 1000);
            if (session === state.session) assert.equal(expires - created, 15 * 60 * 1000);
            else assert.equal(expires, short.principal.expiresAt.getTime());
            const stored = (
              await db`SELECT created_at,expires_at FROM project_configuration_plans WHERE id=${plan.planId}`
            )[0];
            assert.ok(stored);
            assert.equal(Date.parse(instant(stored.created_at)), created);
            assert.equal(Date.parse(instant(stored.expires_at)), expires);
            await repository.cancel(
              state.context,
              state.project.projectId,
              session.principal,
              plan.planId,
              { reviewedDigest: plan.reviewedDigest },
            );
          }
        assert.equal(statements.length, 24);
        for (const statement of statements) {
          assert.equal((statement.match(/clock_timestamp\s*\(/g) ?? []).length, 1);
          assert.match(statement, /stamp\.created_at\s*\+\s*interval '15 minutes'/);
          assert.match(statement, /least\(stamp\.created_at/);
        }
      },
    );

    await t.test(
      "EXPLAIN shows bounded maintenance and long-history quota index conditions with captured cutoffs",
      async () => {
        const state = await fixture(db),
          plan = await createPlan(db, state, true),
          repository = new ConfigurationRepository(db);
        const identities =
          await db`INSERT INTO audit_events(id,organization_id,actor_type,actor_id,action,resource_type,resource_id,source,payload)
        SELECT audit_id,${state.organizationId},'user',${state.userId},'configuration.plan','project',${state.project.projectId},'api',jsonb_build_object('planId',plan_id::text,'sessionId',${state.session.principal.sessionId}::text,'reviewedDigest',${plan.reviewedDigest}::text)
        FROM(SELECT gen_random_uuid() AS audit_id,gen_random_uuid() AS plan_id FROM generate_series(1,2048)) identities
        RETURNING id,payload->>'planId' AS plan_id`;
        await db`INSERT INTO project_configuration_plans(organization_id,project_id,id,actor_id,session_id,protocol_version,configuration_version,normalization_version,base_revision,base_input_hash_sha256,desired_input_hash_sha256,request_hash_sha256,reviewed_digest,no_op,created_at,expires_at,artifacts_keep_until,plan_audit_id)
        SELECT p.organization_id,p.project_id,i.plan_id,actor_id,session_id,protocol_version,configuration_version,normalization_version,base_revision,base_input_hash_sha256,desired_input_hash_sha256,request_hash_sha256,reviewed_digest,no_op,created_at-interval '2 days',expires_at-interval '2 days',artifacts_keep_until-interval '2 days',i.id
        FROM project_configuration_plans p CROSS JOIN jsonb_to_recordset(${JSON.stringify(identities)}::text::jsonb) AS i(id uuid,plan_id uuid) WHERE p.id=${plan.planId}`;
        await repository.cancel(
          state.context,
          state.project.projectId,
          state.session.principal,
          plan.planId,
          { reviewedDigest: plan.reviewedDigest },
        );
        await expireArtifacts(db, [plan.planId]);
        await db.unsafe("ANALYZE project_configuration_artifacts");
        await db.unsafe("ANALYZE project_configuration_plans");
        const cutoff = new Date(instant((await db`SELECT clock_timestamp() AS cutoff`)[0]?.cutoff)),
          hourly = new Date(cutoff.getTime() - 3600000).toISOString();
        for (const bound of ["1970-01-01T00:00:00.000Z", cutoff.toISOString()]) {
          const rows =
            await db`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT organization_id,project_id,plan_id FROM project_configuration_artifacts WHERE keep_until<=${bound}::timestamptz ORDER BY keep_until,organization_id,project_id,plan_id FOR UPDATE SKIP LOCKED LIMIT 64`;
          const nodes = explainNodes(rows[0]?.["QUERY PLAN"]),
            index = nodes.find(
              (node) => node["Index Name"] === "project_configuration_artifact_retention_idx",
            );
          assert.ok(index, JSON.stringify(rows));
          assert.match(String(index["Index Cond"]), /keep_until <=/);
          assert.equal(String(index["Index Cond"]).includes("clock_timestamp"), false);
          const limit = nodes.find((node) => node["Node Type"] === "Limit");
          assert.ok(limit);
          assert.equal(Number(limit["Actual Rows"]), bound.startsWith("1970") ? 0 : 1);
        }
        const actor =
          await db`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT 1 FROM project_configuration_plans WHERE organization_id=${state.organizationId} AND project_id=${state.project.projectId} AND actor_id=${state.userId} AND created_at>${hourly}::timestamptz LIMIT 60`;
        const actorIndex = explainNodes(actor[0]?.["QUERY PLAN"]).find(
          (node) => node["Index Name"] === "project_configuration_actor_created_idx",
        );
        assert.ok(actorIndex, JSON.stringify(actor));
        assert.match(String(actorIndex["Index Cond"]), /created_at >/);
        assert.match(String(actorIndex["Index Cond"]), /actor_id =/);
        const recent =
          await db`SELECT id,created_at FROM project_configuration_plans WHERE organization_id=${state.organizationId} AND project_id=${state.project.projectId} AND actor_id=${state.userId} AND created_at>${hourly}::timestamptz LIMIT 60`;
        assert.equal(
          recent.length,
          0,
          "Original identity and all2048 archive fixtures must be outside the live hourly range",
        );
        const actorLimit = explainNodes(actor[0]?.["QUERY PLAN"]).find(
          (node) => node["Node Type"] === "Limit",
        );
        assert.ok(actorLimit);
        assert.equal(Number(actorLimit["Actual Rows"]), recent.length);
        // A Bitmap Index Scan may count the dead original recent entry after
        // UPDATE aged its heap row. ANALYZE does not VACUUM that index entry.
        // Bound candidates independently of the2048 archived live identities.
        assert.ok(Number(actorIndex["Actual Rows"]) <= recent.length + 1, JSON.stringify(actor));
        const project =
          await db`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT 1 FROM project_configuration_plans p WHERE organization_id=${state.organizationId} AND project_id=${state.project.projectId} AND created_at>${hourly}::timestamptz AND expires_at>${cutoff.toISOString()}::timestamptz AND NOT EXISTS(SELECT 1 FROM project_configuration_outcomes o WHERE o.organization_id=p.organization_id AND o.project_id=p.project_id AND o.plan_id=p.id) LIMIT 32`;
        const projectNodes = explainNodes(project[0]?.["QUERY PLAN"]),
          projectIndex = projectNodes.find((node) =>
            [
              "project_configuration_project_created_idx",
              "project_configuration_project_pending_idx",
            ].includes(String(node["Index Name"])),
          );
        assert.ok(projectIndex, JSON.stringify(project));
        assert.match(
          String(projectIndex["Index Cond"]),
          projectIndex["Index Name"] === "project_configuration_project_created_idx"
            ? /created_at >/
            : /expires_at >/,
        );
        assert.match(String(projectIndex["Index Cond"]), /organization_id =/);
        assert.match(String(projectIndex["Index Cond"]), /project_id =/);
        assert.equal(String(projectIndex["Index Cond"]).includes("clock_timestamp"), false);
        const liveProject =
          await db`SELECT id FROM project_configuration_plans p WHERE organization_id=${state.organizationId} AND project_id=${state.project.projectId} AND created_at>${hourly}::timestamptz AND expires_at>${cutoff.toISOString()}::timestamptz AND NOT EXISTS(SELECT 1 FROM project_configuration_outcomes o WHERE o.organization_id=p.organization_id AND o.project_id=p.project_id AND o.plan_id=p.id) LIMIT 32`;
        assert.equal(liveProject.length, 0);
        const projectLimit = projectNodes.find((node) => node["Node Type"] === "Limit");
        assert.ok(projectLimit);
        assert.equal(Number(projectLimit["Actual Rows"]), liveProject.length);
        assert.ok(
          Number(projectIndex["Actual Rows"]) <= liveProject.length + 1,
          JSON.stringify(project),
        );
        const budgetFunction = String(
          (
            await db`SELECT pg_get_functiondef('engineo_configuration_artifact_budget()'::regprocedure) AS definition`
          )[0]?.definition,
        );
        assert.equal(
          /\bSUM\s*\(/i.test(budgetFunction),
          false,
          "Admission/release must not scan retained-history totals",
        );
        assert.equal(await repository.maintainArtifacts(), 1);
      },
    );
  } finally {
    await db.end({ timeout: 5 });
  }
});
