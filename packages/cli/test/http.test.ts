import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type EngineScheduleResultV1,
  type ProjectConfigurationPlanReadV1,
  type ProjectConfigurationPlanV1,
  type ProjectConfigurationReadV1,
  type ProjectConfigurationReceiptV1,
  type ProjectConfigurationV1,
  type ScheduleCalculationMetadataV1,
  serializeProjectConfigurationReviewV1,
  serializeScheduleInputV1,
  serializeScheduleResultV1,
} from "@engineo/contracts";
import type { Database } from "../../../apps/api/src/db/client.js";
import type { IssuedSession } from "../../../apps/api/src/security/session.js";
import type { CliOutputV1 } from "../src/run.js";
import { strictConfigurationFailures } from "./configuration-failures.js";

// Explicit opt-in: this suite creates and drops ONLY its own uniquely named database.
// Build contracts, CLI, API and the real Rust executable first. Start PostgreSQL
// outside this test under the coordinated executor wrapper. No app.inject or fake DB.
// ENGINEO_CLI_HTTP_API_ROOT may select an API worktree's apps/api during parallel work.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiRoot = process.env.ENGINEO_CLI_HTTP_API_ROOT ?? resolve(packageRoot, "../../apps/api");
const cliEntry = join(packageRoot, "dist/main.js");
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const secrets: string[] = [];

interface Run {
  output: CliOutputV1;
  stdout: string;
  stderr: string;
}
interface Target {
  organizationId: string;
  projectId: string;
  authFile: string;
}
interface Fault {
  method: string;
  path: string;
  mode: "drop" | "hold" | "unavailable" | "tamper";
  seen?: () => void;
  held?: ServerResponse;
  transform?: (body: Record<string, unknown>) => void;
}

function assertPrivate(text: string): void {
  for (const secret of secrets) assert.equal(text.includes(secret), false, "Session secret leaked");
}
function success<T>(run: Run): T {
  assert.equal(run.output.ok, true, JSON.stringify(run.output));
  assert.equal(run.output.exitCode, 0);
  return run.output.data as T;
}
function failure(run: Run, category: string, code?: string): void {
  assert.equal(run.output.ok, false, JSON.stringify(run.output));
  assert.equal(run.output.error?.category, category);
  const exits: Record<string, number> = {
    usage: 2,
    validation: 3,
    conflict: 4,
    auth: 5,
    capacity: 6,
    uncertain: 7,
    transport: 8,
    integrity: 9,
    unavailable: 10,
    interrupted: 130,
  };
  assert.equal(run.output.exitCode, exits[category]);
  if (code) assert.equal(run.output.error?.code, code);
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
}

function launch(argv: string[], authDescriptor?: number | "pipe") {
  const child = spawn(process.execPath, [cliEntry, ...argv], {
    stdio:
      authDescriptor === undefined
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe", authDescriptor],
    env: { ...process.env, NODE_ENV: "test" },
  });
  const done = new Promise<Run>((resolveRun, reject) => {
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI test subprocess timed out"));
    }, 20_000);
    child.stdout?.on("data", (bytes: Buffer) => {
      stdout += bytes.toString("utf8");
    });
    child.stderr?.on("data", (bytes: Buffer) => {
      stderr += bytes.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      try {
        assert.equal(signal, null, "CLI was killed without a JSON interruption envelope");
        assert.equal(stderr, "", "CLI stderr must not expose exception diagnostics");
        assertPrivate(stdout);
        assertPrivate(stderr);
        assert.ok(Buffer.byteLength(stdout) < 16 * 1024 * 1024);
        assert.equal(stdout.trim().split("\n").length, 1, "Exactly one JSON envelope is required");
        const output = JSON.parse(stdout) as CliOutputV1;
        assert.equal(output.schemaVersion, 1);
        assert.equal(output.kind, "engineo-cli-output");
        assert.equal(typeof output.ok, "boolean");
        assert.equal(exitCode, output.exitCode);
        resolveRun({ output, stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
  return { child, done };
}

test("built private CLI uses the real HTTP API, disposable PostgreSQL and Rust", {
  skip:
    process.env.ENGINEO_CLI_HTTP_TEST === "1"
      ? false
      : "Set ENGINEO_CLI_HTTP_TEST=1 to run real HTTP/PostgreSQL/Rust integration",
  timeout: 240_000,
}, async (t) => {
  assert.ok(
    process.env.DATABASE_URL,
    "An explicitly configured disposable local PostgreSQL server is required",
  );
  assert.ok(
    process.env.ENGINEO_SCHEDULER_BIN,
    "Build and provide the real Rust executable with ENGINEO_SCHEDULER_BIN",
  );
  let adminUrl: URL;
  try {
    adminUrl = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error("A valid local PostgreSQL source URL is required");
  }
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(adminUrl.hostname),
    "HTTP integration refuses non-loopback databases",
  );
  assert.ok(["postgres:", "postgresql:"].includes(adminUrl.protocol));
  assert.equal(adminUrl.search, "", "Database query overrides are forbidden");
  assert.equal(adminUrl.hash, "", "Database URL fragments are forbidden");
  assert.match(adminUrl.pathname, /^\/[A-Za-z0-9_-]+$/, "Use an unambiguous source database name");
  assert.ok(
    adminUrl.href === process.env.DATABASE_URL,
    "Noncanonical database URL aliases are forbidden",
  );
  await access(cliEntry);
  await access(process.env.ENGINEO_SCHEDULER_BIN);
  const { buildApp } = (await import(
    pathToFileURL(join(apiRoot, "dist/app.js")).href
  )) as typeof import("../../../apps/api/src/app.js");
  const { createDatabase } = (await import(
    pathToFileURL(join(apiRoot, "dist/db/client.js")).href
  )) as typeof import("../../../apps/api/src/db/client.js");
  const { migrateDatabase } = (await import(
    pathToFileURL(join(apiRoot, "dist/db/migrate.js")).href
  )) as typeof import("../../../apps/api/src/db/migrate.js");
  const { tenantContext } = (await import(
    pathToFileURL(join(apiRoot, "dist/db/tenant-context.js")).href
  )) as typeof import("../../../apps/api/src/db/tenant-context.js");
  const { PlannerRepository } = (await import(
    pathToFileURL(join(apiRoot, "dist/repositories/planner-repository.js")).href
  )) as typeof import("../../../apps/api/src/repositories/planner-repository.js");
  const { ProjectRepository } = (await import(
    pathToFileURL(join(apiRoot, "dist/repositories/project-repository.js")).href
  )) as typeof import("../../../apps/api/src/repositories/project-repository.js");
  const { issueSession } = (await import(
    pathToFileURL(join(apiRoot, "dist/security/session.js")).href
  )) as typeof import("../../../apps/api/src/security/session.js");
  const { ProcessScheduleRunner } = (await import(
    pathToFileURL(join(apiRoot, "dist/scheduler/runner.js")).href
  )) as typeof import("../../../apps/api/src/scheduler/runner.js");
  const configFor = (url: string) => ({
    url,
    maxConnections: 10,
    idleTimeoutSeconds: 1,
    connectTimeoutSeconds: 3,
  });
  const databaseName = `engineo_cli_http_${randomUUID().replaceAll("-", "")}`;
  assert.match(databaseName, /^engineo_cli_http_[a-f0-9]{32}$/);
  const admin = createDatabase(configFor(adminUrl.href));
  const workUrl = new URL(adminUrl);
  workUrl.pathname = `/${databaseName}`;
  let db: Database | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  let proxy: Server | undefined;
  let created = false;
  const directory = await mkdtemp(join(tmpdir(), "engineo-cli-http-"));
  const oldNodeEnv = process.env.NODE_ENV,
    oldAppOrigin = process.env.APP_ORIGIN;
  process.env.NODE_ENV = "test";
  const faults: Fault[] = [];
  const calls: { method: string; path: string }[] = [];
  const cleanupErrors: unknown[] = [];
  let primaryError: unknown;
  let failed = false;
  try {
    const sourceIdentity =
      await admin`SELECT current_database() AS name, host(inet_server_addr()) AS address, inet_server_port() AS port`;
    assert.equal(sourceIdentity.length, 1);
    assert.equal(sourceIdentity[0]?.name, adminUrl.pathname.slice(1));
    assert.equal(typeof sourceIdentity[0]?.address, "string");
    assert.equal(typeof sourceIdentity[0]?.port, "number");
    await admin.unsafe(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    created = true;
    const database = createDatabase(configFor(workUrl.href));
    db = database;
    const fixtureIdentity =
      await database`SELECT current_database() AS name, host(inet_server_addr()) AS address, inet_server_port() AS port`;
    assert.equal(fixtureIdentity.length, 1);
    assert.equal(fixtureIdentity[0]?.name, databaseName);
    assert.equal(fixtureIdentity[0]?.address, sourceIdentity[0]?.address);
    assert.equal(fixtureIdentity[0]?.port, sourceIdentity[0]?.port);
    await migrateDatabase(database, join(apiRoot, "migrations"));
    const runner = new ProcessScheduleRunner({ binaryPath: process.env.ENGINEO_SCHEDULER_BIN });
    const engineVersion = await runner.getEngineVersion();
    app = buildApp({ database, scheduleRunner: runner });
    let backendOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
    // A transparent TCP proxy keeps production routes untouched. It can discard
    // ONLY an already received successful response, establishing actual commit
    // before testing lost replies and interruption uncertainty.
    proxy = createServer((incoming, outgoing) => {
      const path = incoming.url ?? "/",
        method = incoming.method ?? "GET";
      calls.push({ method, path });
      const faultIndex = faults.findIndex((row) => row.path === path && row.method === method);
      const fault = faultIndex < 0 ? undefined : faults.splice(faultIndex, 1)[0];
      if (fault?.mode === "unavailable") {
        outgoing.writeHead(503, { "content-type": "application/json" });
        outgoing.end('{"error":"temporarily_unavailable"}');
        fault.seen?.();
        return;
      }
      const upstream = request(
        `${backendOrigin}${path}`,
        { method, headers: incoming.headers },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            let body = Buffer.concat(chunks);
            if ((fault?.mode === "drop" || fault?.mode === "hold") && response.statusCode === 200) {
              fault.held = outgoing;
              fault.seen?.();
              if (fault.mode === "drop") outgoing.destroy();
              return;
            }
            if (fault?.mode === "tamper" && response.statusCode === 200) {
              const value = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
              fault.transform?.(value);
              body = Buffer.from(JSON.stringify(value));
            }
            outgoing.writeHead(response.statusCode ?? 502, {
              ...response.headers,
              "content-length": body.length,
            });
            outgoing.end(body);
            fault?.seen?.();
          });
          response.on("error", () => outgoing.destroy());
        },
      );
      upstream.on("error", () => outgoing.destroy());
      incoming.pipe(upstream);
    });
    const origin = await listen(proxy);
    process.env.APP_ORIGIN = origin;
    const planner = new PlannerRepository(database),
      projects = new ProjectRepository(database);

    async function sessionFile(
      session: IssuedSession,
      actorId = session.principal.userId,
    ): Promise<string> {
      secrets.push(session.token, session.csrfToken);
      const path = join(directory, `${randomUUID()}.session.json`);
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: 1,
          kind: "engineo-cli-session",
          actorId,
          sessionId: session.principal.sessionId,
          sessionToken: session.token,
          csrfToken: session.csrfToken,
        }),
        { mode: 0o600 },
      );
      return path;
    }
    async function fixture() {
      const organizationId = randomUUID(),
        actorId = randomUUID(),
        email = `${actorId}@example.test`;
      await database`INSERT INTO organizations (id, slug, name) VALUES (${organizationId}, ${organizationId}, 'HTTP CLI fixture')`;
      await database`INSERT INTO users (id,email) VALUES (${actorId},${email})`;
      await database`INSERT INTO organization_memberships (organization_id,user_id,role) VALUES (${organizationId},${actorId},'owner')`;
      const context = tenantContext(organizationId, actorId, `cli-http-${randomUUID()}`);
      const project = await planner.createProject(context, {
        name: "CLI project",
        code: "PRESERVED-CODE",
        description: "PRIVATE-DESCRIPTION",
        plannedStart: "2026-10-05T08:00:00.123Z",
        timeZone: "UTC",
      });
      const first = await planner.createActivity(context, project.projectId, project.revision, {
        name: "Foundation",
        wbsId: project.rootWbsId,
        calendarId: project.calendarId,
        kind: "TASK",
        durationMinutes: 480,
        constraints: [],
        sortOrder: 20,
      });
      const second = await planner.createActivity(context, project.projectId, first.revision, {
        name: "Frame",
        wbsId: project.rootWbsId,
        calendarId: project.calendarId,
        kind: "TASK",
        durationMinutes: 480,
        constraints: [],
        sortOrder: 10,
      });
      await planner.createRelationship(context, project.projectId, second.revision, {
        predecessorId: first.id,
        successorId: second.id,
        type: "FS",
        lagMinutes: 0,
      });
      const session = await issueSession(database, actorId, email, null, undefined);
      const snapshot = await projects.plannerSnapshot(context, project.projectId);
      assert.ok(snapshot);
      assert.equal(snapshot.input.project.plannedStart, "2026-10-05T08:00:00.123Z");
      const configuration: ProjectConfigurationV1 = {
        schemaVersion: 1,
        kind: "engineo-project-configuration",
        scope: "schedule",
        input: snapshot.input,
      };
      return {
        organizationId,
        projectId: project.projectId,
        actorId,
        session,
        context,
        snapshot,
        configuration,
        authFile: await sessionFile(session),
      };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    function args(command: string, state: Target, extra: string[] = [], authFd = false) {
      return [
        command,
        "--api-origin",
        origin,
        "--organization",
        state.organizationId,
        "--project",
        state.projectId,
        ...(authFd ? ["--auth-fd", "3"] : ["--auth-file", state.authFile]),
        "--allow-http-loopback",
        ...extra,
      ];
    }
    async function run(command: string, state: Target, extra: string[] = []) {
      return await launch(args(command, state, extra)).done;
    }
    const configurationPath = (state: Target) =>
      `/organizations/${state.organizationId}/projects/${state.projectId}/configuration`;
    async function inputFile(configuration: ProjectConfigurationV1) {
      const path = join(directory, `${randomUUID()}.configuration.json`);
      await writeFile(path, JSON.stringify(configuration), { mode: 0o600 });
      return path;
    }
    function desired(state: Fixture, suffix = "changed") {
      const value = structuredClone(state.configuration);
      assert.ok(value.input.activities[0]);
      value.input.activities[0].name += ` ${suffix}`;
      value.input.activities[0].durationMinutes += 60;
      return value;
    }
    async function plan(state: Fixture, configuration = desired(state), planId = randomUUID()) {
      const file = await inputFile(configuration),
        out = join(directory, `${randomUUID()}.review.json`);
      const argv = [
        "--file",
        file,
        "--plan-id",
        planId,
        "--expected-revision",
        String(state.snapshot.revision),
        "--out",
        out,
      ];
      const output = success<ProjectConfigurationPlanReadV1 & { recovered: boolean }>(
        await run("plan", state, argv),
      );
      assert.ok(output.plan);
      assert.equal(output.planId, planId);
      assert.equal(
        hash(serializeProjectConfigurationReviewV1(output.plan)),
        output.plan.reviewedDigest,
      );
      assert.equal(
        hash(serializeScheduleInputV1(output.plan.configuration.input)),
        output.plan.desiredInputHashSha256,
      );
      const artifact = await readFile(out, "utf8");
      assertPrivate(artifact);
      assert.equal((await stat(out)).mode & 0o077, 0);
      assert.deepEqual((JSON.parse(artifact) as { plan: unknown }).plan, output.plan);
      return { plan: output.plan, out, file, argv, output };
    }
    const mutationArgs = (review: { out: string; plan: ProjectConfigurationPlanV1 }) => [
      "--plan",
      review.out,
      "--expected-revision",
      String(review.plan.baseRevision),
    ];
    async function current(state: Fixture) {
      const value = await projects.plannerSnapshot(state.context, state.projectId);
      assert.ok(value);
      return value;
    }
    async function audits(state: Fixture, planId: string) {
      return await database`SELECT id,action,actor_id,payload FROM audit_events WHERE organization_id=${state.organizationId}
        AND resource_id=${state.projectId} AND payload->>'planId'=${planId} ORDER BY occurred_at,id`;
    }
    async function assertOutcome(state: Fixture, receipt: ProjectConfigurationReceiptV1) {
      const rows =
        await database`SELECT receipt_json,receipt_hash_sha256 FROM project_configuration_outcomes
        WHERE organization_id=${state.organizationId} AND project_id=${state.projectId} AND plan_id=${receipt.planId}`;
      assert.equal(rows.length, 1);
      assert.deepEqual(JSON.parse(String(rows[0]?.receipt_json)), receipt);
      assert.equal(hash(String(rows[0]?.receipt_json)), rows[0]?.receipt_hash_sha256);
      const events = await audits(state, receipt.planId);
      assert.equal(events.filter((event) => event.action === "configuration.plan").length, 1);
      assert.equal(
        events.filter(
          (event) =>
            event.action ===
            (receipt.outcome === "cancelled" ? "configuration.cancel" : "configuration.apply"),
        ).length,
        1,
      );
      assert.ok(events.every((event) => event.actor_id === state.actorId));
      assert.equal(events.filter((event) => event.id === receipt.provenanceAuditId).length, 1);
      assert.equal(
        events.filter((event) => event.action === "project.schedule.edit").length,
        receipt.outcome === "applied" ? 1 : 0,
      );
      if (receipt.outcome === "applied")
        assert.equal(
          events.find((event) => event.action === "project.schedule.edit")?.id,
          receipt.scheduleEditAuditId,
        );
    }
    interface ReceiptData {
      historical: true;
      receipt: ProjectConfigurationReceiptV1;
      recovered: boolean;
    }
    interface ResultData {
      revision: number;
      result: EngineScheduleResultV1 | null;
      calculation: ScheduleCalculationMetadataV1 | null;
      recovered?: boolean;
    }

    await t.test(
      "a still-open auth descriptor exits with one JSON envelope on deadline and SIGINT",
      async () => {
        const state = await fixture();
        const deadline = launch(args("read", state, ["--timeout-ms", "250"], true), "pipe");
        try {
          failure(await deadline.done, "transport", "input_timeout");
        } finally {
          deadline.child.stdio[3]?.destroy();
        }
        const interrupted = launch(args("read", state, ["--timeout-ms", "5000"], true), "pipe");
        // Keep descriptor 3 open without EOF. SIGINT is delivered after normal
        // Node startup; the read must not keep the executable alive afterward.
        const timer = setTimeout(() => interrupted.child.kill("SIGINT"), 300);
        try {
          failure(await interrupted.done, "interrupted", "input_interrupted");
        } finally {
          clearTimeout(timer);
          interrupted.child.stdio[3]?.destroy();
        }
      },
    );

    const malformedState = await fixture();
    const malformedCredentials = [
      {
        label: "raw cookie key",
        property: '"engineo_session=CLI_HTTP_SYNTHETIC_COOKIE_RAW"',
        credential: "CLI_HTTP_SYNTHETIC_COOKIE_RAW",
      },
      {
        label: "Unicode-escaped cookie key",
        property: String.raw`"engineo_\u0073ession=CLI_HTTP_SYNTHETIC_COOKIE_UNICODE"`,
        credential: "CLI_HTTP_SYNTHETIC_COOKIE_UNICODE",
      },
      {
        label: "escaped-tab cookie key",
        property: String.raw`"engineo_session\t=CLI_HTTP_SYNTHETIC_COOKIE_TAB"`,
        credential: "CLI_HTTP_SYNTHETIC_COOKIE_TAB",
      },
      {
        label: "raw Bearer key",
        property: '"Bearer CLI_HTTP_SYNTHETIC_BEARER_RAW"',
        credential: "CLI_HTTP_SYNTHETIC_BEARER_RAW",
      },
      {
        label: "Unicode-escaped Bearer key",
        property: String.raw`"\u0042earer CLI_HTTP_SYNTHETIC_BEARER_UNICODE"`,
        credential: "CLI_HTTP_SYNTHETIC_BEARER_UNICODE",
      },
      {
        label: "escaped-tab Bearer key",
        property: String.raw`"Bearer\tCLI_HTTP_SYNTHETIC_BEARER_TAB"`,
        credential: "CLI_HTTP_SYNTHETIC_BEARER_TAB",
      },
    ];
    secrets.push(...malformedCredentials.map((specimen) => specimen.credential));
    for (const specimen of malformedCredentials) {
      for (const mode of ["offline validate", "authoritative validate", "plan"] as const) {
        await t.test(`malformed ${specimen.label} is private during ${mode}`, async () => {
          const file = join(directory, `${randomUUID()}.malformed.json`);
          // The key is valid JSON text, including the decoded escape variants,
          // but its missing value makes whole-document JSON.parse fail. Parser
          // diagnostics must never echo this decoded credential-bearing path.
          await writeFile(file, `{${specimen.property}: }`, { mode: 0o600 });
          const before = calls.length;
          const out = join(directory, `${randomUUID()}.malformed-review.json`);
          const response =
            mode === "offline validate"
              ? await launch(["validate", "--file", file, "--offline"]).done
              : mode === "authoritative validate"
                ? await run("validate", malformedState, ["--file", file, "--authoritative"])
                : await run("plan", malformedState, [
                    "--file",
                    file,
                    "--plan-id",
                    randomUUID(),
                    "--expected-revision",
                    String(malformedState.snapshot.revision),
                    "--out",
                    out,
                  ]);
          failure(response, "validation");
          assert.equal(response.output.command, mode === "plan" ? "plan" : "validate");
          assert.equal(response.stderr, "");
          assertPrivate(JSON.stringify(response.output));
          assert.deepEqual(
            calls.slice(before),
            mode === "offline validate" ? [] : [{ method: "GET", path: "/auth/me" }],
          );
          await assert.rejects(access(out));
          assert.equal((await current(malformedState)).revision, malformedState.snapshot.revision);
        });
      }
    }

    secrets.push(...strictConfigurationFailures.map((specimen) => specimen.credential));
    for (const specimen of strictConfigurationFailures) {
      for (const mode of ["offline validate", "authoritative validate", "plan"] as const) {
        await t.test(`strict ${specimen.label} is private during ${mode}`, async () => {
          assert.doesNotThrow(() => JSON.parse(specimen.source));
          const file = join(directory, `${randomUUID()}.strict-invalid.json`),
            out = join(directory, `${randomUUID()}.strict-invalid-review.json`);
          await writeFile(file, specimen.source, { mode: 0o600 });
          const before = calls.length;
          const response =
            mode === "offline validate"
              ? await launch(["validate", "--file", file, "--offline"]).done
              : mode === "authoritative validate"
                ? await run("validate", malformedState, ["--file", file, "--authoritative"])
                : await run("plan", malformedState, [
                    "--file",
                    file,
                    "--plan-id",
                    randomUUID(),
                    "--expected-revision",
                    String(malformedState.snapshot.revision),
                    "--out",
                    out,
                  ]);
          failure(response, "validation", "configuration_invalid");
          assert.equal(response.output.command, mode === "plan" ? "plan" : "validate");
          assert.equal(response.stderr, "");
          assertPrivate(response.stdout);
          const details = response.output.error?.details as {
            valid: boolean;
            calculationChecked: boolean;
            diagnostics: {
              totalCount: number;
              truncated: boolean;
              issues: { code: string; path: string; message: string }[];
            };
          };
          assert.equal(details.valid, false);
          assert.equal(details.calculationChecked, false);
          assert.equal(details.diagnostics.totalCount, 1);
          assert.equal(details.diagnostics.truncated, false);
          assert.equal(details.diagnostics.issues.length, 1);
          assert.equal(details.diagnostics.issues[0]?.code, specimen.issueCode);
          assert.equal(details.diagnostics.issues[0]?.path, "");
          if (specimen.issueCode === "INVALID_JSON")
            assert.match(
              details.diagnostics.issues[0]?.message ?? "",
              /^Malformed JSON at character \d+\.$/,
            );
          assert.deepEqual(
            calls.slice(before),
            mode === "offline validate" ? [] : [{ method: "GET", path: "/auth/me" }],
          );
          await assert.rejects(access(out));
          assert.equal((await current(malformedState)).revision, malformedState.snapshot.revision);
        });
      }
    }

    await t.test(
      "read/export and both validation modes use canonical hashes, private artifacts and export audits",
      async () => {
        const state = await fixture(),
          file = await inputFile(state.configuration);
        const exported = join(directory, "export.json");
        const read = success<ProjectConfigurationReadV1>(await run("read", state));
        assert.equal(read.revision, state.snapshot.revision);
        assert.equal(read.configuration.input.project.plannedStart, "2026-10-05T08:00:00.123Z");
        assert.equal(
          read.inputHashSha256,
          hash(serializeScheduleInputV1(state.configuration.input)),
        );
        success(await run("export", state, ["--out", exported]));
        const text = await readFile(exported, "utf8");
        assertPrivate(text);
        assert.equal(text.includes("PRESERVED-CODE"), false);
        assert.equal(text.includes("PRIVATE-DESCRIPTION"), false);
        assert.deepEqual(JSON.parse(text), read.configuration);
        assert.equal((await stat(exported)).mode & 0o077, 0);
        const authoritative = success<{
          authoritative: boolean;
          calculationChecked: boolean;
          desiredInputHashSha256: string;
        }>(await run("validate", state, ["--file", file, "--authoritative"]));
        assert.equal(authoritative.authoritative, true);
        assert.equal(authoritative.calculationChecked, false);
        assert.equal(authoritative.desiredInputHashSha256, read.inputHashSha256);
        const offline = success<{ authoritative: boolean }>(
          await launch(["validate", "--file", file, "--offline"]).done,
        );
        assert.equal(offline.authoritative, false);
        const events =
          await database`SELECT actor_id,payload FROM audit_events WHERE organization_id=${state.organizationId}
        AND resource_id=${state.projectId} AND action='project.export'`;
        assert.equal(events.length, 2);
        assert.ok(events.every((event) => event.actor_id === state.actorId));
        assert.equal((await current(state)).revision, state.snapshot.revision);
        const handle = await open(state.authFile, "r");
        try {
          success(await launch(args("read", state, [], true), handle.fd).done);
        } finally {
          await handle.close();
        }
      },
    );

    await t.test(
      "live actor/session binding, CSRF, allowed origin and tenant membership fail closed",
      async () => {
        const state = await fixture(),
          file = await inputFile(state.configuration);
        const actorMismatch = {
          ...state,
          authFile: await sessionFile(state.session, randomUUID()),
        };
        failure(await run("read", actorMismatch), "auth", "identity_mismatch");
        const invalid = JSON.parse(await readFile(state.authFile, "utf8"));
        invalid.sessionId = randomUUID();
        const badSession = join(directory, "bad-session.json");
        await writeFile(badSession, JSON.stringify(invalid), { mode: 0o600 });
        failure(await run("read", { ...state, authFile: badSession }), "auth", "session_changed");
        invalid.sessionId = state.session.principal.sessionId;
        invalid.csrfToken = randomBytes(32).toString("base64url");
        secrets.push(invalid.csrfToken);
        const badCsrf = join(directory, "bad-csrf.json");
        await writeFile(badCsrf, JSON.stringify(invalid), { mode: 0o600 });
        failure(
          await run("validate", { ...state, authFile: badCsrf }, [
            "--file",
            file,
            "--authoritative",
          ]),
          "auth",
          "csrf_validation_failed",
        );
        failure(
          await run("validate", state, [
            "--file",
            file,
            "--authoritative",
            "--app-origin",
            "http://127.0.0.1:1",
          ]),
          "auth",
          "origin_not_allowed",
        );
        const stranger = await fixture();
        failure(await run("read", { ...state, authFile: stranger.authFile }), "auth", "forbidden");
        failure(
          await run("read", { ...state, organizationId: stranger.organizationId }),
          "auth",
          "forbidden",
        );
        await database`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=${state.session.principal.sessionId}`;
        failure(await run("read", state), "auth", "unauthenticated");
        assert.equal((await current(state)).revision, state.snapshot.revision);
      },
    );

    await t.test(
      "plan/status/apply/receipt and same-identity retries persist one revision and exact atomic audits",
      async () => {
        const state = await fixture(),
          review = await plan(state);
        assert.equal(review.output.status, "pending");
        assert.equal(review.plan.noOp, false);
        assert.equal((await current(state)).revision, state.snapshot.revision);
        const status = success<ProjectConfigurationPlanReadV1>(
          await run("status", state, ["--plan-id", review.plan.planId]),
        );
        assert.deepEqual(status.plan, review.plan);
        assert.equal(status.receipt, null);
        const duplicateOut = join(directory, `${randomUUID()}.retry.json`);
        const replay = success<ProjectConfigurationPlanReadV1>(
          await run("plan", state, [...review.argv.slice(0, -1), duplicateOut]),
        );
        assert.deepEqual(replay.plan, review.plan);
        const applied = success<ReceiptData>(await run("apply", state, mutationArgs(review)));
        assert.equal(applied.historical, true);
        assert.equal(applied.receipt.outcome, "applied");
        assert.equal(applied.receipt.committedRevision, state.snapshot.revision + 1);
        assert.deepEqual(
          success<ReceiptData>(await run("apply", state, mutationArgs(review))).receipt,
          applied.receipt,
        );
        assert.deepEqual(
          success<ReceiptData>(await run("receipt", state, ["--plan-id", review.plan.planId]))
            .receipt,
          applied.receipt,
        );
        const persisted = await current(state);
        assert.equal(persisted.revision, applied.receipt.committedRevision);
        assert.equal(
          hash(serializeScheduleInputV1(persisted.input)),
          review.plan.desiredInputHashSha256,
        );
        const native =
          await database`SELECT code,description FROM projects WHERE id=${state.projectId}`;
        assert.equal(native[0]?.code, "PRESERVED-CODE");
        assert.equal(native[0]?.description, "PRIVATE-DESCRIPTION");
        await assertOutcome(state, applied.receipt);
        const otherSession = await issueSession(
          database,
          state.actorId,
          state.session.principal.email,
          null,
          undefined,
        );
        const changed = { ...state, authFile: await sessionFile(otherSession) };
        failure(
          await run("apply", changed, mutationArgs(review)),
          "auth",
          "review_identity_mismatch",
        );
        failure(
          await run("status", changed, ["--plan-id", review.plan.planId]),
          "unavailable",
          "configuration_plan_not_found",
        );
        // Historical receipts remain accessible to the creator after session rotation.
        assert.deepEqual(
          success<ReceiptData>(await run("receipt", changed, ["--plan-id", review.plan.planId]))
            .receipt,
          applied.receipt,
        );
        failure(
          await run("apply", { ...state, projectId: randomUUID() }, mutationArgs(review)),
          "conflict",
          "review_destination_mismatch",
        );
      },
    );

    await t.test(
      "cancel is terminal/idempotent and no-op preserves revision and existing Rust result",
      async () => {
        const state = await fixture(),
          review = await plan(state);
        const cancelled = success<ReceiptData>(await run("cancel", state, mutationArgs(review)));
        assert.equal(cancelled.receipt.outcome, "cancelled");
        assert.equal(cancelled.receipt.committedRevision, null);
        assert.deepEqual(
          success<ReceiptData>(await run("cancel", state, mutationArgs(review))).receipt,
          cancelled.receipt,
        );
        failure(
          await run("apply", state, mutationArgs(review)),
          "conflict",
          "configuration_cancelled",
        );
        await assertOutcome(state, cancelled.receipt);
        const result = success<ResultData>(
          await run("calculate", state, ["--expected-revision", String(state.snapshot.revision)]),
        );
        assert.ok(result.result && result.calculation);
        assert.equal(result.calculation.engineVersion, engineVersion);
        const noOp = await plan(state, state.configuration);
        assert.equal(noOp.plan.noOp, true);
        assert.deepEqual(noOp.plan.changes, []);
        const applied = success<ReceiptData>(await run("apply", state, mutationArgs(noOp)));
        assert.equal(applied.receipt.outcome, "no_op");
        assert.equal(applied.receipt.committedRevision, state.snapshot.revision);
        await assertOutcome(state, applied.receipt);
        const retained = success<ResultData>(
          await run("result", state, ["--expected-revision", String(state.snapshot.revision)]),
        );
        assert.deepEqual(retained.result, result.result);
        assert.deepEqual(retained.calculation, result.calculation);
        assert.equal((await current(state)).revision, state.snapshot.revision);
      },
    );

    await t.test(
      "stale plans, mismatched revisions and reused identities never mutate",
      async () => {
        const state = await fixture(),
          first = await plan(state),
          stale = await plan(state, desired(state, "other"));
        failure(
          await run("apply", state, [
            "--plan",
            first.out,
            "--expected-revision",
            String(state.snapshot.revision + 1),
          ]),
          "conflict",
          "review_revision_mismatch",
        );
        success(await run("apply", state, mutationArgs(first)));
        failure(await run("apply", state, mutationArgs(stale)), "conflict", "revision_conflict");
        const changedFile = await inputFile(desired(state, "identity-conflict"));
        failure(
          await run("plan", state, [
            "--file",
            changedFile,
            "--plan-id",
            first.plan.planId,
            "--expected-revision",
            String(state.snapshot.revision),
            "--out",
            join(directory, `${randomUUID()}.conflict.json`),
          ]),
          "conflict",
          "configuration_idempotency_conflict",
        );
        failure(
          await run("calculate", state, ["--expected-revision", String(state.snapshot.revision)]),
          "conflict",
          "revision_conflict",
        );
        assert.equal((await current(state)).revision, state.snapshot.revision + 1);
        assert.equal(
          (await audits(state, stale.plan.planId)).filter(
            (row) => row.action === "configuration.apply",
          ).length,
          0,
        );
      },
    );

    await t.test(
      "simultaneous same-plan applies replay one receipt; competing plans cannot both commit",
      async () => {
        const same = await fixture(),
          review = await plan(same);
        const pair = await Promise.all([
          run("apply", same, mutationArgs(review)),
          run("apply", same, mutationArgs(review)),
        ]);
        const receipts = pair.map((row) => success<ReceiptData>(row).receipt);
        assert.deepEqual(receipts[0], receipts[1]);
        assert.ok(receipts[0]);
        await assertOutcome(same, receipts[0]);
        assert.equal((await current(same)).revision, same.snapshot.revision + 1);
        const competing = await fixture(),
          first = await plan(competing),
          second = await plan(competing, desired(competing, "second"));
        const results = await Promise.all([
          run("apply", competing, mutationArgs(first)),
          run("apply", competing, mutationArgs(second)),
        ]);
        assert.equal(results.filter((row) => row.output.ok).length, 1);
        const loser = results.find((row) => !row.output.ok);
        assert.ok(loser);
        failure(loser, "conflict", "revision_conflict");
        assert.equal((await current(competing)).revision, competing.snapshot.revision + 1);
        const winner = results.find((row) => row.output.ok);
        assert.ok(winner);
        await assertOutcome(competing, success<ReceiptData>(winner).receipt);
      },
    );

    await t.test(
      "pending reviews, terminal receipts and Rust results survive real API restarts",
      async () => {
        const state = await fixture(),
          review = await plan(state);
        const restart = async () => {
          assert.ok(app);
          await app.close();
          app = buildApp({
            database,
            scheduleRunner: new ProcessScheduleRunner({
              binaryPath: process.env.ENGINEO_SCHEDULER_BIN ?? "",
            }),
          });
          backendOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
        };
        await restart();
        const pending = success<ProjectConfigurationPlanReadV1>(
          await run("status", state, ["--plan-id", review.plan.planId]),
        );
        assert.equal(pending.status, "pending");
        assert.deepEqual(pending.plan, review.plan);
        const applied = success<ReceiptData>(await run("apply", state, mutationArgs(review)));
        const revision = String(state.snapshot.revision + 1);
        const calculated = success<ResultData>(
          await run("calculate", state, ["--expected-revision", revision]),
        );
        assert.ok(calculated.result && calculated.calculation);
        await restart();
        const terminal = success<ProjectConfigurationPlanReadV1>(
          await run("status", state, ["--plan-id", review.plan.planId]),
        );
        assert.equal(terminal.status, "applied");
        assert.deepEqual(terminal.receipt, applied.receipt);
        assert.deepEqual(
          success<ReceiptData>(await run("apply", state, mutationArgs(review))).receipt,
          applied.receipt,
        );
        const restored = success<ResultData>(
          await run("result", state, ["--expected-revision", revision]),
        );
        assert.deepEqual(restored.result, calculated.result);
        assert.deepEqual(restored.calculation, calculated.calculation);
        await assertOutcome(state, applied.receipt);
      },
    );

    await t.test(
      "lost post-commit plan/apply/cancel/calculation responses recover by the same identity",
      async () => {
        const state = await fixture();
        faults.push({ method: "POST", path: `${configurationPath(state)}/plans`, mode: "drop" });
        const review = await plan(state);
        assert.equal(review.output.recovered, true);
        faults.push({
          method: "POST",
          path: `${configurationPath(state)}/plans/${review.plan.planId}/apply`,
          mode: "drop",
        });
        const applied = success<ReceiptData>(await run("apply", state, mutationArgs(review)));
        assert.equal(applied.recovered, true);
        await assertOutcome(state, applied.receipt);
        const cancelState = await fixture(),
          cancelReview = await plan(cancelState);
        faults.push({
          method: "POST",
          path: `${configurationPath(cancelState)}/plans/${cancelReview.plan.planId}/cancel`,
          mode: "drop",
        });
        const cancelled = success<ReceiptData>(
          await run("cancel", cancelState, mutationArgs(cancelReview)),
        );
        assert.equal(cancelled.recovered, true);
        await assertOutcome(cancelState, cancelled.receipt);
        faults.push({
          method: "POST",
          path: `/organizations/${state.organizationId}/projects/${state.projectId}/schedule/run`,
          mode: "drop",
        });
        const calculated = success<ResultData>(
          await run("calculate", state, [
            "--expected-revision",
            String(state.snapshot.revision + 1),
          ]),
        );
        assert.equal(calculated.recovered, true);
        assert.ok(calculated.calculation && calculated.result);
        assert.equal(calculated.calculation.engineVersion, engineVersion);
        assert.equal(calculated.calculation.inputHashSha256, review.plan.desiredInputHashSha256);
        assert.equal(
          calculated.calculation.resultHashSha256,
          hash(serializeScheduleResultV1(calculated.result)),
        );
        const stored =
          await database`SELECT c.*,a.action,a.actor_id,a.payload FROM schedule_calculations c JOIN audit_events a
        ON a.id=c.audit_event_id AND a.organization_id=c.organization_id WHERE c.id=${calculated.calculation.calculationId}`;
        assert.equal(stored.length, 1);
        assert.equal(stored[0]?.action, "schedule.run");
        assert.equal(stored[0]?.actor_id, state.actorId);
        assert.equal(stored[0]?.input_hash_sha256, calculated.calculation.inputHashSha256);
        assert.equal(stored[0]?.result_hash_sha256, calculated.calculation.resultHashSha256);
        assert.equal(
          hash(String(stored[0]?.input_canonical)),
          calculated.calculation.inputHashSha256,
        );
        assert.equal(hash(String(stored[0]?.result_json)), calculated.calculation.resultHashSha256);
        assert.equal(stored[0]?.engine_version, engineVersion);
        assert.equal(stored[0]?.engine_contract_version, 1);
        const reused = success<ResultData>(
          await run("calculate", state, [
            "--expected-revision",
            String(state.snapshot.revision + 1),
          ]),
        );
        assert.equal(reused.calculation?.calculationId, calculated.calculation.calculationId);
      },
    );

    await t.test(
      "unavailable recovery reports uncertainty without inventing cancellation or a fresh plan identity",
      async () => {
        const state = await fixture(),
          review = await plan(state);
        const applyPath = `${configurationPath(state)}/plans/${review.plan.planId}/apply`,
          receiptPath = `${configurationPath(state)}/plans/${review.plan.planId}/receipt`;
        faults.push(
          { method: "POST", path: applyPath, mode: "drop" },
          { method: "GET", path: receiptPath, mode: "unavailable" },
        );
        const before = calls.filter((call) => call.path === applyPath).length;
        const uncertain = await run("apply", state, mutationArgs(review));
        failure(uncertain, "uncertain", "mutation_outcome_unknown");
        assert.equal(uncertain.output.exitCode, 7);
        assert.deepEqual(uncertain.output.error?.details, {
          action: "apply",
          planId: review.plan.planId,
          outcomeKnown: false,
        });
        assert.equal(calls.filter((call) => call.path === applyPath).length, before + 1);
        const receipt = success<ReceiptData>(
          await run("receipt", state, ["--plan-id", review.plan.planId]),
        ).receipt;
        assert.equal(receipt.outcome, "applied");
        await assertOutcome(state, receipt);
      },
    );

    await t.test(
      "SIGINT after server commit reports unknown outcome and leaves the committed receipt intact",
      async () => {
        const state = await fixture(),
          review = await plan(state);
        let observed: (() => void) | undefined;
        const committed = new Promise<void>((resolveCommit) => {
          observed = resolveCommit;
        });
        const fault: Fault = {
          method: "POST",
          path: `${configurationPath(state)}/plans/${review.plan.planId}/apply`,
          mode: "hold",
          seen: () => observed?.(),
        };
        faults.push(fault);
        const pending = launch(args("apply", state, mutationArgs(review)));
        try {
          await Promise.race([
            committed,
            pending.done.then(() => {
              throw new Error("CLI exited before the held post-commit response was observed");
            }),
          ]);
          assert.equal(pending.child.kill("SIGINT"), true);
          const interrupted = await pending.done;
          failure(interrupted, "interrupted", "mutation_interrupted");
          assert.equal(interrupted.output.exitCode, 130);
          assert.deepEqual(interrupted.output.error?.details, {
            action: "apply",
            planId: review.plan.planId,
            outcomeKnown: false,
          });
        } finally {
          fault.held?.destroy();
        }
        const receipt = success<ReceiptData>(
          await run("receipt", state, ["--plan-id", review.plan.planId]),
        ).receipt;
        assert.equal(receipt.outcome, "applied");
        await assertOutcome(state, receipt);
      },
    );

    await t.test(
      "real session revocation during lost-reply recovery preserves the original mutation uncertainty",
      async () => {
        const state = await fixture(),
          review = await plan(state);
        let observed: (() => void) | undefined;
        const committed = new Promise<void>((resolveCommit) => {
          observed = resolveCommit;
        });
        const fault: Fault = {
          method: "POST",
          path: `${configurationPath(state)}/plans/${review.plan.planId}/apply`,
          mode: "hold",
          seen: () => observed?.(),
        };
        faults.push(fault);
        const pending = launch(args("apply", state, mutationArgs(review)));
        try {
          await Promise.race([
            committed,
            pending.done.then(() => {
              throw new Error("CLI exited before the held post-commit response was observed");
            }),
          ]);
          await database`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=${state.session.principal.sessionId}`;
          fault.held?.destroy();
          const denied = await pending.done;
          failure(denied, "auth", "unauthenticated");
          assert.deepEqual(denied.output.error?.details, {
            httpStatus: 401,
            action: "apply",
            planId: review.plan.planId,
            outcomeKnown: false,
          });
        } finally {
          fault.held?.destroy();
        }
        const replacement = await issueSession(
          database,
          state.actorId,
          state.session.principal.email,
          null,
          undefined,
        );
        const rotated = { ...state, authFile: await sessionFile(replacement) };
        const receipt = success<ReceiptData>(
          await run("receipt", rotated, ["--plan-id", review.plan.planId]),
        ).receipt;
        assert.equal(receipt.outcome, "applied");
        await assertOutcome(state, receipt);
      },
    );

    await t.test(
      "tampered complete reviews and API result hashes fail integrity and never leave applyable output",
      async () => {
        const state = await fixture(),
          review = await plan(state);
        const edited = JSON.parse(await readFile(review.out, "utf8"));
        edited.plan.configuration.input.activities[0].durationMinutes += 1;
        const editedPath = join(directory, "tampered-review.json");
        await writeFile(editedPath, JSON.stringify(edited), { mode: 0o600 });
        failure(
          await run("apply", state, [
            "--plan",
            editedPath,
            "--expected-revision",
            String(state.snapshot.revision),
          ]),
          "integrity",
        );
        assert.equal((await current(state)).revision, state.snapshot.revision);
        const out = join(directory, "tampered-response.json");
        faults.push({
          method: "POST",
          path: `${configurationPath(state)}/plans`,
          mode: "tamper",
          transform(body) {
            (body.plan as Record<string, unknown>).desiredInputHashSha256 = "0".repeat(64);
          },
        });
        failure(
          await run("plan", state, [
            "--file",
            review.file,
            "--plan-id",
            randomUUID(),
            "--expected-revision",
            String(state.snapshot.revision),
            "--out",
            out,
          ]),
          "integrity",
        );
        await assert.rejects(access(out));
        success(
          await run("calculate", state, ["--expected-revision", String(state.snapshot.revision)]),
        );
        faults.push({
          method: "GET",
          path: `/organizations/${state.organizationId}/projects/${state.projectId}/schedule/result`,
          mode: "tamper",
          transform(body) {
            (body.calculation as Record<string, unknown>).resultHashSha256 = "0".repeat(64);
          },
        });
        failure(
          await run("result", state, ["--expected-revision", String(state.snapshot.revision)]),
          "integrity",
        );
      },
    );
    assert.equal(faults.length, 0, "All intended TCP faults must have been reached");
  } catch (error) {
    primaryError = error;
    failed = true;
  } finally {
    // Continue disposal even if one close fails. In particular, a denied socket
    // listen must not strand the disposable database or skip connection cleanup.
    const dispose = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    const closingProxy = proxy,
      closingApp = app,
      closingDatabase = db;
    if (closingProxy?.listening) await dispose(() => close(closingProxy));
    if (closingApp) await dispose(() => closingApp.close());
    if (closingDatabase) await dispose(() => closingDatabase.end({ timeout: 5 }));
    if (created) await dispose(() => admin.unsafe(`DROP DATABASE "${databaseName}"`));
    await dispose(() => admin.end({ timeout: 5 }));
    await dispose(() => rm(directory, { recursive: true, force: true }));
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = oldAppOrigin;
    if (cleanupErrors.length)
      t.diagnostic(`Disposal had ${cleanupErrors.length} failure(s) for ${databaseName}`);
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(failed ? [primaryError] : []), ...cleanupErrors],
      "CLI HTTP integration and/or disposable cleanup failed",
    );
  if (failed) throw primaryError;
});
