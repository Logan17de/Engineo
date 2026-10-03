import { randomUUID } from "node:crypto";
import type { EngineProjectInputV1 } from "@engineo/contracts";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { createDatabase } from "../apps/api/src/db/client.js";
import { migrateDatabase } from "../apps/api/src/db/migrate.js";
import { tenantContext } from "../apps/api/src/db/tenant-context.js";
import { PlannerRepository } from "../apps/api/src/repositories/planner-repository.js";
import { ProjectRepository } from "../apps/api/src/repositories/project-repository.js";
import { hashPassword } from "../apps/api/src/security/password.js";

const db = createDatabase();
const password = "disposable-loopback-multi-tab-fixture";
let passwordHash = "";
type Account = { id: string; email: string };
type Fixture = {
  a: Account;
  b: Account;
  organization: string;
  project: string;
  input: EngineProjectInputV1;
  revision: number;
};
function barrier() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(shared = true): Promise<Fixture> {
  const a = { id: randomUUID(), email: `${randomUUID()}@example.test` };
  const b = { id: randomUUID(), email: `${randomUUID()}@example.test` };
  const organization = randomUUID(),
    foreign = randomUUID();
  await db.begin(async (sql) => {
    for (const user of [a, b]) {
      await sql`INSERT INTO users (id,email) VALUES (${user.id},${user.email})`;
      await sql`INSERT INTO password_credentials (user_id,password_hash) VALUES (${user.id},${passwordHash})`;
    }
    await sql`INSERT INTO organizations (id,slug,name) VALUES (${organization},${organization},'Multi-tab workspace'),(${foreign},${foreign},'Separate workspace')`;
    await sql`INSERT INTO organization_memberships (organization_id,user_id,role) VALUES (${organization},${a.id},'owner'),(${foreign},${b.id},'owner')`;
    if (shared)
      await sql`INSERT INTO organization_memberships (organization_id,user_id,role) VALUES (${organization},${b.id},'planner')`;
  });
  const context = tenantContext(organization, a.id, "multi-tab-fixture");
  const planner = new PlannerRepository(db);
  const created = await planner.createProject(context, {
    name: "Private tab project",
    code: null,
    description: null,
    plannedStart: "2026-10-05T08:00:00Z",
    timeZone: "UTC",
  });
  const state = await new ProjectRepository(db).plannerSnapshot(context, created.projectId);
  if (!state) throw new Error("Missing multi-tab fixture");
  state.input.activities = [
    {
      id: randomUUID(),
      name: "Original saved activity",
      wbsId: created.rootWbsId,
      calendarId: created.calendarId,
      kind: "TASK",
      durationMinutes: 480,
      constraints: [],
    },
  ];
  const revision = await planner.replaceSchedule(context, created.projectId, 1, state.input);
  if (shared)
    await db`INSERT INTO project_memberships (organization_id,project_id,user_id,role) VALUES (${organization},${created.projectId},${b.id},'planner')`;
  return { a, b, organization, project: created.projectId, input: state.input, revision };
}
const path = (data: Fixture) => `/api/organizations/${data.organization}/projects/${data.project}`;
async function login(page: Page, user: Account) {
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(user.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".account")).toContainText(user.email);
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
}
async function open(page: Page, data: Fixture) {
  await page.goto(`/?organization=${data.organization}&project=${data.project}`);
  await login(page, data.a);
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toBeVisible();
  const me = await page.request.get("/api/auth/me");
  expect(me.status()).toBe(200);
  return ((await me.json()) as { session: { id: string } }).session.id;
}
async function switchAccount(page: Page, data: Fixture) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page, data.b);
}
async function cleared(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Sign in to Engineo", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".projectCard")).toHaveCount(0);
  await expect(page.locator(".plannerPanel")).toHaveCount(0);
  await expect(page.getByText(/unsaved edits are kept in this tab/)).toHaveCount(0);
}
async function headers(page: Page, sessionId: string) {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "engineo_csrf");
  expect(csrf).toBeDefined();
  return {
    "x-csrf-token": csrf?.value ?? "",
    "x-engineo-session": sessionId,
    origin: "http://127.0.0.1:3100",
  };
}
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
const pageErrors = new WeakMap<BrowserContext, string[]>();
test.afterEach(async ({ context }) => {
  expect(pageErrors.get(context) ?? []).toEqual([]);
});

test("shared-project account switch clears the first tab and server rejects its old binding", async ({
  page,
  context,
}) => {
  const data = await fixture();
  const originalSession = await open(page, data);
  await page
    .getByRole("textbox", { name: "Activity 1 name", exact: true })
    .fill("A's unsaved private draft");
  const other = await context.newPage();
  await switchAccount(other, data);
  await cleared(page);
  const changed = structuredClone(data.input);
  const activity = changed.activities[0];
  if (!activity) throw new Error("Missing shared-project activity");
  activity.name = "Cannot save as B under A's identity";
  const denied = await page.request.put(`${path(data)}/schedule`, {
    headers: await headers(page, originalSession),
    data: { expectedRevision: data.revision, input: changed },
  });
  expect(denied.status()).toBe(409);
  expect((await denied.json()).error).toBe("session_changed");
  const current = await page.request.get(`${path(data)}/schedule`);
  expect(current.status()).toBe(200);
  expect(((await current.json()) as { revision: number }).revision).toBe(data.revision);
  const me = await other.request.get("/api/auth/me");
  const session = ((await me.json()) as { session: { id: string } }).session.id;
  activity.name = "B's explicitly authorized edit";
  const allowed = await other.request.put(`${path(data)}/schedule`, {
    headers: await headers(other, session),
    data: { expectedRevision: data.revision, input: changed },
  });
  expect(allowed.status()).toBe(200);
  const audits =
    await db`SELECT actor_id FROM audit_events WHERE organization_id=${data.organization} AND resource_id=${data.project} AND action='project.schedule.edit' ORDER BY occurred_at DESC`;
  expect(audits[0]?.actor_id).toBe(data.b.id);
  expect(audits).toHaveLength(2);
  await other.close();
});

test("forbidden-project account switch clears the old tab without exposing its project", async ({
  page,
  context,
}) => {
  const data = await fixture(false);
  await open(page, data);
  await page
    .getByRole("textbox", { name: "Activity 1 name", exact: true })
    .fill("A's forbidden draft");
  const other = await context.newPage();
  await switchAccount(other, data);
  await cleared(page);
  const denied = await other.request.get(`${path(data)}/schedule`);
  expect(denied.status()).toBe(403);
  expect(await denied.text()).not.toContain("Original saved activity");
  await other.close();
});

test("delayed project response cannot restore A's workspace after B signs in without BroadcastChannel", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true });
  });
  const data = await fixture();
  await open(page, data);
  const delayed = barrier();
  let fetched = false,
    delivered = false;
  await page.route("**/schedule", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    fetched = true;
    await delayed.promise;
    await route.fulfill({ response }).catch(() => {});
    delivered = true;
  });
  try {
    await page.getByRole("button", { name: "Reload saved version", exact: true }).click();
    await expect.poll(() => fetched).toBe(true);
    const other = await context.newPage();
    await switchAccount(other, data);
    delayed.release();
    await expect.poll(() => delivered).toBe(true);
    await cleared(page);
    await expect(page.locator(".account")).not.toContainText(data.a.email);
    await other.close();
  } finally {
    delayed.release();
    await page.unroute("**/schedule");
  }
});

test("a delayed committed save cannot calculate or repopulate A's tab using B's session", async ({
  page,
  context,
}) => {
  await context.addInitScript(() => {
    Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true });
  });
  const data = await fixture();
  await open(page, data);
  const delayed = barrier();
  let committed = false,
    delivered = false,
    runs = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/schedule/run")) runs++;
  });
  await page.route("**/schedule", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed = true;
    await delayed.promise;
    await route.fulfill({ response }).catch(() => {});
    delivered = true;
  });
  try {
    await page
      .getByRole("textbox", { name: "Activity 1 name", exact: true })
      .fill("A committed before switch");
    await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
    await expect.poll(() => committed).toBe(true);
    const other = await context.newPage();
    await switchAccount(other, data);
    delayed.release();
    await expect.poll(() => delivered).toBe(true);
    await page.bringToFront();
    await cleared(page);
    expect(runs).toBe(0);
    const current = await other.request.get(`${path(data)}/schedule`);
    expect(current.status()).toBe(200);
    const persisted = (await current.json()) as { revision: number; input: EngineProjectInputV1 };
    expect(persisted.revision).toBe(data.revision + 1);
    expect(persisted.input.activities[0]?.name).toBe("A committed before switch");
    const audits =
      await db`SELECT actor_id FROM audit_events WHERE organization_id=${data.organization} AND resource_id=${data.project} AND action='project.schedule.edit'`;
    expect(audits).toHaveLength(2);
    expect(audits.every((row) => row.actor_id === data.a.id)).toBe(true);
    await other.close();
  } finally {
    delayed.release();
    await page.unroute("**/schedule");
  }
});

test("a delayed initial identity response is discarded after another tab changes accounts", async ({
  page,
  context,
}) => {
  const data = await fixture(false);
  await open(page, data);
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
  const delayed = barrier();
  let fetched = false,
    delivered = false;
  await page.route("**/auth/me", async (route) => {
    const response = await route.fetch();
    fetched = true;
    await delayed.promise;
    await route.fulfill({ response }).catch(() => {});
    delivered = true;
  });
  try {
    await page.reload();
    await expect.poll(() => fetched).toBe(true);
    await other.getByRole("button", { name: "Sign out", exact: true }).click();
    await login(other, data.b);
    delayed.release();
    await expect.poll(() => delivered).toBe(true);
    await cleared(page);
  } finally {
    delayed.release();
    await page.unroute("**/auth/me");
    await other.close();
  }
});

test("explicit sign out after session expiry permanently discards the accepted dirty draft", async ({
  page,
}) => {
  const data = await fixture();
  const session = await open(page, data);
  await page
    .getByRole("textbox", { name: "Activity 1 name", exact: true })
    .fill("Discarded expired draft");
  await db`UPDATE auth_sessions SET revoked_at=now() WHERE id=${session}`;
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await cleared(page);
  await login(page, data.a);
  await page.locator(`.projectCard[data-project-id="${data.project}"]`).click();
  await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
    "Original saved activity",
  );
  await expect(page.locator(".revisionBadge")).not.toContainText("Unsaved edits");
});

for (const retainWriteAccess of [true, false]) {
  test(`same-account reauthentication in another tab retains expiry escrow and rechecks ${retainWriteAccess ? "write access" : "lost write access"}`, async ({
    page,
    context,
  }) => {
    const data = await fixture();
    const session = await open(page, data);
    await page
      .getByRole("textbox", { name: "Activity 1 name", exact: true })
      .fill("Escrow after same-account reauthentication");
    await db`UPDATE auth_sessions SET revoked_at=now() WHERE id=${session}`;
    await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
    await expect(page.getByText(/unsaved edits are kept in this tab/)).toBeVisible();
    if (!retainWriteAccess) {
      await db`UPDATE organization_memberships SET role='viewer' WHERE organization_id=${data.organization} AND user_id=${data.a.id}`;
      await db`UPDATE project_memberships SET role='viewer' WHERE organization_id=${data.organization} AND project_id=${data.project} AND user_id=${data.a.id}`;
    }
    const other = await context.newPage();
    await other.goto("/");
    // Reauthentication has no deliberate logout/discard intent.
    await login(other, data.a);
    await page.bringToFront();
    await expect(page.getByText(/unsaved edits are kept in this tab/)).toBeVisible();
    await expect(page.locator(".plannerPanel")).toHaveCount(0);
    await login(page, data.a);
    const activity = page.getByRole("textbox", { name: "Activity 1 name", exact: true });
    await expect(activity).toHaveValue(
      retainWriteAccess ? "Escrow after same-account reauthentication" : "Original saved activity",
    );
    if (retainWriteAccess) {
      await expect(page.locator(".revisionBadge")).toContainText("Unsaved edits");
    } else {
      await expect(activity).toBeDisabled();
      await expect(page.getByText(/project access changed/)).toBeVisible();
      await expect(page.locator(".revisionBadge")).not.toContainText("Unsaved edits");
    }
    const saved = await page.request.get(`${path(data)}/schedule`);
    expect(saved.status()).toBe(200);
    const state = (await saved.json()) as { revision: number; input: EngineProjectInputV1 };
    expect(state.revision).toBe(data.revision);
    expect(state.input.activities[0]?.name).toBe("Original saved activity");
    await other.close();
  });
}

for (const failure of ["unavailable", "offline", "held"] as const) {
  test(`without BroadcastChannel a changed cookie clears old data before ${failure} identity verification`, async ({
    page,
    context,
  }) => {
    await context.addInitScript(() => {
      Object.defineProperty(globalThis, "BroadcastChannel", {
        value: undefined,
        configurable: true,
      });
    });
    const data = await fixture();
    await open(page, data);
    await page
      .getByRole("textbox", { name: "Activity 1 name", exact: true })
      .fill("Unverified-account escrow");
    const delayed = barrier();
    let probed = false,
      first = true,
      delivered = false;
    await page.route("**/auth/me", async (route) => {
      if (!first) {
        await route.continue();
        return;
      }
      first = false;
      probed = true;
      if (failure === "offline") await route.abort("internetdisconnected");
      else if (failure === "unavailable")
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporarily_unavailable" }),
        });
      else {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        expect(((await response.json()) as { user: Account }).user.id).toBe(data.b.id);
        await delayed.promise;
        await route.fulfill({ response }).catch(() => {});
        delivered = true;
      }
    });
    const other = await context.newPage();
    try {
      await switchAccount(other, data);
      await page.bringToFront();
      await expect.poll(() => probed).toBe(true);
      await expect(
        page.getByRole("heading", { name: "Sign in to Engineo", exact: true }),
      ).toBeVisible({ timeout: 2000 });
      await expect(page.locator(".plannerPanel")).toHaveCount(0);
      await expect(page.locator(".projectCard")).toHaveCount(0);
      await expect(page.locator(".account")).not.toContainText(data.a.email);
      await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
        "verification did not finish",
        {
          timeout: 7000,
        },
      );
      await expect(page.getByRole("alert", { name: "Error", exact: true })).toBeFocused();
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
      // A failed probe cannot restore a workspace. Deliberate same-user login
      // can consume the scoped escrow only after ordinary fresh authorization.
      await login(page, data.a);
      await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
        "Unverified-account escrow",
      );
      delayed.release();
      if (failure === "held") await expect.poll(() => delivered).toBe(true);
      await expect(page.locator(".account")).toContainText(data.a.email);
    } finally {
      delayed.release();
      await page.unroute("**/auth/me");
      await other.close();
    }
  });
}

for (const sameAccount of [false, true]) {
  test(`verified ${sameAccount ? "same" : "different"} account ${sameAccount ? "retains" : "discards"} recovery before failed organization loading and unavailable fallback probes`, async ({
    page,
  }) => {
    const data = await fixture();
    const session = await open(page, data);
    const draftName = "Recovery scoped to the original immutable account";
    await page.getByRole("textbox", { name: "Activity 1 name", exact: true }).fill(draftName);
    await db`UPDATE auth_sessions SET revoked_at=now() WHERE id=${session}`;
    await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
    await expect(page.getByText(/unsaved edits are kept in this tab/)).toBeVisible();

    const account = sameAccount ? data.a : data.b;
    const organizationResponse = barrier();
    let verifiedIdentity = false,
      organizationsRequested = false,
      failedFallbackProbes = 0;
    await page.route("**/auth/me", async (route) => {
      if (verifiedIdentity) {
        await route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } });
        failedFallbackProbes++;
        return;
      }
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect(((await response.json()) as { user: Account }).user.id).toBe(account.id);
      verifiedIdentity = true;
      await route.fulfill({ response });
    });
    await page.route("**/api/organizations", async (route) => {
      organizationsRequested = true;
      await organizationResponse.promise;
      await route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } });
    });
    try {
      await page.getByRole("textbox", { name: "Email", exact: true }).fill(account.email);
      await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect.poll(() => verifiedIdentity && organizationsRequested).toBe(true);
      const recoveryNotice = page.getByText(/unsaved edits are kept in this tab/);
      // Verify the discard boundary while organization I/O is still pending.
      await expect(recoveryNotice).toHaveCount(sameAccount ? 1 : 0);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const event = new Event("beforeunload", { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
          }),
        )
        .toBe(sameAccount);
      organizationResponse.release();
      await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
      await expect(page.locator(".plannerPanel")).toHaveCount(0);
      await expect(page.locator(".projectCard")).toHaveCount(0);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      if (sameAccount) {
        await expect.poll(() => failedFallbackProbes).toBeGreaterThan(0);
        await expect(page.getByRole("alert", { name: "Error", exact: true })).toContainText(
          "verification did not finish",
        );
      } else expect(failedFallbackProbes).toBe(0);
      await expect(recoveryNotice).toHaveCount(sameAccount ? 1 : 0);
    } finally {
      organizationResponse.release();
      await page.unroute("**/api/organizations");
      await page.unroute("**/auth/me");
    }
    // A later explicit login must not resurrect a draft after verified B.
    await login(page, data.a);
    await expect(page.getByRole("textbox", { name: "Activity 1 name", exact: true })).toHaveValue(
      sameAccount ? draftName : "Original saved activity",
    );
    await expect(page.locator(".revisionBadge")).toContainText(
      sameAccount ? "Unsaved edits" : `Revision ${data.revision}`,
    );
    const saved = await page.request.get(`${path(data)}/schedule`);
    expect(saved.status()).toBe(200);
    const state = (await saved.json()) as { revision: number; input: EngineProjectInputV1 };
    expect(state.revision).toBe(data.revision);
    expect(state.input.activities[0]?.name).toBe("Original saved activity");
  });
}

for (const removed of ["organization", "project"] as const) {
  test(`same-account recovery discards escrow after actual ${removed} membership removal`, async ({
    page,
  }) => {
    const data = await fixture();
    const session = await open(page, data);
    await page
      .getByRole("textbox", { name: "Activity 1 name", exact: true })
      .fill("Escrow must be discarded after access loss");
    await db`UPDATE auth_sessions SET revoked_at=now() WHERE id=${session}`;
    await page.getByRole("button", { name: "Save & recalculate", exact: true }).click();
    await expect(page.getByText(/unsaved edits are kept in this tab/)).toBeVisible();
    if (removed === "organization")
      await db`DELETE FROM organization_memberships WHERE organization_id=${data.organization} AND user_id=${data.a.id}`;
    else {
      await db`UPDATE organization_memberships SET role='planner' WHERE organization_id=${data.organization} AND user_id=${data.a.id}`;
      await db`DELETE FROM project_memberships WHERE organization_id=${data.organization} AND project_id=${data.project} AND user_id=${data.a.id}`;
    }
    await login(page, data.a);
    await expect(page.locator(".plannerPanel")).toHaveCount(0);
    await expect(page.getByText(/project access changed/)).toBeVisible();
    await expect(page.getByText(/unsaved edits are kept in this tab/)).toHaveCount(0);
    const denied = await page.request.get(`${path(data)}/schedule`);
    expect(denied.status()).toBe(403);
    let unexpectedWarning = false;
    const observe = async (dialog: import("@playwright/test").Dialog) => {
      if (dialog.type() === "beforeunload") unexpectedWarning = true;
      await dialog.accept();
    };
    page.on("dialog", observe);
    await page.reload();
    page.off("dialog", observe);
    expect(unexpectedWarning).toBe(false);
    await expect(page.locator(".account")).toContainText(data.a.email);
    await expect(page.locator(".plannerPanel")).toHaveCount(0);
  });
}
