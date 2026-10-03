import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  calculatePlannerViewConfigurationHashV1,
  calculatePlannerViewReviewDigestV1,
  NATIVE_PLANNER_PRESENTATION_V1,
  type PlannerViewConfigurationV1,
  type PlannerViewPlanRequestV1,
  type PlannerViewPlanV1,
  type PlannerViewReceiptV1,
  type PlannerViewReviewV1,
} from "@engineo/contracts";
import { hash } from "./artifacts.js";
import { EXIT } from "./errors.js";
import { type CliOutputV1, runCli } from "./run.js";
import type { SessionMaterial } from "./transport.js";
import {
  type AvailableViewProjectionV1,
  type SavedViewReviewV1,
  savedViewReview,
  VIEW_CAPABILITY_LIMITS_V1,
  type ViewOperationStatusV1,
  type ViewReadV1,
} from "./view-artifacts.js";

// Synthetic DTO markers only. Every request is intercepted; no server is started.
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
const newSession: SessionMaterial = {
  ...session,
  sessionId: id(14),
  sessionToken: "n".repeat(48),
  csrfToken: "d".repeat(48),
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
const path = `/organizations/${target.organizationId}/projects/${target.projectId}/views`;
const operationWindowId = "2020-01-02";
const operationId = id(6);
const operationPath = `${path}/operations/${operationWindowId}/${operationId}`;

function configuration(name = "My tasks"): PlannerViewConfigurationV1 {
  return {
    schemaVersion: 1,
    kind: "engineo-planner-view",
    name,
    visibility: "private",
    presentation: {
      ...NATIVE_PLANNER_PRESENTATION_V1,
      sort: { field: "native", direction: "asc" },
    },
  };
}
const configHash = (value: PlannerViewConfigurationV1) =>
  calculatePlannerViewConfigurationHashV1(value, hash);
function viewRead(value = configuration("Previous")): ViewReadV1 {
  return {
    schemaVersion: 1,
    viewId: id(5),
    viewRevision: 2,
    configuration: value,
    configHashSha256: configHash(value),
    createdAt: "2020-01-01T12:00:00.000Z",
    updatedAt: "2020-01-02T12:00:00.000Z",
  };
}
function plan(
  action: "create" | "update" | "delete" = "create",
  desired = configuration(),
): PlannerViewPlanV1 {
  const base = action === "create" ? null : configuration("Previous");
  const review: PlannerViewReviewV1 = {
    schemaVersion: 1,
    kind: "engineo-planner-view-review",
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    action,
    viewId: action === "create" ? null : id(5),
    actorId: session.actorId,
    sessionId: session.sessionId,
    organizationId: target.organizationId,
    projectId: target.projectId,
    expectedViewRevision: action === "create" ? 0 : 2,
    expectedScheduleRevision: 7,
    baseConfigHash: base === null ? null : configHash(base),
    desiredConfigHash: action === "delete" ? null : configHash(desired),
    baseConfiguration: base,
    desiredConfiguration: action === "delete" ? null : desired,
    operationWindowId,
    operationId,
    issuedAt: "2020-01-02T12:00:00.000Z",
    expiresAt: "2020-01-02T12:15:00.000Z",
  };
  return { review, reviewedDigest: calculatePlannerViewReviewDigestV1(review, hash) };
}
function rebind(value: PlannerViewPlanV1): PlannerViewPlanV1 {
  return { ...value, reviewedDigest: calculatePlannerViewReviewDigestV1(value.review, hash) };
}
function planRequest(value: PlannerViewPlanV1): PlannerViewPlanRequestV1 {
  const review = value.review;
  const common = {
    operationWindowId: review.operationWindowId,
    operationId: review.operationId,
    expectedScheduleRevision: review.expectedScheduleRevision,
  };
  if (review.action === "create") {
    assert.ok(review.desiredConfiguration);
    return { ...common, action: "create", configuration: review.desiredConfiguration };
  }
  assert.ok(review.viewId);
  if (review.action === "update") {
    assert.ok(review.desiredConfiguration);
    return {
      ...common,
      action: "update",
      viewId: review.viewId,
      expectedViewRevision: review.expectedViewRevision,
      configuration: review.desiredConfiguration,
    };
  }
  return {
    ...common,
    action: "delete",
    viewId: review.viewId,
    expectedViewRevision: review.expectedViewRevision,
  };
}
function receipt(value = plan()): PlannerViewReceiptV1 {
  const review = value.review;
  const noOp = review.action === "update" && review.baseConfigHash === review.desiredConfigHash;
  return {
    schemaVersion: 1,
    kind: "engineo-planner-view-receipt",
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    action: review.action,
    outcome: review.action === "delete" ? "deleted" : noOp ? "no_op" : "applied",
    viewId: review.viewId ?? id(5),
    actorId: review.actorId,
    sessionId: review.sessionId,
    organizationId: review.organizationId,
    projectId: review.projectId,
    previousViewRevision: review.expectedViewRevision,
    committedViewRevision:
      review.action === "delete" ? null : review.expectedViewRevision + (noOp ? 0 : 1),
    expectedScheduleRevision: review.expectedScheduleRevision,
    baseConfigHash: review.baseConfigHash,
    desiredConfigHash: review.desiredConfigHash,
    operationWindowId: review.operationWindowId,
    operationId: review.operationId,
    reviewedDigest: value.reviewedDigest,
    auditId: id(7),
    recordedAt: "2020-01-02T12:05:00.000Z",
  };
}
function operationStatus(
  value: PlannerViewReceiptV1 | null = receipt(),
  windowClosed = true,
): ViewOperationStatusV1 {
  return {
    schemaVersion: 1,
    status: value === null ? "not_recorded" : "recorded",
    operationWindowId,
    operationId,
    windowClosed,
    absenceDefinitive: value === null && windowClosed,
    receipt: value,
  };
}
function capabilities() {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    visibility: ["private"],
    actions: ["create", "update", "delete"],
    capabilities: ["project.read", "view.private.write"],
    builtIn: { id: "native", immutable: true },
    operationWindowId,
    operationWindowClosesAt: "2020-01-03T00:00:00.000Z",
    operationReplayUntil: "2020-01-04T00:00:00.000Z",
    limits: { ...VIEW_CAPABILITY_LIMITS_V1 },
  };
}
function projection(value = configuration()): AvailableViewProjectionV1 {
  return {
    available: true,
    rows: [
      { kind: "activity", activityId: id(10), nativeIndex: 0, displayOrdinal: 1, groupKey: null },
      { kind: "activity", activityId: id(12), nativeIndex: 1, displayOrdinal: 2, groupKey: null },
      { kind: "activity", activityId: id(11), nativeIndex: 2, displayOrdinal: 3, groupKey: null },
    ],
    sourceActivityCount: 3,
    visibleActivityCount: 3,
    visualRowCount: 3,
    groupCount: 0,
    binding: {
      organizationId: target.organizationId,
      projectId: target.projectId,
      scheduleRevision: 7,
      inputHashSha256: hash("synthetic-saved-input"),
      inputState: "saved",
      projectionVersion: 1,
      normalizationVersion: 1,
      configHashSha256: configHash(value),
    },
  };
}
function groupedProjection(value: PlannerViewConfigurationV1): AvailableViewProjectionV1 {
  const result = projection(value);
  const key = `group:wbs:${id(20)}`;
  result.rows = [
    {
      kind: "group",
      key,
      wbsId: id(20),
      wbsCode: "1",
      wbsName: "Synthetic group",
      activityCount: 3,
    },
    { kind: "activity", activityId: id(10), nativeIndex: 0, displayOrdinal: 1, groupKey: key },
    { kind: "activity", activityId: id(12), nativeIndex: 1, displayOrdinal: 2, groupKey: key },
    { kind: "activity", activityId: id(11), nativeIndex: 2, displayOrdinal: 3, groupKey: key },
  ];
  result.visualRowCount = 4;
  result.groupCount = 1;
  return result;
}

function rawResponse(
  value: string | Uint8Array,
  status = 200,
  headers: Record<string, string> = {},
  live = session,
): Response {
  return new Response(typeof value === "string" ? value : new Uint8Array(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-engineo-session": live.sessionId,
      ...headers,
    },
  });
}
function response(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
  live = session,
): Response {
  return rawResponse(JSON.stringify(value), status, headers, live);
}
interface MockStep {
  method: "GET" | "POST";
  path: string;
  reply: () => Response | Promise<Response>;
  body?: unknown;
}
interface RequestLog {
  method: string;
  url: string;
  body: unknown;
}
const get = (suffix: string, value: unknown, live = session): MockStep => ({
  method: "GET",
  path: `${path}${suffix}`,
  reply: () => response(value, 200, {}, live),
});
const post = (suffix: string, body: unknown, value: unknown, live = session): MockStep => ({
  method: "POST",
  path: `${path}${suffix}`,
  body,
  reply: () => response(value, 200, {}, live),
});
const statusStep = (value: unknown, live = session): MockStep => ({
  method: "GET",
  path: operationPath,
  reply: () => response(value, 200, {}, live),
});

async function fixture(
  run: (files: { dir: string; auth: string; config: string; review: string }) => Promise<void>,
  live = session,
  reviewed = plan(),
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "engineo-views-mocked-"));
  const files = {
    dir,
    auth: join(dir, "auth.json"),
    config: join(dir, "configuration.json"),
    review: join(dir, "review.json"),
  };
  try {
    await writeFile(files.auth, JSON.stringify(live), { mode: 0o600 });
    await writeFile(files.config, JSON.stringify(configuration()));
    await writeFile(files.review, JSON.stringify(savedViewReview(reviewed, target)), {
      mode: 0o600,
    });
    await run(files);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
function assertSafe(output: CliOutputV1): void {
  const serialized = JSON.stringify(output);
  for (const marker of [
    session.sessionToken,
    session.csrfToken,
    newSession.sessionToken,
    newSession.csrfToken,
    "server-only-detail",
    "synthetic-private-path",
    "engineo_session=",
    "engineo_csrf=",
    "Bearer ",
  ])
    assert.equal(serialized.includes(marker), false, `Output exposed ${marker}`);
}
function failed(output: CliOutputV1, code: string, exitCode: number): void {
  assert.equal(output.kind, "engineo-cli-output");
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.ok, false);
  assert.equal(output.exitCode, exitCode);
  assert.equal(output.error?.code, code);
  assert.equal(output.data, undefined);
  assertSafe(output);
}
function succeeded(output: CliOutputV1, command: string): void {
  assert.equal(output.kind, "engineo-cli-output");
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.command, `views ${command}`);
  assert.equal(output.ok, true);
  assert.equal(output.exitCode, 0);
  assert.equal(output.error, undefined);
  assertSafe(output);
}

/** Also records assertion failures because runCli deliberately catches fetch errors. */
async function mockedRun(
  command: string,
  auth: string,
  args: string[],
  steps: MockStep[],
  live = session,
  interruption = new AbortController().signal,
): Promise<{ output: CliOutputV1; requests: RequestLog[] }> {
  const allSteps: MockStep[] = [
    {
      method: "GET",
      path: "/auth/me",
      reply: () =>
        response({ session: { id: live.sessionId }, user: { id: live.actorId } }, 200, {}, live),
    },
    ...steps,
  ];
  const original = globalThis.fetch;
  const requests: RequestLog[] = [];
  const assertionErrors: unknown[] = [];
  let offset = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ method, url, body });
    const step = allSteps[offset++];
    try {
      assert.equal(new URL(url).origin, target.apiOrigin);
      assert.ok(step, "Unexpected additional request, retry or fresh operation");
      assert.equal(url, `${target.apiOrigin}${step.path}`);
      assert.equal(method, step.method);
      assert.equal(init?.redirect, "manual");
      assert.ok(init?.signal instanceof AbortSignal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("accept"), "application/json");
      assert.equal(headers.get("origin"), target.appOrigin);
      assert.equal(headers.get("x-engineo-session"), live.sessionId);
      assert.equal(
        headers.get("cookie"),
        `engineo_session=${live.sessionToken}; engineo_csrf=${live.csrfToken}`,
      );
      if (method === "POST") {
        assert.equal(headers.get("content-type"), "application/json");
        assert.equal(headers.get("x-csrf-token"), live.csrfToken);
        assert.ok(Buffer.byteLength(String(init?.body), "utf8") <= 65536);
        assert.deepEqual(body, step.body);
      } else {
        assert.equal(headers.get("x-csrf-token"), null);
        assert.equal(init?.body, undefined);
      }
    } catch (error) {
      assertionErrors.push(error);
      throw error;
    }
    assert.ok(step);
    return await step.reply();
  };
  let output: CliOutputV1;
  try {
    output = await runCli(
      ["views", command, ...remote, "--auth-file", auth, ...args],
      interruption,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(assertionErrors, []);
  assert.equal(offset, allSteps.length, "Expected mocked requests were not consumed");
  assertSafe(output);
  return { output, requests };
}
async function offlineRun(args: string[]): Promise<CliOutputV1> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("Offline commands must not use fetch");
  };
  try {
    const output = await runCli(["views", ...args]);
    assert.equal(calls, 0);
    assertSafe(output);
    return output;
  } finally {
    globalThis.fetch = original;
  }
}
const applyArgs = (review: string, revision = "7") => [
  "--review",
  review,
  "--expected-schedule-revision",
  revision,
];
const statusArgs = (review?: string) => [
  "--operation-window",
  operationWindowId,
  "--operation-id",
  operationId,
  ...(review === undefined ? [] : ["--review", review]),
];
function previewArgs(action: "create" | "update" | "delete", file: string, out: string): string[] {
  return [
    "--action",
    action,
    "--operation-window",
    operationWindowId,
    "--operation-id",
    operationId,
    "--expected-schedule-revision",
    "7",
    "--out",
    out,
    ...(action === "delete" ? [] : ["--file", file]),
    ...(action === "create" ? [] : ["--view-id", id(5), "--expected-view-revision", "2"]),
  ];
}

test("views help dispatches locally and describes held API and source-verification limits", async () => {
  const output = await offlineRun(["help"]);
  succeeded(output, "help");
  const help = output.data as { commands: Record<string, string>; notes: string[] };
  assert.deepEqual(Object.keys(help.commands), [
    "capabilities",
    "list",
    "read",
    "validate",
    "plan",
    "apply",
    "status",
    "project",
    "select",
  ]);
  assert.ok(help.notes.some((note) => note.includes("draft/held")));
  assert.ok(
    help.notes.some((note) =>
      note.includes("digest alone does not establish real-engine provenance"),
    ),
  );
});

test("offline validation normalizes a complete view and returns independently computed hash without calculation", async () => {
  await fixture(async ({ config }) => {
    const input = configuration("  My tasks  ");
    input.presentation.search = "  visible  ";
    await writeFile(config, JSON.stringify(input));
    const normalized = configuration();
    normalized.presentation.search = "visible";
    const output = await offlineRun(["validate", "--file", config, "--offline"]);
    succeeded(output, "validate");
    assert.deepEqual(output.data, {
      schemaVersion: 1,
      valid: true,
      normalizedConfiguration: normalized,
      configHashSha256: configHash(normalized),
      diagnostics: { issues: [], totalCount: 0, truncated: false },
      authoritative: false,
      calculationChecked: false,
    });
  });
});

const configSource = JSON.stringify(configuration());
const strictOfflineSources = [
  [
    "duplicate key",
    configSource.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
  ],
  [
    "escaped duplicate key",
    configSource.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1'),
  ],
  ["decimal original integer", configSource.replace('"schemaVersion":1', '"schemaVersion":1.0')],
  ["exponent original integer", configSource.replace('"schemaVersion":1', '"schemaVersion":1e0')],
  ["negative zero", configSource.replace('"schemaVersion":1', '"schemaVersion":-0')],
  ["unsafe integer", configSource.replace('"schemaVersion":1', '"schemaVersion":9007199254740993')],
  ["BOM", `\uFEFF${configSource}`],
  ["deep nesting", '{"unknown":[[[[[[[[[[]]]]]]]]]]}'],
  ["malformed credential key", `{"Bearer ${session.sessionToken}":invalid}`],
  [
    "escaped malformed credential key",
    `{"\\u0065ngineo_session\\u003d${session.sessionToken}":invalid}`,
  ],
  [
    "credential-bearing unknown property",
    configSource.replace('"schemaVersion":1', `"schemaVersion":1,"${session.csrfToken}":true`),
  ],
  [
    "prototype property",
    configSource.replace('"schemaVersion":1', '"schemaVersion":1,"__proto__":{}'),
  ],
] as const;
for (const [label, source] of strictOfflineSources) {
  test(`offline ${label} fails closed with redacted configuration diagnostics`, async () => {
    await fixture(async ({ config }) => {
      await writeFile(config, source);
      const output = await offlineRun(["validate", "--file", config, "--offline"]);
      failed(output, "view_configuration_invalid", EXIT.validation);
      const diagnostics = output.error?.details as {
        issues: Array<{ code: string; path: string; message: string }>;
        totalCount: number;
        truncated: boolean;
      };
      assert.ok(diagnostics.totalCount >= 1);
      assert.ok(diagnostics.issues.length > 0);
      assert.ok(
        diagnostics.issues.every(
          (issue) => issue.path === "" && issue.message === output.error?.message,
        ),
      );
      assert.equal(JSON.stringify(output).includes("unknown"), false);
    });
  });
}

test("offline credentials, invalid UTF-8 and oversized source stay local and safe", async () => {
  await fixture(async ({ config }) => {
    await writeFile(config, JSON.stringify(configuration(`Bearer ${session.sessionToken}`)));
    failed(
      await offlineRun(["validate", "--file", config, "--offline"]),
      "credentials_in_artifact",
      EXIT.validation,
    );
    await writeFile(config, Buffer.from([0xff]));
    failed(
      await offlineRun(["validate", "--file", config, "--offline"]),
      "invalid_utf8",
      EXIT.validation,
    );
    await writeFile(config, " ".repeat(8193));
    failed(
      await offlineRun(["validate", "--file", config, "--offline"]),
      "invalid_input_file",
      EXIT.validation,
    );
  });
});

test("capabilities and cursor-limited list use authenticated read-only requests", async () => {
  await fixture(async ({ auth }) => {
    const advertised = capabilities();
    const capabilityRun = await mockedRun(
      "capabilities",
      auth,
      [],
      [get("/capabilities", advertised)],
    );
    succeeded(capabilityRun.output, "capabilities");
    assert.deepEqual(capabilityRun.output.data, advertised);
    const view = viewRead();
    const page = {
      schemaVersion: 1,
      builtIn: { id: "native", immutable: true },
      views: [
        {
          viewId: view.viewId,
          viewRevision: view.viewRevision,
          name: view.configuration.name,
          configHashSha256: view.configHashSha256,
          updatedAt: view.updatedAt,
        },
      ],
      nextCursor: id(9),
    };
    const list = await mockedRun(
      "list",
      auth,
      ["--limit", "1", "--cursor", id(8)],
      [get(`?limit=1&cursor=${id(8)}`, page)],
    );
    succeeded(list.output, "list");
    assert.deepEqual(list.output.data, page);
    assert.ok(list.requests.every((request) => request.method === "GET"));
  });
});

test("read exports only the complete configuration to a new private file", async () => {
  await fixture(async ({ auth, dir }) => {
    const value = viewRead();
    const out = join(dir, "export.json");
    const { output } = await mockedRun(
      "read",
      auth,
      ["--view-id", value.viewId, "--out", out],
      [get(`/${value.viewId}`, value)],
    );
    succeeded(output, "read");
    assert.deepEqual(output.data, value);
    assert.deepEqual(JSON.parse(await readFile(out, "utf8")), value.configuration);
    assert.equal((await stat(out)).mode & 0o777, 0o600);
    const text = await readFile(out, "utf8");
    assert.equal(text.includes(session.sessionToken), false);
    assert.equal(text.includes("destination"), false);
  });
});

test("existing output and output symlinks are never overwritten and stop before view access", async () => {
  await fixture(async ({ auth, dir }) => {
    const existing = join(dir, "existing.json");
    const linked = join(dir, "linked.json");
    const sentinel = "synthetic-private-path existing content";
    await writeFile(existing, sentinel, { mode: 0o600 });
    await symlink(existing, linked);
    for (const out of [existing, linked]) {
      const { output, requests } = await mockedRun(
        "read",
        auth,
        ["--view-id", id(5), "--out", out],
        [],
      );
      failed(output, "output_unavailable", EXIT.usage);
      assert.equal(requests.length, 1);
      assert.equal(await readFile(existing, "utf8"), sentinel);
    }
  });
});

test("failed read integrity removes reserved output rather than leaving a partial artifact", async () => {
  await fixture(async ({ auth, dir }) => {
    const out = join(dir, "refused.json");
    const { output } = await mockedRun(
      "read",
      auth,
      ["--view-id", id(5), "--out", out],
      [get(`/${id(5)}`, { ...viewRead(), configHashSha256: "0".repeat(64) })],
    );
    failed(output, "invalid_response", EXIT.integrity);
    await assert.rejects(readFile(out));
  });
});

test("authoritative validate sends normalized configuration with exact Origin and CSRF", async () => {
  await fixture(async ({ auth, config }) => {
    await writeFile(config, JSON.stringify(configuration("  My tasks  ")));
    const validated = {
      schemaVersion: 1,
      valid: true,
      normalizedConfiguration: configuration(),
      configHashSha256: configHash(configuration()),
      observedScheduleRevision: 7,
      activationAvailable: true,
      calculationChecked: false,
      diagnostics: { issues: [], totalCount: 0, truncated: false },
    };
    const { output, requests } = await mockedRun(
      "validate",
      auth,
      ["--file", config, "--authoritative"],
      [post("/validate", { configuration: configuration() }, validated)],
    );
    succeeded(output, "validate");
    assert.deepEqual(output.data, { ...validated, authoritative: true });
    assert.deepEqual(
      requests.map((request) => request.method),
      ["GET", "POST"],
    );
  });
});

test("authoritative malformed config and embedded live-session token cannot reach validation POST", async () => {
  await fixture(async ({ auth, config }) => {
    for (const [source, code] of [
      [`{"${session.csrfToken}":invalid}`, "view_configuration_invalid"],
      [JSON.stringify(configuration(session.sessionToken)), "credentials_in_artifact"],
    ] as const) {
      await writeFile(config, source);
      const { output } = await mockedRun(
        "validate",
        auth,
        ["--file", config, "--authoritative"],
        [],
      );
      failed(output, code, EXIT.validation);
    }
  });
});

for (const action of ["create", "update", "delete"] as const) {
  test(`${action} preview binds explicit operation, hashes and base revision and saves complete reusable review`, async () => {
    const reviewed = plan(action);
    await fixture(
      async ({ auth, config, dir }) => {
        const out = join(dir, "complete-review.json");
        const request = planRequest(reviewed);
        const steps = [
          get("/capabilities", capabilities()),
          ...(action === "create" ? [] : [get(`/${id(5)}`, viewRead())]),
          post("/plan", request, reviewed),
        ];
        const { output, requests } = await mockedRun(
          "plan",
          auth,
          previewArgs(action, config, out),
          steps,
        );
        succeeded(output, "plan");
        assert.deepEqual(output.data, reviewed);
        const saved: SavedViewReviewV1 = JSON.parse(await readFile(out, "utf8"));
        assert.deepEqual(saved, savedViewReview(reviewed, target));
        assert.deepEqual(Object.keys(saved), ["schemaVersion", "kind", "destination", "plan"]);
        assert.deepEqual(Object.keys(saved.plan), ["review", "reviewedDigest"]);
        assert.equal(
          saved.plan.reviewedDigest,
          calculatePlannerViewReviewDigestV1(saved.plan.review, hash),
        );
        assert.equal(
          saved.plan.review.baseConfigHash,
          action === "create" ? null : configHash(configuration("Previous")),
        );
        assert.equal(
          saved.plan.review.desiredConfigHash,
          action === "delete" ? null : configHash(configuration()),
        );
        assert.equal((await stat(out)).mode & 0o777, 0o600);
        assert.deepEqual(
          requests.filter((entry) => entry.method === "POST").map((entry) => entry.url),
          [`${target.apiOrigin}${path}/plan`],
        );
        assert.equal(JSON.stringify(saved).includes(session.sessionToken), false);
        const applied = await mockedRun("apply", auth, applyArgs(out), [
          post("/apply", reviewed, receipt(reviewed)),
        ]);
        succeeded(applied.output, "apply");
        assert.deepEqual(applied.output.data, {
          historical: true,
          receipt: receipt(reviewed),
          recovered: false,
        });
      },
      session,
      reviewed,
    );
  });
}

test("preview refuses stale explicit window and view revision before planning POST", async () => {
  await fixture(async ({ auth, config, dir }) => {
    const windowOut = join(dir, "window-refused.json");
    const wrongWindow = previewArgs("create", config, windowOut);
    wrongWindow[wrongWindow.indexOf(operationWindowId)] = "2020-01-01";
    const first = await mockedRun("plan", auth, wrongWindow, [
      get("/capabilities", capabilities()),
    ]);
    failed(first.output, "view_operation_window_closed", EXIT.conflict);
    await assert.rejects(readFile(windowOut));
    const revisionOut = join(dir, "revision-refused.json");
    const second = await mockedRun("plan", auth, previewArgs("update", config, revisionOut), [
      get("/capabilities", capabilities()),
      get(`/${id(5)}`, { ...viewRead(), viewRevision: 3 }),
    ]);
    failed(second.output, "view_base_changed", EXIT.conflict);
    await assert.rejects(readFile(revisionOut));
  });
});

test("failed preview leaves no saved review when malformed local config is discovered", async () => {
  await fixture(async ({ auth, config, dir }) => {
    const out = join(dir, "config-refused.json");
    await writeFile(config, `{"Bearer ${session.sessionToken}":invalid}`);
    const { output } = await mockedRun("plan", auth, previewArgs("create", config, out), [
      get("/capabilities", capabilities()),
    ]);
    failed(output, "view_configuration_invalid", EXIT.validation);
    await assert.rejects(readFile(out));
  });
});

const tamperedPlans: Array<[string, (value: PlannerViewPlanV1) => PlannerViewPlanV1]> = [
  [
    "schedule revision",
    (value) => rebind({ ...value, review: { ...value.review, expectedScheduleRevision: 8 } }),
  ],
  [
    "project scope",
    (value) => rebind({ ...value, review: { ...value.review, projectId: id(80) } }),
  ],
  [
    "organization scope",
    (value) => rebind({ ...value, review: { ...value.review, organizationId: id(80) } }),
  ],
  ["actor", (value) => rebind({ ...value, review: { ...value.review, actorId: id(80) } })],
  ["session", (value) => rebind({ ...value, review: { ...value.review, sessionId: id(80) } })],
  [
    "operation UUID",
    (value) => rebind({ ...value, review: { ...value.review, operationId: id(80) } }),
  ],
  ["digest", (value) => ({ ...value, reviewedDigest: "0".repeat(64) })],
  [
    "desired hash",
    (value) => ({ ...value, review: { ...value.review, desiredConfigHash: "0".repeat(64) } }),
  ],
];
for (const [label, change] of tamperedPlans) {
  test(`preview rejects a self-consistent or tampered ${label} response and discards output`, async () => {
    await fixture(async ({ auth, config, dir }) => {
      const out = join(dir, "tampered-plan.json");
      const { output } = await mockedRun("plan", auth, previewArgs("create", config, out), [
        get("/capabilities", capabilities()),
        post("/plan", planRequest(plan()), change(plan())),
      ]);
      failed(output, "invalid_response", EXIT.integrity);
      await assert.rejects(readFile(out));
    });
  });
}

test("update preview independently binds the supplied current base configuration", async () => {
  await fixture(async ({ auth, config, dir }) => {
    const reviewed = plan("update");
    const wrongBase = configuration("Another base");
    const changed = rebind({
      ...reviewed,
      review: {
        ...reviewed.review,
        baseConfiguration: wrongBase,
        baseConfigHash: configHash(wrongBase),
      },
    });
    const out = join(dir, "wrong-base.json");
    const { output } = await mockedRun("plan", auth, previewArgs("update", config, out), [
      get("/capabilities", capabilities()),
      get(`/${id(5)}`, viewRead()),
      post("/plan", planRequest(reviewed), changed),
    ]);
    failed(output, "invalid_response", EXIT.integrity);
    await assert.rejects(readFile(out));
  });
});

const savedTamperCases: Array<[string, (value: SavedViewReviewV1) => unknown, string, number]> = [
  [
    "destination",
    (value) => ({ ...value, destination: { ...target, projectId: id(80) } }),
    "review_destination_mismatch",
    EXIT.conflict,
  ],
  [
    "review scope",
    (value) => ({
      ...value,
      plan: rebind({ ...value.plan, review: { ...value.plan.review, projectId: id(80) } }),
    }),
    "invalid_response",
    EXIT.integrity,
  ],
  [
    "actor",
    (value) => ({
      ...value,
      plan: rebind({ ...value.plan, review: { ...value.plan.review, actorId: id(80) } }),
    }),
    "review_identity_mismatch",
    EXIT.auth,
  ],
  [
    "session",
    (value) => ({
      ...value,
      plan: rebind({ ...value.plan, review: { ...value.plan.review, sessionId: id(80) } }),
    }),
    "review_identity_mismatch",
    EXIT.auth,
  ],
  [
    "schedule revision",
    (value) => ({
      ...value,
      plan: rebind({
        ...value.plan,
        review: { ...value.plan.review, expectedScheduleRevision: 8 },
      }),
    }),
    "review_revision_mismatch",
    EXIT.conflict,
  ],
  [
    "review digest",
    (value) => ({ ...value, plan: { ...value.plan, reviewedDigest: "0".repeat(64) } }),
    "invalid_response",
    EXIT.integrity,
  ],
  [
    "configuration hash",
    (value) => ({
      ...value,
      plan: { ...value.plan, review: { ...value.plan.review, desiredConfigHash: "0".repeat(64) } },
    }),
    "invalid_response",
    EXIT.integrity,
  ],
  [
    "extra key",
    (value) => ({ ...value, unsafe: "server-only-detail" }),
    "invalid_response",
    EXIT.integrity,
  ],
];
for (const [label, change, code, exit] of savedTamperCases) {
  test(`apply refuses saved ${label} before the only mutation endpoint`, async () => {
    await fixture(async ({ auth, review }) => {
      await writeFile(review, JSON.stringify(change(savedViewReview(plan(), target))));
      const { output, requests } = await mockedRun("apply", auth, applyArgs(review), []);
      failed(output, code, exit);
      assert.deepEqual(
        requests.map((entry) => entry.method),
        ["GET"],
      );
    });
  });
}

test("saved review retains original-byte duplicate, integer, BOM and body-size refusal", async () => {
  await fixture(async ({ auth, review }) => {
    const source = JSON.stringify(savedViewReview(plan(), target));
    const invalid = [
      source.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      source.replace('"schemaVersion":1', '"schemaVersion":1.0'),
      source.replace('"schemaVersion":1', '"schemaVersion":1e0'),
      `\uFEFF${source}`,
    ];
    for (const value of invalid) {
      await writeFile(review, value);
      failed(
        (await mockedRun("apply", auth, applyArgs(review), [])).output,
        "view_review_invalid",
        EXIT.validation,
      );
    }
    await writeFile(review, " ".repeat(65537));
    failed(
      (await mockedRun("apply", auth, applyArgs(review), [])).output,
      "invalid_input_file",
      EXIT.validation,
    );
  });
});

test("apply refuses an explicit expected schedule revision different from the complete review", async () => {
  await fixture(async ({ auth, review }) => {
    const { output } = await mockedRun("apply", auth, applyArgs(review, "8"), []);
    failed(output, "review_revision_mismatch", EXIT.conflict);
  });
});

test("no-op apply sends only review and digest and returns the original unchanged revision", async () => {
  const reviewed = plan("update", configuration("Previous"));
  await fixture(
    async ({ auth, review }) => {
      const { output, requests } = await mockedRun("apply", auth, applyArgs(review), [
        post("/apply", reviewed, receipt(reviewed)),
      ]);
      succeeded(output, "apply");
      assert.deepEqual(requests[1]?.body, reviewed);
      assert.deepEqual(Object.keys(requests[1]?.body as object), ["review", "reviewedDigest"]);
      assert.deepEqual(output.data, {
        historical: true,
        receipt: receipt(reviewed),
        recovered: false,
      });
      assert.equal(receipt(reviewed).committedViewRevision, 2);
      assert.equal(receipt(reviewed).outcome, "no_op");
    },
    session,
    reviewed,
  );
});

const lostApply = (reviewed = plan(), interruption?: AbortController): MockStep => ({
  method: "POST",
  path: `${path}/apply`,
  body: reviewed,
  reply: () => {
    interruption?.abort();
    throw new Error(`server-only-detail ${session.sessionToken} synthetic-private-path`);
  },
});

test("lost apply response recovers an exact-key historical receipt with one mutation and no fresh UUID", async () => {
  await fixture(async ({ auth, review }) => {
    const reviewed = plan();
    const { output, requests } = await mockedRun("apply", auth, applyArgs(review), [
      lostApply(reviewed),
      statusStep(operationStatus(receipt(reviewed))),
    ]);
    succeeded(output, "apply");
    assert.deepEqual(output.data, {
      historical: true,
      receipt: receipt(reviewed),
      recovered: true,
    });
    assert.deepEqual(
      requests.map((entry) => `${entry.method} ${entry.url}`),
      [
        `GET ${target.apiOrigin}/auth/me`,
        `POST ${target.apiOrigin}${path}/apply`,
        `GET ${target.apiOrigin}${operationPath}`,
      ],
    );
    assert.equal(requests.filter((entry) => entry.method === "POST").length, 1);
  });
});

for (const closed of [false, true]) {
  test(`lost response with ${closed ? "closed" : "open"} absent operation has ${closed ? "definitive absence" : "unknown outcome"}`, async () => {
    await fixture(async ({ auth, review }) => {
      const { output, requests } = await mockedRun("apply", auth, applyArgs(review), [
        lostApply(),
        statusStep(operationStatus(null, closed)),
      ]);
      failed(
        output,
        closed ? "view_operation_not_recorded" : "view_mutation_outcome_unknown",
        closed ? EXIT.conflict : EXIT.uncertain,
      );
      assert.deepEqual(output.error?.details, {
        ...(closed ? {} : { action: "create" }),
        operationWindowId,
        operationId,
        outcomeKnown: closed,
      });
      assert.equal(requests.filter((entry) => entry.method === "POST").length, 1);
      assert.equal(JSON.stringify(output).includes('"cancelled"'), false);
    });
  });
}

test("interruption after apply POST remains unknown and cannot mean cancellation or trigger retry", async () => {
  await fixture(async ({ auth, review }) => {
    const controller = new AbortController();
    const { output, requests } = await mockedRun(
      "apply",
      auth,
      applyArgs(review),
      [lostApply(plan(), controller)],
      session,
      controller.signal,
    );
    failed(output, "view_mutation_interrupted", EXIT.interrupted);
    assert.deepEqual(output.error?.details, {
      action: "create",
      operationWindowId,
      operationId,
      outcomeKnown: false,
    });
    assert.match(output.error?.message ?? "", /interruption is not cancellation/);
    assert.deepEqual(
      requests.map((entry) => entry.method),
      ["GET", "POST"],
    );
  });
});

test("SIGINT interruption during the recovery GET preserves original identity and unknown outcome", async () => {
  await fixture(async ({ auth, review }) => {
    // main.ts maps SIGINT to this signal. Keep the test inert instead of signalling its runner.
    const controller = new AbortController();
    const { output, requests } = await mockedRun(
      "apply",
      auth,
      applyArgs(review),
      [
        lostApply(),
        {
          method: "GET",
          path: operationPath,
          reply: () => {
            controller.abort();
            throw new Error(`server-only-detail ${session.sessionToken}`);
          },
        },
      ],
      session,
      controller.signal,
    );
    failed(output, "view_mutation_interrupted", EXIT.interrupted);
    assert.deepEqual(output.error?.details, {
      action: "create",
      operationWindowId,
      operationId,
      outcomeKnown: false,
    });
    assert.deepEqual(
      requests.map((entry) => `${entry.method} ${entry.url}`),
      [
        `GET ${target.apiOrigin}/auth/me`,
        `POST ${target.apiOrigin}${path}/apply`,
        `GET ${target.apiOrigin}${operationPath}`,
      ],
    );
    assert.equal(requests.filter((entry) => entry.method === "POST").length, 1);
  });
});

test("recovery rejects receipt extra keys, wrong session, hash and exact operation identity", async () => {
  await fixture(async ({ auth, review }) => {
    const original = receipt();
    const badReceipts = [
      { ...original, extra: true },
      { ...original, sessionId: id(80) },
      { ...original, actorId: id(80) },
      { ...original, reviewedDigest: "0".repeat(64) },
      { ...original, operationId: id(80) },
      { ...original, operationWindowId: "2020-01-01" },
      { ...original, desiredConfigHash: "0".repeat(64) },
    ];
    for (const invalid of badReceipts) {
      const { output, requests } = await mockedRun("apply", auth, applyArgs(review), [
        lostApply(),
        statusStep(operationStatus(invalid)),
      ]);
      failed(output, "invalid_response", EXIT.integrity);
      assert.deepEqual(output.error?.details, {
        operationWindowId,
        operationId,
        outcomeKnown: false,
      });
      assert.equal(requests.filter((entry) => entry.method === "POST").length, 1);
    }
  });
});

test("denied recovery keeps the denial visible and the original mutation outcome unknown", async () => {
  await fixture(async ({ auth, review }) => {
    for (const [status, code, exit] of [
      [403, "forbidden", EXIT.auth],
      [409, "view_operation_expired", EXIT.conflict],
      [429, "view_rate_limit", EXIT.capacity],
    ] as const) {
      const { output } = await mockedRun("apply", auth, applyArgs(review), [
        lostApply(),
        {
          method: "GET",
          path: operationPath,
          reply: () =>
            response({ error: code, detail: `server-only-detail ${session.sessionToken}` }, status),
        },
      ]);
      failed(output, code, exit);
      assert.deepEqual(output.error?.details, {
        operationWindowId,
        operationId,
        outcomeKnown: false,
      });
    }
  });
});

test("explicit apply denials never become recovery or disclose server body text", async () => {
  await fixture(async ({ auth, review }) => {
    for (const [status, code, exit] of [
      [401, "unauthenticated", EXIT.auth],
      [403, "csrf_validation_failed", EXIT.auth],
      [403, "origin_not_allowed", EXIT.auth],
      [403, "session_intent_required", EXIT.auth],
      [409, "revision_conflict", EXIT.conflict],
      [409, "view_review_changed", EXIT.conflict],
      [409, "view_review_expired", EXIT.conflict],
      [429, "view_capacity", EXIT.capacity],
      [422, "view_invalid", EXIT.validation],
      [404, "view_not_found", EXIT.unavailable],
    ] as const) {
      const { output, requests } = await mockedRun("apply", auth, applyArgs(review), [
        {
          method: "POST",
          path: `${path}/apply`,
          body: plan(),
          reply: () =>
            response(
              {
                error: code,
                detail: `server-only-detail ${session.csrfToken}`,
                source: "synthetic-private-path",
              },
              status,
              { "cache-control": "" },
            ),
        },
      ]);
      failed(output, code, exit);
      assert.deepEqual(output.error?.details, { httpStatus: status });
      assert.deepEqual(
        requests.map((entry) => entry.method),
        ["GET", "POST"],
      );
    }
    const { output } = await mockedRun("apply", auth, applyArgs(review), [
      {
        method: "POST",
        path: `${path}/apply`,
        body: plan(),
        reply: () =>
          rawResponse(`server-only-detail ${session.sessionToken}`, 403, {
            "content-type": "text/plain",
          }),
      },
    ]);
    failed(output, "remote_error", EXIT.auth);
  });
});

test("a denial code coinciding with synthetic session material cannot leak through the allowlist", async () => {
  const coincident = "configuration_idempotency_conflict";
  assert.ok(coincident.length >= 32);
  const live = { ...session, sessionToken: coincident };
  await fixture(async ({ auth, review }) => {
    const { output } = await mockedRun(
      "apply",
      auth,
      applyArgs(review),
      [
        {
          method: "POST",
          path: `${path}/apply`,
          body: plan(),
          reply: () => response({ error: coincident }, 409, {}, live),
        },
      ],
      live,
    );
    failed(output, "credential_output_refused", EXIT.integrity);
    assert.equal(JSON.stringify(output).includes(coincident), false);
  }, live);
});

test("a new live session reads the same actor's old receipt and original review but cannot apply it", async () => {
  await fixture(async ({ auth, review }) => {
    const { output, requests } = await mockedRun(
      "status",
      auth,
      statusArgs(review),
      [statusStep(operationStatus(), newSession)],
      newSession,
    );
    succeeded(output, "status");
    assert.deepEqual(output.data, { historical: true, ...operationStatus() });
    assert.equal(
      (output.data as { receipt: PlannerViewReceiptV1 }).receipt.sessionId,
      session.sessionId,
    );
    assert.ok(requests.every((entry) => entry.method === "GET"));
    const apply = await mockedRun("apply", auth, applyArgs(review), [], newSession);
    failed(apply.output, "review_identity_mismatch", EXIT.auth);
  }, newSession);
});

test("status without a saved review remains historical and validates exact explicit operation keys", async () => {
  await fixture(async ({ auth }) => {
    const good = await mockedRun(
      "status",
      auth,
      statusArgs(),
      [statusStep(operationStatus(), newSession)],
      newSession,
    );
    succeeded(good.output, "status");
    for (const invalid of [
      { ...operationStatus(), operationId: id(80) },
      { ...operationStatus(null, false), absenceDefinitive: true },
      { ...operationStatus(), receipt: { ...receipt(), actorId: id(80) } },
      { ...operationStatus(), extra: true },
    ]) {
      const { output } = await mockedRun(
        "status",
        auth,
        statusArgs(),
        [statusStep(invalid, newSession)],
        newSession,
      );
      failed(output, "invalid_response", EXIT.integrity);
    }
  }, newSession);
});

test("status refuses a saved review for a different explicit operation before the status read", async () => {
  await fixture(async ({ auth, review }) => {
    const args = statusArgs(review);
    args[args.indexOf(operationId)] = id(80);
    failed(
      (await mockedRun("status", auth, args, [])).output,
      "view_operation_identity_mismatch",
      EXIT.conflict,
    );
  });
});

test("named select and project return only structurally verified shared rows with bound scope and revision", async () => {
  await fixture(async ({ auth, dir }) => {
    const config = configuration();
    const value = projection(config);
    for (const command of ["select", "project"]) {
      const out = join(dir, `${command}.json`);
      const { output, requests } = await mockedRun(
        command,
        auth,
        ["--view-id", id(5), "--expected-schedule-revision", "7", "--out", out],
        [get(`/${id(5)}`, viewRead(config)), get(`/${id(5)}/projection`, value)],
      );
      succeeded(output, command);
      assert.deepEqual(output.data, value);
      assert.deepEqual(JSON.parse(await readFile(out, "utf8")), value);
      assert.equal((await stat(out)).mode & 0o777, 0o600);
      assert.ok(requests.every((entry) => entry.method === "GET"));
      assert.deepEqual(Object.keys(output.data as object), [
        "available",
        "rows",
        "sourceActivityCount",
        "visibleActivityCount",
        "visualRowCount",
        "groupCount",
        "binding",
      ]);
      assert.equal(JSON.stringify(output.data).includes("sourceVerified"), false);
      assert.equal(JSON.stringify(output.data).includes("rust"), false);
    }
  });
});

test("transient project uses an exact configuration/revision body without selection persistence or mutation", async () => {
  await fixture(async ({ auth, config }) => {
    const value = projection();
    const { output, requests } = await mockedRun(
      "project",
      auth,
      ["--file", config, "--expected-schedule-revision", "7"],
      [post("/projection", { configuration: configuration(), expectedScheduleRevision: 7 }, value)],
    );
    succeeded(output, "project");
    assert.deepEqual(output.data, value);
    assert.deepEqual(
      requests.map((entry) => entry.url),
      [`${target.apiOrigin}/auth/me`, `${target.apiOrigin}${path}/projection`],
    );
  });
});

test("WBS groups and empty results survive the mocked named projection flow", async () => {
  await fixture(async ({ auth }) => {
    const config = configuration();
    config.presentation.groupBy = "wbs";
    const grouped = groupedProjection(config);
    const empty = {
      ...projection(config),
      rows: [],
      sourceActivityCount: 0,
      visibleActivityCount: 0,
      visualRowCount: 0,
      groupCount: 0,
    };
    for (const value of [grouped, empty]) {
      const { output } = await mockedRun(
        "select",
        auth,
        ["--view-id", id(5), "--expected-schedule-revision", "7"],
        [get(`/${id(5)}`, viewRead(config)), get(`/${id(5)}/projection`, value)],
      );
      succeeded(output, "select");
      assert.deepEqual(output.data, value);
    }
    const invalid = structuredClone(grouped);
    if (invalid.rows[0]?.kind !== "group") throw new Error("Invalid synthetic group fixture");
    invalid.rows[0].activityCount = 1;
    failed(
      (
        await mockedRun(
          "select",
          auth,
          ["--view-id", id(5), "--expected-schedule-revision", "7"],
          [get(`/${id(5)}`, viewRead(config)), get(`/${id(5)}/projection`, invalid)],
        )
      ).output,
      "invalid_response",
      EXIT.integrity,
    );
  });
});

test("only explicitly filtered projections may omit source activities", async () => {
  await fixture(async ({ auth, config }) => {
    const filtered = configuration();
    filtered.presentation.search = "matching";
    await writeFile(config, JSON.stringify(filtered));
    const subset = projection(filtered);
    subset.rows.splice(1, 1);
    const last = subset.rows[1];
    assert.ok(last?.kind === "activity");
    last.displayOrdinal = 2;
    subset.visibleActivityCount = 2;
    subset.visualRowCount = 2;
    const result = await mockedRun(
      "project",
      auth,
      ["--file", config, "--expected-schedule-revision", "7"],
      [post("/projection", { configuration: filtered, expectedScheduleRevision: 7 }, subset)],
    );
    succeeded(result.output, "project");
    assert.deepEqual(result.output.data, subset);
    await writeFile(config, JSON.stringify(configuration()));
    subset.binding.configHashSha256 = configHash(configuration());
    failed(
      (
        await mockedRun(
          "project",
          auth,
          ["--file", config, "--expected-schedule-revision", "7"],
          [
            post(
              "/projection",
              { configuration: configuration(), expectedScheduleRevision: 7 },
              subset,
            ),
          ],
        )
      ).output,
      "invalid_response",
      EXIT.integrity,
    );
  });
});

test("transient projection rejects stale revision, scope/hash mismatch and malformed shared rows", async () => {
  await fixture(async ({ auth, config }) => {
    const original = projection();
    const invalid = [
      { ...original, binding: { ...original.binding, scheduleRevision: 8 } },
      { ...original, binding: { ...original.binding, projectId: id(80) } },
      { ...original, binding: { ...original.binding, organizationId: id(80) } },
      { ...original, binding: { ...original.binding, configHashSha256: "0".repeat(64) } },
      { ...original, binding: { ...original.binding, inputHashSha256: "bad-hash" } },
      { ...original, rows: [original.rows[0], original.rows[0], original.rows[2]] },
      {
        ...original,
        rows: [{ ...original.rows[0], displayOrdinal: 2 }, original.rows[1], original.rows[2]],
      },
      { ...original, visibleActivityCount: 1 },
      { ...original, sourceVerified: true },
    ];
    for (const value of invalid) {
      const { output } = await mockedRun(
        "project",
        auth,
        ["--file", config, "--expected-schedule-revision", "7"],
        [
          post(
            "/projection",
            { configuration: configuration(), expectedScheduleRevision: 7 },
            value,
          ),
        ],
      );
      failed(output, "invalid_response", EXIT.integrity);
    }
  });
});

test("calculation-dependent projections require bound calculation metadata while making no authenticity claim", async () => {
  await fixture(async ({ auth, config }) => {
    const value = configuration();
    value.presentation.sort = { field: "earlyStart", direction: "asc" };
    await writeFile(config, JSON.stringify(value));
    const projected = projection(value);
    projected.binding.calculation = {
      calculationId: id(30),
      resultHashSha256: hash("synthetic-result"),
      engineContractVersion: 1,
      engineVersion: "synthetic-fixture-v1",
    };
    const good = await mockedRun(
      "project",
      auth,
      ["--file", config, "--expected-schedule-revision", "7"],
      [post("/projection", { configuration: value, expectedScheduleRevision: 7 }, projected)],
    );
    succeeded(good.output, "project");
    assert.deepEqual(good.output.data, projected);
    const missing = projection(value);
    failed(
      (
        await mockedRun(
          "project",
          auth,
          ["--file", config, "--expected-schedule-revision", "7"],
          [post("/projection", { configuration: value, expectedScheduleRevision: 7 }, missing)],
        )
      ).output,
      "invalid_response",
      EXIT.integrity,
    );
  });
});

const capabilitySource = JSON.stringify(capabilities());
const invalidResponseCases: Array<[string, () => Response, string, number]> = [
  [
    "missing no-store",
    () => response(capabilities(), 200, { "cache-control": "private, max-age=0" }),
    "invalid_response",
    EXIT.integrity,
  ],
  [
    "missing session intent",
    () => response(capabilities(), 200, { "x-engineo-session": "" }),
    "session_changed",
    EXIT.auth,
  ],
  [
    "changed session intent",
    () => response(capabilities(), 200, { "x-engineo-session": id(80) }),
    "session_changed",
    EXIT.auth,
  ],
  [
    "duplicate key",
    () =>
      rawResponse(
        capabilitySource.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      ),
    "invalid_response",
    EXIT.integrity,
  ],
  [
    "escaped duplicate key",
    () =>
      rawResponse(
        capabilitySource.replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1'),
      ),
    "invalid_response",
    EXIT.integrity,
  ],
  [
    "decimal original integer",
    () => rawResponse(capabilitySource.replace('"schemaVersion":1', '"schemaVersion":1.0')),
    "invalid_response",
    EXIT.integrity,
  ],
  [
    "exponent original integer",
    () => rawResponse(capabilitySource.replace('"schemaVersion":1', '"schemaVersion":1e0')),
    "invalid_response",
    EXIT.integrity,
  ],
  [
    "negative zero",
    () => rawResponse(capabilitySource.replace('"schemaVersion":1', '"schemaVersion":-0')),
    "invalid_response",
    EXIT.integrity,
  ],
  [
    "unsafe integer",
    () =>
      rawResponse(
        capabilitySource.replace('"schemaVersion":1', '"schemaVersion":9007199254740993'),
      ),
    "invalid_response",
    EXIT.integrity,
  ],
  ["BOM", () => rawResponse(`\uFEFF${capabilitySource}`), "invalid_response", EXIT.integrity],
  [
    "depth beyond eight",
    () => rawResponse('{"a":[[[[[[[[[]]]]]]]]]}'),
    "invalid_response",
    EXIT.integrity,
  ],
  ["invalid UTF-8", () => rawResponse(Buffer.from([0xff])), "invalid_response", EXIT.integrity],
  [
    "wrong content type",
    () => response(capabilities(), 200, { "content-type": "text/plain" }),
    "invalid_response",
    EXIT.integrity,
  ],
  [
    "oversized declared body",
    () => response(capabilities(), 200, { "content-length": "65537" }),
    "response_too_large",
    EXIT.integrity,
  ],
  [
    "oversized actual body",
    () => rawResponse(" ".repeat(65537)),
    "response_too_large",
    EXIT.integrity,
  ],
  [
    "server credentials in bounded response",
    () => response({ ...capabilities(), detail: session.sessionToken }),
    "invalid_response",
    EXIT.integrity,
  ],
];
for (const [label, reply, code, exit] of invalidResponseCases) {
  test(`view response ${label} is refused without text leakage or retries`, async () => {
    await fixture(async ({ auth }) => {
      const { output, requests } = await mockedRun(
        "capabilities",
        auth,
        [],
        [{ method: "GET", path: `${path}/capabilities`, reply }],
      );
      failed(output, code, exit);
      assert.deepEqual(
        requests.map((entry) => entry.method),
        ["GET", "GET"],
      );
    });
  });
}

test("absent session intent is refused on successful view response", async () => {
  await fixture(async ({ auth }) => {
    const reply = () => {
      const value = response(capabilities());
      value.headers.delete("x-engineo-session");
      return value;
    };
    failed(
      (
        await mockedRun(
          "capabilities",
          auth,
          [],
          [{ method: "GET", path: `${path}/capabilities`, reply }],
        )
      ).output,
      "invalid_response",
      EXIT.integrity,
    );
  });
});

const unusableApplyResponses: Array<[string, () => Response]> = [
  [
    "malformed 2xx JSON",
    () => rawResponse(`{"detail":"server-only-detail ${session.sessionToken}"`),
  ],
  [
    "duplicate 2xx JSON",
    () =>
      rawResponse(
        JSON.stringify(receipt()).replace(
          '"schemaVersion":1',
          '"schemaVersion":1,"schemaVersion":1',
        ),
      ),
  ],
  [
    "decimal original number",
    () =>
      rawResponse(JSON.stringify(receipt()).replace('"schemaVersion":1', '"schemaVersion":1.0')),
  ],
  [
    "exponent original number",
    () =>
      rawResponse(JSON.stringify(receipt()).replace('"schemaVersion":1', '"schemaVersion":1e0')),
  ],
  ["2xx BOM", () => rawResponse(`\uFEFF${JSON.stringify(receipt())}`)],
  ["extra receipt key", () => response({ ...receipt(), extra: "server-only-detail" })],
  ["wrong operation receipt", () => response({ ...receipt(), operationId: id(80) })],
  ["wrong digest receipt", () => response({ ...receipt(), reviewedDigest: "0".repeat(64) })],
  ["oversized actual receipt", () => rawResponse(" ".repeat(2049))],
  ["oversized declared receipt", () => response(receipt(), 200, { "content-length": "2049" })],
  ["invalid receipt UTF-8", () => rawResponse(Buffer.from([0xff]))],
  [
    "missing session intent",
    () => {
      const value = response(receipt());
      value.headers.delete("x-engineo-session");
      return value;
    },
  ],
  ["changed session intent", () => response(receipt(), 200, { "x-engineo-session": id(80) })],
  ["missing no-store", () => response(receipt(), 200, { "cache-control": "" })],
  ["bad content type", () => response(receipt(), 200, { "content-type": "text/plain" })],
  [
    "redirect response",
    () => rawResponse("", 302, { location: `${target.apiOrigin}/unexpected-redirect` }),
  ],
  [
    "explicit 5xx error",
    () =>
      response(
        { error: "view_integrity_error", detail: `server-only-detail ${session.csrfToken}` },
        503,
      ),
  ],
  [
    "malformed 5xx error",
    () =>
      rawResponse(`server-only-detail ${session.sessionToken}`, 502, {
        "content-type": "text/plain",
      }),
  ],
];

test("a receipt response exactly at two KiB stays within the bound without recovery", async () => {
  await fixture(async ({ auth, review }) => {
    const source = JSON.stringify(receipt());
    assert.ok(Buffer.byteLength(source, "utf8") < 2048);
    const body = source + " ".repeat(2048 - Buffer.byteLength(source, "utf8"));
    assert.equal(Buffer.byteLength(body, "utf8"), 2048);
    const { output, requests } = await mockedRun("apply", auth, applyArgs(review), [
      { method: "POST", path: `${path}/apply`, body: plan(), reply: () => rawResponse(body) },
    ]);
    succeeded(output, "apply");
    assert.deepEqual(output.data, { historical: true, receipt: receipt(), recovered: false });
    assert.deepEqual(
      requests.map((entry) => entry.method),
      ["GET", "POST"],
    );
  });
});

for (const [label, reply] of unusableApplyResponses) {
  test(`apply ${label} recovers only the original receipt with one POST and no fresh key`, async () => {
    await fixture(async ({ auth, review }) => {
      const { output, requests } = await mockedRun("apply", auth, applyArgs(review), [
        { method: "POST", path: `${path}/apply`, body: plan(), reply },
        statusStep(operationStatus()),
      ]);
      succeeded(output, "apply");
      assert.deepEqual(output.data, { historical: true, receipt: receipt(), recovered: true });
      assert.deepEqual(
        requests.map((entry) => `${entry.method} ${entry.url}`),
        [
          `GET ${target.apiOrigin}/auth/me`,
          `POST ${target.apiOrigin}${path}/apply`,
          `GET ${target.apiOrigin}${operationPath}`,
        ],
      );
      assert.equal(requests.filter((entry) => entry.method === "POST").length, 1);
      assert.deepEqual(requests[1]?.body, plan());
    });
  });
}

test("an unusable successful apply response followed by open absence remains unknown", async () => {
  await fixture(async ({ auth, review }) => {
    const { output, requests } = await mockedRun("apply", auth, applyArgs(review), [
      { method: "POST", path: `${path}/apply`, body: plan(), reply: () => rawResponse("{") },
      statusStep(operationStatus(null, false)),
    ]);
    failed(output, "view_mutation_outcome_unknown", EXIT.uncertain);
    assert.deepEqual(output.error?.details, {
      action: "create",
      operationWindowId,
      operationId,
      outcomeKnown: false,
    });
    assert.equal(requests.filter((entry) => entry.method === "POST").length, 1);
  });
});

test("projection transport refuses actual or declared bodies above four MiB and removes reserved output", async () => {
  await fixture(async ({ auth, config, dir }) => {
    for (const [index, reply] of [
      () => rawResponse(" ".repeat(4194305)),
      () => response(projection(), 200, { "content-length": "4194305" }),
    ].entries()) {
      const out = join(dir, `oversized-projection-${index}.json`);
      const { output } = await mockedRun(
        "project",
        auth,
        ["--file", config, "--expected-schedule-revision", "7", "--out", out],
        [
          {
            method: "POST",
            path: `${path}/projection`,
            body: { configuration: configuration(), expectedScheduleRevision: 7 },
            reply,
          },
        ],
      );
      failed(output, "response_too_large", EXIT.integrity);
      await assert.rejects(readFile(out));
    }
  });
});

test("a complete compact projection within the response bound cannot leave an oversized pretty export", async () => {
  await fixture(async ({ auth, dir }) => {
    const config = configuration();
    config.presentation.groupBy = "wbs";
    const value = projection(config);
    value.rows = [];
    const groupCount = 4500;
    for (let index = 0; index < groupCount; index++) {
      const wbsId = id(1000 + index);
      const key = `group:wbs:${wbsId}`;
      value.rows.push(
        {
          kind: "group",
          key,
          wbsId,
          wbsCode: String(index + 1),
          wbsName: "Synthetic group ".padEnd(500, "x"),
          activityCount: 1,
        },
        {
          kind: "activity",
          activityId: id(10000 + index),
          nativeIndex: index,
          displayOrdinal: index + 1,
          groupKey: key,
        },
      );
    }
    value.sourceActivityCount = groupCount;
    value.visibleActivityCount = groupCount;
    value.visualRowCount = groupCount * 2;
    value.groupCount = groupCount;
    assert.ok(Buffer.byteLength(JSON.stringify(value), "utf8") <= 4194304);
    assert.ok(Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8") > 4194304);
    const out = join(dir, "oversized-pretty-projection.json");
    const { output } = await mockedRun(
      "select",
      auth,
      ["--view-id", id(5), "--expected-schedule-revision", "7", "--out", out],
      [get(`/${id(5)}`, viewRead(config)), get(`/${id(5)}/projection`, value)],
    );
    failed(output, "view_output_too_large", EXIT.validation);
    await assert.rejects(readFile(out));
  });
});

test("select rejects transient configuration at argument parsing without acquiring session or network", async () => {
  const output = await offlineRun([
    "select",
    ...remote,
    "--auth-file",
    "synthetic-private-path",
    "--file",
    "synthetic-private-path",
    "--expected-schedule-revision",
    "7",
  ]);
  failed(output, "invalid_view_arguments", EXIT.usage);
});
