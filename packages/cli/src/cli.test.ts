import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  diffProjectConfigurationV1,
  type ProjectConfigurationPlanV1,
  type ProjectConfigurationReceiptV1,
  type ProjectConfigurationV1,
  serializeProjectConfigurationReviewV1,
  serializeScheduleInputV1,
  serializeScheduleResultV1,
  validateProjectConfigurationV1,
} from "@engineo/contracts";
import { destination, parseArguments, safeOrigin } from "./arguments.js";
import { checkPlan, checkSavedReview, hash, savedReview } from "./artifacts.js";
import { CliError, EXIT, remoteError } from "./errors.js";
import { readInput, reserveOutput } from "./files.js";
import { parseJson, rejectCredentials } from "./json.js";
import { checkResult } from "./result.js";
import { runCli } from "./run.js";
import { ApiClient, type SessionMaterial } from "./transport.js";

const id = (number: number) => `00000000-0000-0000-0000-${number.toString(16).padStart(12, "0")}`;
const target = {
  apiOrigin: "https://api.example.test",
  appOrigin: "https://app.example.test",
  organizationId: id(1),
  projectId: id(2),
};
const session: SessionMaterial = {
  schemaVersion: 1,
  kind: "engineo-cli-session",
  actorId: id(3),
  sessionId: id(4),
  sessionToken: "s".repeat(48),
  csrfToken: "c".repeat(48),
};
const remote = [
  "--api-origin",
  target.apiOrigin,
  "--app-origin",
  target.appOrigin,
  "--organization",
  target.organizationId,
  "--project",
  target.projectId,
];
function configuration(name = "Project"): ProjectConfigurationV1 {
  const value: ProjectConfigurationV1 = {
    schemaVersion: 1,
    kind: "engineo-project-configuration",
    scope: "schedule",
    input: {
      schemaVersion: 1,
      project: {
        id: id(2),
        name,
        plannedStart: "2026-10-05T08:00:00.000Z",
        dataDate: "2026-10-05T08:00:00.000Z",
        requiredFinish: null,
        defaultCalendarId: id(5),
      },
      scheduleOptions: {
        criticalFloatThresholdMinutes: 0,
        lagCalendarPolicy: "SUCCESSOR",
        projectFinishPolicy: "CALCULATED",
      },
      calendars: [
        {
          id: id(5),
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
      wbs: [{ id: id(6), parentId: null, code: "1", name: "Root", sortOrder: 0 }],
      activities: [
        {
          id: id(7),
          wbsId: id(6),
          calendarId: id(5),
          name: "Work",
          kind: "TASK",
          durationMinutes: 60,
          constraints: [],
        },
      ],
      relationships: [],
    },
  };
  const normalized = validateProjectConfigurationV1(value);
  assert.equal(normalized.valid, true);
  if (!normalized.valid) throw new Error("Invalid test fixture");
  return normalized.normalizedConfiguration;
}
function plan(noOp = false): ProjectConfigurationPlanV1 {
  const base = configuration(),
    candidate = configuration(noOp ? "Project" : "Changed");
  const value = {
    schemaVersion: 1 as const,
    protocolVersion: 1 as const,
    normalizationVersion: 1 as const,
    planId: id(8),
    organizationId: target.organizationId,
    projectId: target.projectId,
    actorId: session.actorId,
    sessionId: session.sessionId,
    createdAt: "2026-10-03T09:00:00.000Z",
    expiresAt: "2026-10-03T09:15:00.000Z",
    baseRevision: 2,
    baseInputHashSha256: hash(serializeScheduleInputV1(base.input)),
    desiredInputHashSha256: hash(serializeScheduleInputV1(candidate.input)),
    configuration: candidate,
    changes: diffProjectConfigurationV1(base.input, candidate.input).changes,
    noOp,
  };
  return { ...value, reviewedDigest: hash(serializeProjectConfigurationReviewV1(value)) };
}
function receipt(review = plan(), cancelled = false): ProjectConfigurationReceiptV1 {
  const common = {
    schemaVersion: 1 as const,
    planId: review.planId,
    organizationId: review.organizationId,
    projectId: review.projectId,
    previousRevision: review.baseRevision,
    baseInputHashSha256: review.baseInputHashSha256,
    reviewedDigest: review.reviewedDigest,
    provenanceAuditId: id(9),
    recordedAt: "2026-10-03T09:10:00.000Z",
  };
  return cancelled
    ? {
        ...common,
        outcome: "cancelled",
        committedRevision: null,
        committedInputHashSha256: null,
        scheduleEditAuditId: null,
      }
    : {
        ...common,
        outcome: review.noOp ? "no_op" : "applied",
        committedRevision: review.baseRevision + (review.noOp ? 0 : 1),
        committedInputHashSha256: review.desiredInputHashSha256,
        scheduleEditAuditId: review.noOp ? null : id(10),
      };
}
function response(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "x-engineo-session": session.sessionId,
      ...headers,
    },
  });
}
async function temporary(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "engineo-cli-unit-"));
}
async function withMock(
  action: (url: string, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => await action(String(input), init);
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("parser accepts explicit offline validation and remote destination", () => {
  assert.equal(parseArguments(["validate", "--file", "x", "--offline"]).flags.has("offline"), true);
  const parsed = parseArguments(["read", ...remote, "--auth-fd", "3"]);
  assert.deepEqual(destination(parsed), target);
});
for (const args of [
  ["login"],
  ["validate", "--file", "x"],
  ["validate", "--file", "x", "--offline", "--authoritative"],
  ["read", ...remote],
  ["read", ...remote, "--auth-file", "x", "--auth-fd", "3"],
  ["read", ...remote, "--auth-fd", "2"],
  ["read", ...remote, "--auth-fd", "3", "--cookie", "secret"],
  ["read", ...remote, "--auth-fd", "3", "--api-origin", "https://other.test"],
  ["calculate", ...remote, "--auth-fd", "3", "--expected-revision", "0"],
  ["calculate", ...remote, "--auth-fd", "3", "--expected-revision", "1.0"],
  ["read", ...remote, "--auth-fd", "3", "--timeout-ms", "99"],
  ["plan", ...remote, "--auth-fd", "3", "--file", "x", "--expected-revision", "1", "--out", "x"],
])
  test(`parser rejects unsafe/incomplete options ${JSON.stringify(args.slice(0, 2))}`, () => {
    assert.throws(() => parseArguments(args), CliError);
  });

for (const origin of [
  "http://api.example.test",
  "https://x.test/path",
  "https://user:pass@x.test",
  "https://x.test?token=secret",
  "https://x.test#secret",
  "file:///tmp/x",
  "http://127.1",
  "http://2130706433",
  "http://0.0.0.0",
  "https://x.test:443",
])
  test(`origin rejects ${origin}`, () => {
    assert.throws(() => safeOrigin(origin, true), CliError);
  });
test("explicit loopback allowance and canonical origin", () => {
  assert.throws(() => safeOrigin("http://127.0.0.1:4000", false), CliError);
  assert.equal(safeOrigin("http://127.0.0.1:4000/", true), "http://127.0.0.1:4000");
  assert.equal(safeOrigin("http://[::1]:4000", true), "http://[::1]:4000");
});
for (const text of [
  '{"x":1,"x":2}',
  '{"x":1,"\\u0078":2}',
  '"\\ud800"',
  "NaN",
  "1e400",
  "1.00000000000000000001",
  "1e-999",
  "9007199254740992",
  "[1,]",
  '{"a":1} x',
])
  test(`bounded JSON rejects ${text.slice(0, 32)}`, () => {
    assert.throws(() => parseJson(text, 1024), CliError);
  });
test("bounded JSON handles escaped strings and prototype keys inertly", () => {
  assert.deepEqual(
    parseJson('{"__proto__":{"x":1},"a":"a\\"b"}', 1024),
    JSON.parse('{"__proto__":{"x":1},"a":"a\\"b"}'),
  );
  assert.throws(() => parseJson('"xxxxxxxx"', 3), CliError);
  assert.throws(() => parseJson(`${"[".repeat(66)}0${"]".repeat(66)}`, 1024), CliError);
});
for (const value of [
  { password: "x" },
  { api_key: "x" },
  { nested: { authorization: "x" } },
  { name: "engineo_session=x" },
  { name: "Bearer ABCDEF" },
  { name: session.sessionToken },
  { [session.csrfToken]: "x" },
])
  test("credentials cannot enter artifacts or diagnostic keys", () => {
    assert.throws(
      () => rejectCredentials(value, [session.sessionToken, session.csrfToken]),
      CliError,
    );
  });

test("complete review verifies visible changes, input, versions and all identities", () => {
  assert.deepEqual(checkPlan(plan(), target, session), plan());
  assert.deepEqual(checkSavedReview(savedReview(plan(), target), target, session, 2).plan, plan());
  for (const mutate of [
    (value: ProjectConfigurationPlanV1) => {
      value.configuration.input.project.name = "tampered";
    },
    (value: ProjectConfigurationPlanV1) => {
      value.changes = [];
    },
    (value: ProjectConfigurationPlanV1) => {
      value.baseRevision++;
    },
    (value: ProjectConfigurationPlanV1) => {
      value.desiredInputHashSha256 = "0".repeat(64);
    },
    (value: ProjectConfigurationPlanV1) => {
      value.actorId = id(90);
    },
    (value: ProjectConfigurationPlanV1) => {
      value.sessionId = id(90);
    },
  ]) {
    const copy = structuredClone(plan());
    mutate(copy);
    assert.throws(() => checkPlan(copy, target, session), CliError);
  }
  assert.throws(
    () =>
      checkSavedReview(
        savedReview(plan(), { ...target, apiOrigin: "https://other.test" }),
        target,
        session,
        2,
      ),
    CliError,
  );
  assert.throws(() => checkSavedReview(savedReview(plan(), target), target, session, 3), CliError);
  assert.throws(
    () => checkSavedReview({ ...savedReview(plan(), target), secret: "x" }, target, session, 2),
    CliError,
  );
});
test("exit categories preserve explicit errors without leaking server messages", () => {
  for (const [status, code, category] of [
    [401, "unauthenticated", "auth"],
    [403, "forbidden", "auth"],
    [409, "revision_conflict", "conflict"],
    [429, "configuration_capacity", "capacity"],
    [503, "configuration_integrity_error", "integrity"],
    [422, "configuration_invalid", "validation"],
    [410, "configuration_artifact_unavailable", "unavailable"],
  ] as const) {
    const value = remoteError(status, {
      error: code,
      message: session.sessionToken,
      stack: session.csrfToken,
    });
    assert.equal(value.category, category);
    assert.equal(JSON.stringify(value).includes(session.sessionToken), false);
  }
  assert.equal(remoteError(500, { error: session.sessionToken }).code, "remote_error");
  assert.equal(EXIT.uncertain, 7);
  assert.equal(remoteError(409, { error: "schedule_already_running" }).category, "capacity");
  assert.equal(
    remoteError(422, { error: "schedule_calculation_failed" }).code,
    "schedule_calculation_failed",
  );
  assert.equal(remoteError(503, { error: "schedule_output_limit" }).code, "schedule_output_limit");
  assert.equal(
    remoteError(503, { error: "temporarily_unavailable" }).code,
    "temporarily_unavailable",
  );
});
test("safe input/output refuses symlinks, shared session files, invalid UTF8, size and overwrite", async () => {
  const dir = await temporary(),
    signal = new AbortController().signal;
  try {
    const file = join(dir, "input");
    await writeFile(file, "{}", { mode: 0o600 });
    assert.equal(await readInput(file, 20, signal, true), "{}");
    const link = join(dir, "link");
    await symlink(file, link);
    await assert.rejects(readInput(link, 20, signal), CliError);
    const shared = join(dir, "shared");
    await writeFile(shared, "{}", { mode: 0o644 });
    await assert.rejects(readInput(shared, 20, signal, true), CliError);
    const fifo = join(dir, "fifo");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    await assert.rejects(readInput(fifo, 20, signal, true), CliError);
    await assert.rejects(readInput(dir, 20, signal), CliError);
    await assert.rejects(readInput(file, 1, signal), CliError);
    await writeFile(file, Buffer.from([0xc0, 0xaf]));
    await assert.rejects(readInput(file, 20, signal), CliError);
    const out = join(dir, "out");
    const reserved = await reserveOutput(out);
    await assert.rejects(reserveOutput(out), CliError);
    await reserved.save({ complete: true });
    await reserved.discard();
    assert.deepEqual(JSON.parse(await readFile(out, "utf8")), { complete: true });
    const discarded = join(dir, "discarded");
    await (await reserveOutput(discarded)).discard();
    await assert.rejects(readFile(discarded));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("offline output is versioned, inert and calculationChecked false", async () => {
  const dir = await temporary();
  try {
    const file = join(dir, "config.json");
    await writeFile(file, JSON.stringify(configuration()));
    const output = await runCli(["validate", "--file", file, "--offline"]);
    assert.equal(output.kind, "engineo-cli-output");
    assert.equal(output.schemaVersion, 1);
    assert.equal(output.exitCode, 0);
    assert.equal((output.data as { calculationChecked: boolean }).calculationChecked, false);
    await writeFile(file, '{"schemaVersion":1,"schemaVersion":1}');
    assert.equal((await runCli(["validate", "--file", file, "--offline"])).exitCode, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const malformedSecret = "malformed-source-secret-".repeat(2);
const malformedConfigurations = [
  ["cookie", `{"engineo_session=${malformedSecret}":invalid}`],
  ["escaped cookie", `{"\\u0065ngineo_session\\u003d${malformedSecret}":invalid}`],
  ["Bearer", `{"Bearer ${malformedSecret}":invalid}`],
  ["escaped Bearer", `{"\\u0042earer ${malformedSecret}":invalid}`],
  ["escaped Bearer whitespace", `{"Bearer\\t${malformedSecret}":invalid}`],
  ["nested cookie", `{"input":{"engineo_csrf=${malformedSecret}":invalid}}`],
] as const;
for (const [name, source] of malformedConfigurations) {
  for (const mode of ["offline", "authoritative", "plan"] as const) {
    test(`malformed ${name} key is safely rejected during ${mode}`, async () => {
      await cliFixture(async (dir, auth) => {
        const file = join(dir, "malformed.json");
        await writeFile(file, source);
        const requests: string[] = [];
        await withMock(
          async (url, init) => {
            requests.push(`${init?.method} ${url}`);
            assert.equal(url, `${target.apiOrigin}/auth/me`);
            assert.equal(init?.method, "GET");
            return response({ session: { id: session.sessionId }, user: { id: session.actorId } });
          },
          async () => {
            const argv =
              mode === "offline"
                ? ["validate", "--offline", "--file", file]
                : [
                    mode === "plan" ? "plan" : "validate",
                    ...remote,
                    "--auth-file",
                    auth,
                    "--file",
                    file,
                    ...(mode === "plan"
                      ? [
                          "--plan-id",
                          id(8),
                          "--expected-revision",
                          "2",
                          "--out",
                          join(dir, "pending-review.json"),
                        ]
                      : ["--authoritative"]),
                  ];
            const output = await runCli(argv);
            assert.equal(output.exitCode, 3);
            assert.equal(output.error?.category, "validation");
            assert.equal(output.error?.code, "configuration_invalid");
            const text = JSON.stringify(output);
            for (const forbidden of [
              malformedSecret,
              "engineo_session=",
              "engineo_csrf=",
              "Bearer ",
              "Bearer\\t",
            ])
              assert.equal(text.includes(forbidden), false);
            assert.deepEqual(
              requests,
              mode === "offline" ? [] : [`GET ${target.apiOrigin}/auth/me`],
            );
          },
        );
      });
    });
  }
}
test("malformed diagnostics retain safe bounded codes, counts and character offsets", async () => {
  const dir = await temporary();
  try {
    const file = join(dir, "malformed.json");
    await writeFile(file, '{"input":{"project":invalid}}');
    const output = await runCli(["validate", "--file", file, "--offline"]);
    assert.equal(output.exitCode, 3);
    assert.deepEqual(output.error?.details, {
      valid: false,
      diagnostics: {
        issues: [{ code: "INVALID_JSON", path: "", message: "Malformed JSON at character 20." }],
        totalCount: 1,
        truncated: false,
      },
      calculationChecked: false,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("actual offline entry emits one safe exit-3 envelope and empty stderr for malformed keys", async () => {
  const dir = await temporary();
  try {
    const file = join(dir, "malformed.json");
    for (const [, source] of malformedConfigurations) {
      await writeFile(file, source);
      const run = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/main.ts", "validate", "--file", file, "--offline"],
        { cwd: new URL("../", import.meta.url), encoding: "utf8", timeout: 10_000 },
      );
      assert.equal(run.status, 3);
      assert.equal(run.signal, null);
      assert.equal(run.stderr, "");
      assert.equal(run.stdout.trim().split("\n").length, 1);
      assert.equal(run.stdout.includes(malformedSecret), false);
      const output = JSON.parse(run.stdout);
      assert.equal(output.schemaVersion, 1);
      assert.equal(output.kind, "engineo-cli-output");
      assert.equal(output.exitCode, 3);
      assert.equal(output.error.category, "validation");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("transport sends Origin, session, cookie and mutation CSRF and never follows redirects", async () => {
  const client = new ApiClient(target, session, Date.now() + 1000, new AbortController().signal);
  await withMock(
    async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("origin"), target.appOrigin);
      assert.equal(headers.get("x-engineo-session"), session.sessionId);
      assert.equal(headers.get("x-csrf-token"), session.csrfToken);
      assert.equal(init?.redirect, "manual");
      assert.equal(
        headers.get("cookie"),
        `engineo_session=${session.sessionToken}; engineo_csrf=${session.csrfToken}`,
      );
      return new Response(null, { status: 302, headers: { location: "https://foreign.test" } });
    },
    async () => {
      await assert.rejects(
        client.request("POST", "/x", {}),
        (error: unknown) => error instanceof CliError && error.code === "redirect_refused",
      );
    },
  );
});
test("transport rejects oversized, invalid UTF8, duplicate JSON and session-mismatched responses", async () => {
  for (const reply of [
    response({}, 200, { "content-length": "99999999" }),
    new Response(Buffer.from([0xff]), {
      headers: { "content-type": "application/json", "x-engineo-session": session.sessionId },
    }),
    new Response('{"a":1,"a":2}', {
      headers: { "content-type": "application/json", "x-engineo-session": session.sessionId },
    }),
    response({}, 200, { "x-engineo-session": id(80) }),
    response({}, 200, { "content-type": "text/plain" }),
    new Response("{}", { headers: { "content-type": "application/json" } }),
  ])
    await withMock(
      async () => reply,
      async () => {
        await assert.rejects(
          new ApiClient(target, session, Date.now() + 1000, new AbortController().signal).request(
            "GET",
            "/x",
          ),
          CliError,
        );
      },
    );
});
test("transport bounds actual streamed bytes and request envelope without trusting content length", async () => {
  const client = new ApiClient(target, session, Date.now() + 1000, new AbortController().signal);
  let calls = 0;
  await withMock(
    async () => {
      calls++;
      return response({ payload: "x".repeat(1000) });
    },
    async () => {
      await assert.rejects(
        client.request("GET", "/x", undefined, 20),
        (error: unknown) => error instanceof CliError && error.code === "response_too_large",
      );
      await assert.rejects(
        client.request("POST", "/x", { payload: "x".repeat(1024 * 1024) }),
        (error: unknown) => error instanceof CliError && error.code === "request_too_large",
      );
      assert.equal(calls, 1);
    },
  );
});
test("unsafe TLS environment is refused before any request", () => {
  const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    assert.throws(
      () => new ApiClient(target, session, Date.now() + 1000, new AbortController().signal),
      (error: unknown) => error instanceof CliError && error.code === "insecure_tls_environment",
    );
  } finally {
    if (original === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;
  }
});
test("explicit API interruptions have their own exit category", () => {
  assert.equal(remoteError(409, { error: "configuration_interrupted" }).category, "interrupted");
  assert.equal(remoteError(409, { error: "schedule_cancelled" }).category, "interrupted");
});

async function cliFixture(
  run: (dir: string, auth: string, review: string) => Promise<void>,
): Promise<void> {
  const dir = await temporary(),
    auth = join(dir, "auth.json"),
    review = join(dir, "review.json");
  await writeFile(auth, JSON.stringify(session), { mode: 0o600 });
  await writeFile(review, JSON.stringify(savedReview(plan(), target)));
  try {
    await run(dir, auth, review);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("apply lost-response recovery uses exact authorized receipt and only one POST", async () => {
  await cliFixture(async (_dir, auth, review) => {
    const methods: string[] = [];
    await withMock(
      async (url, init) => {
        methods.push(init?.method ?? "");
        if (url.endsWith("/auth/me"))
          return response({ session: { id: session.sessionId }, user: { id: session.actorId } });
        if (init?.method === "POST") throw new Error(`never dump ${session.sessionToken}`);
        assert.equal(url.endsWith(`/plans/${id(8)}/receipt`), true);
        return response(receipt());
      },
      async () => {
        const output = await runCli([
          "apply",
          ...remote,
          "--auth-file",
          auth,
          "--plan",
          review,
          "--expected-revision",
          "2",
        ]);
        assert.equal(output.exitCode, 0);
        assert.equal((output.data as { recovered: boolean }).recovered, true);
        assert.deepEqual(methods, ["GET", "POST", "GET"]);
        assert.equal(JSON.stringify(output).includes(session.sessionToken), false);
      },
    );
  });
});
test("pending receipt after a lost response remains uncertainty and never becomes cancellation", async () => {
  await cliFixture(async (_dir, auth, review) => {
    await withMock(
      async (url, init) => {
        if (url.endsWith("/auth/me"))
          return response({ session: { id: session.sessionId }, user: { id: session.actorId } });
        if (init?.method === "POST") throw new Error("lost");
        return response({ error: "configuration_not_terminal" }, 409);
      },
      async () => {
        const output = await runCli([
          "cancel",
          ...remote,
          "--auth-file",
          auth,
          "--plan",
          review,
          "--expected-revision",
          "2",
        ]);
        assert.equal(output.exitCode, 7);
        assert.equal(output.error?.code, "mutation_outcome_unknown");
      },
    );
  });
});
test("denied recovery preserves authorization failure and original uncertainty", async () => {
  await cliFixture(async (_dir, auth, review) => {
    await withMock(
      async (url, init) => {
        if (url.endsWith("/auth/me"))
          return response({ session: { id: session.sessionId }, user: { id: session.actorId } });
        if (init?.method === "POST") throw new Error("lost");
        return response({ error: "forbidden" }, 403);
      },
      async () => {
        const output = await runCli([
          "apply",
          ...remote,
          "--auth-file",
          auth,
          "--plan",
          review,
          "--expected-revision",
          "2",
        ]);
        assert.equal(output.exitCode, 5);
        assert.equal(output.error?.code, "forbidden");
        assert.equal((output.error?.details as { outcomeKnown: boolean }).outcomeKnown, false);
        assert.equal((output.error?.details as { planId: string }).planId, plan().planId);
      },
    );
  });
});
test("explicit integrity/auth/conflict/capacity POST errors never invoke recovery", async () => {
  await cliFixture(async (_dir, auth, review) => {
    for (const [status, code, expected] of [
      [503, "configuration_integrity_error", 9],
      [403, "forbidden", 5],
      [409, "revision_conflict", 4],
      [429, "configuration_capacity", 6],
    ] as const) {
      let calls = 0;
      await withMock(
        async (url) => {
          calls++;
          return url.endsWith("/auth/me")
            ? response({ session: { id: session.sessionId }, user: { id: session.actorId } })
            : response({ error: code }, status);
        },
        async () => {
          const output = await runCli([
            "apply",
            ...remote,
            "--auth-file",
            auth,
            "--plan",
            review,
            "--expected-revision",
            "2",
          ]);
          assert.equal(output.exitCode, expected);
          assert.equal(calls, 2);
        },
      );
    }
  });
});
test("immutable actor mismatch fails before project access", async () => {
  await cliFixture(async (_dir, auth) => {
    let calls = 0;
    await withMock(
      async () => {
        calls++;
        return response({ session: { id: session.sessionId }, user: { id: id(80) } });
      },
      async () => {
        const output = await runCli(["read", ...remote, "--auth-file", auth]);
        assert.equal(output.exitCode, 5);
        assert.equal(calls, 1);
      },
    );
  });
});
test("error-code allowlisting cannot leak a coincident session token", async () => {
  await cliFixture(async (_dir, auth, review) => {
    const coincident = "configuration_idempotency_conflict";
    assert.ok(coincident.length >= 32);
    await writeFile(auth, JSON.stringify({ ...session, sessionToken: coincident }), {
      mode: 0o600,
    });
    await withMock(
      async (url) =>
        url.endsWith("/auth/me")
          ? response({ session: { id: session.sessionId }, user: { id: session.actorId } })
          : response({ error: coincident }, 409),
      async () => {
        const output = await runCli([
          "apply",
          ...remote,
          "--auth-file",
          auth,
          "--plan",
          review,
          "--expected-revision",
          "2",
        ]);
        assert.equal(output.exitCode, 9);
        assert.equal(JSON.stringify(output).includes(coincident), false);
      },
    );
  });
});
test("SIGINT during mutation reports unknown outcome and sends no cancel or retry", async () => {
  await cliFixture(async (_dir, auth, review) => {
    const controller = new AbortController();
    let calls = 0;
    await withMock(
      async (url) => {
        calls++;
        if (url.endsWith("/auth/me"))
          return response({ session: { id: session.sessionId }, user: { id: session.actorId } });
        controller.abort();
        throw new Error("interrupted");
      },
      async () => {
        const output = await runCli(
          ["apply", ...remote, "--auth-file", auth, "--plan", review, "--expected-revision", "2"],
          controller.signal,
        );
        assert.equal(output.exitCode, 130);
        assert.equal(output.error?.code, "mutation_interrupted");
        assert.equal(calls, 2);
        assert.equal((output.error?.details as { outcomeKnown: boolean }).outcomeKnown, false);
      },
    );
  });
});
test("calculation result binds structural coverage, revision, canonical result and input hashes", () => {
  const input = configuration().input;
  const result = {
    schemaVersion: 1 as const,
    projectFinish: "2026-10-05T09:00:00Z",
    lateProjectFinish: "2026-10-05T09:00:00Z",
    controllingFinishActivity: id(7),
    controllingPath: [id(7)],
    activities: {
      [id(7)]: {
        earlyStart: "2026-10-05T08:00:00Z",
        earlyFinish: "2026-10-05T09:00:00Z",
        lateStart: "2026-10-05T08:00:00Z",
        lateFinish: "2026-10-05T09:00:00Z",
        totalFloatMinutes: 0,
        freeFloatMinutes: 0,
        critical: true,
        drivingCauses: [],
      },
    },
    constraintViolations: [],
  };
  const inputHash = hash(serializeScheduleInputV1(input));
  const value = {
    revision: 2,
    result,
    calculation: {
      schemaVersion: 1,
      calculationId: id(11),
      projectRevision: 2,
      inputHashSha256: inputHash,
      resultHashSha256: hash(serializeScheduleResultV1(result)),
      engineContractVersion: 1,
      engineVersion: "engineo-0.0.0",
      calculatedAt: "2026-10-03T09:00:00.000Z",
    },
  };
  assert.deepEqual(checkResult(value, input, 2, inputHash, true), value);
  assert.throws(() => checkResult(value, input, 3, inputHash, true), CliError);
  assert.throws(() => checkResult(value, input, 2, "0".repeat(64), true), CliError);
  assert.throws(
    () =>
      checkResult(
        { ...value, result: { ...result, controllingPath: [id(99)] } },
        input,
        2,
        inputHash,
        true,
      ),
    CliError,
  );
  assert.throws(
    () =>
      checkResult(
        { ...value, calculation: { ...value.calculation, resultHashSha256: "0".repeat(64) } },
        input,
        2,
        inputHash,
        true,
      ),
    CliError,
  );
  assert.deepEqual(
    checkResult({ revision: 2, result: null, calculation: null }, input, 2, inputHash, false),
    { revision: 2, result: null, calculation: null },
  );
  assert.throws(
    () => checkResult({ revision: 2, result: null, calculation: null }, input, 2, inputHash, true),
    CliError,
  );
});
test("calculation POST uses the documented 32 MiB result response budget", async () => {
  await cliFixture(async (_dir, auth) => {
    const config = configuration();
    await withMock(
      async (url) => {
        if (url.endsWith("/auth/me"))
          return response({ session: { id: session.sessionId }, user: { id: session.actorId } });
        if (url.endsWith("/configuration"))
          return response({
            schemaVersion: 1,
            revision: 2,
            inputHashSha256: hash(serializeScheduleInputV1(config.input)),
            configuration: config,
          });
        // Use a header to prove admission chooses the Rust result bound without
        // allocating a giant fixture. Structural result validation still fails.
        return response({}, 200, { "content-length": String(16 * 1024 * 1024 + 1) });
      },
      async () => {
        const output = await runCli([
          "calculate",
          ...remote,
          "--auth-file",
          auth,
          "--expected-revision",
          "2",
        ]);
        assert.equal(output.exitCode, 9);
        assert.equal(output.error?.code, "invalid_response");
      },
    );
  });
});
