import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  type ProjectConfigurationPlanV1,
  type ProjectConfigurationV1,
  serializeScheduleInputV1,
  validateProjectConfigurationV1,
} from "@engineo/contracts";
import { createBrowserDatabase } from "../../../scripts/browser-test-database.mjs";
import { createDatabase, type Database, type DatabaseExecutor } from "./db/client.js";
import { databaseConfigFromEnv } from "./db/config.js";
import { migrateDatabase } from "./db/migrate.js";
import { tenantContext } from "./db/tenant-context.js";
import {
  ConfigurationError,
  ConfigurationRepository,
} from "./repositories/configuration-repository.js";
import { reconcileConfigurationSchedule } from "./repositories/configuration-reconcile.js";
import { PlannerRepository } from "./repositories/planner-repository.js";
import { ProjectRepository } from "./repositories/project-repository.js";
import { issueSession } from "./security/session.js";

const materialStateConstraint = "configuration_outcome_material_state";
const migrationName = "0006_configuration_outcome_material_state.sql";
const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const databaseTest = {
  skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not configured",
  timeout: 180_000,
};

async function fixture(db: Database) {
  const organizationId = randomUUID(),
    userId = randomUUID();
  await db`INSERT INTO organizations(id,slug,name) VALUES(${organizationId},${organizationId},'Configuration invariant')`;
  await db`INSERT INTO users(id,email) VALUES(${userId},${`${userId}@example.test`})`;
  await db`INSERT INTO organization_memberships(organization_id,user_id,role) VALUES(${organizationId},${userId},'owner')`;
  const context = tenantContext(organizationId, userId, randomUUID());
  const planner = new PlannerRepository(db);
  const project = await planner.createProject(context, {
    name: "Invariant project",
    code: null,
    description: null,
    plannedStart: "2026-10-05T08:00:00Z",
    timeZone: "UTC",
  });
  let revision = project.revision;
  const activityIds: string[] = [];
  for (let index = 0; index < 3; index++) {
    const activity = await planner.createActivity(context, project.projectId, revision, {
      name: `Invariant activity ${index}`,
      wbsId: project.rootWbsId,
      calendarId: project.calendarId,
      kind: "TASK",
      durationMinutes: 480,
      constraints: [],
      sortOrder: index,
    });
    activityIds.push(activity.id);
    revision = activity.revision;
  }
  const first = activityIds[0],
    second = activityIds[1];
  assert.ok(first && second);
  await planner.createRelationship(context, project.projectId, revision, {
    predecessorId: first,
    successorId: second,
    type: "FS",
    lagMinutes: 0,
  });
  const session = await issueSession(db, userId, `${userId}@example.test`, null, undefined);
  const snapshot = await new ProjectRepository(db).plannerSnapshot(context, project.projectId);
  assert.ok(snapshot);
  const configuration: ProjectConfigurationV1 = {
    schemaVersion: 1,
    kind: "engineo-project-configuration",
    scope: "schedule",
    input: structuredClone(snapshot.input),
  };
  return {
    organizationId,
    userId,
    context,
    project,
    activityIds,
    session,
    snapshot,
    configuration,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function plan(
  db: Database,
  state: Fixture,
  configuration = structuredClone(state.configuration),
  expectedRevision = state.snapshot.revision,
) {
  const response = await new ConfigurationRepository(db).plan(
    state.context,
    state.project.projectId,
    state.session.principal,
    { planId: randomUUID(), expectedRevision, configuration },
  );
  assert.ok(response.plan);
  return response.plan;
}
function apply(
  repository: ConfigurationRepository,
  state: Fixture,
  review: ProjectConfigurationPlanV1,
) {
  return repository.apply(
    state.context,
    state.project.projectId,
    state.session.principal,
    review.planId,
    {
      expectedRevision: review.baseRevision,
      reviewedDigest: review.reviewedDigest,
    },
  );
}
async function activityRows(db: DatabaseExecutor, state: Fixture) {
  return await db`SELECT id,sort_order::text,created_at,updated_at FROM activities
    WHERE organization_id=${state.organizationId} AND project_id=${state.project.projectId}
    ORDER BY sort_order,id`;
}
async function edgeRows(db: DatabaseExecutor, state: Fixture) {
  return await db`SELECT * FROM relationships WHERE organization_id=${state.organizationId}
    AND project_id=${state.project.projectId} ORDER BY id`;
}
async function durableState(db: DatabaseExecutor, state: Fixture) {
  return {
    projects: await db`SELECT * FROM projects WHERE id=${state.project.projectId}`,
    activities: await activityRows(db, state),
    calendars:
      await db`SELECT * FROM calendars WHERE project_id=${state.project.projectId} ORDER BY id`,
    wbs: await db`SELECT * FROM wbs_nodes WHERE project_id=${state.project.projectId} ORDER BY id`,
    settings:
      await db`SELECT * FROM project_schedule_settings WHERE project_id=${state.project.projectId}`,
    relationships: await edgeRows(db, state),
    plans:
      await db`SELECT * FROM project_configuration_plans WHERE project_id=${state.project.projectId} ORDER BY id`,
    artifacts:
      await db`SELECT * FROM project_configuration_artifacts WHERE project_id=${state.project.projectId} ORDER BY plan_id`,
    outcomes:
      await db`SELECT * FROM project_configuration_outcomes WHERE project_id=${state.project.projectId} ORDER BY plan_id`,
    audits:
      await db`SELECT * FROM audit_events WHERE resource_id=${state.project.projectId} ORDER BY id`,
    projectBudget:
      await db`SELECT * FROM project_configuration_project_storage WHERE project_id=${state.project.projectId}`,
    globalBudget: await db`SELECT * FROM project_configuration_storage_budget`,
  };
}
function constraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23514" &&
    "constraint_name" in error &&
    error.constraint_name === materialStateConstraint
  );
}
function idConflict(error: unknown): boolean {
  return (
    error instanceof ConfigurationError &&
    error.code === "configuration_id_conflict" &&
    error.statusCode === 422
  );
}

test(
  "configuration material-state CHECK rejects SQL UNKNOWN independently of triggers",
  databaseTest,
  async (t) => {
    const db = createDatabase();
    await migrateDatabase(db);
    try {
      for (const outcome of ["applied", "no_op", "cancelled"] as const) {
        const organizationId = randomUUID(),
          projectId = randomUUID(),
          planId = randomUUID(),
          editId = randomUUID();
        const baseHash = "a".repeat(64),
          desiredHash = outcome === "applied" ? "b".repeat(64) : baseHash;
        const validRevision = outcome === "cancelled" ? null : outcome === "applied" ? 3 : 2;
        const validHash = outcome === "cancelled" ? null : desiredHash;
        const validEdit = outcome === "applied" ? editId : null;
        const cases =
          outcome === "cancelled"
            ? [
                { name: "revision", revision: 2, inputHash: null, edit: null },
                { name: "hash", revision: null, inputHash: baseHash, edit: null },
                { name: "edit", revision: null, inputHash: null, edit: editId },
              ]
            : [
                { name: "null revision", revision: null, inputHash: validHash, edit: validEdit },
                { name: "null hash", revision: validRevision, inputHash: null, edit: validEdit },
                { name: "both null", revision: null, inputHash: null, edit: validEdit },
                { name: "wrong revision", revision: 4, inputHash: validHash, edit: validEdit },
              ];
        for (const candidate of [
          { name: "valid", revision: validRevision, inputHash: validHash, edit: validEdit },
          ...cases,
        ]) {
          await t.test(`${outcome}: ${candidate.name}`, async () => {
            // LIKE copies actual production CHECKs and NOT NULLs, but no triggers
            // or foreign keys. No production protection is disabled or changed.
            await db.begin(async (sql) => {
              await sql`CREATE TEMP TABLE configuration_outcome_check_probe
              (LIKE project_configuration_outcomes INCLUDING CONSTRAINTS INCLUDING DEFAULTS) ON COMMIT DROP`;
              const receiptJson = JSON.stringify({ organizationId, projectId, planId, outcome });
              const insertion = (
                executor: DatabaseExecutor,
              ) => executor`INSERT INTO configuration_outcome_check_probe
              (organization_id,project_id,plan_id,outcome,previous_revision,committed_revision,
               base_input_hash_sha256,committed_input_hash_sha256,reviewed_digest,provenance_audit_id,
               schedule_edit_audit_id,receipt_json,receipt_hash_sha256)
              VALUES(${organizationId},${projectId},${planId},${outcome},2,${candidate.revision},
                ${baseHash},${candidate.inputHash},${baseHash},${randomUUID()},${candidate.edit},
                ${receiptJson},${hash(receiptJson)})`;
              if (candidate.name === "valid") {
                await insertion(sql);
                assert.equal(
                  (await sql`SELECT * FROM configuration_outcome_check_probe`).length,
                  1,
                );
              } else {
                await assert.rejects(
                  sql.savepoint(async (savepoint) => {
                    await insertion(savepoint);
                  }),
                  (error: unknown) => {
                    // Some already-invalid fields may fail an older CHECK first;
                    // the NULL revision/no-op hash cases specifically need 0006.
                    return (
                      typeof error === "object" &&
                      error !== null &&
                      "code" in error &&
                      error.code === "23514" &&
                      (candidate.name === "null revision" ||
                      (outcome === "no_op" && candidate.name === "null hash")
                        ? constraintViolation(error)
                        : true)
                    );
                  },
                );
                assert.equal(
                  (await sql`SELECT * FROM configuration_outcome_check_probe`).length,
                  0,
                );
              }
            });
          });
        }
      }
    } finally {
      await db.end({ timeout: 5 });
    }
  },
);

test(
  "configuration NULL material outcomes roll back real apply with production triggers enabled",
  databaseTest,
  async (t) => {
    const db = createDatabase();
    await migrateDatabase(db);
    try {
      for (const noOp of [false, true]) {
        for (const field of noOp
          ? ["committed_revision", "committed_input_hash_sha256"]
          : ["committed_revision"]) {
          await t.test(
            `${noOp ? "no-op" : "applied"} ${field} is required and retry remains valid`,
            async () => {
              const state = await fixture(db),
                configuration = structuredClone(state.configuration);
              if (!noOp) configuration.input.project.name = "Material invariant change";
              const repository = new ConfigurationRepository(db),
                review = await plan(db, state, configuration),
                before = await durableState(db, state),
                triggerName = `zz_configuration_null_${randomUUID().replaceAll("-", "")}`;
              await db.unsafe(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN NEW.${field} := NULL; RETURN NEW; END; $$`);
              try {
                await db.unsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON project_configuration_outcomes
              FOR EACH ROW WHEN (NEW.project_id='${state.project.projectId}'::uuid) EXECUTE FUNCTION ${triggerName}()`);
                const guards = await db`SELECT tgname,tgenabled FROM pg_trigger
              WHERE tgrelid='project_configuration_outcomes'::regclass AND NOT tgisinternal ORDER BY tgname`;
                for (const guard of guards) assert.equal(guard.tgenabled, "O");
                assert.ok(
                  guards.some((guard) => guard.tgname === "configuration_outcome_plan_bound"),
                );
                await assert.rejects(apply(repository, state, review), constraintViolation);
                assert.deepEqual(
                  await durableState(db, state),
                  before,
                  "Failed terminal insertion must roll back material writes, revision, audits, receipt and counters",
                );
              } finally {
                await db.unsafe(
                  `DROP TRIGGER IF EXISTS ${triggerName} ON project_configuration_outcomes`,
                );
                await db.unsafe(`DROP FUNCTION ${triggerName}()`);
              }
              const receipt = await apply(repository, state, review);
              assert.equal(receipt.outcome, noOp ? "no_op" : "applied");
              assert.equal(receipt.committedRevision, review.baseRevision + (noOp ? 0 : 1));
              assert.deepEqual(await apply(repository, state, review), receipt);
            },
          );
        }
      }
      await t.test("valid cancellation preserves null material fields and replay", async () => {
        const state = await fixture(db),
          review = await plan(db, state),
          repository = new ConfigurationRepository(db);
        const receipt = await repository.cancel(
          state.context,
          state.project.projectId,
          state.session.principal,
          review.planId,
          { reviewedDigest: review.reviewedDigest },
        );
        assert.equal(receipt.outcome, "cancelled");
        assert.equal(receipt.committedRevision, null);
        assert.equal(receipt.committedInputHashSha256, null);
        assert.equal(receipt.scheduleEditAuditId, null);
        assert.deepEqual(
          await repository.cancel(
            state.context,
            state.project.projectId,
            state.session.principal,
            review.planId,
            { reviewedDigest: review.reviewedDigest },
          ),
          receipt,
        );
        assert.deepEqual(
          await new ProjectRepository(db).plannerSnapshot(state.context, state.project.projectId),
          state.snapshot,
        );
      });
    } finally {
      await db.end({ timeout: 5 });
    }
  },
);

test(
  "forward material-state migration preserves populated 0005 historical receipts and checksums",
  databaseTest,
  async () => {
    const config = databaseConfigFromEnv();
    // The shared disposable-database guard pins the loopback server and owns only
    // its random database. The configured source is never migrated or reset here.
    const disposable = await createBrowserDatabase(config.url, (url) =>
      createDatabase({ ...config, url }),
    );
    const db = createDatabase({ ...config, url: disposable.env.DATABASE_URL });
    const legacyDirectory = await mkdtemp(join(tmpdir(), "engineo-configuration-migrations-"));
    try {
      for (const name of (await readdir(migrationsDirectory)).filter(
        (name) => name.endsWith(".sql") && name < migrationName,
      )) {
        await writeFile(
          join(legacyDirectory, name),
          await readFile(join(migrationsDirectory, name)),
        );
      }
      await migrateDatabase(db, legacyDirectory);
      const repository = new ConfigurationRepository(db);
      const history = [];
      for (const outcome of ["applied", "no_op", "cancelled"] as const) {
        const state = await fixture(db),
          configuration = structuredClone(state.configuration);
        if (outcome === "applied") configuration.input.project.name = "Historical applied project";
        const review = await plan(db, state, configuration);
        const receipt =
          outcome === "cancelled"
            ? await repository.cancel(
                state.context,
                state.project.projectId,
                state.session.principal,
                review.planId,
                { reviewedDigest: review.reviewedDigest },
              )
            : await apply(repository, state, review);
        assert.equal(receipt.outcome, outcome);
        history.push({ state, review, receipt });
      }
      const before = await Promise.all(history.map(({ state }) => durableState(db, state)));
      const oldMigrations = await db`SELECT * FROM engineo_schema_migrations ORDER BY name`;
      assert.equal(oldMigrations.length, 5);
      const migrationSql = await readFile(join(migrationsDirectory, migrationName), "utf8");
      // A failing statement after the real migration proves its ALTER rolls back
      // together with the migration ledger, without editing an applied SQL file.
      const failingDirectory = await mkdtemp(
        join(tmpdir(), "engineo-configuration-failed-migration-"),
      );
      try {
        await writeFile(join(failingDirectory, migrationName), `${migrationSql}\nSELECT 1 / 0;\n`);
        await assert.rejects(migrateDatabase(db, failingDirectory));
        assert.deepEqual(
          await db`SELECT * FROM engineo_schema_migrations ORDER BY name`,
          oldMigrations,
        );
        assert.equal(
          (
            await db`SELECT conname FROM pg_constraint WHERE conrelid='project_configuration_outcomes'::regclass AND conname=${materialStateConstraint}`
          ).length,
          0,
        );
      } finally {
        await rm(failingDirectory, { recursive: true, force: true });
      }
      await migrateDatabase(db);
      const constraints = await db`SELECT convalidated FROM pg_constraint
      WHERE conrelid='project_configuration_outcomes'::regclass AND conname=${materialStateConstraint}`;
      assert.equal(constraints[0]?.convalidated, true);
      assert.deepEqual(
        await Promise.all(history.map(({ state }) => durableState(db, state))),
        before,
      );
      const migrations = await db`SELECT * FROM engineo_schema_migrations ORDER BY name`;
      assert.deepEqual(migrations.slice(0, 5), [...oldMigrations]);
      assert.equal(migrations[5]?.name, migrationName);
      assert.equal(migrations[5]?.checksum_sha256, hash(migrationSql));
      await migrateDatabase(db);
      assert.deepEqual(await db`SELECT * FROM engineo_schema_migrations ORDER BY name`, migrations);
      for (const { state, review, receipt } of history) {
        // A historical receipt remains replayable even if later current storage
        // is unsupported. No historical outcome/artifact/provenance is rewritten.
        await db`UPDATE project_schedule_settings SET data_date='2026-10-05T08:00:00.000001Z' WHERE project_id=${state.project.projectId}`;
        assert.deepEqual(
          await repository.receipt(
            state.context,
            state.project.projectId,
            state.session.principal,
            review.planId,
          ),
          receipt,
        );
        if (receipt.outcome === "cancelled") {
          assert.deepEqual(
            await repository.cancel(
              state.context,
              state.project.projectId,
              state.session.principal,
              review.planId,
              { reviewedDigest: review.reviewedDigest },
            ),
            receipt,
          );
        } else {
          assert.deepEqual(await apply(repository, state, review), receipt);
        }
      }
    } finally {
      await db.end({ timeout: 5 });
      await disposable.dispose();
      await rm(legacyDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "configuration append order is exact above JS safe integers and at PostgreSQL BIGINT capacity",
  databaseTest,
  async (t) => {
    const db = createDatabase();
    await migrateDatabase(db);
    try {
      for (const maximum of [9007199254740999n, 9223372036854775805n]) {
        await t.test(`native reconcile sorts reversed UUIDs exactly after ${maximum}`, async () => {
          const state = await fixture(db),
            first = state.activityIds[0],
            second = state.activityIds[1],
            removed = state.activityIds[2];
          assert.ok(first && second && removed);
          for (const [id, order] of [
            [first, maximum - 11n],
            [second, maximum - 10n],
            [removed, maximum],
          ] as const)
            await db`UPDATE activities SET sort_order=${String(order)}::bigint WHERE id=${id}`;
          const configuration = structuredClone(state.configuration),
            template = configuration.input.activities.find((activity) => activity.id === first),
            newIds: string[] = [randomUUID(), randomUUID()].sort();
          assert.ok(template);
          configuration.input.activities = configuration.input.activities.filter(
            (activity) => activity.id !== removed,
          );
          for (const id of newIds)
            configuration.input.activities.push({
              ...structuredClone(template),
              id,
              name: `Native ${id}`,
            });
          const validated = validateProjectConfigurationV1(configuration);
          assert.ok(validated.valid);
          // Repository canonicalization sorts arrays before reconcile. Reverse
          // only this nonsemantic ordering after validation to exercise the SQL
          // ORDER BY independently, with normalized UUIDs and legitimate fields.
          validated.normalizedInput.activities.reverse();
          assert.deepEqual(
            validated.normalizedInput.activities
              .filter((activity) => newIds.includes(activity.id))
              .map((activity) => activity.id),
            [...newIds].reverse(),
          );
          const before = await durableState(db, state),
            rollback = new Error("Rollback native-only append-order probe");
          await assert.rejects(
            db.begin(async (sql) => {
              await sql`SELECT id FROM projects WHERE organization_id=${state.organizationId}
              AND id=${state.project.projectId} FOR UPDATE`;
              await reconcileConfigurationSchedule(
                sql,
                state.context,
                state.project.projectId,
                validated.normalizedInput,
              );
              const after = await activityRows(sql, state);
              assert.deepEqual(
                after
                  .filter((row) => newIds.includes(String(row.id)))
                  .map((row) => ({ id: row.id, sort_order: row.sort_order })),
                newIds.map((id, index) => ({
                  id,
                  sort_order: String(maximum + BigInt(index) + 1n),
                })),
              );
              assert.deepEqual(
                after.filter((row) => !newIds.includes(String(row.id))),
                before.activities.filter((row) => row.id !== removed),
              );
              assert.deepEqual(await edgeRows(sql, state), before.relationships);
              // The caller owns revision/audits. This isolated native SQL probe
              // is rolled back rather than committing an unaudited schedule edit.
              throw rollback;
            }),
            (error: unknown) => error === rollback,
          );
          assert.deepEqual(await durableState(db, state), before);
        });
        await t.test(
          `UUID-sorted append after ${maximum}, including a removed maximum row`,
          async () => {
            const state = await fixture(db),
              repository = new ConfigurationRepository(db);
            const first = state.activityIds[0],
              second = state.activityIds[1],
              removed = state.activityIds[2];
            assert.ok(first && second && removed);
            for (const [id, order] of [
              [first, maximum - 11n],
              [second, maximum - 10n],
              [removed, maximum],
            ] as const) {
              await db`UPDATE activities SET sort_order=${String(order)}::bigint WHERE id=${id}`;
            }
            const before = await activityRows(db, state),
              edges = await edgeRows(db, state),
              configuration = structuredClone(state.configuration);
            configuration.input.activities = configuration.input.activities.filter(
              (activity) => activity.id !== removed,
            );
            const survivor = configuration.input.activities.find(
              (activity) => activity.id === first,
            );
            assert.ok(survivor);
            survivor.name = "Surviving renamed boundary row";
            const newIds: string[] = [randomUUID(), randomUUID()].sort();
            for (const id of [...newIds].reverse())
              configuration.input.activities.unshift({
                ...structuredClone(survivor),
                id,
                name: `New ${id}`,
              });
            const review = await plan(db, state, configuration),
              receipt = await apply(repository, state, review);
            assert.equal(receipt.outcome, "applied");
            const after = await activityRows(db, state);
            assert.deepEqual(
              after
                .filter((row) => newIds.includes(String(row.id)))
                .map((row) => ({ id: row.id, sort_order: row.sort_order })),
              newIds.map((id, index) => ({ id, sort_order: String(maximum + BigInt(index) + 1n) })),
            );
            assert.equal(
              after.some((row) => row.id === removed),
              false,
            );
            for (const id of [first, second]) {
              const original = before.find((row) => row.id === id),
                retained = after.find((row) => row.id === id);
              assert.ok(original && retained);
              assert.equal(retained.sort_order, original.sort_order);
              assert.deepEqual(retained.created_at, original.created_at);
              if (id === second) assert.deepEqual(retained.updated_at, original.updated_at);
            }
            assert.deepEqual(await edgeRows(db, state), edges);
            const snapshot = await new ProjectRepository(db).plannerSnapshot(
              state.context,
              state.project.projectId,
            );
            assert.ok(snapshot);
            assert.equal(snapshot.revision, state.snapshot.revision + 1);
            assert.equal(
              hash(serializeScheduleInputV1(snapshot.input)),
              review.desiredInputHashSha256,
            );
            if (maximum === 9223372036854775805n) {
              assert.equal(after.at(-1)?.sort_order, "9223372036854775807");
              const currentConfiguration: ProjectConfigurationV1 = {
                ...state.configuration,
                input: structuredClone(snapshot.input),
              };
              currentConfiguration.input.activities.reverse();
              const noOpReview = await plan(db, state, currentConfiguration, snapshot.revision),
                nativeBefore = await activityRows(db, state),
                noOpReceipt = await apply(repository, state, noOpReview);
              assert.equal(noOpReceipt.outcome, "no_op");
              assert.equal(noOpReceipt.committedRevision, snapshot.revision);
              assert.deepEqual(await activityRows(db, state), nativeBefore);
              assert.deepEqual(await edgeRows(db, state), edges);
              assert.deepEqual(await apply(repository, state, noOpReview), noOpReceipt);
              const overflow = structuredClone(currentConfiguration),
                newActivity = overflow.input.activities[0];
              assert.ok(newActivity);
              overflow.input.activities.push({
                ...structuredClone(newActivity),
                id: randomUUID(),
                name: "One beyond BIGINT",
              });
              const durableBefore = await durableState(db, state);
              await assert.rejects(plan(db, state, overflow, snapshot.revision), idConflict);
              assert.deepEqual(
                await durableState(db, state),
                durableBefore,
                "Overflow admission must retain no plan, allocation, schedule write, revision or audit",
              );
            }
          },
        );
      }
      await t.test(
        "one-overflow after review rejects apply without partial writes or audits",
        async () => {
          const state = await fixture(db),
            repository = new ConfigurationRepository(db),
            configuration = structuredClone(state.configuration),
            template = configuration.input.activities[0],
            maximumId = state.activityIds[2];
          assert.ok(template && maximumId);
          await db`UPDATE activities SET sort_order='9223372036854775806'::bigint WHERE id=${maximumId}`;
          configuration.input.activities.push({
            ...structuredClone(template),
            id: randomUUID(),
            name: "Reviewed final slot",
          });
          const review = await plan(db, state, configuration);
          // GUI ordering is outside canonical input/revision. Capacity can change
          // independently after review, so the apply-time guard must recheck it.
          await db`UPDATE activities SET sort_order='9223372036854775807'::bigint WHERE id=${maximumId}`;
          const before = await durableState(db, state);
          await assert.rejects(apply(repository, state, review), idConflict);
          assert.deepEqual(await durableState(db, state), before);
          assert.deepEqual(
            await new ProjectRepository(db).plannerSnapshot(state.context, state.project.projectId),
            state.snapshot,
          );
          const pending = await repository.getPlan(
            state.context,
            state.project.projectId,
            state.session.principal,
            review.planId,
          );
          assert.equal(pending.status, "pending");
          assert.equal(pending.receipt, null);
        },
      );
    } finally {
      await db.end({ timeout: 5 });
    }
  },
);
