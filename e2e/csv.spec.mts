import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { createDatabase } from "../apps/api/src/db/client.js";
import { migrateDatabase } from "../apps/api/src/db/migrate.js";
import { tenantContext } from "../apps/api/src/db/tenant-context.js";
import { exportActivityCsv } from "../apps/api/src/interchange/activity-csv.js";
import { PlannerRepository } from "../apps/api/src/repositories/planner-repository.js";
import { ProjectRepository } from "../apps/api/src/repositories/project-repository.js";
import { hashPassword } from "../apps/api/src/security/password.js";
import { test } from "./fixtures.mjs";

const db = createDatabase();
const user = randomUUID(),
  org = randomUUID(),
  email = `${user}@example.test`;
const password = "disposable-csv-browser-fixture";
const context = tenantContext(org, user, "csv-browser");
const planner = new PlannerRepository(db),
  projects = new ProjectRepository(db);
let projectId = "";
const state = async () => {
  const result = await projects.plannerSnapshot(context, projectId);
  if (!result) throw new Error("Missing CSV fixture");
  return result;
};
const importPath = () => `/api/organizations/${org}/projects/${projectId}/activities/import`;
const selectFile = (page: Page, csv: string) =>
  page
    .getByLabel("Activity CSV file", { exact: true })
    .setInputFiles({ name: "activities.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
const changedCsv = async () => {
  const current = await state();
  const activity = current.input.activities[0];
  if (!activity) throw new Error("Missing activity");
  activity.name = "Imported construction";
  activity.durationMinutes = 960;
  current.input.activities = [activity];
  return exportActivityCsv(current.input);
};
test.beforeAll(async () => {
  await migrateDatabase(db);
  await db`INSERT INTO organizations (id,slug,name) VALUES (${org},${org},'CSV browser team')`;
  await db`INSERT INTO users (id,email) VALUES (${user},${email})`;
  await db`INSERT INTO password_credentials (user_id,password_hash) VALUES (${user},${await hashPassword(password)})`;
  await db`INSERT INTO organization_memberships (organization_id,user_id,role) VALUES (${org},${user},'owner')`;
});
test.afterAll(async () => {
  await db.end({ timeout: 5 });
});
test.beforeEach(async ({ page }) => {
  const created = await planner.createProject(context, {
    name: "CSV round trip",
    code: null,
    description: null,
    plannedStart: "2026-10-05T08:00:00Z",
    timeZone: "UTC",
  });
  projectId = created.projectId;
  const current = await state();
  current.input.activities = [1, 2].map((index) => ({
    id: randomUUID(),
    name: `CSV activity ${index}`,
    kind: "TASK",
    durationMinutes: 480,
    wbsId: created.rootWbsId,
    calendarId: created.calendarId,
    constraints: [],
  }));
  await planner.replaceSchedule(context, projectId, 1, current.input);
  await page.goto(`/?organization=${org}&project=${projectId}`);
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toBeVisible();
});

test("CSV download, no-op round trip, keyboard preview/apply and real recalculation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const before = await state();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export activities CSV", exact: true }).click();
  const file = await downloaded,
    path = await file.path();
  expect(path).not.toBeNull();
  const csv = await readFile(path as string, "utf8");
  expect(csv).toBe(exportActivityCsv(before.input));
  await page.getByRole("button", { name: "Import CSV", exact: true }).click();
  await selectFile(page, csv);
  await page.getByRole("button", { name: "Preview CSV changes", exact: true }).click();
  await expect(page.getByText("No changes to apply.", { exact: true })).toBeVisible();
  await selectFile(
    page,
    csv.replace('"CSV activity 1"', '"Imported construction"').replace('"480"', '"960"'),
  );
  const preview = page.getByRole("button", { name: "Preview CSV changes", exact: true });
  await preview.focus();
  await page.keyboard.press("Enter");
  const region = page.getByRole("region", { name: "CSV import preview", exact: true });
  await expect(region).toBeFocused();
  await expect(region).toContainText("1 changed · 1 unchanged");
  expect(await state()).toEqual(before);
  await page.screenshot({ path: "/tmp/engineo-csv-preview.png", fullPage: true });
  const apply = page.getByRole("button", { name: "Apply CSV changes", exact: true });
  await apply.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".liveStatus")).toContainText(
    "Imported 1 activity changes at revision 3",
  );
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Imported construction",
  );
  expect((await state()).input.activities[1]).toEqual(before.input.activities[1]);
  await page.getByRole("button", { name: "Recalculate", exact: true }).click();
  await expect(page.locator(".liveStatus")).toContainText("Schedule calculated");
  expect(errors).toEqual([]);
});

test("invalid CSV, cancellation, unsaved edits and offline preview do not change the saved project", async ({
  page,
}) => {
  const before = await state(),
    csv = await changedCsv();
  await page.getByRole("button", { name: "Import CSV", exact: true }).click();
  await selectFile(page, 'broken,"quote');
  await page.getByRole("button", { name: "Preview CSV changes", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
    "unterminated",
  );
  await selectFile(page, csv);
  await page.route(`${importPath()}/preview`, (route) => route.abort());
  await page.getByRole("button", { name: "Preview CSV changes", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toBeVisible();
  await page.unroute(`${importPath()}/preview`);
  await page.getByRole("button", { name: "Preview CSV changes", exact: true }).click();
  await expect(page.getByRole("region", { name: "CSV import preview", exact: true })).toContainText(
    "1 omitted and preserved",
  );
  await page.getByRole("button", { name: "Cancel CSV import", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply CSV changes", exact: true })).toHaveCount(0);
  expect(await state()).toEqual(before);
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  await page.getByRole("textbox", { name: "Activity 1 name", exact: true }).fill("Unsaved draft");
  await page.getByRole("button", { name: "Import CSV", exact: true }).click();
  await expect(page.getByLabel("Activity CSV file", { exact: true })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Preview CSV changes", exact: true }),
  ).toBeDisabled();
  expect(await state()).toEqual(before);
});

test("stale preview is rejected and reload clears it without overwriting a concurrent save", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Import CSV", exact: true }).click();
  await selectFile(page, await changedCsv());
  await page.getByRole("button", { name: "Preview CSV changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply CSV changes", exact: true })).toBeEnabled();
  const concurrent = await state();
  concurrent.input.project.name = "Concurrent project edit";
  await planner.replaceSchedule(context, projectId, concurrent.revision, concurrent.input);
  await page.getByRole("button", { name: "Apply CSV changes", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
    "changed elsewhere",
  );
  expect((await state()).input).toEqual(concurrent.input);
  await page.getByRole("button", { name: "Reload saved version", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "CSV activity 1",
  );
  await page.getByRole("button", { name: "Import CSV", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Preview CSV changes", exact: true }),
  ).toBeDisabled();
});

test("ambiguous applied response retries conflict safely and reload shows the committed import", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Import CSV", exact: true }).click();
  await selectFile(page, await changedCsv());
  await page.getByRole("button", { name: "Preview CSV changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply CSV changes", exact: true })).toBeEnabled();
  await page.route(`${importPath()}/apply`, async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.abort();
  });
  await page.getByRole("button", { name: "Apply CSV changes", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toBeVisible();
  await page.unroute(`${importPath()}/apply`);
  await page.getByRole("button", { name: "Apply CSV changes", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
    "changed elsewhere",
  );
  await page.getByRole("button", { name: "Reload saved version", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Imported construction",
  );
  expect((await state()).revision).toBe(3);
  const audits =
    await db`SELECT id FROM audit_events WHERE resource_id = ${projectId} AND action = 'project.activities.import'`;
  expect(audits).toHaveLength(1);
});

test("1,000 activity changes have bounded review pages and one atomic apply", async ({ page }) => {
  const initial = await state();
  const template = initial.input.activities[0];
  if (!template) throw new Error("Missing CSV activity");
  initial.input.activities = Array.from({ length: 1000 }, (_, index) => ({
    ...template,
    id: randomUUID(),
    name: `Bulk CSV ${index + 1}`,
  }));
  await planner.replaceSchedule(context, projectId, initial.revision, initial.input);
  await page.getByRole("button", { name: "Reload saved version", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Bulk CSV 1",
  );
  for (const activity of initial.input.activities) activity.durationMinutes = 960;
  await page.getByRole("button", { name: "Import CSV", exact: true }).click();
  await selectFile(page, exportActivityCsv(initial.input));
  const started = performance.now();
  await page.getByRole("button", { name: "Preview CSV changes", exact: true }).click();
  const region = page.getByRole("region", { name: "CSV import preview", exact: true });
  await expect(region).toContainText("1000 changed");
  await expect(region.locator("tbody tr")).toHaveCount(50);
  await page.getByRole("button", { name: "Next changes", exact: true }).click();
  await expect(region.locator("caption")).toHaveText("Changes 51–100 of 1000");
  await page.getByRole("button", { name: "Previous changes", exact: true }).click();
  await expect(region.locator("caption")).toHaveText("Changes 1–50 of 1000");
  await page.getByRole("button", { name: "Apply CSV changes", exact: true }).click();
  await expect(page.locator(".liveStatus")).toContainText(
    "Imported 1000 activity changes at revision 4",
  );
  const after = await state();
  expect(after.input).toEqual(initial.input);
  console.log(
    `CSV 1000-activity browser preview, pagination and apply: ${(performance.now() - started).toFixed(1)} ms`,
  );
});
