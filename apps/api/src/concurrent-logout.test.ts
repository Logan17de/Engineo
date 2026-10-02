import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { migrateDatabase } from "./db/migrate.js";
import { issueSession } from "./security/session.js";

test("already-authenticated concurrent logout requests append one audit per organization", {
  skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not configured",
}, async () => {
  const db = createDatabase();
  await migrateDatabase(db);
  let releaseTransactions: () => void = () => {};
  let bothArrived: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseTransactions = resolve;
  });
  const authenticated = new Promise<void>((resolve) => {
    bothArrived = resolve;
  });
  let arrivals = 0;
  // Gate only transaction admission, after the actual session and CSRF queries
  // have succeeded. SQL results are genuine and neither revocation is mocked.
  const coordinatedDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "begin") return Reflect.get(target, property, receiver);
      return async (...args: unknown[]) => {
        arrivals++;
        if (arrivals === 2) bothArrived();
        await gate;
        return await Reflect.apply(target.begin, target, args);
      };
    },
  });
  const app = buildApp({ database: coordinatedDb });
  const org = randomUUID(),
    user = randomUUID(),
    email = `${user}@example.test`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requests: Promise<unknown>[] = [];
  try {
    await db`INSERT INTO organizations (id, slug, name) VALUES (${org}, ${org}, 'Concurrent logout')`;
    await db`INSERT INTO users (id, email) VALUES (${user}, ${email})`;
    await db`INSERT INTO organization_memberships (organization_id, user_id, role) VALUES (${org}, ${user}, 'owner')`;
    const session = await issueSession(db, user, email, null, undefined);
    const options = {
      method: "POST" as const,
      url: "/auth/logout",
      headers: {
        cookie: `engineo_session=${session.token}; engineo_csrf=${session.csrfToken}`,
        "x-csrf-token": session.csrfToken,
      },
    };
    const first = app.inject(options),
      second = app.inject(options);
    requests = [first, second];
    await Promise.race([
      authenticated,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Both authenticated logout requests must reach transaction admission"),
            ),
          3000,
        );
      }),
    ]);
    clearTimeout(timer);
    releaseTransactions();
    const responses = await Promise.all([first, second]);
    assert.deepEqual(
      responses.map((response) => response.statusCode),
      [204, 204],
    );
    for (const response of responses) assert.ok(response.headers["set-cookie"]);
    const rows = await db`SELECT count(*)::int AS count FROM audit_events
      WHERE organization_id = ${org} AND resource_id = ${session.principal.sessionId} AND action = 'auth.logout'`;
    assert.equal(Number(rows[0]?.count), 1);
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/auth/me",
          headers: { cookie: options.headers.cookie },
        })
      ).statusCode,
      401,
    );
  } finally {
    clearTimeout(timer);
    releaseTransactions();
    await Promise.allSettled(requests);
    await app.close();
    await db.end({ timeout: 5 });
  }
});
