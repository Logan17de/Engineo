import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { hashPassword, verifyPassword } from "./security/password.js";
import { authorizeProject } from "./security/rbac.js";

const databaseUrl = process.env.DATABASE_URL;

function cookieHeader(setCookie: string | string[] | undefined): {
  cookie: string;
  csrf: string;
} {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const pairs = values.map((value) => value.split(";", 1)[0] ?? "");
  const csrf = pairs
    .find((value) => value.startsWith("engineo_csrf="))
    ?.slice("engineo_csrf=".length);

  assert.ok(csrf, "login must issue a CSRF cookie");
  return {
    cookie: pairs.join("; "),
    csrf: decodeURIComponent(csrf),
  };
}

test("scrypt password hashes verify without storing plaintext", async () => {
  const hash = await hashPassword("correct horse battery staple");

  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("wrong password", hash), false);
  assert.equal(hash.includes("correct horse battery staple"), false);
});

test("corrupt scrypt work parameters fail closed without throwing", async () => {
  const hash = await hashPassword("correct horse battery staple");
  const password = "correct horse battery staple";
  assert.equal(await verifyPassword(password, hash.replace("32768", "32769")), false);
  assert.equal(await verifyPassword(password, hash.replace("32768$8", "65536$16")), false);
  assert.equal(await verifyPassword(password, `${hash}$trailing`), false);
  assert.equal(await verifyPassword(password, hash.replace("32768", "32768suffix")), false);
});

test("database-backed auth enforces CSRF revocation and project RBAC", {
  skip: databaseUrl ? false : "DATABASE_URL is not configured",
}, async () => {
  const db = createDatabase({
    url: databaseUrl!,
    maxConnections: 4,
    idleTimeoutSeconds: 5,
    connectTimeoutSeconds: 5,
  });

  try {
    await db.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrateDatabase(db);

    const organizationId = randomUUID();
    const userId = randomUUID();
    const projectId = randomUUID();

    await db`
        INSERT INTO organizations (id, slug, name)
        VALUES (${organizationId}, 'security-org', 'Security Org')
      `;
    await db`
        INSERT INTO users (id, email, display_name)
        VALUES (${userId}, 'security@example.test', 'Security User')
      `;
    await db`
        INSERT INTO organization_memberships (organization_id, user_id, role)
        VALUES (${organizationId}, ${userId}, 'planner')
      `;
    await db`
        INSERT INTO projects (id, organization_id, name, code)
        VALUES (${projectId}, ${organizationId}, 'Secure Project', 'SEC-1')
      `;
    await db`
        INSERT INTO project_memberships (organization_id, project_id, user_id, role)
        VALUES (${organizationId}, ${projectId}, ${userId}, 'planner')
      `;

    const passwordHash = await hashPassword("correct horse battery staple");
    await db`
        INSERT INTO password_credentials (user_id, password_hash)
        VALUES (${userId}, ${passwordHash})
      `;

    const decision = await authorizeProject(db, userId, organizationId, projectId, "project.write");
    assert.equal(decision.allowed, true);
    assert.equal(decision.projectRole, "planner");

    const app = buildApp({ database: db });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          email: "security@example.test",
          password: "correct horse battery staple",
        },
      });
      assert.equal(login.statusCode, 200);
      assert.equal(login.headers["x-content-type-options"], "nosniff");
      const authCookies = cookieHeader(login.headers["set-cookie"]);

      const me = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: {
          cookie: authCookies.cookie,
        },
      });
      assert.equal(me.statusCode, 200);
      assert.equal(me.json().user.id, userId);

      const missingCsrf = await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: {
          cookie: authCookies.cookie,
        },
      });
      assert.equal(missingCsrf.statusCode, 403);

      const logout = await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: {
          cookie: authCookies.cookie,
          "x-csrf-token": authCookies.csrf,
        },
      });
      assert.equal(logout.statusCode, 204);

      const revoked = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: {
          cookie: authCookies.cookie,
        },
      });
      assert.equal(revoked.statusCode, 401);

      const audit = await db`
          SELECT action
          FROM audit_events
          WHERE organization_id = ${organizationId}
            AND actor_id = ${userId}
          ORDER BY occurred_at, action
        `;
      assert.deepEqual(
        audit.map((row) => row.action),
        ["auth.login", "auth.logout"],
      );

      await db`
          UPDATE password_credentials
          SET mfa_required = true
          WHERE user_id = ${userId}
        `;
      const mfaBlocked = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          email: "security@example.test",
          password: "correct horse battery staple",
        },
      });
      assert.equal(mfaBlocked.statusCode, 403);
      assert.equal(mfaBlocked.json().error, "mfa_required");
    } finally {
      await app.close();
    }
  } finally {
    await db.end({ timeout: 5 });
  }
});
