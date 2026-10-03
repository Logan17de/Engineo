import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import {
  assertSerialBrowserScenario,
  browserDatabaseEnvironment,
  browserDatabaseSource,
  createBrowserDatabase,
  resetBrowserLoginQuota,
} from "./browser-test-database.mjs";

const runId = "610b4860-c601-4949-b065-ac1d04f7d650";
const name = `engineo_browser_${runId.replaceAll("-", "_")}`;
const identity = { address: "127.0.0.1", port: 5432 };
const pin = JSON.stringify(identity);
const marker = (id = runId, server = pin) => ({ run_id: id, server_identity: server });
const env = {
  DATABASE_URL: `postgres://engineo@127.0.0.1:5432/${name}`,
  ENGINEO_BROWSER_TEST_RUN_ID: runId,
  ENGINEO_BROWSER_TEST_SERVER_ID: pin,
};

function simulatedServer(sourceIdentity, fixtureIdentity = sourceIdentity) {
  const queries = [];
  const markers = new Map();
  let observedFixture = fixtureIdentity;
  const connect = (url) => {
    const database = new URL(url).pathname.slice(1);
    const sql = async (strings, ...values) => {
      if (typeof strings === "string") return strings;
      const query = strings.join("?");
      queries.push({ database, query, values });
      if (query.includes("current_database()")) {
        return [{ name: database, ...(database === "engineo" ? sourceIdentity : observedFixture) }];
      }
      if (query.includes("INSERT INTO public.engineo_browser_test_guard")) {
        markers.set(database, [marker(values[0], values[1])]);
      } else if (query.includes("SELECT run_id::text")) {
        return markers.get(database) ?? [];
      }
      return [];
    };
    // Identifier construction is synchronous, as in the postgres client.
    const client = (strings, ...values) =>
      typeof strings === "string" ? strings : sql(strings, ...values);
    client.begin = (operation) => operation(client);
    client.end = async () => {};
    return client;
  };
  return {
    connect,
    queries,
    changeFixture: (identity) => {
      observedFixture = identity;
    },
  };
}

test("browser database URLs reject remote sources and connection overrides", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    assert.equal(browserDatabaseSource(`postgresql://engineo@${host}:5432/engineo`).hostname, host);
  }
  for (const url of [
    undefined,
    "not a URL",
    "postgres://engineo@database.example/engineo",
    "https://127.0.0.1/engineo",
    "postgres://engineo@127.0.0.1/",
    "postgres://engineo@127.0.0.1/engineo?host=database.example",
    "postgres://engineo@127.0.0.1/engineo?dbname=production",
    "postgres://engineo@127.0.0.1/engineo#override",
  ]) {
    assert.throws(() => browserDatabaseSource(url));
  }
});

test("quota reset requires the exact unique fixture name, run ID and canonical source-server pin", () => {
  assert.deepEqual(browserDatabaseEnvironment(env), {
    url: env.DATABASE_URL,
    runId,
    serverIdentity: identity,
  });
  for (const invalid of [
    {},
    { DATABASE_URL: env.DATABASE_URL },
    { ...env, ENGINEO_BROWSER_TEST_RUN_ID: "fixture" },
    { ...env, DATABASE_URL: "postgres://engineo@127.0.0.1/engineo" },
    { ...env, DATABASE_URL: env.DATABASE_URL.replace(name, `${name}_other`) },
    ...[
      undefined,
      "",
      "not JSON",
      "null",
      "{}",
      "[]",
      JSON.stringify({ address: "database.example", port: 5432 }),
      JSON.stringify({ address: "127.0.0.1", port: "5432" }),
      JSON.stringify({ address: "127.0.0.1", port: 0 }),
      JSON.stringify({ address: "127.0.0.1", port: 65536 }),
      JSON.stringify({ address: "127.0.0.1", port: 5432.5 }),
      JSON.stringify({ address: "fe80::1%eth0", port: 5432 }),
      JSON.stringify({ address: "127.0.0.1", port: 5432, extra: true }),
      JSON.stringify({ port: 5432, address: "127.0.0.1" }),
    ].map((server) => ({ ...env, ENGINEO_BROWSER_TEST_SERVER_ID: server })),
  ]) {
    assert.throws(() => browserDatabaseEnvironment(invalid));
  }
  assert.doesNotThrow(() => assertSerialBrowserScenario(1, "http://127.0.0.1:3100"));
  for (const [workers, baseURL] of [
    [2, "http://127.0.0.1:3100"],
    [1, "https://engineo.example"],
    [1, undefined],
  ]) {
    assert.throws(() => assertSerialBrowserScenario(workers, baseURL));
  }
});

test("failed database/name/server-pin/marker checks never reach quota deletion", async () => {
  for (const state of [
    { name: "engineo", address: "127.0.0.1", marker: [marker()] },
    { name, address: "192.0.2.1", marker: [marker()] },
    { name, address: null, marker: [marker()] },
    { name, address: "127.0.0.1", port: 5433, marker: [marker()] },
    { name, address: "127.0.0.1", port: "5432", marker: [marker()] },
    { name, address: "127.0.0.1", marker: [] },
    { name, address: "127.0.0.1", marker: [marker(randomUUID())] },
    { name, address: "127.0.0.1", marker: [marker(), marker(randomUUID())] },
    {
      name,
      address: "127.0.0.1",
      marker: [marker(runId, JSON.stringify({ address: "172.17.0.2", port: 5432 }))],
    },
    { name, address: "127.0.0.1", marker: null },
  ]) {
    const queries = [];
    const sql = async (strings) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("current_database()"))
        return [{ name: state.name, address: state.address, port: state.port ?? 5432 }];
      if (query.includes("engineo_browser_test_guard")) {
        if (state.marker === null) throw new Error("fixture marker table is missing");
        return state.marker;
      }
      throw new Error("Unexpected mutation");
    };
    sql.begin = (operation) => operation(sql);
    await assert.rejects(resetBrowserLoginQuota(sql, env));
    assert.equal(
      queries.some((query) => query.includes("DELETE")),
      false,
    );
  }
});

test("native and port-mapped loopback endpoints pin only the exact observed server identity", async () => {
  for (const observed of [
    { address: "127.0.0.1", port: 5439 },
    { address: "172.17.0.2", port: 5432 },
    { address: "fd00::2", port: 5432 },
  ]) {
    const server = simulatedServer(observed);
    const fixture = await createBrowserDatabase(
      "postgres://engineo@127.0.0.1:5439/engineo",
      server.connect,
    );
    try {
      assert.equal(new URL(fixture.env.DATABASE_URL).hostname, "127.0.0.1");
      assert.equal(fixture.env.ENGINEO_BROWSER_TEST_SERVER_ID, JSON.stringify(observed));
      const markerInsert = server.queries.find((entry) => entry.query.includes("INSERT INTO"));
      assert.equal(markerInsert.values[1], fixture.env.ENGINEO_BROWSER_TEST_SERVER_ID);
      await resetBrowserLoginQuota(server.connect(fixture.env.DATABASE_URL), fixture.env);
      assert.equal(server.queries.filter((entry) => entry.query.includes("DELETE FROM")).length, 1);
    } finally {
      await fixture.dispose();
    }
  }
});

test("a changed container address or port cannot initialize the fixture or reset its quota", async () => {
  const sourceIdentity = { address: "172.17.0.2", port: 5432 };
  for (const different of [
    { address: "172.17.0.3", port: 5432 },
    { address: "172.17.0.2", port: 5433 },
  ]) {
    const initialMismatch = simulatedServer(sourceIdentity, different);
    await assert.rejects(
      createBrowserDatabase("postgres://engineo@127.0.0.1:5439/engineo", initialMismatch.connect),
      /pinned source-server identity/,
    );
    const created = initialMismatch.queries.find((entry) =>
      entry.query.includes("CREATE DATABASE"),
    );
    const dropped = initialMismatch.queries.find((entry) => entry.query.includes("DROP DATABASE"));
    assert.deepEqual(dropped.values, created.values);
    assert.equal(
      initialMismatch.queries.some((entry) => entry.query.includes("CREATE TABLE")),
      false,
    );

    const server = simulatedServer(sourceIdentity);
    const fixture = await createBrowserDatabase(
      "postgres://engineo@127.0.0.1:5439/engineo",
      server.connect,
    );
    try {
      server.changeFixture(different);
      const db = server.connect(fixture.env.DATABASE_URL);
      await assert.rejects(
        resetBrowserLoginQuota(db, fixture.env),
        /pinned source-server identity/,
      );
      // Editing the environment cannot substitute a new server identity: the
      // marker still binds the fixture to its original source-server pin.
      await assert.rejects(
        resetBrowserLoginQuota(db, {
          ...fixture.env,
          ENGINEO_BROWSER_TEST_SERVER_ID: JSON.stringify(different),
        }),
        /fixture database marker/,
      );
      assert.equal(
        server.queries.some((entry) => entry.query.includes("DELETE FROM")),
        false,
      );
    } finally {
      await fixture.dispose();
    }
  }
});

test("malformed server pins and source URLs fail before SQL without exposing credentials", async () => {
  let connected = false;
  await assert.rejects(
    createBrowserDatabase("postgres://owner:secret-fixture-password@127.0.0.1:bad/engineo", () => {
      connected = true;
    }),
    (error) => {
      assert.equal(JSON.stringify(error).includes("secret-fixture-password"), false);
      assert.equal(error.message.includes("secret-fixture-password"), false);
      return true;
    },
  );
  assert.equal(connected, false);
  let queried = false;
  const sql = async () => {
    queried = true;
    throw new Error("Must not query invalid pin");
  };
  sql.begin = (operation) => operation(sql);
  await assert.rejects(
    resetBrowserLoginQuota(sql, {
      ...env,
      ENGINEO_BROWSER_TEST_SERVER_ID: "secret-fixture-password",
    }),
    /pin is missing or malformed/,
  );
  assert.equal(queried, false);
});

test("failed fixture initialization drops only its new database and closes connections", async () => {
  const queries = [];
  const closed = [];
  const connect = (url) => {
    const database = new URL(url).pathname.slice(1);
    const sql = (strings, ...values) => {
      if (typeof strings === "string") return strings;
      const query = strings.join("?");
      queries.push({ database, query, values });
      if (query.includes("current_database()")) {
        return Promise.resolve([{ name: database, address: "127.0.0.1", port: 5432 }]);
      }
      if (query.includes("CREATE TABLE")) return Promise.reject(new Error("fixture setup failed"));
      return Promise.resolve([]);
    };
    sql.end = async () => closed.push(database);
    return sql;
  };
  await assert.rejects(createBrowserDatabase("postgres://engineo@127.0.0.1/engineo", connect));
  const created = queries.find((entry) => entry.query.includes("CREATE DATABASE"));
  const dropped = queries.find((entry) => entry.query.includes("DROP DATABASE"));
  assert.match(created.values[0], /^engineo_browser_[0-9a-f_]{36}$/);
  assert.deepEqual(dropped.values, created.values);
  assert.deepEqual(closed, [created.values[0], "engineo"]);
});

test("cleanup failure still closes the administrative database connection", async () => {
  const closed = [];
  const connect = (url) => {
    const database = new URL(url).pathname.slice(1);
    const sql = (strings) => {
      if (typeof strings === "string") return strings;
      const query = strings.join("?");
      if (query.includes("current_database()")) {
        return Promise.resolve([{ name: database, address: "127.0.0.1", port: 5432 }]);
      }
      if (query.includes("CREATE TABLE") || query.includes("DROP DATABASE")) {
        return Promise.reject(new Error("fixture setup or cleanup failed"));
      }
      return Promise.resolve([]);
    };
    sql.end = async () => closed.push(database);
    return sql;
  };
  await assert.rejects(createBrowserDatabase("postgres://engineo@127.0.0.1/engineo", connect));
  assert.match(closed[0], /^engineo_browser_[0-9a-f_]{36}$/);
  assert.equal(closed[1], "engineo");
});

test("real disposable quota reset preserves data and real SQL / Fastify login thresholds", {
  skip: process.env.DATABASE_URL ? false : "DATABASE_URL is not configured",
  timeout: 30_000,
}, async (t) => {
  const requireApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
  const postgres = requireApi("postgres");
  const { tsImport } = requireApi("tsx/esm/api");
  const { migrateDatabase } = await tsImport("../apps/api/src/db/migrate.ts", import.meta.url);
  const { buildApp } = await tsImport("../apps/api/src/app.ts", import.meta.url);
  const { LOGIN_IP_LIMIT, LOGIN_ACCOUNT_LIMIT } = await tsImport(
    "../apps/api/src/security/rate-limit.ts",
    import.meta.url,
  );
  const connect = (url) => postgres(url, { max: 2, idle_timeout: 1, connect_timeout: 5 });
  const source = connect(browserDatabaseSource(process.env.DATABASE_URL).href);
  const snapshotSource = async () => {
    const available = await source`SELECT to_regclass('public.auth_rate_limits') AS rate_limits`;
    return available[0].rate_limits
      ? await source`SELECT * FROM auth_rate_limits ORDER BY key_sha256`
      : null;
  };
  const sourceBefore = await snapshotSource();
  const fixture = await createBrowserDatabase(process.env.DATABASE_URL, connect).catch(
    async (error) => {
      await source.end({ timeout: 5 });
      throw error;
    },
  );
  const db = connect(fixture.env.DATABASE_URL);
  const first = buildApp({ database: db });
  const second = buildApp({ database: db });
  const fixtureName = new URL(fixture.env.DATABASE_URL).pathname.slice(1);
  try {
    const sourceServer = await source`
      SELECT host(inet_server_addr()) AS address, inet_server_port() AS port
    `;
    assert.equal(
      fixture.env.ENGINEO_BROWSER_TEST_SERVER_ID,
      JSON.stringify({
        address: sourceServer[0].address,
        port: sourceServer[0].port,
      }),
    );
    await migrateDatabase(db);
    const user = randomUUID(),
      organization = randomUUID(),
      project = randomUUID();
    await db`INSERT INTO users (id,email) VALUES (${user},'preserved@example.test')`;
    await db`INSERT INTO organizations (id,slug,name) VALUES (${organization},${organization},'Preserved fixture')`;
    await db`INSERT INTO projects (id,organization_id,name) VALUES (${project},${organization},'Preserved project')`;
    await db`INSERT INTO auth_sessions (id,user_id,token_hash_sha256,csrf_hash_sha256,expires_at)
      VALUES (${randomUUID()},${user},${"1".repeat(64)},${"2".repeat(64)},now() + interval '1 hour')`;
    await db`INSERT INTO audit_events (id,organization_id,actor_type,actor_id,action,resource_type,resource_id,source)
      VALUES (${randomUUID()},${organization},'user',${user},'fixture.preserved','project',${project},'browser-fixture-test')`;
    const saved = async () => ({
      users: await db`SELECT * FROM users ORDER BY id`,
      projects: await db`SELECT * FROM projects ORDER BY id`,
      sessions: await db`SELECT * FROM auth_sessions ORDER BY id`,
      audits: await db`SELECT * FROM audit_events ORDER BY id`,
    });
    const dataBefore = await saved();

    await t.test("IP quota rejects attempt 61 and resets only for the next scenario", async () => {
      assert.equal(LOGIN_IP_LIMIT, 60);
      for (let attempt = 0; attempt < LOGIN_IP_LIMIT; attempt++) {
        const response = await first.inject({
          method: "POST",
          url: "/auth/login",
          remoteAddress: "127.0.0.1",
          headers: { "content-type": "application/json" },
          payload: '{"email":',
        });
        assert.equal(response.statusCode, 400);
      }
      const denied = await second.inject({
        method: "POST",
        url: "/auth/login",
        remoteAddress: "127.0.0.1",
        payload: { email: "missing@example.test", password: "incorrect" },
      });
      assert.equal(denied.statusCode, 429);
      assert.equal(denied.json().error, "too_many_attempts");
      assert.ok(Number(denied.headers["retry-after"]) > 0);
      await resetBrowserLoginQuota(db, fixture.env);
      const nextScenario = await second.inject({
        method: "POST",
        url: "/auth/login",
        remoteAddress: "127.0.0.1",
        headers: { "content-type": "application/json" },
        payload: '{"email":',
      });
      assert.equal(nextScenario.statusCode, 400);
      assert.deepEqual(await saved(), dataBefore);
    });

    await t.test(
      "account quota rejects attempt 9 and source database cannot be reset",
      async () => {
        assert.equal(LOGIN_ACCOUNT_LIMIT, 8);
        for (let attempt = 0; attempt < LOGIN_ACCOUNT_LIMIT; attempt++) {
          const response = await first.inject({
            method: "POST",
            url: "/auth/login",
            remoteAddress: "127.0.0.1",
            payload: { email: "missing@example.test", password: "incorrect" },
          });
          assert.equal(response.statusCode, 401);
        }
        const denied = await second.inject({
          method: "POST",
          url: "/auth/login",
          remoteAddress: "127.0.0.1",
          payload: { email: "missing@example.test", password: "incorrect" },
        });
        assert.equal(denied.statusCode, 429);
        await assert.rejects(resetBrowserLoginQuota(source, fixture.env));
        assert.deepEqual(await snapshotSource(), sourceBefore);
        await resetBrowserLoginQuota(db, fixture.env);
        assert.equal(
          Number((await db`SELECT count(*)::int AS total FROM auth_rate_limits`)[0].total),
          0,
        );
        assert.deepEqual(await saved(), dataBefore);
      },
    );

    await t.test("tampered/missing run markers fail closed without clearing counters", async () => {
      await db`INSERT INTO auth_rate_limits (key_sha256,attempts,expires_at)
        VALUES (${"3".repeat(64)},60,now() + interval '5 minutes')`;
      await db`UPDATE engineo_browser_test_guard SET server_identity=${JSON.stringify({ address: "192.0.2.1", port: 5432 })}`;
      await assert.rejects(resetBrowserLoginQuota(db, fixture.env), /fixture database marker/);
      assert.equal(Number((await db`SELECT attempts FROM auth_rate_limits`)[0].attempts), 60);
      await db`UPDATE engineo_browser_test_guard SET server_identity=${fixture.env.ENGINEO_BROWSER_TEST_SERVER_ID}`;
      await db`UPDATE engineo_browser_test_guard SET run_id=${randomUUID()}`;
      await assert.rejects(resetBrowserLoginQuota(db, fixture.env));
      assert.equal(Number((await db`SELECT attempts FROM auth_rate_limits`)[0].attempts), 60);
      await db`DROP TABLE engineo_browser_test_guard`;
      await assert.rejects(resetBrowserLoginQuota(db, fixture.env));
      assert.equal(Number((await db`SELECT attempts FROM auth_rate_limits`)[0].attempts), 60);
      assert.deepEqual(await saved(), dataBefore);
    });
  } finally {
    await first.close();
    await second.close();
    await db.end({ timeout: 5 });
    await fixture.dispose();
    await fixture.dispose();
    try {
      assert.equal(
        (await source`SELECT datname FROM pg_database WHERE datname=${fixtureName}`).length,
        0,
      );
      assert.deepEqual(await snapshotSource(), sourceBefore);
    } finally {
      await source.end({ timeout: 5 });
    }
  }
});
