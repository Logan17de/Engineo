import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  canonicalizeScheduleInputV1,
  type EngineProjectInputV1,
  type EngineScheduleResultV1,
} from "@engineo/contracts";
import { expect, type Page, test } from "@playwright/test";
import { createDatabase } from "../apps/api/src/db/client.js";
import { migrateDatabase } from "../apps/api/src/db/migrate.js";
import { tenantContext } from "../apps/api/src/db/tenant-context.js";
import { PlannerRepository } from "../apps/api/src/repositories/planner-repository.js";
import { ProjectRepository } from "../apps/api/src/repositories/project-repository.js";
import { hashPassword } from "../apps/api/src/security/password.js";

const password = "disposable-loopback-browser-fixture";
const owner = { id: randomUUID(), email: `${randomUUID()}@example.test` };
const viewer = { id: randomUUID(), email: `${randomUUID()}@example.test` };
const empty = { id: randomUUID(), email: `${randomUUID()}@example.test` };
const foreign = { id: randomUUID(), email: `${randomUUID()}@example.test` };
const org = randomUUID(),
  foreignOrg = randomUUID();
const secondaryOrg = randomUUID();
const db = createDatabase();
let fixtureProject = "",
  foreignProject = "";
let viewerLargeProject = "";
const pageErrors = new WeakMap<Page, string[]>();
function gate() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, release: () => resolve() };
}

async function login(page: Page, account = owner) {
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(account.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
}
function projectPath(page: Page) {
  const query = new URL(page.url()).searchParams;
  return `/api/organizations/${query.get("organization")}/projects/${query.get("project")}`;
}
async function snapshot(page: Page) {
  const response = await page.request.get(`${projectPath(page)}/schedule`);
  expect(response.status()).toBe(200);
  return (await response.json()) as { revision: number; input: EngineProjectInputV1 };
}
async function csrf(page: Page) {
  const cookie = (await page.context().cookies()).find((item) => item.name === "engineo_csrf");
  expect(cookie).toBeDefined();
  return { "x-csrf-token": cookie?.value ?? "", origin: "http://127.0.0.1:3100" };
}
async function openFixture(page: Page, account = owner, projectId = fixtureProject) {
  await page.goto(`/?organization=${org}&project=${projectId}`);
  await login(page, account);
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toBeVisible();
}
async function recalculate(page: Page, finish: string) {
  await page.getByRole("button", { name: /^(Save & recalculate|Recalculate)$/ }).click();
  await expect(page.locator(".liveStatus")).toContainText(`finish ${finish} UTC`);
}

test.beforeAll(async () => {
  await migrateDatabase(db);
  const hash = await hashPassword(password);
  await db.begin(async (sql) => {
    for (const user of [owner, viewer, empty, foreign]) {
      await sql`INSERT INTO users (id,email,display_name) VALUES (${user.id},${user.email},'Browser test')`;
      await sql`INSERT INTO password_credentials (user_id,password_hash) VALUES (${user.id},${hash})`;
    }
    await sql`INSERT INTO organizations (id,slug,name) VALUES (${org},${org},'Fixture workspace'),(${foreignOrg},${foreignOrg},'Foreign private workspace')`;
    await sql`INSERT INTO organizations (id,slug,name) VALUES (${secondaryOrg},${secondaryOrg},'Secondary workspace')`;
    await sql`INSERT INTO organization_memberships (organization_id,user_id,role) VALUES (${org},${owner.id},'owner'),(${org},${viewer.id},'viewer'),(${foreignOrg},${foreign.id},'owner')`;
    await sql`INSERT INTO organization_memberships (organization_id,user_id,role) VALUES (${secondaryOrg},${owner.id},'owner')`;
  });
  const planner = new PlannerRepository(db),
    projects = new ProjectRepository(db);
  for (const [organizationId, actorId, name] of [
    [org, owner.id, "State test project"],
    [foreignOrg, foreign.id, "Foreign confidential project"],
  ] as const) {
    const context = tenantContext(organizationId, actorId, "browser-fixture");
    const project = await planner.createProject(context, {
      name,
      code: null,
      description: null,
      plannedStart: "2026-10-05T08:00:00Z",
      timeZone: "UTC",
    });
    const state = await projects.plannerSnapshot(context, project.projectId);
    expect(state).not.toBeNull();
    if (!state) throw new Error("Fixture snapshot is missing");
    state.input.activities = [1, 2].map((index) => ({
      id: randomUUID(),
      name: `Fixture activity ${index}`,
      kind: "TASK",
      durationMinutes: 480,
      wbsId: project.rootWbsId,
      calendarId: project.calendarId,
      constraints: [],
    }));
    await planner.replaceSchedule(context, project.projectId, 1, state.input);
    if (organizationId === org) fixtureProject = project.projectId;
    else foreignProject = project.projectId;
  }
  await db`INSERT INTO project_memberships (organization_id,project_id,user_id,role) VALUES (${org},${fixtureProject},${viewer.id},'viewer')`;
  const context = tenantContext(org, owner.id, "browser-viewer-fixture");
  const large = await planner.createProject(context, {
    name: "Viewer 1000",
    code: null,
    description: null,
    plannedStart: "2026-10-05T08:00:00Z",
    timeZone: "UTC",
  });
  const largeSnapshot = await projects.plannerSnapshot(context, large.projectId);
  if (!largeSnapshot) throw new Error("Large viewer snapshot is missing");
  largeSnapshot.input.activities = Array.from({ length: 1000 }, (_, index) => ({
    id: randomUUID(),
    name: `Viewer activity ${index + 1}`,
    kind: "TASK",
    durationMinutes: 480,
    wbsId: large.rootWbsId,
    calendarId: large.calendarId,
    constraints: [],
  }));
  await planner.replaceSchedule(context, large.projectId, 1, largeSnapshot.input);
  viewerLargeProject = large.projectId;
  await db`INSERT INTO project_memberships (organization_id,project_id,user_id,role) VALUES (${org},${viewerLargeProject},${viewer.id},'viewer')`;
});
test.afterAll(async () => {
  await db.end({ timeout: 5 });
});
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? []).toEqual([]);
});

test("create/edit/recalculate 1000 activities, calendar controls, keyboard range and audited export", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(owner.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText("incorrect");
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toBeFocused();
  await login(page);
  await page.getByText("New organization", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "Organization name", exact: true })
    .fill("Browser acceptance");
  await page.getByRole("textbox", { name: "Address", exact: true }).fill(randomUUID());
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await page.getByText("New project", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "Project name", exact: true })
    .fill("Planner browser 1000");
  await page.locator('input[name="start"]').fill("2026-10-05T08:00");
  await page.getByRole("button", { name: "Create project", exact: true }).dblclick();
  await expect(
    page.getByRole("heading", { name: "Planner browser 1000", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".projectCard")).toHaveCount(1);
  await page.getByText("New organization", { exact: true }).click();
  await page.getByText("New project", { exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "Number of activities to add", exact: true })
    .fill("1000");
  await page.getByRole("button", { name: "Add activities", exact: true }).click();
  await expect(page.locator("tbody tr:not(.spacer)")).toHaveCount(24);
  await page.getByRole("textbox", { name: "Activity 1 name", exact: true }).fill("Foundation");
  await page.getByRole("textbox", { name: "Activity 2 name", exact: true }).fill("Installation");
  await page
    .getByRole("spinbutton", { name: "Activity 2 duration in minutes", exact: true })
    .fill("960");
  await page.getByRole("button", { name: "Constraints", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add constraint", exact: true })).toBeEnabled();
  await page.locator('input[name="instant"]').fill("2026-10-05T08:00");
  await page.getByRole("button", { name: "Add constraint", exact: true }).click();
  await page.getByRole("button", { name: "WBS", exact: true }).click();
  await page.getByRole("button", { name: "Add WBS group", exact: true }).click();
  await page.getByRole("button", { name: "Add WBS group", exact: true }).click();
  await page.getByRole("button", { name: "Remove group", exact: true }).nth(1).click();
  await page.getByRole("button", { name: "Add WBS group", exact: true }).click();
  const codes = await page
    .locator('input[aria-label$=" code"]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value));
  expect(new Set(codes).size).toBe(codes.length);
  await page.getByRole("textbox", { name: "WBS 1.1 name", exact: true }).fill("Earthworks");
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Activity 1 WBS", exact: true })
    .selectOption({ label: "1.1 · Earthworks" });
  await page.getByRole("button", { name: "Relationships", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Predecessor", exact: true })
    .selectOption({ label: "Foundation" });
  await page
    .getByRole("combobox", { name: "Successor", exact: true })
    .selectOption({ label: "Installation" });
  await page.getByRole("button", { name: "Add relationship", exact: true }).click();
  await page.getByRole("button", { name: "Add relationship", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
    "already exists",
  );
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toBeFocused();
  await page
    .getByRole("combobox", { name: "Predecessor", exact: true })
    .selectOption({ label: "Installation" });
  await page
    .getByRole("combobox", { name: "Successor", exact: true })
    .selectOption({ label: "Foundation" });
  await page.getByRole("button", { name: "Add relationship", exact: true }).click();
  await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText("cycle");
  expect((await snapshot(page)).revision).toBe(1);
  await page.getByRole("button", { name: "Remove relationship", exact: true }).last().click();
  await recalculate(page, "07 Oct 2026, 17:00");
  let state = await snapshot(page);
  expect(state.input.activities).toHaveLength(1000);
  expect(state.input.relationships).toHaveLength(1);
  expect(state.input.activities[0]?.constraints).toHaveLength(1);
  await page.getByRole("button", { name: "Calendars", exact: true }).click();
  const tuesday = page.getByRole("textbox", { name: "tuesday working intervals", exact: true });
  await tuesday.fill("09:00-12:00-13:00-17:00");
  await tuesday.press("Tab");
  await expect(tuesday).toHaveValue("09:00-12:00-13:00-17:00");
  await expect(tuesday).toHaveAttribute("aria-invalid", "true");
  await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
    "Work intervals require",
  );
  expect((await snapshot(page)).revision).toBe(state.revision);
  await tuesday.fill("09:00-12:00, 13:00-17:00");
  await page
    .getByRole("textbox", { name: "Nonworking exception date", exact: true })
    .fill("2026-10-07");
  await page.getByRole("button", { name: "Add nonworking day", exact: true }).click();
  await recalculate(page, "09 Oct 2026, 09:00");
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  await expect(page.locator(".ganttBar")).toHaveCount(24);
  await page.getByRole("button", { name: "Next activities", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: "Activity 19 name", exact: true })).toBeVisible();
  for (
    let range = 0;
    range < 60 &&
    (await page.getByRole("button", { name: "Next activities", exact: true }).isEnabled());
    range++
  ) {
    await page.keyboard.press("Enter");
  }
  await expect(
    page.getByRole("textbox", { name: "Activity 1000 name", exact: true }),
  ).toBeVisible();
  const lastActivity = page.getByRole("textbox", { name: "Activity 1000 name", exact: true });
  for (
    let step = 0;
    step < 200 &&
    !(await page.evaluate(
      () => document.activeElement?.getAttribute("aria-label") === "Activity 1000 name",
    ));
    step++
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(lastActivity).toBeFocused();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Final package");
  await expect(lastActivity).toHaveValue("Final package");
  await page.getByRole("button", { name: "Export JSON", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
    "Save your edits before exporting",
  );
  await recalculate(page, "09 Oct 2026, 09:00");
  await page.getByRole("searchbox", { name: "Find activities", exact: true }).fill("Final package");
  await expect(page.locator("tbody tr:not(.spacer)")).toHaveCount(1);
  await page.getByRole("searchbox", { name: "Find activities", exact: true }).fill("");
  await expect(page.locator("tbody tr:not(.spacer)")).toHaveCount(24);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON", exact: true }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).not.toBeNull();
  const content = await readFile(path ?? "", "utf8");
  const exported = JSON.parse(content) as EngineProjectInputV1;
  expect(exported.activities).toHaveLength(1000);
  expect(
    exported.activities.find((activity) => activity.id === state.input.activities.at(-1)?.id)?.name,
  ).toBe("Final package");
  expect(content).not.toMatch(/engineo_session|password_hash|engineo_csrf/);
  state = await snapshot(page);
  expect(exported).toEqual(canonicalizeScheduleInputV1(state.input));
  const exportAudit =
    await db`SELECT payload->>'inputHash' AS hash FROM audit_events WHERE resource_id=${state.input.project.id} AND action='project.export' ORDER BY occurred_at DESC LIMIT 1`;
  expect(createHash("sha256").update(content).digest("hex")).toBe(exportAudit[0]?.hash);
  const calculation = await page.request.post(`${projectPath(page)}/schedule/run`, {
    headers: await csrf(page),
    data: { expectedRevision: state.revision },
  });
  expect(calculation.status()).toBe(200);
  const result = ((await calculation.json()) as { result: EngineScheduleResultV1 }).result;
  expect(Date.parse(result.projectFinish)).toBe(Date.parse("2026-10-09T09:00:00Z"));
  expect(
    (
      await db`SELECT count(*)::int AS count FROM audit_events WHERE resource_id=${state.input.project.id} AND action='project.export'`
    )[0]?.count,
  ).toBe(1);
});

test("offline retry, replay, stale revision and request cancellation preserve explicit saved state", async ({
  page,
}) => {
  await openFixture(page);
  const initial = await snapshot(page);
  await page.getByRole("textbox", { name: "Activity 1 name", exact: true }).fill("Offline edit");
  await page.context().setOffline(true);
  await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Offline edit",
  );
  await page.context().setOffline(false);
  expect((await snapshot(page)).revision).toBe(initial.revision);
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/schedule")) writes++;
  });
  await page.getByRole("button", { name: "Save & recalculate", exact: true }).dblclick();
  await expect(page.locator(".liveStatus")).toContainText("Schedule calculated");
  expect(writes).toBe(1);
  let state = await snapshot(page);
  expect(state.revision).toBe(initial.revision + 1);
  await page
    .getByRole("textbox", { name: "Activity 1 name", exact: true })
    .fill("Cancelled after save");
  const cancellationGate = gate();
  let runIntercepted = false;
  await page.route("**/schedule/run", async (route) => {
    runIntercepted = true;
    await cancellationGate.promise;
    await route.continue().catch(() => {});
  });
  await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).revision).toBe(state.revision + 1);
  await expect.poll(() => runIntercepted).toBe(true);
  await page.getByRole("button", { name: "Stop request", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
    "Request stopped",
  );
  state = await snapshot(page);
  expect(state.input.activities[0]?.name).toBe("Cancelled after save");
  cancellationGate.release();
  await page.unroute("**/schedule/run");
  await recalculate(page, "05 Oct 2026, 17:00");
  const changed = structuredClone(state.input);
  changed.project.name = "Changed elsewhere";
  const concurrent = await page.request.put(`${projectPath(page)}/schedule`, {
    headers: await csrf(page),
    data: { expectedRevision: state.revision, input: changed },
  });
  expect(concurrent.status()).toBe(200);
  await page.getByRole("textbox", { name: "Activity 1 name", exact: true }).fill("Stale draft");
  await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
    "changed elsewhere",
  );
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Stale draft",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Reload saved version", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Stale draft",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reload saved version", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Changed elsewhere", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Cancelled after save",
  );
  const delayedSave = gate();
  let committed = false;
  const beforeCancel = await snapshot(page);
  await page
    .getByRole("textbox", { name: "Activity 1 name", exact: true })
    .fill("Committed before response");
  await page.route("**/schedule", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed = true;
    await delayedSave.promise;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
  await expect.poll(() => committed).toBe(true);
  await page.getByRole("button", { name: "Stop request", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
    "Request stopped",
  );
  await expect(page.locator(".revisionBadge")).toContainText("Unsaved edits");
  delayedSave.release();
  await page.unroute("**/schedule");
  expect((await snapshot(page)).revision).toBe(beforeCancel.revision + 1);
  await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
    "changed elsewhere",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reload saved version", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Committed before response",
  );
  await page.route(`**/organizations/${secondaryOrg}/projects`, (route) =>
    route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } }),
  );
  await page
    .getByRole("combobox", { name: "Organization", exact: true })
    .selectOption(secondaryOrg);
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
    "temporarily unavailable",
  );
  await expect(page.locator(".projectCard")).toHaveCount(0);
  await expect(page.locator(".plannerPanel")).toHaveCount(0);
  await page.unroute(`**/organizations/${secondaryOrg}/projects`);
});

test("expired session recovers drafts only for the same immutable account and logout clears project state", async ({
  page,
}) => {
  await openFixture(page);
  await page
    .getByRole("textbox", { name: "Activity 1 name", exact: true })
    .fill("Recovered session draft");
  await db`UPDATE auth_sessions SET revoked_at=now() WHERE user_id=${owner.id} AND revoked_at IS NULL`;
  await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to Engineo", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/unsaved edits are kept in this tab/)).toBeVisible();
  await login(page);
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Recovered session draft",
  );
  await expect(page.locator(".revisionBadge")).toContainText("Unsaved edits");
  expect((await snapshot(page)).input.activities[0]?.name).not.toBe("Recovered session draft");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Recovered session draft",
  );
  await db`UPDATE auth_sessions SET revoked_at=now() WHERE user_id=${owner.id} AND revoked_at IS NULL`;
  await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to Engineo", exact: true }),
  ).toBeVisible();
  await login(page, empty);
  await expect(page.getByText(/unsaved edits are kept in this tab/)).toHaveCount(0);
  await expect(page.locator(".projectCard")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your projects", exact: true })).toBeVisible();
  await expect(page.getByText("Changed elsewhere", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page);
  await page.getByRole("combobox", { name: "Organization", exact: true }).selectOption(org);
  await page.locator(`.projectCard[data-project-id="${fixtureProject}"]`).click();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).not.toHaveValue(
    "Recovered session draft",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page, empty);
  await expect(page.locator(".projectCard")).toHaveCount(0);
});

test("session expiry after a confirmed save restores current persisted state without a stale draft", async ({
  page,
}) => {
  await openFixture(page);
  const initial = await snapshot(page);
  await page
    .getByRole("textbox", { name: "Activity 1 name", exact: true })
    .fill("Saved before expiry");
  await page.route("**/schedule", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await db`UPDATE auth_sessions SET revoked_at=now() WHERE user_id=${owner.id} AND revoked_at IS NULL`;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to Engineo", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/unsaved edits are kept in this tab/)).toHaveCount(0);
  await page.unroute("**/schedule");
  await login(page);
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Saved before expiry",
  );
  expect((await snapshot(page)).revision).toBe(initial.revision + 1);
  await expect(page.locator(".revisionBadge")).not.toContainText("Unsaved edits");
});

test("viewer controls and foreign project requests enforce tenant boundaries", async ({ page }) => {
  await openFixture(page, viewer, viewerLargeProject);
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Recalculate", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add activities", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Next activities", exact: true }).focus();
  for (
    let range = 0;
    range < 60 &&
    (await page.getByRole("button", { name: "Next activities", exact: true }).isEnabled());
    range++
  )
    await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Next activities", exact: true })).toBeDisabled();
  await page.keyboard.press("Control+End");
  await expect(
    page.getByRole("textbox", { name: "Activity 1000 name", exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByRole("textbox", { name: "Activity 1000 name", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("tbody tr:not(.spacer)")).toHaveCount(18);
  const current = await snapshot(page);
  const write = await page.request.put(`${projectPath(page)}/schedule`, {
    headers: await csrf(page),
    data: { expectedRevision: current.revision, input: current.input },
  });
  expect(write.status()).toBe(403);
  const run = await page.request.post(`${projectPath(page)}/schedule/run`, {
    headers: await csrf(page),
    data: { expectedRevision: current.revision },
  });
  expect(run.status()).toBe(403);
  const other = await page.request.get(
    `/api/organizations/${foreignOrg}/projects/${foreignProject}/schedule`,
  );
  expect(other.status()).toBe(403);
  expect(await other.text()).not.toContain("Foreign confidential project");
});
