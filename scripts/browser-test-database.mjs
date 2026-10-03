import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function assertSerialBrowserScenario(workers, baseURL) {
  if (workers !== 1 || baseURL !== "http://127.0.0.1:3100") {
    throw new Error("Disposable browser quota isolation requires one worker and local servers.");
  }
}

export function browserDatabaseSource(databaseUrl) {
  if (!databaseUrl) throw new Error("Browser tests require a disposable loopback DATABASE_URL.");
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("Browser tests require a valid PostgreSQL source URL.");
  }
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

function serverIdentity(address, port) {
  if (
    typeof address !== "string" ||
    !isIP(address) ||
    address.includes("%") ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("Browser fixture source-server identity is missing or malformed.");
  }
  return { address, port };
}

function parseServerIdentity(pin) {
  try {
    const parsed = JSON.parse(pin);
    const identity = serverIdentity(parsed.address, parsed.port);
    if (JSON.stringify(identity) !== pin) throw new Error("Non-canonical server identity");
    return identity;
  } catch {
    throw new Error("Browser fixture source-server pin is missing or malformed.");
  }
}

export function browserDatabaseEnvironment(env) {
  const source = browserDatabaseSource(env.DATABASE_URL);
  const runId = env.ENGINEO_BROWSER_TEST_RUN_ID ?? "";
  if (source.pathname !== `/${databaseName(runId)}`) {
    throw new Error("Browser quota isolation requires the per-run fixture database.");
  }
  const identity = parseServerIdentity(env.ENGINEO_BROWSER_TEST_SERVER_ID);
  return { url: source.href, runId, serverIdentity: identity };
}

async function assertDatabaseConnection(db, expectedName, expectedServer) {
  const rows = await db`
    SELECT current_database() AS name, host(inet_server_addr()) AS address,
      inet_server_port() AS port
  `;
  if (rows.length !== 1 || rows[0]?.name !== expectedName) {
    throw new Error("Browser fixture connection is not the expected database.");
  }
  const identity = serverIdentity(rows[0].address, rows[0].port);
  if (expectedServer && JSON.stringify(identity) !== JSON.stringify(expectedServer)) {
    throw new Error("Browser fixture connection does not match the pinned source-server identity.");
  }
  return identity;
}

export async function assertBrowserDatabase(db, env) {
  const { runId, serverIdentity: identity } = browserDatabaseEnvironment(env);
  await assertDatabaseConnection(db, databaseName(runId), identity);
  const marker = await db`
    SELECT run_id::text, server_identity FROM public.engineo_browser_test_guard FOR SHARE
  `;
  if (
    marker.length !== 1 ||
    marker[0]?.run_id !== runId ||
    marker[0]?.server_identity !== JSON.stringify(identity)
  ) {
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
  let identity;
  try {
    // The client URL is loopback-only. A port-mapped local Docker service can
    // legitimately report its container-side address/port. Pin the exact source
    // identity rather than trusting loopback or any private network range.
    identity = await assertDatabaseConnection(admin, decodeURIComponent(source.pathname.slice(1)));
    await admin`CREATE DATABASE ${admin(name)} TEMPLATE template0`;
    created = true;
    const fixture = connect(fixtureUrl.href);
    try {
      await assertDatabaseConnection(fixture, name, identity);
      await fixture`CREATE TABLE public.engineo_browser_test_guard (
        run_id uuid PRIMARY KEY, server_identity text NOT NULL
      )`;
      await fixture`INSERT INTO public.engineo_browser_test_guard (run_id,server_identity)
        VALUES (${runId},${JSON.stringify(identity)})`;
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
    env: {
      DATABASE_URL: fixtureUrl.href,
      ENGINEO_BROWSER_TEST_RUN_ID: runId,
      ENGINEO_BROWSER_TEST_SERVER_ID: JSON.stringify(identity),
    },
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
