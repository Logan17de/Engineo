import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type EngineProjectInputV1,
  type EngineScheduleResultV1,
  type ProjectConfigurationPlanReadV1,
  type ProjectConfigurationPlanV1,
  type ProjectConfigurationReadV1,
  type ProjectConfigurationReceiptV1,
  type ProjectConfigurationV1,
  type ScheduleCalculationMetadataV1,
  serializeProjectConfigurationReviewV1,
  serializeScheduleInputV1,
  serializeScheduleResultV1,
  validateProjectConfigurationPlanReadV1,
  validateProjectConfigurationReadV1,
  validateProjectConfigurationReceiptV1,
} from "@engineo/contracts";
import { type BrowserContext, expect, type Page, type TestInfo } from "@playwright/test";
import { createDatabase } from "../apps/api/src/db/client.js";
import { migrateDatabase } from "../apps/api/src/db/migrate.js";
import { tenantContext } from "../apps/api/src/db/tenant-context.js";
import { PlannerRepository } from "../apps/api/src/repositories/planner-repository.js";
import { ProjectRepository } from "../apps/api/src/repositories/project-repository.js";
import { ProcessScheduleRunner } from "../apps/api/src/scheduler/runner.js";
import { hashPassword } from "../apps/api/src/security/password.js";
import { issueSession, revokeSession } from "../apps/api/src/security/session.js";
import { assertBrowserDatabase } from "../scripts/browser-test-database.mjs";
import { test as browserTest } from "./fixtures.mjs";

// The browser wrapper owns the uniquely named, server-pinned disposable database.
// No real account, browser credential extraction, identity provisioning or app.inject.
const db = createDatabase();
const cliEntry = fileURLToPath(new URL("../packages/cli/dist/main.js", import.meta.url));
const apiOrigin = "http://127.0.0.1:4000";
const appOrigin = "http://127.0.0.1:3100";
const password = "disposable-loopback-cli-gui-fixture";
let passwordHash = "";
let engineVersion = "";
let nativeRunner: ProcessScheduleRunner;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
type Account = { id: string; email: string };
type Fixture = {
  owner: Account;
  viewer: Account;
  foreign: Account;
  organization: string;
  project: string;
  rootWbs: string;
  firstActivity: string;
  revision: number;
};
type Auth = { file: string; actorId: string; sessionId: string };
type Envelope = {
  schemaVersion: 1;
  kind: "engineo-cli-output";
  command: string;
  ok: boolean;
  exitCode: number;
  data?: unknown;
  error?: { category: string; code: string; message: string; details?: unknown };
};
type Calculation = {
  revision: number;
  result: EngineScheduleResultV1 | null;
  calculation: ScheduleCalculationMetadataV1 | null;
};
type Review = { file: string; plan: ProjectConfigurationPlanV1 };
type PrivateCli = {
  auth: (account: Account) => Promise<Auth>;
  run: (command: string, data: Fixture, auth: Auth, extra?: string[]) => Promise<Envelope>;
  offline: (file: string) => Promise<Envelope>;
  safe: (text: string) => void;
  commands: string[];
};
const projectPath = (data: Fixture) =>
  `/api/organizations/${data.organization}/projects/${data.project}`;

function success<T>(envelope: Envelope): T {
  expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
  expect(envelope.exitCode).toBe(0);
  return envelope.data as T;
}
function primaryPlanPayload(envelope: Envelope): ProjectConfigurationPlanReadV1 {
  const value = success<ProjectConfigurationPlanReadV1 & { recovered: boolean }>(envelope);
  expect(Object.hasOwn(value, "recovered")).toBe(true);
  const { recovered, ...payload } = value;
  // Recovery belongs to the CLI envelope, not the strict API wrapper. Removing
  // only this explicitly checked field leaves every unexpected API key visible
  // to the unchanged contract validator.
  expect(recovered).toBe(false);
  expect(validateProjectConfigurationPlanReadV1(payload)).toBe(true);
  return payload;
}
function denied(envelope: Envelope, category: string, code: string, exitCode: number) {
  expect(envelope.ok).toBe(false);
  expect(envelope.error?.category).toBe(category);
  expect(envelope.error?.code).toBe(code);
  expect(envelope.exitCode).toBe(exitCode);
}
function displayInstant(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

const test = browserTest.extend<{ privateCli: PrivateCli }>({
  privateCli: async ({ isolatedLoginQuota }, use) => {
    void isolatedLoginQuota;
    // Credentials stay outside the repository and all retained evidence. Every
    // descriptor is an explicitly issued synthetic session for this test only.
    const directory = await mkdtemp(join(tmpdir(), "engineo-cli-gui-auth-"));
    const sessions: Auth[] = [];
    const secrets = [password];
    const commands: string[] = [];
    const safe = (text: string) => {
      for (const secret of secrets)
        expect(text.includes(secret), "Disposable authentication material must never leak").toBe(
          false,
        );
      expect(/engineo_session=|engineo_csrf=|"sessionToken"|"csrfToken"/.test(text)).toBe(false);
    };
    async function launch(argv: string[]): Promise<Envelope> {
      commands.push(argv[0] ?? "unknown");
      const child = spawn(process.execPath, [cliEntry, ...argv], {
        stdio: ["ignore", "pipe", "pipe"],
        // No ambient account credentials, password, database URL or tokens.
        env: { NODE_ENV: "test" },
      });
      return await new Promise<Envelope>((resolve, reject) => {
        let stdout = "",
          stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("Built CLI subprocess exceeded its bounded test deadline"));
        }, 45_000);
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (Buffer.byteLength(stdout) > 32 * 1024 * 1024) child.kill("SIGKILL");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
          if (Buffer.byteLength(stderr) > 8192) child.kill("SIGKILL");
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (exitCode, signal) => {
          clearTimeout(timer);
          try {
            safe(stdout);
            safe(stderr);
            expect(signal).toBeNull();
            expect(stderr).toBe("");
            expect(stdout.endsWith("\n")).toBe(true);
            expect(stdout.trim().split("\n")).toHaveLength(1);
            const value = JSON.parse(stdout) as Envelope;
            expect(value.schemaVersion).toBe(1);
            expect(value.kind).toBe("engineo-cli-output");
            expect(value.command).toBe(argv[0]);
            expect(typeof value.ok).toBe("boolean");
            expect(exitCode).toBe(value.exitCode);
            resolve(value);
          } catch (error) {
            reject(error);
          }
        });
      });
    }
    try {
      await use({
        commands,
        safe,
        auth: async (account) => {
          const issued = await issueSession(db, account.id, account.email, null, undefined);
          secrets.push(issued.token, issued.csrfToken);
          const file = join(directory, `${randomUUID()}.session.json`);
          const auth = { file, actorId: account.id, sessionId: issued.principal.sessionId };
          sessions.push(auth);
          await writeFile(
            file,
            JSON.stringify({
              schemaVersion: 1,
              kind: "engineo-cli-session",
              actorId: auth.actorId,
              sessionId: auth.sessionId,
              sessionToken: issued.token,
              csrfToken: issued.csrfToken,
            }),
            { mode: 0o600, flag: "wx" },
          );
          expect((await stat(file)).mode & 0o077).toBe(0);
          return auth;
        },
        run: async (command, data, auth, extra = []) =>
          await launch([
            command,
            "--api-origin",
            apiOrigin,
            "--app-origin",
            appOrigin,
            "--organization",
            data.organization,
            "--project",
            data.project,
            "--auth-file",
            auth.file,
            "--allow-http-loopback",
            ...extra,
          ]),
        offline: async (file) => await launch(["validate", "--file", file, "--offline"]),
      });
    } finally {
      try {
        for (const session of sessions) await revokeSession(db, session.sessionId);
      } finally {
        await rm(directory, { recursive: true, force: true });
        expect(
          await stat(directory).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              expect(error.code).toBe("ENOENT");
              return false;
            },
          ),
        ).toBe(false);
      }
    }
  },
});
// Trace archives can contain cookies/login bodies. This suite retains only
// explicitly sanitized JSON and manual PNG screenshots.
test.use({ trace: "off", video: "off", screenshot: "off" });

async function fixture(count = 1): Promise<Fixture> {
  const owner = { id: randomUUID(), email: `${randomUUID()}@example.test` };
  const viewer = { id: randomUUID(), email: `${randomUUID()}@example.test` };
  const foreign = { id: randomUUID(), email: `${randomUUID()}@example.test` };
  const organization = randomUUID(),
    foreignOrganization = randomUUID();
  await db.begin(async (sql) => {
    for (const account of [owner, viewer, foreign]) {
      await sql`INSERT INTO users (id,email) VALUES (${account.id},${account.email})`;
      await sql`INSERT INTO password_credentials (user_id,password_hash)
        VALUES (${account.id},${passwordHash})`;
    }
    await sql`INSERT INTO organizations (id,slug,name) VALUES
      (${organization},${organization},'Built CLI GUI parity'),
      (${foreignOrganization},${foreignOrganization},'Foreign CLI GUI fixture')`;
    await sql`INSERT INTO organization_memberships (organization_id,user_id,role) VALUES
      (${organization},${owner.id},'owner'),(${organization},${viewer.id},'viewer'),
      (${foreignOrganization},${foreign.id},'owner')`;
  });
  const context = tenantContext(organization, owner.id, "cli-gui-disposable-fixture");
  const planner = new PlannerRepository(db);
  const created = await planner.createProject(context, {
    name: "Built CLI project",
    code: "CLI-KEEP-CODE",
    description: "Outside-schedule metadata survives built CLI apply.",
    plannedStart: "2026-10-05T08:00:00Z",
    timeZone: "UTC",
  });
  const snapshot = await new ProjectRepository(db).plannerSnapshot(context, created.projectId);
  if (!snapshot) throw new Error("Missing disposable CLI GUI project");
  // Native insertion order deliberately differs from canonical UUID order.
  const ids = Array.from({ length: count }, () => randomUUID())
    .sort()
    .reverse();
  snapshot.input.activities = ids.map((id, index) => ({
    id,
    name: `Seed CLI activity ${index + 1}`,
    wbsId: created.rootWbsId,
    calendarId: created.calendarId,
    kind: "TASK" as const,
    durationMinutes: 480,
    constraints: [],
  }));
  const firstActivity = ids[0];
  if (!firstActivity) throw new Error("Missing first disposable CLI activity");
  if (ids[1])
    snapshot.input.relationships = [
      { predecessorId: firstActivity, successorId: ids[1], type: "FS", lagMinutes: 0 },
    ];
  const revision = await planner.replaceSchedule(context, created.projectId, 1, snapshot.input);
  await db`INSERT INTO project_memberships (organization_id,project_id,user_id,role)
    VALUES (${organization},${created.projectId},${viewer.id},'viewer')`;
  return {
    owner,
    viewer,
    foreign,
    organization,
    project: created.projectId,
    rootWbs: created.rootWbsId,
    firstActivity,
    revision,
  };
}
async function login(page: Page, data: Fixture, account = data.owner) {
  await page.goto(`/?organization=${data.organization}&project=${data.project}`);
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(account.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".account")).toContainText(account.email);
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
}
async function expectSavedSummary(page: Page, data: Fixture, revision: number, name: string) {
  const card = page.locator(`.projectCard[data-project-id="${data.project}"]`);
  await expect(card).toHaveClass(/selectedProject/);
  await expect(card.locator("strong")).toHaveText(name);
  await expect(card.locator(".projectCode")).toHaveText("CLI-KEEP-CODE");
  await expect(card.locator("span").last()).toHaveText(`Revision ${revision}`);
  await expect(page.locator(".revisionBadge")).toContainText(
    new RegExp(`^Revision ${revision}(?!\\d)`),
  );
}
async function current(cli: PrivateCli, data: Fixture, auth: Auth) {
  const value = success<ProjectConfigurationReadV1>(await cli.run("read", data, auth));
  expect(validateProjectConfigurationReadV1(value)).toBe(true);
  expect(value.configuration.input.project.id).toBe(data.project);
  expect(value.inputHashSha256).toBe(hash(serializeScheduleInputV1(value.configuration.input)));
  return value;
}
async function inputFile(info: TestInfo, cli: PrivateCli, name: string, input: unknown) {
  const text = JSON.stringify(input, null, 2);
  cli.safe(text);
  const file = info.outputPath(`${name}.json`);
  await writeFile(file, text, { flag: "wx", mode: 0o600 });
  return file;
}
async function plan(
  cli: PrivateCli,
  data: Fixture,
  auth: Auth,
  info: TestInfo,
  configuration: ProjectConfigurationV1,
  revision: number,
  name: string,
): Promise<Review> {
  const file = await inputFile(info, cli, `${name}-configuration`, configuration);
  const out = info.outputPath(`${name}-review.json`),
    planId = randomUUID();
  const value = primaryPlanPayload(
    await cli.run("plan", data, auth, [
      "--file",
      file,
      "--plan-id",
      planId,
      "--expected-revision",
      String(revision),
      "--out",
      out,
    ]),
  );
  expect(value.status).toBe("pending");
  if (!value.plan) throw new Error("Built CLI returned no complete reviewed plan");
  expect(value.plan.planId).toBe(planId);
  expect(value.plan.actorId).toBe(auth.actorId);
  expect(value.plan.sessionId).toBe(auth.sessionId);
  expect(value.plan.baseRevision).toBe(revision);
  expect(value.plan.reviewedDigest).toBe(hash(serializeProjectConfigurationReviewV1(value.plan)));
  expect(value.plan.desiredInputHashSha256).toBe(
    hash(serializeScheduleInputV1(value.plan.configuration.input)),
  );
  const artifact = await readFile(out, "utf8");
  cli.safe(artifact);
  expect((await stat(out)).mode & 0o077).toBe(0);
  expect(JSON.parse(artifact)).toEqual({
    schemaVersion: 1,
    kind: "engineo-cli-reviewed-plan",
    destination: {
      apiOrigin,
      appOrigin,
      organizationId: data.organization,
      projectId: data.project,
    },
    plan: value.plan,
  });
  return { file: out, plan: value.plan };
}
const mutationArgs = (review: Review) => [
  "--plan",
  review.file,
  "--expected-revision",
  String(review.plan.baseRevision),
];
async function apply(cli: PrivateCli, data: Fixture, auth: Auth, review: Review) {
  const value = success<{ receipt: ProjectConfigurationReceiptV1 }>(
    await cli.run("apply", data, auth, mutationArgs(review)),
  );
  expect(validateProjectConfigurationReceiptV1(value.receipt)).toBe(true);
  expect(value.receipt.planId).toBe(review.plan.planId);
  expect(value.receipt.reviewedDigest).toBe(review.plan.reviewedDigest);
  return value.receipt;
}
async function guiReload(page: Page, data: Fixture) {
  // These are the actual responses consumed by the GUI, not independent API reads.
  const schedule = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${projectPath(data)}/schedule` &&
      response.request().method() === "GET",
  );
  const result = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${projectPath(data)}/schedule/result` &&
      response.request().method() === "GET",
  );
  const detail = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === projectPath(data) &&
      response.request().method() === "GET",
  );
  await page.reload();
  const [inputResponse, resultResponse, detailResponse] = await Promise.all([
    schedule,
    result,
    detail,
  ]);
  expect(inputResponse.status()).toBe(200);
  expect(resultResponse.status()).toBe(200);
  expect(detailResponse.status()).toBe(200);
  return {
    detail: (await detailResponse.json()) as {
      project: { id: string; revision: number; code: string | null; description: string | null };
    },
    snapshot: (await inputResponse.json()) as { revision: number; input: EngineProjectInputV1 },
    calculation: (await resultResponse.json()) as Calculation,
  };
}
async function evidence(page: Page, info: TestInfo, cli: PrivateCli, name: string, value: unknown) {
  const file = await inputFile(info, cli, name, {
    builtNodeCli: true,
    commands: cli.commands,
    evidence: value,
  });
  await info.attach(name, { path: file, contentType: "application/json" });
  const png = info.outputPath(`${name}.png`);
  await page.screenshot({ path: png, fullPage: true });
  await info.attach(`${name}-gui`, { path: png, contentType: "image/png" });
}
async function audits(data: Fixture) {
  const rows = await db`SELECT action,count(*)::int AS count FROM audit_events
    WHERE organization_id=${data.organization} AND resource_id=${data.project}
    AND action IN ('configuration.plan','configuration.apply','configuration.cancel','schedule.run')
    GROUP BY action`;
  return Object.fromEntries(rows.map((row) => [String(row.action), Number(row.count)]));
}
const pageErrors = new WeakMap<BrowserContext, string[]>();
test.beforeAll(async () => {
  await assertBrowserDatabase(db, process.env);
  await access(cliEntry);
  const scheduler = process.env.ENGINEO_SCHEDULER_BIN;
  if (!scheduler) throw new Error("Provide the explicitly built real Rust ENGINEO_SCHEDULER_BIN");
  await access(scheduler);
  nativeRunner = new ProcessScheduleRunner({ binaryPath: scheduler });
  engineVersion = await nativeRunner.getEngineVersion();
  await migrateDatabase(db);
  passwordHash = await hashPassword(password);
});
test.afterAll(async () => {
  await db.end({ timeout: 5 });
});
test.beforeEach(async ({ page, context }) => {
  const errors: string[] = [];
  const observe = (tab: Page) => tab.on("pageerror", (error) => errors.push(error.message));
  observe(page);
  context.on("page", observe);
  pageErrors.set(context, errors);
});
test.afterEach(async ({ context }) => {
  expect(pageErrors.get(context) ?? []).toEqual([]);
});

// This test fails if packages/cli/dist/main.js is missing or any command is skipped.
test("built CLI exports, validates, reviews, applies/replays and calculates 1,000 activities identical to GUI and Rust", async ({
  page,
  privateCli: cli,
}, info) => {
  test.setTimeout(180_000);
  const data = await fixture(1000),
    auth = await cli.auth(data.owner);
  await login(page, data);
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Seed CLI activity 1",
  );
  const exportedFile = info.outputPath("cli-exported-1000-configuration.json");
  const exported = success<ProjectConfigurationReadV1>(
    await cli.run("export", data, auth, ["--out", exportedFile]),
  );
  expect(validateProjectConfigurationReadV1(exported)).toBe(true);
  const exportedText = await readFile(exportedFile, "utf8");
  cli.safe(exportedText);
  expect(JSON.parse(exportedText)).toEqual(exported.configuration);
  expect(exported.revision).toBe(data.revision);
  expect(exported.inputHashSha256).toBe(
    hash(serializeScheduleInputV1(exported.configuration.input)),
  );
  const beforeRows = Array.from(
    await db`SELECT id,sort_order,created_at FROM activities
    WHERE organization_id=${data.organization} AND project_id=${data.project} ORDER BY sort_order,id`,
  );
  const beforeRelationships = Array.from(
    await db`SELECT id,predecessor_id,successor_id,relationship_type,lag_minutes FROM relationships
    WHERE organization_id=${data.organization} AND project_id=${data.project} ORDER BY id`,
  );
  const desired = structuredClone(exported.configuration);
  desired.input.project.name = "Built CLI reviewed 1,000-activity project";
  desired.input.project.plannedStart = "2026-10-05T08:00:00.123Z";
  desired.input.project.dataDate = "2026-10-05T08:00:00.456Z";
  desired.input.project.requiredFinish = "2026-11-05T17:00:00.789Z";
  const childWbs = randomUUID();
  desired.input.wbs.push({
    id: childWbs,
    parentId: data.rootWbs,
    code: "1.1",
    name: "CLI reviewed work package",
    sortOrder: 1,
  });
  const first = desired.input.activities.find((row) => row.id === data.firstActivity);
  if (!first) throw new Error("Missing first native activity");
  first.name = "CLI configured first native activity";
  first.wbsId = childWbs;
  const removed = String(beforeRows[999]?.id),
    added = randomUUID();
  desired.input.activities = desired.input.activities.filter((row) => row.id !== removed);
  desired.input.activities.push({
    id: added,
    name: "CLI created final native activity",
    wbsId: childWbs,
    calendarId: first.calendarId,
    kind: "TASK",
    durationMinutes: 240,
    constraints: [],
  });
  const validationFile = await inputFile(info, cli, "cli-1000-desired-validation", desired);
  const offline = success<{ valid: boolean; authoritative: boolean; calculationChecked: boolean }>(
    await cli.offline(validationFile),
  );
  expect(offline).toMatchObject({ valid: true, authoritative: false, calculationChecked: false });
  const validated = success<{
    valid: boolean;
    authoritative: boolean;
    calculationChecked: boolean;
  }>(await cli.run("validate", data, auth, ["--file", validationFile, "--authoritative"]));
  expect(validated).toMatchObject({ valid: true, authoritative: true, calculationChecked: false });
  const review = await plan(cli, data, auth, info, desired, exported.revision, "cli-1000");
  expect(
    review.plan.changes.some(
      (change) =>
        change.entity === "activity" && change.operation === "delete" && change.key === removed,
    ),
  ).toBe(true);
  expect(
    review.plan.changes.some(
      (change) =>
        change.entity === "activity" && change.operation === "create" && change.key === added,
    ),
  ).toBe(true);
  const replayFile = info.outputPath("cli-1000-replayed-review.json");
  const replay = primaryPlanPayload(
    await cli.run("plan", data, auth, [
      "--file",
      validationFile,
      "--plan-id",
      review.plan.planId,
      "--expected-revision",
      String(exported.revision),
      "--out",
      replayFile,
    ]),
  );
  expect(replay.plan).toEqual(review.plan);
  cli.safe(await readFile(replayFile, "utf8"));
  expect(JSON.parse(await readFile(replayFile, "utf8"))).toEqual(
    JSON.parse(await readFile(review.file, "utf8")),
  );
  const status = success<ProjectConfigurationPlanReadV1>(
    await cli.run("status", data, auth, ["--plan-id", review.plan.planId]),
  );
  expect(status.status).toBe("pending");
  expect(status.plan).toEqual(review.plan);
  expect((await current(cli, data, auth)).revision).toBe(data.revision);
  const receipt = await apply(cli, data, auth, review);
  expect(receipt.outcome).toBe("applied");
  expect(receipt.committedRevision).toBe(data.revision + 1);
  expect(await apply(cli, data, auth, review)).toEqual(receipt);
  const historical = success<{ historical: boolean; receipt: ProjectConfigurationReceiptV1 }>(
    await cli.run("receipt", data, auth, ["--plan-id", review.plan.planId]),
  );
  expect(historical).toEqual({ historical: true, receipt });
  const receiptAuth = await cli.auth(data.owner);
  expect(
    success<{ historical: boolean; receipt: ProjectConfigurationReceiptV1 }>(
      await cli.run("receipt", data, receiptAuth, ["--plan-id", review.plan.planId]),
    ),
  ).toEqual(historical);
  const committed = await current(cli, data, auth);
  expect(committed.revision).toBe(receipt.committedRevision);
  expect(committed.inputHashSha256).toBe(review.plan.desiredInputHashSha256);
  expect(committed.configuration.input.project).toMatchObject({
    plannedStart: "2026-10-05T08:00:00.123Z",
    dataDate: "2026-10-05T08:00:00.456Z",
    requiredFinish: "2026-11-05T17:00:00.789Z",
  });
  const afterRows = Array.from(
    await db`SELECT id,sort_order,created_at FROM activities
    WHERE organization_id=${data.organization} AND project_id=${data.project} ORDER BY sort_order,id`,
  );
  expect(afterRows.slice(0, 999)).toEqual(beforeRows.filter((row) => row.id !== removed));
  expect(afterRows[999]?.id).toBe(added);
  expect(
    Array.from(
      await db`SELECT id,predecessor_id,successor_id,relationship_type,lag_minutes FROM relationships
    WHERE organization_id=${data.organization} AND project_id=${data.project} ORDER BY id`,
    ),
  ).toEqual(beforeRelationships);
  const metadata =
    await db`SELECT code,description FROM projects WHERE organization_id=${data.organization} AND id=${data.project}`;
  expect(metadata[0]).toEqual({
    code: "CLI-KEEP-CODE",
    description: "Outside-schedule metadata survives built CLI apply.",
  });
  expect(
    success<Calculation>(
      await cli.run("result", data, auth, ["--expected-revision", String(committed.revision)]),
    ),
  ).toEqual({ revision: committed.revision, result: null, calculation: null });
  const calculated = success<Calculation>(
    await cli.run("calculate", data, auth, ["--expected-revision", String(committed.revision)]),
  );
  if (!calculated.result || !calculated.calculation)
    throw new Error("No real Rust-backed CLI calculation");
  const result = success<Calculation>(
    await cli.run("result", data, auth, ["--expected-revision", String(committed.revision)]),
  );
  expect(result).toEqual({
    revision: calculated.revision,
    result: calculated.result,
    calculation: calculated.calculation,
  });
  expect(Object.keys(result.result?.activities ?? {})).toHaveLength(1000);
  expect(result.calculation?.inputHashSha256).toBe(committed.inputHashSha256);
  expect(result.calculation?.resultHashSha256).toBe(
    hash(serializeScheduleResultV1(calculated.result)),
  );
  expect(result.calculation?.engineContractVersion).toBe(1);
  expect(result.calculation?.engineVersion).toBe(engineVersion);
  const nativeResult = await nativeRunner.calculate(committed.configuration.input);
  expect(serializeScheduleResultV1(calculated.result)).toBe(
    serializeScheduleResultV1(nativeResult),
  );
  expect(result.calculation?.resultHashSha256).toBe(hash(serializeScheduleResultV1(nativeResult)));
  // Refresh inside the mounted Planner first. A full page reload below also
  // reloads the project list and would otherwise conceal a stale cached card.
  await page.getByRole("button", { name: "Reload saved version", exact: true }).click();
  await expectSavedSummary(page, data, committed.revision, desired.input.project.name);
  const gui = await guiReload(page, data);
  expect(gui.snapshot.revision).toBe(committed.revision);
  expect(gui.detail.project).toMatchObject({
    id: data.project,
    revision: committed.revision,
    ...metadata[0],
  });
  await expect(
    page.locator(`.projectCard[data-project-id="${data.project}"] .projectCode`),
  ).toHaveText("CLI-KEEP-CODE");
  expect(serializeScheduleInputV1(gui.snapshot.input)).toBe(
    serializeScheduleInputV1(committed.configuration.input),
  );
  expect(gui.snapshot.input.activities.map((row) => row.id)).toEqual(
    afterRows.map((row) => row.id),
  );
  expect(gui.calculation).toEqual(result);
  await expect(
    page.getByRole("heading", { name: desired.input.project.name, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".revisionBadge")).toContainText(`Revision ${committed.revision}`);
  await expect(page.locator(".revisionBadge")).not.toContainText("Unsaved edits");
  await expectSavedSummary(page, data, committed.revision, desired.input.project.name);
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    first.name,
  );
  await expect(page.getByRole("combobox", { name: "Activity 1 WBS", exact: true })).toHaveValue(
    childWbs,
  );
  await expect(page.getByRole("textbox", { name: "Activity 2 name", exact: true })).toHaveValue(
    gui.snapshot.input.activities[1]?.name ?? "",
  );
  await expect(page.locator(".summaryStrip > div").nth(0)).toContainText("1,000");
  await expect(page.locator(".summaryStrip > div").nth(3)).toContainText(
    displayInstant(calculated.result.projectFinish),
  );
  const row = page
    .getByRole("table", { name: "Activities", exact: true })
    .locator('tr[aria-rowindex="2"]');
  const firstResult = calculated.result.activities[data.firstActivity];
  if (!firstResult) throw new Error("Rust omitted first native activity result");
  await expect(row.locator(".dateCell").nth(0)).toHaveText(displayInstant(firstResult.earlyStart));
  await expect(row.locator(".dateCell").nth(1)).toHaveText(displayInstant(firstResult.earlyFinish));
  await expect(row.locator(".ganttBar")).toBeVisible();
  const counts = await audits(data);
  expect(counts).toEqual({ "configuration.plan": 1, "configuration.apply": 1, "schedule.run": 1 });
  await evidence(page, info, cli, "cli-gui-1000-parity", {
    receipt,
    configuration: committed,
    nativeOrder: afterRows,
    relationshipIdentity: beforeRelationships,
    outsideMetadata: gui.detail.project,
    independentNativeResultHashSha256: hash(serializeScheduleResultV1(nativeResult)),
    guiLoadedIds: gui.snapshot.input.activities.map((activity) => activity.id),
    result,
    auditCounts: counts,
  });
  await page.getByLabel("Activity table and synchronized Gantt").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByRole("textbox", { name: "Activity 1000 name", exact: true })).toHaveValue(
    "CLI created final native activity",
  );
  const finalPng = info.outputPath("cli-gui-1000-last-native-row.png");
  await page.screenshot({ path: finalPng, fullPage: true });
  await info.attach("cli-gui-1000-last-native-row", { path: finalPng, contentType: "image/png" });
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByLabel("Saved calculation provenance")).toContainText(
    `revision ${committed.revision}`,
  );
  await expect(page.getByLabel("Saved calculation provenance")).toContainText(
    calculated.calculation.engineVersion,
  );
  const provenancePng = info.outputPath("cli-gui-1000-provenance.png");
  await page.screenshot({ path: provenancePng, fullPage: true });
  await info.attach("cli-gui-1000-provenance", { path: provenancePng, contentType: "image/png" });
});

test("saved CLI review loses to a newer GUI save and stale GUI draft cannot overwrite a CLI commit", async ({
  page,
  privateCli: cli,
}, info) => {
  const data = await fixture(),
    auth = await cli.auth(data.owner);
  await login(page, data);
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Seed CLI activity 1",
  );
  const initial = await current(cli, data, auth),
    desired = structuredClone(initial.configuration);
  const first = desired.input.activities[0];
  if (!first) throw new Error("Missing fixture activity");
  first.name = "Stale saved CLI review";
  const stale = await plan(cli, data, auth, info, desired, initial.revision, "cli-stale");
  await page
    .getByRole("textbox", { name: "Activity 1 name", exact: true })
    .fill("GUI committed first");
  await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
  await expect(page.locator(".liveStatus")).toContainText("Schedule calculated");
  const rejected = await cli.run("apply", data, auth, mutationArgs(stale));
  denied(rejected, "conflict", "revision_conflict", 4);
  const guiSaved = await current(cli, data, auth);
  expect(guiSaved.revision).toBe(initial.revision + 1);
  expect(guiSaved.configuration.input.activities[0]?.name).toBe("GUI committed first");
  await expectSavedSummary(
    page,
    data,
    guiSaved.revision,
    guiSaved.configuration.input.project.name,
  );
  await page
    .getByRole("textbox", { name: "Activity 1 name", exact: true })
    .fill("Unsaved stale GUI draft");
  const next = structuredClone(guiSaved.configuration);
  next.input.project.name = "CLI renamed the saved project";
  const nextActivity = next.input.activities[0];
  if (!nextActivity) throw new Error("Missing persisted activity");
  nextActivity.name = "CLI committed second";
  const reviewed = await plan(cli, data, auth, info, next, guiSaved.revision, "cli-newer");
  const receipt = await apply(cli, data, auth, reviewed);
  await expectSavedSummary(
    page,
    data,
    guiSaved.revision,
    guiSaved.configuration.input.project.name,
  );
  const save = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${projectPath(data)}/schedule` &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
  const saveResponse = await save;
  expect(saveResponse.status()).toBe(409);
  expect((await saveResponse.json()).error).toBe("revision_conflict");
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
    "This project changed elsewhere",
  );
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Unsaved stale GUI draft",
  );
  await expect(page.locator(".revisionBadge")).toContainText("Unsaved edits");
  await expectSavedSummary(
    page,
    data,
    guiSaved.revision,
    guiSaved.configuration.input.project.name,
  );
  await expect(page.locator(".ganttBar")).toHaveCount(0);
  const committed = await current(cli, data, auth);
  expect(committed.revision).toBe(initial.revision + 2);
  expect(committed.configuration.input.activities[0]?.name).toBe("CLI committed second");
  expect(receipt.committedRevision).toBe(committed.revision);
  expect(await apply(cli, data, auth, reviewed)).toEqual(receipt);
  const counts = await audits(data);
  expect(counts).toEqual({ "configuration.plan": 2, "configuration.apply": 1, "schedule.run": 1 });
  await evidence(page, info, cli, "cli-gui-stale-draft-retained", {
    staleCliError: rejected.error,
    staleGuiSaveStatus: saveResponse.status(),
    savedRevision: committed.revision,
    receipt,
    auditCounts: counts,
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reload saved version", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "CLI committed second",
  );
  await expect(page.locator(".revisionBadge")).toContainText(`Revision ${committed.revision}`);
  await expect(page.locator(".revisionBadge")).not.toContainText("Unsaved edits");
  await expectSavedSummary(
    page,
    data,
    committed.revision,
    committed.configuration.input.project.name,
  );
  await evidence(page, info, cli, "cli-gui-stale-authoritative-reload", {
    configuration: committed,
    receipt,
  });
});

test("built CLI cancellation/replay preserves GUI revision and its saved real Rust result", async ({
  page,
  privateCli: cli,
}, info) => {
  const data = await fixture(),
    auth = await cli.auth(data.owner);
  await login(page, data);
  const initial = await current(cli, data, auth);
  const calculated = success<Calculation>(
    await cli.run("calculate", data, auth, ["--expected-revision", String(initial.revision)]),
  );
  if (!calculated.result || !calculated.calculation)
    throw new Error("Missing cancellation fixture Rust result");
  const desired = structuredClone(initial.configuration),
    first = desired.input.activities[0];
  if (!first) throw new Error("Missing cancellation activity");
  first.name = "Cancelled CLI configuration must not appear";
  const review = await plan(cli, data, auth, info, desired, initial.revision, "cli-cancelled");
  const cancellation = success<{ receipt: ProjectConfigurationReceiptV1 }>(
    await cli.run("cancel", data, auth, mutationArgs(review)),
  );
  expect(validateProjectConfigurationReceiptV1(cancellation.receipt)).toBe(true);
  expect(cancellation.receipt.outcome).toBe("cancelled");
  expect(
    success<{ receipt: ProjectConfigurationReceiptV1 }>(
      await cli.run("cancel", data, auth, mutationArgs(review)),
    ).receipt,
  ).toEqual(cancellation.receipt);
  const receipt = success<{ historical: boolean; receipt: ProjectConfigurationReceiptV1 }>(
    await cli.run("receipt", data, auth, ["--plan-id", review.plan.planId]),
  );
  expect(receipt).toEqual({ historical: true, receipt: cancellation.receipt });
  denied(
    await cli.run("apply", data, auth, mutationArgs(review)),
    "conflict",
    "configuration_cancelled",
    4,
  );
  const after = await current(cli, data, auth);
  expect(after).toEqual(initial);
  await expectSavedSummary(page, data, initial.revision, initial.configuration.input.project.name);
  const result = success<Calculation>(
    await cli.run("result", data, auth, ["--expected-revision", String(initial.revision)]),
  );
  expect(result).toEqual({
    revision: calculated.revision,
    result: calculated.result,
    calculation: calculated.calculation,
  });
  const gui = await guiReload(page, data);
  expect(gui.snapshot.revision).toBe(initial.revision);
  await expectSavedSummary(page, data, initial.revision, initial.configuration.input.project.name);
  expect(gui.calculation).toEqual(result);
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Seed CLI activity 1",
  );
  await expect(page.locator(".ganttBar")).toHaveCount(1);
  const counts = await audits(data);
  expect(counts).toEqual({ "configuration.plan": 1, "configuration.cancel": 1, "schedule.run": 1 });
  await evidence(page, info, cli, "cli-gui-cancelled-replay", {
    receipt,
    revision: after.revision,
    inputHashSha256: after.inputHashSha256,
    result,
    auditCounts: counts,
  });
});

test("built CLI enforces viewer, foreign, changed-session and revoked-session denial without a GUI mutation", async ({
  page,
  browser,
  privateCli: cli,
}, info) => {
  const data = await fixture(),
    auth = await cli.auth(data.owner);
  await login(page, data);
  const initial = await current(cli, data, auth),
    desired = structuredClone(initial.configuration);
  const first = desired.input.activities[0];
  if (!first) throw new Error("Missing authorization fixture activity");
  first.name = "Owner session reviewed change";
  const review = await plan(cli, data, auth, info, desired, initial.revision, "cli-denied");
  const viewer = await cli.auth(data.viewer),
    foreign = await cli.auth(data.foreign),
    changed = await cli.auth(data.owner);
  expect((await current(cli, data, viewer)).configuration).toEqual(initial.configuration);
  const desiredFile = await inputFile(info, cli, "cli-viewer-denied-desired", desired);
  const viewerPlan = await cli.run("plan", data, viewer, [
    "--file",
    desiredFile,
    "--plan-id",
    randomUUID(),
    "--expected-revision",
    String(initial.revision),
    "--out",
    info.outputPath("cli-viewer-unapplied-review.json"),
  ]);
  denied(viewerPlan, "auth", "forbidden", 5);
  expect(viewerPlan.error?.details).toEqual({ httpStatus: 403 });
  const foreignRead = await cli.run("read", data, foreign);
  denied(foreignRead, "auth", "forbidden", 5);
  expect(foreignRead.error?.details).toEqual({ httpStatus: 403 });
  expect(JSON.stringify(foreignRead).includes(initial.configuration.input.project.name)).toBe(
    false,
  );
  const viewerCalculation = await cli.run("calculate", data, viewer, [
    "--expected-revision",
    String(initial.revision),
  ]);
  denied(viewerCalculation, "auth", "forbidden", 5);
  expect(viewerCalculation.error?.details).toEqual({ httpStatus: 403 });
  const viewerStatus = await cli.run("status", data, viewer, ["--plan-id", review.plan.planId]);
  denied(viewerStatus, "unavailable", "configuration_plan_not_found", 10);
  expect(viewerStatus.error?.details).toEqual({ httpStatus: 404 });
  const changedApply = await cli.run("apply", data, changed, mutationArgs(review));
  denied(changedApply, "auth", "review_identity_mismatch", 5);
  const changedStatus = await cli.run("status", data, changed, ["--plan-id", review.plan.planId]);
  denied(changedStatus, "unavailable", "configuration_plan_not_found", 10);
  const viewerContext = await browser.newContext({ baseURL: appOrigin });
  const errors = pageErrors.get(page.context());
  viewerContext.on("page", (tab) => tab.on("pageerror", (error) => errors?.push(error.message)));
  try {
    const other = await viewerContext.newPage();
    await login(other, data, data.viewer);
    await expect(other.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
      "Seed CLI activity 1",
    );
    await expect(
      other.getByRole("textbox", { name: "Activity 1 name", exact: true }),
    ).toBeDisabled();
    await expect(other.locator(".revisionBadge")).toContainText("Read only");
    await expect(other.getByRole("button", { name: "Recalculate", exact: true })).toHaveCount(0);
    await evidence(other, info, cli, "cli-gui-viewer-denial", {
      viewerPlanError: viewerPlan.error,
      viewerCalculationError: viewerCalculation.error,
      foreignReadError: foreignRead.error,
      viewerReviewError: viewerStatus.error,
      changedSessionApplyError: changedApply.error,
      changedSessionReviewError: changedStatus.error,
    });
  } finally {
    await viewerContext.close();
  }
  const pending = success<ProjectConfigurationPlanReadV1>(
    await cli.run("status", data, auth, ["--plan-id", review.plan.planId]),
  );
  expect(pending.status).toBe("pending");
  expect(pending.plan).toEqual(review.plan);
  expect(await revokeSession(db, auth.sessionId)).toBe(true);
  const revoked = await cli.run("read", data, auth);
  denied(revoked, "auth", "unauthenticated", 5);
  expect(revoked.error?.details).toEqual({ httpStatus: 401 });
  const after = await current(cli, data, changed);
  expect(after).toEqual(initial);
  const gui = await guiReload(page, data);
  expect(gui.snapshot.revision).toBe(initial.revision);
  expect(serializeScheduleInputV1(gui.snapshot.input)).toBe(
    serializeScheduleInputV1(initial.configuration.input),
  );
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Seed CLI activity 1",
  );
  const counts = await audits(data);
  expect(counts).toEqual({ "configuration.plan": 1 });
  await evidence(page, info, cli, "cli-gui-session-denial", {
    revokedSessionError: revoked.error,
    unchangedRevision: after.revision,
    inputHashSha256: after.inputHashSha256,
    auditCounts: counts,
  });
});
