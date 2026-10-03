import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { EngineProjectInputV1, ScheduleCalculationMetadataV1 } from "@engineo/contracts";
import { type BrowserContext, expect, type Page, type TestInfo } from "@playwright/test";
import { createDatabase } from "../apps/api/src/db/client.js";
import { migrateDatabase } from "../apps/api/src/db/migrate.js";
import { tenantContext } from "../apps/api/src/db/tenant-context.js";
import { PlannerRepository } from "../apps/api/src/repositories/planner-repository.js";
import { ProjectRepository } from "../apps/api/src/repositories/project-repository.js";
import { hashPassword } from "../apps/api/src/security/password.js";
import { test } from "./fixtures.mjs";

const db = createDatabase();
const password = "disposable-loopback-calculation-fixture";
let passwordHash = "";
type Account = { id: string; email: string };
type Fixture = {
  owner: Account;
  viewer: Account;
  foreign: Account;
  organization: string;
  project: string;
  input: EngineProjectInputV1;
  revision: number;
};
const path = (data: Fixture) => `/api/organizations/${data.organization}/projects/${data.project}`;
function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(): Promise<Fixture> {
  const owner = { id: randomUUID(), email: `${randomUUID()}@example.test` };
  const viewer = { id: randomUUID(), email: `${randomUUID()}@example.test` };
  const foreign = { id: randomUUID(), email: `${randomUUID()}@example.test` };
  const organization = randomUUID(),
    foreignOrganization = randomUUID();
  await db.begin(async (sql) => {
    for (const user of [owner, viewer, foreign]) {
      await sql`INSERT INTO users (id,email) VALUES (${user.id},${user.email})`;
      await sql`INSERT INTO password_credentials (user_id,password_hash) VALUES (${user.id},${passwordHash})`;
    }
    await sql`INSERT INTO organizations (id,slug,name) VALUES (${organization},${organization},'Calculation workspace'),(${foreignOrganization},${foreignOrganization},'Foreign workspace')`;
    await sql`INSERT INTO organization_memberships (organization_id,user_id,role) VALUES (${organization},${owner.id},'owner'),(${organization},${viewer.id},'viewer'),(${foreignOrganization},${foreign.id},'owner')`;
  });
  const context = tenantContext(organization, owner.id, "calculation-browser-fixture");
  const planner = new PlannerRepository(db);
  const project = await planner.createProject(context, {
    name: "Durable browser calculation",
    code: null,
    description: null,
    plannedStart: "2026-10-05T08:00:00Z",
    timeZone: "UTC",
  });
  const snapshot = await new ProjectRepository(db).plannerSnapshot(context, project.projectId);
  if (!snapshot) throw new Error("Missing calculation fixture");
  snapshot.input.activities = [
    {
      id: randomUUID(),
      name: "Persisted activity",
      wbsId: project.rootWbsId,
      calendarId: project.calendarId,
      kind: "TASK",
      durationMinutes: 480,
      constraints: [],
    },
  ];
  const revision = await planner.replaceSchedule(context, project.projectId, 1, snapshot.input);
  await db`INSERT INTO project_memberships (organization_id,project_id,user_id,role) VALUES (${organization},${project.projectId},${viewer.id},'viewer')`;
  return {
    owner,
    viewer,
    foreign,
    organization,
    project: project.projectId,
    input: snapshot.input,
    revision,
  };
}
async function login(page: Page, user: Account) {
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(user.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".account")).toContainText(user.email);
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
}
async function open(page: Page, data: Fixture) {
  await page.goto(`/?organization=${data.organization}&project=${data.project}`);
  await login(page, data.owner);
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toBeVisible();
}
async function saved(page: Page, data: Fixture) {
  const response = await page.request.get(`${path(data)}/schedule/result`);
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    revision: number;
    calculation: ScheduleCalculationMetadataV1 | null;
  };
}
async function calculate(page: Page) {
  await page.getByRole("button", { name: /^(Save & recalculate|Recalculate)$/ }).click();
  await expect(page.locator(".liveStatus")).toContainText("Schedule calculated");
  await expect(page.locator(".ganttBar")).toHaveCount(1);
}
async function toolbarGeometry(page: Page) {
  return page.locator(".toolbarActions > button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const { x, y, width, height } = button.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
}
async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}
async function headers(page: Page) {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "engineo_csrf");
  if (!csrf) throw new Error("Missing fixture CSRF cookie");
  return { "x-csrf-token": csrf.value, origin: "http://127.0.0.1:3100" };
}
test.beforeAll(async () => {
  await migrateDatabase(db);
  passwordHash = await hashPassword(password);
});
test.afterAll(async () => {
  await db.end({ timeout: 5 });
});
const pageErrors = new WeakMap<BrowserContext, string[]>();
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

test("calculated dates and provenance survive reload and disappear for an unsaved draft", async ({
  page,
}, testInfo) => {
  const data = await fixture();
  await open(page, data);
  await calculate(page);
  const initial = await saved(page, data);
  expect(initial.calculation).not.toBeNull();
  await page.reload();
  await expect(page.locator(".liveStatus")).toContainText("Saved calculation restored");
  await expect(page.locator(".ganttBar")).toHaveCount(1);
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByLabel("Saved calculation provenance")).toContainText(
    `revision ${data.revision}`,
  );
  await capture(page, testInfo, "saved-calculation-provenance");
  await page.getByRole("button", { name: "Activities", exact: true }).click();
  await page.getByRole("textbox", { name: "Activity 1 name", exact: true }).fill("Unsaved name");
  await expect(page.locator(".ganttBar")).toHaveCount(0);
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByLabel("Saved calculation provenance")).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reload saved version", exact: true }).click();
  expect((await saved(page, data)).calculation?.calculationId).toBe(
    initial.calculation?.calculationId,
  );
  await expect(page.locator(".ganttBar")).toHaveCount(1);
});

test("a viewer can restore saved dates without permission to recalculate", async ({ page }) => {
  const data = await fixture();
  await open(page, data);
  await calculate(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page, data.viewer);
  await page.locator(`.projectCard[data-project-id="${data.project}"]`).click();
  await expect(page.locator(".ganttBar")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Recalculate", exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toBeDisabled();
  expect((await saved(page, data)).calculation).not.toBeNull();
});

test("retry after a failed post-save snapshot refresh uses persisted bytes without repeating the edit", async ({
  page,
}) => {
  const data = await fixture();
  await open(page, data);
  await page
    .getByRole("spinbutton", { name: "Number of activities to add", exact: true })
    .fill("1");
  await page.getByRole("button", { name: "Add activities", exact: true }).click();
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await page
    .getByRole("region", { name: "Project planner", exact: true })
    .getByLabel("Planned start (UTC)", { exact: true })
    .fill("2026-10-06T08:00");
  let writes = 0,
    runs = 0,
    failRefresh = true;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/schedule/run")) runs++;
  });
  await page.route("**/schedule", async (route) => {
    if (route.request().method() === "PUT") {
      writes++;
      await route.continue();
    } else if (failRefresh) {
      failRefresh = false;
      await route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } });
    } else await route.continue();
  });
  try {
    await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
    await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
      "temporarily unavailable",
    );
    await expect(page.locator(".revisionBadge")).not.toContainText("Unsaved edits");
    expect(writes).toBe(1);
    expect(runs).toBe(0);
    await page.getByRole("button", { name: "Recalculate", exact: true }).click();
    await expect(page.locator(".liveStatus")).toContainText("Schedule calculated");
    await page.getByRole("button", { name: "Activities", exact: true }).click();
    await expect(page.locator(".ganttBar")).toHaveCount(2);
    expect(writes).toBe(1);
    expect(runs).toBe(1);
    const current = await saved(page, data);
    expect(current.revision).toBe(data.revision + 1);
    expect(current.calculation).not.toBeNull();
  } finally {
    await page.unroute("**/schedule");
  }
});

for (const failure of ["network", "truncated JSON", "unclassified 500"] as const) {
  test(`a committed calculation with ${failure} response recovers by read without duplicate POST or audit`, async ({
    page,
  }) => {
    const data = await fixture();
    await open(page, data);
    let posts = 0;
    await page.route("**/schedule/run", async (route) => {
      posts++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      if (failure === "network") await route.abort("internetdisconnected");
      else if (failure === "truncated JSON")
        await route.fulfill({
          status: 200,
          headers: { ...response.headers(), "content-length": "1" },
          body: "{",
        });
      else await route.fulfill({ status: 500, json: { error: "internal_error" } });
    });
    await page.getByRole("button", { name: "Recalculate", exact: true }).click();
    await expect(page.locator(".liveStatus")).toContainText("Recovered saved calculation");
    await expect(page.locator(".ganttBar")).toHaveCount(1);
    expect(posts).toBe(1);
    await page.unroute("**/schedule/run");
    const initial = await saved(page, data);
    await page.getByRole("button", { name: "Recalculate", exact: true }).dblclick();
    await expect(page.locator(".liveStatus")).toContainText("Schedule calculated");
    expect((await saved(page, data)).calculation?.calculationId).toBe(
      initial.calculation?.calculationId,
    );
    const audits =
      await db`SELECT id FROM audit_events WHERE organization_id=${data.organization} AND resource_id=${data.project} AND action='schedule.run'`;
    expect(audits).toHaveLength(1);
  });
}

for (const width of [1440, 780]) {
  test(`planner action targets stay fixed through save, repeated clicks and explicit cancellation at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 960 });
    const data = await fixture();
    await open(page, data);
    const idle = await toolbarGeometry(page);
    const action = page.locator(".toolbarActions .primary");
    const target = await action.boundingBox();
    if (!target) throw new Error("Missing calculation action target");
    await expect(page.getByRole("button", { name: "Stop request", exact: true })).toHaveCount(0);
    await expect(page.locator(".requestStop")).toBeDisabled();
    await expect(page.locator(".requestStop")).toHaveAttribute("tabindex", "-1");
    await page
      .getByRole("textbox", { name: "Activity 1 name", exact: true })
      .fill("Repeated-click saved edit");
    await expect(action).toHaveAccessibleName("Save & recalculate");
    const dirty = await toolbarGeometry(page);
    expect(dirty).toEqual(idle);

    let writes = 0,
      runs = 0;
    page.on("request", (request) => {
      if (request.method() === "PUT" && request.url().endsWith("/schedule")) writes++;
      if (request.method() === "POST" && request.url().endsWith("/schedule/run")) runs++;
    });
    const pendingRun = barrier();
    await page.route("**/schedule/run", async (route) => {
      await pendingRun.promise;
      await route.continue();
    });
    try {
      await page.getByRole("button", { name: "Save & recalculate", exact: true }).dblclick();
      await expect.poll(() => runs).toBe(1);
      await expect(action).toHaveAccessibleName("Recalculate");
      await expect(page.locator(".revisionBadge")).not.toContainText("Unsaved edits");
      await expect(action).toBeDisabled();
      await expect(page.getByRole("button", { name: "Stop request", exact: true })).toBeEnabled();
      const saving = await toolbarGeometry(page);
      expect(saving).toEqual(idle);
      await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
      await expect(page.getByRole("alert", { name: "Error", exact: true })).toHaveCount(0);
      expect(writes).toBe(1);
      expect(runs).toBe(1);
      const geometryPath = testInfo.outputPath("stable-planner-action-geometry.json");
      await writeFile(
        geometryPath,
        JSON.stringify({ viewportWidth: width, idle, dirty, saving }, null, 2),
      );
      await testInfo.attach("stable-planner-action-geometry", {
        path: geometryPath,
        contentType: "application/json",
      });
      await capture(page, testInfo, "repeat-click-busy-toolbar");
      pendingRun.release();
      await expect(page.locator(".liveStatus")).toContainText("Schedule calculated");
    } finally {
      pendingRun.release();
      await page.unrouteAll({ behavior: "wait" });
    }
    const initial = await saved(page, data);
    expect(initial.revision).toBe(data.revision + 1);
    expect(initial.calculation).not.toBeNull();
    const recalculationIdle = await toolbarGeometry(page);
    const pendingRead = barrier();
    let readRequested = false,
      stopRequested = false;
    await page.route("**/schedule", async (route) => {
      expect(route.request().method()).toBe("GET");
      readRequested = true;
      await pendingRead.promise;
      try {
        await route.continue();
      } catch (error) {
        // Explicit Stop detaches the intercepted GET before its barrier is released.
        if (!stopRequested) throw error;
      }
    });
    try {
      await page.getByRole("button", { name: "Recalculate", exact: true }).dblclick();
      await expect.poll(() => readRequested).toBe(true);
      await expect(action).toBeDisabled();
      await expect(page.getByRole("button", { name: "Stop request", exact: true })).toBeEnabled();
      expect(await toolbarGeometry(page)).toEqual(recalculationIdle);
      await expect(page.getByRole("alert", { name: "Error", exact: true })).toHaveCount(0);
      expect(writes).toBe(1);
      expect(runs).toBe(1);
      stopRequested = true;
      await page.getByRole("button", { name: "Stop request", exact: true }).click();
      await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
        "Request stopped",
      );
      await expect(action).toBeEnabled();
      await expect(page.getByRole("button", { name: "Stop request", exact: true })).toHaveCount(0);
      await expect(page.locator(".requestStop")).toBeHidden();
      await expect(page.locator(".requestStop")).toBeDisabled();
      await expect(page.locator(".requestStop")).toHaveAttribute("tabindex", "-1");
      await capture(page, testInfo, "intentional-cancel-toolbar");
    } finally {
      pendingRead.release();
      await page.unrouteAll({ behavior: "wait" });
    }
    await calculate(page);
    expect(writes).toBe(1);
    expect(runs).toBe(2);
    expect((await saved(page, data)).calculation?.calculationId).toBe(
      initial.calculation?.calculationId,
    );
    const audits =
      await db`SELECT id FROM audit_events WHERE organization_id=${data.organization} AND resource_id=${data.project} AND action='schedule.run'`;
    expect(audits).toHaveLength(1);
  });
}

test("an explicit engine-integrity conflict remains failed even when an older saved result exists", async ({
  page,
}) => {
  const data = await fixture();
  await open(page, data);
  await calculate(page);
  expect((await saved(page, data)).calculation).not.toBeNull();
  let recoveryReads = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/schedule/result")) recoveryReads++;
  });
  await page.route("**/schedule/run", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: "schedule_result_conflict",
        message: "Calculation result changed for the same engine and input.",
      },
    }),
  );
  await page.getByRole("button", { name: "Recalculate", exact: true }).click();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
    "result changed",
  );
  await expect(page.locator(".liveStatus")).not.toContainText("Recovered saved calculation");
  await expect(page.locator(".ganttBar")).toHaveCount(0);
  expect(recoveryReads).toBe(0);
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByLabel("Saved calculation provenance")).toHaveCount(0);
  await page.unroute("**/schedule/run");
});

test("optional result-read failure preserves the saved plan and explicit reload restores dates", async ({
  page,
}) => {
  const data = await fixture();
  await open(page, data);
  await calculate(page);
  await page.route("**/schedule/result", (route) => route.abort("internetdisconnected"));
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Persisted activity",
  );
  await expect(page.locator(".liveStatus")).toContainText("Saved calculation could not be loaded");
  await expect(page.locator(".ganttBar")).toHaveCount(0);
  await page.unroute("**/schedule/result");
  await page.getByRole("button", { name: "Reload saved version", exact: true }).click();
  await expect(page.locator(".ganttBar")).toHaveCount(1);
  await expect(page.locator(".liveStatus")).toContainText("Saved calculation restored");
});

test("stored-result integrity failure is visible while the saved plan remains editable", async ({
  page,
}) => {
  const data = await fixture();
  await open(page, data);
  await calculate(page);
  await page.route("**/schedule/result", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: "schedule_invalid_output",
        message: "Stored calculation failed integrity validation.",
      },
    }),
  );
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Persisted activity",
  );
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toBeEnabled();
  await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
    "integrity validation",
  );
  await expect(page.locator(".ganttBar")).toHaveCount(0);
  await page.unroute("**/schedule/result");
  await page.getByRole("button", { name: "Reload saved version", exact: true }).click();
  await expect(page.locator(".ganttBar")).toHaveCount(1);
});

test("session expiry during startup result reading clears the verified account and surfaces the error", async ({
  page,
}) => {
  const data = await fixture();
  await open(page, data);
  await calculate(page);
  const pending = barrier();
  let snapshotDelivered = false,
    permissionsDelivered = false,
    resultRequested = false,
    resultUnauthorized = false;
  await page.route("**/schedule", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({ response });
    snapshotDelivered = true;
  });
  const detailPath = `**/api/organizations/${data.organization}/projects/${data.project}`;
  await page.route(detailPath, async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    await route.fulfill({ response });
    permissionsDelivered = true;
  });
  await page.route("**/schedule/result", async (route) => {
    resultRequested = true;
    await pending.promise;
    const response = await route.fetch();
    expect(response.status()).toBe(401);
    resultUnauthorized = true;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.reload();
    await expect
      .poll(() => snapshotDelivered && permissionsDelivered && resultRequested)
      .toBe(true);
    await db`UPDATE auth_sessions SET revoked_at=now() WHERE user_id=${data.owner.id} AND revoked_at IS NULL`;
    pending.release();
    await expect.poll(() => resultUnauthorized).toBe(true);
    await expect(
      page.getByRole("heading", { name: "Sign in to Engineo", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
      "session has ended",
    );
    await expect(page.locator(".account")).not.toContainText(data.owner.email);
    await expect(page.locator(".plannerPanel")).toHaveCount(0);
    await expect(page.locator(".projectCard")).toHaveCount(0);
  } finally {
    pending.release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await login(page, data.owner);
  await expect(page.locator(".ganttBar")).toHaveCount(1);
});

test("a revision changed while reading calculations cannot attach newer dates to an older snapshot", async ({
  page,
}) => {
  const data = await fixture();
  await open(page, data);
  await calculate(page);
  const pending = barrier();
  let requested = false,
    oldSnapshotDelivered = false;
  await page.route("**/schedule", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    expect(((await response.json()) as { revision: number }).revision).toBe(data.revision);
    await route.fulfill({ response });
    oldSnapshotDelivered = true;
  });
  await page.route("**/schedule/result", async (route) => {
    requested = true;
    await pending.promise;
    await route.continue();
  });
  try {
    await page.reload();
    await expect.poll(() => requested && oldSnapshotDelivered).toBe(true);
    const changed = structuredClone(data.input);
    const activity = changed.activities[0];
    if (!activity) throw new Error("Missing fixture activity");
    activity.name = "Changed concurrently";
    const edited = await page.request.put(`${path(data)}/schedule`, {
      headers: await headers(page),
      data: { expectedRevision: data.revision, input: changed },
    });
    expect(edited.status()).toBe(200);
    pending.release();
    await expect(page.locator(".liveStatus")).toContainText("project changed while loading");
    await expect(page.locator(".ganttBar")).toHaveCount(0);
  } finally {
    pending.release();
    await page.unrouteAll({ behavior: "wait" });
  }
  await page.getByRole("button", { name: "Reload saved version", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Changed concurrently",
  );
  await expect(page.locator(".ganttBar")).toHaveCount(0);
  expect((await saved(page, data)).calculation).toBeNull();
});

test("same-account expiry recovery does not attach saved dates to restored unsaved inputs", async ({
  page,
}) => {
  const data = await fixture();
  await open(page, data);
  await calculate(page);
  await page
    .getByRole("textbox", { name: "Activity 1 name", exact: true })
    .fill("Recovered unsaved input");
  await db`UPDATE auth_sessions SET revoked_at=now() WHERE user_id=${data.owner.id} AND revoked_at IS NULL`;
  await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
  await expect(page.getByText(/unsaved edits are kept in this tab/)).toBeVisible();
  await login(page, data.owner);
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Recovered unsaved input",
  );
  await expect(page.locator(".ganttBar")).toHaveCount(0);
  await expect(page.locator(".revisionBadge")).toContainText("Unsaved edits");
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.getByLabel("Saved calculation provenance")).toHaveCount(0);
  expect((await saved(page, data)).calculation).not.toBeNull();
});

test("a delayed saved result cannot repopulate an old tab after another account signs in", async ({
  page,
  context,
}) => {
  const data = await fixture();
  await open(page, data);
  await calculate(page);
  const pending = barrier();
  let fetched = false;
  await page.route("**/schedule/result", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    fetched = true;
    await pending.promise;
    await route.fulfill({ response }).catch(() => {});
  });
  const other = await context.newPage();
  try {
    await page.reload();
    await expect.poll(() => fetched).toBe(true);
    await other.goto("/");
    await expect(other.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
    await other.getByRole("button", { name: "Sign out", exact: true }).click();
    await login(other, data.foreign);
    pending.release();
    await expect(
      page.getByRole("heading", { name: "Sign in to Engineo", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".plannerPanel")).toHaveCount(0);
    await expect(page.locator(".ganttBar")).toHaveCount(0);
    await expect(page.locator(".account")).not.toContainText(data.owner.email);
  } finally {
    pending.release();
    try {
      await page.unrouteAll({ behavior: "wait" });
    } finally {
      await other.close();
    }
  }
});
