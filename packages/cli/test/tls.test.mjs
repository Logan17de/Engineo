import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Test-only transport acceptance: no API/database fixture, identity provisioning,
// real credentials, trust-store changes, installs, or network destinations beyond
// these ephemeral loopback listeners. The built CLI itself is not mocked.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = resolve(process.env.ENGINEO_CLI_TLS_ENTRY ?? join(packageRoot, "dist/main.js"));
const contractsEntry = resolve(dirname(cliEntry), "../../contracts/dist/index.js");
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function privateOutput(text, secrets) {
  for (const secret of secrets)
    assert.equal(text.includes(secret), false, "Fixture credential must never appear in output");
  assert.equal(
    text.includes("-----BEGIN"),
    false,
    "Certificate/key bytes must never appear in output",
  );
}

function launch(argv, secrets, environment = {}, noDialPreload) {
  // Deliberately exclude inherited NODE_OPTIONS, NODE_EXTRA_CA_CERTS, SSL_CERT_*,
  // NODE_USE_SYSTEM_CA, and NODE_TLS_REJECT_UNAUTHORIZED. Test CA trust is supplied
  // explicitly to individual disposable subprocesses only.
  const child = spawn(
    process.execPath,
    [...(noDialPreload ? ["--require", noDialPreload] : []), cliEntry, ...argv],
    {
      env: { PATH: process.env.PATH ?? "", LANG: "C", NODE_ENV: "test", ...environment },
      stdio: noDialPreload ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    },
  );
  return new Promise((resolveRun, reject) => {
    let stdout = "",
      stderr = "",
      networkAttempts = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Built CLI TLS subprocess exceeded the test deadline"));
    }, 15_000);
    child.stdout.on("data", (bytes) => {
      stdout += bytes.toString("utf8");
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes.toString("utf8");
    });
    child.stdio[3]?.on("data", (bytes) => {
      networkAttempts += bytes.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      try {
        privateOutput(stdout, secrets);
        privateOutput(stderr, secrets);
        assert.equal(signal, null, "CLI must exit normally with its JSON envelope");
        assert.equal(stderr, "", "No exception diagnostics or TLS warnings may escape");
        assert.ok(Buffer.byteLength(stdout) < 1024 * 1024, "CLI test envelope must stay bounded");
        assert.equal(stdout.endsWith("\n"), true, "Output envelope must end with a newline");
        assert.equal(stdout.trim().split("\n").length, 1, "Exactly one JSON envelope is required");
        const output = JSON.parse(stdout);
        assert.equal(output.schemaVersion, 1);
        assert.equal(output.kind, "engineo-cli-output");
        assert.equal(typeof output.ok, "boolean");
        assert.equal(exitCode, output.exitCode, "OS status must match the versioned JSON status");
        resolveRun({ output, networkAttempts });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function failure(run, category, code, exitCode) {
  assert.equal(run.output.ok, false);
  assert.equal(run.output.error?.category, category);
  assert.equal(run.output.error?.code, code);
  assert.equal(run.output.exitCode, exitCode);
}

async function certificateFixture(directory) {
  const ca = join(directory, "ca.pem"),
    caKey = join(directory, "ca-key.pem"),
    key = join(directory, "server-key.pem"),
    csr = join(directory, "server.csr"),
    cert = join(directory, "server.pem"),
    extensions = join(directory, "server.ext");
  await writeFile(
    extensions,
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n" +
      "extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n",
    { mode: 0o600, flag: "wx" },
  );
  const openssl = (args) => {
    const result = spawnSync("openssl", args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 15_000,
      env: { PATH: process.env.PATH ?? "", LANG: "C" },
    });
    assert.equal(result.error, undefined, "Installed OpenSSL must run without installation");
    assert.equal(result.status, 0, "Disposable fixture certificate generation must succeed");
  };
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-subj",
    "/CN=Engineo disposable CLI transport test CA",
    "-keyout",
    caKey,
    "-out",
    ca,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  openssl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-subj",
    "/CN=localhost",
    "-keyout",
    key,
    "-out",
    csr,
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    ca,
    "-CAkey",
    caKey,
    "-set_serial",
    `0x${randomBytes(16).toString("hex")}`,
    "-days",
    "1",
    "-sha256",
    "-extfile",
    extensions,
    "-out",
    cert,
  ]);
  for (const path of [ca, caKey, key, csr, cert, extensions]) await chmod(path, 0o600);
  return { ca, key: await readFile(key), cert: await readFile(cert) };
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

test("built application CLI preserves strict HTTPS transport and session isolation", {
  skip:
    process.env.ENGINEO_CLI_TLS_TEST === "1"
      ? false
      : "Set ENGINEO_CLI_TLS_TEST=1 for loopback HTTPS tests",
  timeout: 120_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "engineo-cli-tls-"));
  await chmod(directory, 0o700);
  const servers = [];
  const cleanupErrors = [];
  let primaryError;
  try {
    await readFile(cliEntry);
    const { validateProjectConfigurationV1 } = await import(pathToFileURL(contractsEntry).href);
    const organizationId = randomUUID(),
      projectId = randomUUID(),
      calendarId = randomUUID(),
      wbsId = randomUUID();
    const session = {
      schemaVersion: 1,
      kind: "engineo-cli-session",
      actorId: randomUUID(),
      sessionId: randomUUID(),
      sessionToken: randomBytes(48).toString("base64url"),
      csrfToken: randomBytes(48).toString("base64url"),
    };
    const secrets = [session.sessionToken, session.csrfToken];
    const authFile = join(directory, "session.json");
    await writeFile(authFile, JSON.stringify(session), { mode: 0o600, flag: "wx" });
    const checked = validateProjectConfigurationV1({
      schemaVersion: 1,
      kind: "engineo-project-configuration",
      scope: "schedule",
      input: {
        schemaVersion: 1,
        project: {
          id: projectId,
          name: "Disposable TLS transport fixture",
          plannedStart: "2026-10-05T08:00:00.000Z",
          dataDate: "2026-10-05T08:00:00.000Z",
          requiredFinish: null,
          defaultCalendarId: calendarId,
        },
        scheduleOptions: {
          criticalFloatThresholdMinutes: 0,
          lagCalendarPolicy: "SUCCESSOR",
          projectFinishPolicy: "CALCULATED",
        },
        calendars: [
          {
            id: calendarId,
            name: "Standard",
            timeZone: "UTC",
            week: {
              MONDAY: [{ start: "08:00", end: "17:00" }],
              TUESDAY: [{ start: "08:00", end: "17:00" }],
              WEDNESDAY: [{ start: "08:00", end: "17:00" }],
              THURSDAY: [{ start: "08:00", end: "17:00" }],
              FRIDAY: [{ start: "08:00", end: "17:00" }],
              SATURDAY: [],
              SUNDAY: [],
            },
            exceptions: [],
          },
        ],
        wbs: [{ id: wbsId, parentId: null, code: "1", name: "Root", sortOrder: 0 }],
        activities: [
          {
            id: randomUUID(),
            wbsId,
            calendarId,
            name: "Work",
            kind: "TASK",
            durationMinutes: 60,
            constraints: [],
          },
        ],
        relationships: [],
      },
    });
    assert.equal(checked.valid, true, "Synthetic configuration must satisfy the built contract");
    const configuration = checked.normalizedConfiguration;
    const snapshot = {
      schemaVersion: 1,
      revision: 1,
      configuration,
      inputHashSha256: hash(checked.canonicalInput),
    };
    const configurationFile = join(directory, "configuration.json");
    await writeFile(configurationFile, JSON.stringify(configuration), { mode: 0o600, flag: "wx" });

    const certificates = await certificateFixture(directory);
    const destinationRequests = [];
    let destinationConnections = 0;
    const destination = createServer(
      { key: certificates.key, cert: certificates.cert },
      (request, response) => {
        // Store only inert request metadata; never retain forwarded credential values.
        destinationRequests.push({ method: request.method, path: request.url });
        request.resume();
        response.writeHead(500, { "content-type": "application/json" });
        response.end("{}");
      },
    );
    destination.on("connection", () => destinationConnections++);
    destination.on("tlsClientError", () => {});
    servers.push(destination);
    const destinationPort = await listen(destination);
    const redirectTarget = `https://localhost:${destinationPort}/must-not-receive-credentials`;

    let behavior = "read",
      connections = 0,
      secureConnections = 0;
    const requests = [];
    const configurationPath = `/organizations/${organizationId}/projects/${projectId}/configuration`;
    const source = createServer(
      { key: certificates.key, cert: certificates.cert },
      (request, response) => {
        const cookiesMatch =
          request.headers.cookie ===
          `engineo_session=${session.sessionToken}; engineo_csrf=${session.csrfToken}`;
        const sessionMatches = request.headers["x-engineo-session"] === session.sessionId;
        const csrfMatches = request.headers["x-csrf-token"] === session.csrfToken;
        requests.push({
          method: request.method,
          path: request.url,
          cookiesMatch,
          sessionMatches,
          csrfMatches,
          origin: request.headers.origin,
          encrypted: request.socket.encrypted,
          tlsProtocol: request.socket.getProtocol(),
        });
        request.resume();
        const reply = (body) => {
          response.writeHead(200, {
            "content-type": "application/json",
            "x-engineo-session": session.sessionId,
          });
          response.end(JSON.stringify(body));
        };
        if (
          behavior === "redirect-identity" ||
          (behavior.startsWith("redirect-post-") && request.method === "POST")
        ) {
          response.writeHead(behavior === "redirect-identity" ? 302 : Number(behavior.slice(-3)), {
            location: redirectTarget,
            "x-engineo-session": session.sessionId,
          });
          response.end();
        } else if (request.url === "/auth/me") {
          reply({
            user: { id: behavior === "wrong-actor" ? randomUUID() : session.actorId },
            session: { id: behavior === "wrong-session" ? randomUUID() : session.sessionId },
          });
        } else if (request.url === configurationPath && request.method === "GET") {
          reply(snapshot);
        } else {
          response.writeHead(404, { "content-type": "application/json" });
          response.end("{}");
        }
      },
    );
    source.on("connection", () => connections++);
    source.on("secureConnection", () => secureConnections++);
    source.on("tlsClientError", () => {});
    servers.push(source);
    const port = await listen(source);
    const origin = `https://localhost:${port}`;
    const trusted = { NODE_EXTRA_CA_CERTS: certificates.ca };
    const args = (command, apiOrigin = origin, extra = []) => [
      command,
      "--api-origin",
      apiOrigin,
      "--organization",
      organizationId,
      "--project",
      projectId,
      "--auth-file",
      authFile,
      "--timeout-ms",
      "5000",
      ...extra,
    ];
    const run = (command = "read", apiOrigin = origin, extra = [], env = trusted, preload) =>
      launch(args(command, apiOrigin, extra), secrets, env, preload);

    await t.test(
      "default trust rejects the disposable CA before any HTTP/auth/project request",
      async () => {
        const before = connections;
        failure(await run("read", origin, [], {}), "transport", "transport_failed", 8);
        assert.ok(connections > before, "The built CLI must attempt a real TLS connection");
        assert.equal(
          requests.length,
          0,
          "Untrusted TLS must transmit no session or project request",
        );
      },
    );

    await t.test(
      "explicit child-only CA trust succeeds with verified localhost and identity-first project I/O",
      async () => {
        behavior = "read";
        const before = requests.length;
        const result = await run();
        assert.equal(result.output.ok, true);
        assert.equal(result.output.exitCode, 0);
        assert.deepEqual(result.output.data, snapshot);
        const observed = requests.slice(before);
        assert.deepEqual(
          observed.map(({ method, path }) => [method, path]),
          [
            ["GET", "/auth/me"],
            ["GET", configurationPath],
          ],
        );
        for (const request of observed) {
          assert.equal(
            request.cookiesMatch,
            true,
            "Explicit fixture cookies must reach only the intended service",
          );
          assert.equal(
            request.sessionMatches,
            true,
            "Explicit immutable session header is mandatory",
          );
          assert.equal(request.origin, origin);
          assert.equal(request.encrypted, true);
          assert.ok(["TLSv1.2", "TLSv1.3"].includes(request.tlsProtocol));
        }
        assert.ok(secureConnections > 0, "A real authenticated TLS handshake is required");
      },
    );

    await t.test(
      "trust remains disposable: another child without explicit CA still rejects it",
      async () => {
        const before = requests.length;
        failure(await run("read", origin, [], {}), "transport", "transport_failed", 8);
        assert.equal(requests.length, before);
      },
    );

    await t.test(
      "a CA-trusted certificate for localhost is rejected for an IP hostname",
      async () => {
        const before = requests.length;
        failure(await run("read", `https://127.0.0.1:${port}`), "transport", "transport_failed", 8);
        assert.equal(
          requests.length,
          before,
          "Hostname mismatch must transmit no credentials or project request",
        );
      },
    );

    for (const mismatch of ["wrong-actor", "wrong-session"]) {
      await t.test(`${mismatch} is rejected after auth/me and before project I/O`, async () => {
        behavior = mismatch;
        const before = requests.length;
        failure(await run(), "auth", "identity_mismatch", 5);
        assert.deepEqual(
          requests.slice(before).map(({ path }) => path),
          ["/auth/me"],
        );
      });
    }

    await t.test(
      "HTTPS identity redirect is refused without connecting or forwarding to its target",
      async () => {
        behavior = "redirect-identity";
        const before = requests.length;
        failure(await run(), "transport", "redirect_refused", 8);
        assert.deepEqual(
          requests.slice(before).map(({ path }) => path),
          ["/auth/me"],
        );
        assert.equal(destinationConnections, 0);
        assert.equal(destinationRequests.length, 0);
      },
    );

    for (const status of [307, 308]) {
      await t.test(
        `HTTPS POST ${status} redirect refuses session/csrf forwarding and POST replay`,
        async () => {
          behavior = `redirect-post-${status}`;
          const before = requests.length;
          failure(
            await run("validate", origin, ["--authoritative", "--file", configurationFile]),
            "transport",
            "redirect_refused",
            8,
          );
          const observed = requests.slice(before);
          assert.deepEqual(
            observed.map(({ method, path }) => [method, path]),
            [
              ["GET", "/auth/me"],
              ["POST", `${configurationPath}/validate`],
            ],
          );
          assert.equal(observed[1].cookiesMatch, true);
          assert.equal(observed[1].sessionMatches, true);
          assert.equal(
            observed[1].csrfMatches,
            true,
            "Original authorized POST must carry fixture CSRF",
          );
          assert.equal(
            destinationConnections,
            0,
            "No TLS connection to the redirect target is permitted",
          );
          assert.equal(
            destinationRequests.length,
            0,
            "No request or credential reaches the redirect target",
          );
        },
      );
    }

    const noDialPreload = join(directory, "no-dial-observer.cjs");
    // Observation is used ONLY for options that must fail before networking.
    // If a regression attempts DNS/TCP, record it on a private IPC descriptor and
    // fail before any actual external connection. TLS behavior above runs without
    // this preload and exclusively uses the real Node transport.
    await writeFile(
      noDialPreload,
      'const fs = require("node:fs");\n' +
        'const refuse = () => { fs.writeSync(3, "network-attempt\\n"); throw new Error("Test no-dial guard"); };\n' +
        'require("node:net").Socket.prototype.connect = refuse;\n' +
        'require("node:dns").lookup = refuse;\n' +
        'require("node:dns").promises.lookup = refuse;\n',
      { mode: 0o600, flag: "wx" },
    );

    await t.test("test-only no-dial observer detects and prevents DNS/TCP attempts", () => {
      for (const expression of [
        'require("node:net").connect({ host: "192.0.2.1", port: 43123 })',
        'require("node:dns").lookup("fixture.invalid", () => {})',
        'require("node:dns").promises.lookup("fixture.invalid")',
      ]) {
        const calibration = spawnSync(
          process.execPath,
          ["--require", noDialPreload, "-e", `try { ${expression}; } catch {}`],
          {
            env: { PATH: process.env.PATH ?? "", LANG: "C", NODE_ENV: "test" },
            stdio: ["ignore", "pipe", "pipe", "pipe"],
            encoding: "utf8",
            timeout: 5000,
          },
        );
        assert.equal(calibration.error, undefined);
        assert.equal(calibration.status, 0);
        assert.equal(calibration.stdout, "");
        assert.equal(calibration.stderr, "");
        assert.equal(
          calibration.output[3],
          "network-attempt\n",
          "The observer must prove it can detect a regression without dialing externally",
        );
      }
    });

    await t.test(
      "NODE_TLS_REJECT_UNAUTHORIZED=0 is refused before DNS/TCP or credential transmission",
      async () => {
        const beforeRequests = requests.length,
          beforeConnections = connections,
          parentTlsEnvironment = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        // The unsafe setting belongs only to this disposable child. Never relax
        // certificate validation in the long-lived unit/TLS test host.
        const result = await run(
          "read",
          origin,
          [],
          {
            ...trusted,
            NODE_TLS_REJECT_UNAUTHORIZED: "0",
          },
          noDialPreload,
        );
        failure(result, "usage", "insecure_tls_environment", 2);
        assert.equal(
          result.networkAttempts,
          "",
          "Unsafe TLS environment must fail before any DNS/TCP attempt",
        );
        assert.equal(requests.length, beforeRequests);
        assert.equal(connections, beforeConnections);
        assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, parentTlsEnvironment);
      },
    );

    await t.test(
      "HTTPS default rejects loopback HTTP without an explicit development flag, before dial",
      async () => {
        const result = await run("read", `http://127.0.0.1:${port}`, [], {}, noDialPreload);
        failure(result, "usage", "https_required", 2);
        assert.equal(result.networkAttempts, "");
      },
    );

    await t.test(
      "even explicit loopback permission cannot authorize non-loopback HTTP, and no dial occurs",
      async () => {
        const result = await run(
          "read",
          "http://192.0.2.1:43123",
          ["--allow-http-loopback"],
          {},
          noDialPreload,
        );
        failure(result, "usage", "https_required", 2);
        assert.equal(result.networkAttempts, "", "Non-loopback HTTP must fail before DNS/TCP");
      },
    );

    await t.test("URL-parser loopback aliases remain rejected before dial", async () => {
      for (const alias of ["127.1", "2130706433"]) {
        const result = await run(
          "read",
          `http://${alias}:${port}`,
          ["--allow-http-loopback"],
          {},
          noDialPreload,
        );
        failure(result, "usage", "invalid_arguments", 2);
        assert.equal(result.networkAttempts, "");
      }
    });
    assert.equal(destinationConnections, 0);
    assert.equal(destinationRequests.length, 0);
    t.diagnostic(
      JSON.stringify({
        sourceRequests: requests.length,
        sourceProjectRequests: requests.filter(({ path }) => path !== "/auth/me").length,
        sourceTcpConnections: connections,
        sourceSecureConnections: secureConnections,
        redirectTargetTcpConnections: destinationConnections,
        redirectTargetRequests: destinationRequests.length,
      }),
    );
  } catch (error) {
    primaryError = error;
  } finally {
    // Disposal is mandatory even after a failed listen or assertion. A denied
    // socket permission is a hard failure, never an alternate access route.
    for (const server of servers) {
      if (!server.listening) continue;
      try {
        await close(server);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await rm(directory, { recursive: true, force: true });
      await assert.rejects(access(directory), { code: "ENOENT" });
      t.diagnostic(
        "Private ephemeral CA/key/session/configuration/preload directory removal verified",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(primaryError ? [primaryError] : []), ...cleanupErrors],
      "CLI HTTPS acceptance or private fixture cleanup failed",
    );
  if (primaryError) throw primaryError;
});
