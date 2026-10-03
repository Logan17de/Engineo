import { randomUUID } from "node:crypto";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const loopbackAddresses = new Set(["127.0.0.1", "::1"]);
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function assertSerialBrowserScenario(workers, baseURL) {
  if (workers !== 1 || baseURL !== "http://127.0.0.1:3100") {
    throw new Error("Disposable browser quota isolation requires one worker and local servers.");
  }
}

export function browserDatabaseSource(databaseUrl) {
  if (!databaseUrl) throw new Error("Browser tests require a disposable loopback DATABASE_URL.");
  const url = new URL(databaseUrl);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !loopbackHosts.has(url.hostname) ||
    url.search ||
    url.hash ||
    url.pathname.length <= 1
  ) {
    throw new Error("Browser tests require a loopback PostgreSQL URL without query overrides.");
  }
  return url;
}

function databaseName(runId) {
  if (!runIdPattern.test(runId)) throw new Error("Missing or invalid browser fixture run ID.");
  return `engineo_browser_${runId.replaceAll("-", "_")}`;
}

export function browserDatabaseEnvironment(env) {
  const source = browserDatabaseSource(env.DATABASE_URL);
  const runId = env.ENGINEO_BROWSER_TEST_RUN_ID ?? "";
  if (source.pathname !== `/${databaseName(runId)}`) {
    throw new Error("Browser quota isolation requires the per-run fixture database.");
  }
  return { url: source.href, runId };
}

async function assertLoopbackConnection(db, expectedName) {
  const rows = await db`
    SELECT current_database() AS name, host(inet_server_addr()) AS address
  `;
  if (rows[0]?.name !== expectedName || !loopbackAddresses.has(String(rows[0]?.address))) {
    throw new Error("Browser fixture database connection is not the expected loopback database.");
  }
}

export async function assertBrowserDatabase(db, env) {
  const { runId } = browserDatabaseEnvironment(env);
  await assertLoopbackConnection(db, databaseName(runId));
  const marker = await db`SELECT run_id::text FROM public.engineo_browser_test_guard FOR SHARE`;
  if (marker.length !== 1 || marker[0]?.run_id !== runId) {
    throw new Error("Browser fixture database marker does not match this disposable run.");
  }
}

// Called once before each serial scenario, never between requests in a scenario.
// Only disposable login counters are reset; users, sessions, projects and audits survive.
export async function resetBrowserLoginQuota(db, env) {
  await db.begin(async (sql) => {
    await assertBrowserDatabase(sql, env);
    await sql`DELETE FROM public.auth_rate_limits`;
  });
}

export async function createBrowserDatabase(sourceUrl, connect) {
  const source = browserDatabaseSource(sourceUrl);
  const runId = randomUUID();
  const name = databaseName(runId);
  const fixtureUrl = new URL(source);
  fixtureUrl.pathname = `/${name}`;
  const admin = connect(source.href);
  let created = false;
  try {
    await assertLoopbackConnection(admin, decodeURIComponent(source.pathname.slice(1)));
    await admin`CREATE DATABASE ${admin(name)} TEMPLATE template0`;
    created = true;
    const fixture = connect(fixtureUrl.href);
    try {
      await assertLoopbackConnection(fixture, name);
      await fixture`CREATE TABLE public.engineo_browser_test_guard (run_id uuid PRIMARY KEY)`;
      await fixture`INSERT INTO public.engineo_browser_test_guard (run_id) VALUES (${runId})`;
    } finally {
      await fixture.end({ timeout: 5 });
    }
  } catch (error) {
    try {
      if (created) await admin`DROP DATABASE ${admin(name)} WITH (FORCE)`;
    } catch (cleanupError) {
      throw new Error(`Could not remove disposable browser database ${name} after setup failed.`, {
        cause: new AggregateError([error, cleanupError]),
      });
    } finally {
      await admin.end({ timeout: 5 });
    }
    throw error;
  }
  let disposed = false;
  let disposalFailure;
  return {
    env: { DATABASE_URL: fixtureUrl.href, ENGINEO_BROWSER_TEST_RUN_ID: runId },
    dispose: async () => {
      if (disposed) return;
      if (disposalFailure) throw disposalFailure;
      try {
        await admin`DROP DATABASE ${admin(name)} WITH (FORCE)`;
        disposed = true;
      } catch (error) {
        disposalFailure = new Error(`Could not remove disposable browser database ${name}.`, {
          cause: error,
        });
        throw disposalFailure;
      } finally {
        await admin.end({ timeout: 5 });
      }
    },
  };
}
