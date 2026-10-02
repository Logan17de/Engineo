import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { hashPassword } from "./security/password.js";
import { authorizeProject } from "./security/rbac.js";

test("auth changes remain atomic and tenant scoped under failure", {
  skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not configured",
}, async () => {
  const db = createDatabase();
  await migrateDatabase(db);
  const app = buildApp({ database: db });
  const organizationId = randomUUID();
  const userId = randomUUID();
  const projectId = randomUUID();
  const foreignOrganizationId = randomUUID();
  const foreignProjectId = randomUUID();
  const email = `${userId}@example.test`;
  const password = "correct horse battery staple";
  try {
    await db`INSERT INTO organizations (id, slug, name) VALUES (${organizationId}, ${organizationId}, 'Auth faults')`;
    await db`INSERT INTO organizations (id, slug, name) VALUES (${foreignOrganizationId}, ${foreignOrganizationId}, 'Foreign tenant')`;
    await db`INSERT INTO users (id, email) VALUES (${userId}, ${email})`;
    await db`INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (${organizationId}, ${userId}, 'admin')`;
    await db`INSERT INTO projects (id, organization_id, name) VALUES (${projectId}, ${organizationId}, 'Authorized project')`;
    await db`INSERT INTO projects (id, organization_id, name) VALUES (${foreignProjectId}, ${foreignOrganizationId}, 'Foreign project')`;
    await db`INSERT INTO password_credentials (user_id, password_hash) VALUES (${userId}, ${await hashPassword(password)})`;

    for (const role of ["admin", "owner"]) {
      await db`UPDATE organization_memberships SET role = ${role} WHERE organization_id = ${organizationId} AND user_id = ${userId}`;
      assert.equal(
        (await authorizeProject(db, userId, organizationId, projectId, "project.read")).allowed,
        true,
      );
      assert.equal(
        (await authorizeProject(db, userId, organizationId, foreignProjectId, "project.read"))
          .allowed,
        false,
      );
      assert.equal(
        (
          await authorizeProject(
            db,
            userId,
            foreignOrganizationId,
            foreignProjectId,
            "project.write",
          )
        ).allowed,
        false,
      );
      assert.equal(
        (await authorizeProject(db, userId, organizationId, randomUUID(), "project.read")).allowed,
        false,
      );
    }

    await db.unsafe(`
      CREATE FUNCTION engineo_test_auth_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action IN ('auth.login', 'auth.logout') THEN
          RAISE EXCEPTION 'private audit failure details';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER engineo_test_auth_audit_failure BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION engineo_test_auth_audit_failure();
    `);
    const failed = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password },
    });
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.headers["set-cookie"], undefined);
    assert.equal(failed.body.includes("private audit"), false);
    assert.equal(
      Number(
        (await db`SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = ${userId}`)[0]
          ?.total,
      ),
      0,
    );

    await db.unsafe("ALTER TABLE audit_events DISABLE TRIGGER engineo_test_auth_audit_failure");
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password },
      headers: { cookie: "engineo_session=attacker_fixed_value; engineo_csrf=attacker_fixed_csrf" },
    });
    assert.equal(login.statusCode, 200);
    const issued = login.headers["set-cookie"];
    const values = Array.isArray(issued) ? issued : [issued ?? ""];
    const cookie = values.map((value) => value.split(";")[0]).join("; ");
    const csrf = values
      .find((value) => value.startsWith("engineo_csrf="))
      ?.split(";")[0]
      ?.slice(13);
    assert.ok(csrf);
    assert.equal(cookie.includes("attacker_fixed"), false);

    await db.unsafe("ALTER TABLE audit_events ENABLE TRIGGER engineo_test_auth_audit_failure");
    const failedLogout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie, "x-csrf-token": csrf },
    });
    assert.equal(failedLogout.statusCode, 500);
    assert.equal(failedLogout.headers["set-cookie"], undefined);
    assert.equal(
      (await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode,
      200,
    );
    assert.equal(
      Number(
        (
          await db`SELECT count(*)::int AS total FROM audit_events WHERE actor_id = ${userId} AND action = 'auth.logout'`
        )[0]?.total,
      ),
      0,
    );

    await db.unsafe("ALTER TABLE audit_events DISABLE TRIGGER engineo_test_auth_audit_failure");
    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie, "x-csrf-token": csrf },
    });
    assert.equal(logout.statusCode, 204);
    assert.equal(
      (await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode,
      401,
    );
    assert.equal(
      Number(
        (
          await db`SELECT count(*)::int AS total FROM audit_events WHERE actor_id = ${userId} AND action = 'auth.logout'`
        )[0]?.total,
      ),
      1,
    );
  } finally {
    await db.unsafe(
      "DROP TRIGGER IF EXISTS engineo_test_auth_audit_failure ON audit_events; DROP FUNCTION IF EXISTS engineo_test_auth_audit_failure();",
    );
    await app.close();
    await db.end({ timeout: 5 });
  }
});
