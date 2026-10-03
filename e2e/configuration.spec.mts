import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  type EngineScheduleResultV1,
  type ProjectConfigurationPlanV1,
  type ProjectConfigurationReadV1,
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
import { hashPassword } from "../apps/api/src/security/password.js";
import { test } from "./fixtures.mjs";

const db = createDatabase();
const password = "disposable-loopback-configuration-gui-fixture";
let passwordHash = "";
type Account = { id: string; email: string };
type Fixture = {
  owner: Account;
  viewer: Account;
  foreign: Account;
  organization: string;
  foreignOrganization: string;
  project: string;
  rootWbs: string;
  firstActivity: string;
  revision: number;
};
type AuthHeaders = { "x-csrf-token": string; "x-engineo-session": string; origin: string };
type Saved = {
  revision: number;
  result: EngineScheduleResultV1 | null;
  calculation: ScheduleCalculationMetadataV1 | null;
};
const projectPath = (data: Fixture) =>
  `/api/organizations/${data.organization}/projects/${data.project}`;
const configPath = (data: Fixture) => `${projectPath(data)}/configuration`;
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
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
async function fixture(count = 1): Promise<Fixture> {
  const owner = { id: randomUUID(), email: `${randomUUID()}@example.test` };
  const viewer = { id: randomUUID(), email: `${randomUUID()}@example.test` };
  const foreign = { id: randomUUID(), email: `${randomUUID()}@example.test` };
  const organization = randomUUID(),
    foreignOrganization = randomUUID();
  await db.begin(async (sql) => {
    for (const account of [owner, viewer, foreign]) {
      await sql`INSERT INTO users (id,email) VALUES (${account.id},${account.email})`;
      await sql`INSERT INTO password_credentials (user_id,password_hash) VALUES (${account.id},${passwordHash})`;
    }
    await sql`INSERT INTO organizations (id,slug,name) VALUES
      (${organization},${organization},'Configuration GUI parity'),
      (${foreignOrganization},${foreignOrganization},'Foreign configuration workspace')`;
    await sql`INSERT INTO organization_memberships (organization_id,user_id,role) VALUES
      (${organization},${owner.id},'owner'),(${organization},${viewer.id},'viewer'),
      (${foreignOrganization},${foreign.id},'owner')`;
  });
  const context = tenantContext(organization, owner.id, "configuration-gui-fixture");
  const planner = new PlannerRepository(db);
  const created = await planner.createProject(context, {
    name: "Configuration GUI project",
    code: "KEEP-CODE",
    description: "Outside-schedule metadata must survive configuration apply.",
    plannedStart: "2026-10-05T08:00:00Z",
    timeZone: "UTC",
  });
  const snapshot = await new ProjectRepository(db).plannerSnapshot(context, created.projectId);
  if (!snapshot) throw new Error("Missing configuration GUI fixture");
  snapshot.input.activities = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    name: `Seed activity ${index + 1}`,
    wbsId: created.rootWbsId,
    calendarId: created.calendarId,
    kind: "TASK" as const,
    durationMinutes: 480,
    constraints: [],
  }));
  const firstActivity = snapshot.input.activities[0]?.id;
  if (!firstActivity) throw new Error("Missing first fixture activity");
  if (count > 1) {
    const next = snapshot.input.activities[1];
    if (!next) throw new Error("Missing second fixture activity");
    snapshot.input.relationships = [
      { predecessorId: firstActivity, successorId: next.id, type: "FS", lagMinutes: 0 },
    ];
  }
  const revision = await planner.replaceSchedule(context, created.projectId, 1, snapshot.input);
  await db`INSERT INTO project_memberships (organization_id,project_id,user_id,role)
    VALUES (${organization},${created.projectId},${viewer.id},'viewer')`;
  return {
    owner,
    viewer,
    foreign,
    organization,
    foreignOrganization,
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
async function authHeaders(page: Page, account: Account): Promise<AuthHeaders> {
  const response = await page.request.get("/api/auth/me");
  expect(response.status()).toBe(200);
  const identity = (await response.json()) as { user: { id: string }; session: { id: string } };
  expect(identity.user.id).toBe(account.id);
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "engineo_csrf");
  if (!csrf) throw new Error("Missing fixture CSRF cookie");
  return {
    "x-csrf-token": csrf.value,
    "x-engineo-session": identity.session.id,
    origin: "http://127.0.0.1:3100",
  };
}
async function read(
  page: Page,
  data: Fixture,
  headers: AuthHeaders,
): Promise<ProjectConfigurationReadV1> {
  const response = await page.request.get(configPath(data), { headers });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const value: unknown = await response.json();
  if (!validateProjectConfigurationReadV1(value)) throw new Error("Invalid configuration read DTO");
  expect(value.inputHashSha256).toBe(hash(serializeScheduleInputV1(value.configuration.input)));
  return value;
}
async function plan(
  page: Page,
  data: Fixture,
  headers: AuthHeaders,
  configuration: ProjectConfigurationV1,
  expectedRevision = data.revision,
): Promise<ProjectConfigurationPlanV1> {
  const planId = randomUUID();
  const body = { planId, expectedRevision, configuration };
  const response = await page.request.post(`${configPath(data)}/plans`, { headers, data: body });
  expect(response.status()).toBe(200);
  const value: unknown = await response.json();
  if (!validateProjectConfigurationPlanReadV1(value) || !value.plan)
    throw new Error("Missing complete configuration plan");
  expect(value.status).toBe("pending");
  expect(value.plan.actorId).toBe(data.owner.id);
  expect(value.plan.sessionId).toBe(headers["x-engineo-session"]);
  expect(value.plan.reviewedDigest).toBe(hash(serializeProjectConfigurationReviewV1(value.plan)));
  const replay = await page.request.post(`${configPath(data)}/plans`, { headers, data: body });
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toEqual(value);
  return value.plan;
}
async function apply(
  page: Page,
  data: Fixture,
  headers: AuthHeaders,
  review: ProjectConfigurationPlanV1,
) {
  const response = await page.request.post(`${configPath(data)}/plans/${review.planId}/apply`, {
    headers,
    data: { expectedRevision: review.baseRevision, reviewedDigest: review.reviewedDigest },
  });
  expect(response.status()).toBe(200);
  const receipt: unknown = await response.json();
  if (!validateProjectConfigurationReceiptV1(receipt)) throw new Error("Invalid apply receipt");
  expect(receipt.planId).toBe(review.planId);
  expect(receipt.reviewedDigest).toBe(review.reviewedDigest);
  return receipt;
}
async function saved(page: Page, data: Fixture, headers: AuthHeaders): Promise<Saved> {
  const response = await page.request.get(`${projectPath(data)}/schedule/result`, { headers });
  expect(response.status()).toBe(200);
  return (await response.json()) as Saved;
}
async function record(page: Page, info: TestInfo, name: string, evidence: unknown) {
  const jsonPath = info.outputPath(`${name}.json`);
  await writeFile(jsonPath, JSON.stringify(evidence, null, 2));
  await info.attach(name, { path: jsonPath, contentType: "application/json" });
  const pngPath = info.outputPath(`${name}.png`);
  await page.screenshot({ path: pngPath, fullPage: true });
  await info.attach(`${name}-gui`, { path: pngPath, contentType: "image/png" });
}
const pageErrors = new WeakMap<BrowserContext, string[]>();
test.beforeAll(async () => {
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

test("1,000-activity headless configuration apply and replay agree with GUI, Rust dates and immutable provenance", async ({
  page,
}, info) => {
  const data = await fixture(1000);
  await login(page, data);
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Seed activity 1",
  );
  const headers = await authHeaders(page, data.owner);
  const current = await read(page, data, headers);
  const beforeRows = await db`SELECT id,sort_order,created_at FROM activities
    WHERE organization_id=${data.organization} AND project_id=${data.project} ORDER BY sort_order,id`;
  const beforeRelationships =
    await db`SELECT id,predecessor_id,successor_id,relationship_type,lag_minutes FROM relationships
    WHERE organization_id=${data.organization} AND project_id=${data.project} ORDER BY id`;
  const desired = structuredClone(current.configuration);
  desired.input.project.name = "Headless-configured 1,000-activity project";
  desired.input.project.plannedStart = "2026-10-05T08:00:00.123Z";
  desired.input.project.dataDate = "2026-10-05T08:00:00.456Z";
  desired.input.project.requiredFinish = "2026-11-05T17:00:00.789Z";
  const first = desired.input.activities.find((activity) => activity.id === data.firstActivity);
  if (!first) throw new Error("Missing preserved first activity");
  const childWbs = randomUUID();
  desired.input.wbs.push({
    id: childWbs,
    parentId: data.rootWbs,
    code: "1.1",
    name: "Configured work package",
    sortOrder: 1,
  });
  first.name = "Configured activity from reviewed input";
  first.wbsId = childWbs;
  const removed = String(beforeRows[beforeRows.length - 1]?.id);
  desired.input.activities = desired.input.activities.filter((activity) => activity.id !== removed);
  const added = randomUUID();
  desired.input.activities.push({
    id: added,
    wbsId: childWbs,
    name: "Headless-created activity",
    kind: "TASK",
    durationMinutes: 240,
    calendarId: first.calendarId,
    constraints: [],
  });
  const review = await plan(page, data, headers, desired);
  expect(
    review.changes.some(
      (change) =>
        change.entity === "activity" && change.operation === "delete" && change.key === removed,
    ),
  ).toBe(true);
  expect(
    review.changes.some(
      (change) =>
        change.entity === "activity" && change.operation === "create" && change.key === added,
    ),
  ).toBe(true);
  const receipt = await apply(page, data, headers, review);
  expect(receipt.outcome).toBe("applied");
  expect(receipt.committedRevision).toBe(data.revision + 1);
  expect(await apply(page, data, headers, review)).toEqual(receipt);
  const committed = await read(page, data, headers);
  expect(committed.inputHashSha256).toBe(review.desiredInputHashSha256);
  expect(committed.revision).toBe(receipt.committedRevision);
  expect(committed.configuration.input.project.plannedStart).toBe("2026-10-05T08:00:00.123Z");
  expect(committed.configuration.input.project.dataDate).toBe("2026-10-05T08:00:00.456Z");
  expect(committed.configuration.input.project.requiredFinish).toBe("2026-11-05T17:00:00.789Z");
  const afterRows = await db`SELECT id,sort_order,created_at FROM activities
    WHERE organization_id=${data.organization} AND project_id=${data.project} ORDER BY sort_order,id`;
  expect(Array.from(afterRows).slice(0, 999)).toEqual(
    Array.from(beforeRows).filter((row) => row.id !== removed),
  );
  expect(afterRows[999]?.id).toBe(added);
  expect(
    Array.from(
      await db`SELECT id,predecessor_id,successor_id,relationship_type,lag_minutes FROM relationships
    WHERE organization_id=${data.organization} AND project_id=${data.project} ORDER BY id`,
    ),
  ).toEqual(Array.from(beforeRelationships));
  const metadata =
    await db`SELECT code,description FROM projects WHERE organization_id=${data.organization} AND id=${data.project}`;
  expect(metadata[0]?.code).toBe("KEEP-CODE");
  expect(metadata[0]?.description).toBe(
    "Outside-schedule metadata must survive configuration apply.",
  );
  const run = await page.request.post(`${projectPath(data)}/schedule/run`, {
    headers,
    data: { expectedRevision: committed.revision },
  });
  expect(run.status()).toBe(200);
  const calculation = await saved(page, data, headers);
  if (!calculation.result || !calculation.calculation)
    throw new Error("Missing real Rust result/provenance");
  expect(Object.keys(calculation.result.activities)).toHaveLength(1000);
  expect(calculation.calculation.inputHashSha256).toBe(committed.inputHashSha256);
  expect(calculation.calculation.resultHashSha256).toBe(
    hash(serializeScheduleResultV1(calculation.result)),
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: desired.input.project.name, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".revisionBadge")).toContainText(`Revision ${committed.revision}`);
  await expect(page.locator(".revisionBadge")).not.toContainText("Unsaved edits");
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    first.name,
  );
  await expect(page.getByRole("combobox", { name: "Activity 1 WBS", exact: true })).toHaveValue(
    childWbs,
  );
  await expect(page.locator(".summaryStrip > div").nth(0)).toContainText("1,000");
  await expect(page.locator(".summaryStrip > div").nth(3)).toContainText(
    displayInstant(calculation.result.projectFinish),
  );
  await expect(page.locator(".ganttBar").first()).toBeVisible();
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByLabel("Saved calculation provenance")).toContainText(
    `revision ${committed.revision}`,
  );
  expect((await saved(page, data, headers)).calculation?.calculationId).toBe(
    calculation.calculation.calculationId,
  );
  const audits =
    await db`SELECT action,count(*)::int AS count FROM audit_events WHERE organization_id=${data.organization}
    AND resource_id=${data.project} AND action IN ('configuration.plan','configuration.apply','project.schedule.edit','schedule.run') GROUP BY action`;
  const counts = Object.fromEntries(audits.map((row) => [String(row.action), Number(row.count)]));
  expect(counts).toEqual({
    "configuration.plan": 1,
    "configuration.apply": 1,
    "project.schedule.edit": 2,
    "schedule.run": 1,
  });
  await record(page, info, "headless-gui-1000-parity", {
    revision: committed.revision,
    activities: 1000,
    reviewDigest: review.reviewedDigest,
    inputHashSha256: committed.inputHashSha256,
    resultHashSha256: calculation.calculation.resultHashSha256,
    calculationId: calculation.calculation.calculationId,
    nativeOrderAndIdentityPreserved: true,
    outsideMetadataPreserved: true,
    auditCounts: counts,
  });
});

test("explicit configuration cancellation and stale reviewed apply preserve the GUI's authoritative saved state", async ({
  page,
}, info) => {
  const data = await fixture();
  await login(page, data);
  const headers = await authHeaders(page, data.owner);
  await page.getByRole("button", { name: "Recalculate", exact: true }).click();
  await expect(page.locator(".liveStatus")).toContainText("Schedule calculated");
  const initial = await saved(page, data, headers);
  const current = await read(page, data, headers);
  const desired = structuredClone(current.configuration);
  const first = desired.input.activities.find((activity) => activity.id === data.firstActivity);
  if (!first) throw new Error("Missing first activity");
  first.name = "Cancelled configuration must not appear";
  const cancelledPlan = await plan(page, data, headers, desired);
  const cancelled = await page.request.post(
    `${configPath(data)}/plans/${cancelledPlan.planId}/cancel`,
    { headers, data: { reviewedDigest: cancelledPlan.reviewedDigest } },
  );
  expect(cancelled.status()).toBe(200);
  const cancellation: unknown = await cancelled.json();
  if (!validateProjectConfigurationReceiptV1(cancellation))
    throw new Error("Invalid cancellation receipt");
  expect(cancellation.outcome).toBe("cancelled");
  const denied = await page.request.post(
    `${configPath(data)}/plans/${cancelledPlan.planId}/apply`,
    {
      headers,
      data: {
        expectedRevision: cancelledPlan.baseRevision,
        reviewedDigest: cancelledPlan.reviewedDigest,
      },
    },
  );
  expect(denied.status()).toBe(409);
  expect((await denied.json()).error).toBe("configuration_cancelled");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Seed activity 1",
  );
  expect((await saved(page, data, headers)).calculation?.calculationId).toBe(
    initial.calculation?.calculationId,
  );
  const stalePlan = await plan(page, data, headers, desired);
  await page
    .getByRole("textbox", { name: "Activity 1 name", exact: true })
    .fill("GUI edit wins over stale configuration");
  await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
  await expect(page.locator(".liveStatus")).toContainText("Schedule calculated");
  const stale = await page.request.post(`${configPath(data)}/plans/${stalePlan.planId}/apply`, {
    headers,
    data: { expectedRevision: stalePlan.baseRevision, reviewedDigest: stalePlan.reviewedDigest },
  });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error).toBe("revision_conflict");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "GUI edit wins over stale configuration",
  );
  const final = await read(page, data, headers);
  expect(final.revision).toBe(data.revision + 1);
  const applications =
    await db`SELECT count(*)::int AS count FROM audit_events WHERE organization_id=${data.organization}
    AND resource_id=${data.project} AND action='configuration.apply'`;
  expect(applications[0]?.count).toBe(0);
  await record(page, info, "headless-cancel-stale-gui", {
    cancellation: cancellation.outcome,
    staleError: "revision_conflict",
    committedRevision: final.revision,
    configurationApplyAuditCount: 0,
  });
});

test("viewer and foreign configuration requests cannot change or expose another actor's reviewed project", async ({
  page,
  browser,
}, info) => {
  const data = await fixture();
  await login(page, data);
  const ownerHeaders = await authHeaders(page, data.owner);
  const current = await read(page, data, ownerHeaders);
  const desired = structuredClone(current.configuration);
  const first = desired.input.activities[0];
  if (!first) throw new Error("Missing fixture activity");
  first.name = "Owner-only reviewed change";
  const review = await plan(page, data, ownerHeaders, desired);
  const contexts: BrowserContext[] = [];
  try {
    for (const account of [data.viewer, data.foreign]) {
      const context = await browser.newContext();
      contexts.push(context);
      const errors = pageErrors.get(page.context());
      if (!errors) throw new Error("Missing page-error observer");
      context.on("page", (tab) => tab.on("pageerror", (error) => errors.push(error.message)));
      const other = await context.newPage();
      await login(other, data, account);
      const headers = await authHeaders(other, account);
      if (account.id === data.viewer.id) {
        const readable = await read(other, data, headers);
        expect(readable.revision).toBe(current.revision);
        await expect(
          other.getByRole("textbox", { name: "Activity 1 name", exact: true }),
        ).toBeDisabled();
      } else {
        const foreignRead = await other.request.get(configPath(data), { headers });
        expect(foreignRead.status()).toBe(403);
        expect(await foreignRead.text()).not.toContain(current.configuration.input.project.name);
        await expect(other.locator(`.projectCard[data-project-id="${data.project}"]`)).toHaveCount(
          0,
        );
      }
      const attempted = await other.request.post(
        `${configPath(data)}/plans/${review.planId}/apply`,
        {
          headers,
          data: { expectedRevision: review.baseRevision, reviewedDigest: review.reviewedDigest },
        },
      );
      expect(attempted.status()).toBe(403);
      const create = await other.request.post(`${configPath(data)}/plans`, {
        headers,
        data: { planId: randomUUID(), expectedRevision: current.revision, configuration: desired },
      });
      expect(create.status()).toBe(403);
      const foreignPlan = await other.request.get(`${configPath(data)}/plans/${review.planId}`, {
        headers,
      });
      expect(foreignPlan.status()).toBe(account.id === data.viewer.id ? 404 : 403);
      expect(await foreignPlan.text()).not.toContain("Owner-only reviewed change");
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
  const after = await read(page, data, ownerHeaders);
  expect(after.configuration).toEqual(current.configuration);
  expect(after.revision).toBe(current.revision);
  const applications =
    await db`SELECT count(*)::int AS count FROM audit_events WHERE organization_id=${data.organization}
    AND resource_id=${data.project} AND action='configuration.apply'`;
  expect(applications[0]?.count).toBe(0);
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Seed activity 1",
  );
  await record(page, info, "headless-viewer-foreign-denial", {
    viewerAndForeignApply: 403,
    viewerOwnerPlanRead: 404,
    foreignRead: 403,
    unchangedRevision: after.revision,
    configurationApplyAuditCount: 0,
  });
});
