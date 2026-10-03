import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { NATIVE_PLANNER_PRESENTATION_V1, type PlannerViewConfigurationV1 } from "./planner-view.js";
import {
  calculatePlannerViewConfigurationHashV1,
  calculatePlannerViewReviewDigestV1,
  parsePlannerViewApplyRequestV1,
  parsePlannerViewOperationsJsonV1,
  parsePlannerViewPlanRequestV1,
  parsePlannerViewProjectionRequestV1,
  parsePlannerViewReceiptV1,
  parsePlannerViewReviewV1,
  parsePlannerViewValidateRequestV1,
  PLANNER_VIEW_MAX_OPERATION_BYTES,
  PLANNER_VIEW_MAX_RECEIPT_BYTES,
  PLANNER_VIEW_MAX_REVIEW_AGE_MS,
  PlannerViewOperationsError,
  type PlannerViewReceiptV1,
  type PlannerViewReviewV1,
  plannerViewOperationWindowV1,
  plannerViewReviewTimesV1,
  serializePlannerViewReceiptV1,
  serializePlannerViewReviewHashPreimageV1,
  serializePlannerViewReviewV1,
  validatePlannerViewPlanRequestV1,
  validatePlannerViewReceiptV1,
  validatePlannerViewReviewV1,
  validatePlannerViewValidateRequestV1,
  verifyPlannerViewReceiptBindingV1,
  verifyPlannerViewReviewBaseV1,
  verifyPlannerViewReviewBindingV1,
  verifyPlannerViewReviewDigestV1,
  verifyPlannerViewReviewTimeV1,
  verifyPlannerViewReviewV1,
} from "./planner-view-operations.js";

const id = (index: number) => `abcdefab-0000-0000-0000-${index.toString().padStart(12, "0")}`;
const sha256 = (preimage: string) => createHash("sha256").update(preimage, "utf8").digest("hex");
const now = "2026-10-03T12:00:00.000Z";
const identity = { actorId: id(1), sessionId: id(2), organizationId: id(3), projectId: id(4) };
const operation = {
  operationWindowId: "2026-10-03",
  operationId: id(5),
  expectedScheduleRevision: 17,
};
const timeContext = { now, sessionExpiresAt: "2026-10-03T16:00:00.000Z" };
function config(name = "My view"): PlannerViewConfigurationV1 {
  return {
    schemaVersion: 1,
    kind: "engineo-planner-view",
    name,
    visibility: "private",
    presentation: structuredClone(NATIVE_PLANNER_PRESENTATION_V1),
  };
}
function review(action: "create" | "update" | "delete" = "create"): PlannerViewReviewV1 {
  const baseConfiguration = action === "create" ? null : config("Original view");
  const desiredConfiguration = action === "delete" ? null : config();
  return {
    schemaVersion: 1,
    kind: "engineo-planner-view-review",
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    action,
    viewId: action === "create" ? null : id(6),
    ...identity,
    expectedViewRevision: action === "create" ? 0 : 4,
    ...operation,
    baseConfigHash: baseConfiguration
      ? calculatePlannerViewConfigurationHashV1(baseConfiguration, sha256)
      : null,
    desiredConfigHash: desiredConfiguration
      ? calculatePlannerViewConfigurationHashV1(desiredConfiguration, sha256)
      : null,
    baseConfiguration,
    desiredConfiguration,
    ...plannerViewReviewTimesV1(timeContext),
  };
}
function receipt(value = review()): PlannerViewReceiptV1 {
  return {
    schemaVersion: 1,
    kind: "engineo-planner-view-receipt",
    protocolVersion: 1,
    projectionVersion: 1,
    normalizationVersion: 1,
    ...identity,
    ...operation,
    action: value.action,
    outcome: value.action === "delete" ? "deleted" : "applied",
    viewId: value.viewId ?? id(7),
    previousViewRevision: value.expectedViewRevision,
    committedViewRevision: value.action === "delete" ? null : value.expectedViewRevision + 1,
    baseConfigHash: value.baseConfigHash,
    desiredConfigHash: value.desiredConfigHash,
    reviewedDigest: calculatePlannerViewReviewDigestV1(value, sha256),
    auditId: id(8),
    recordedAt: "2026-10-03T12:01:00.000Z",
  };
}
function throwsCode(source: string | Uint8Array, code: string): void {
  assert.throws(
    () => parsePlannerViewOperationsJsonV1(source),
    (error: unknown) => error instanceof PlannerViewOperationsError && error.code === code,
  );
}

test("plan request has action-specific closed shapes and normalizes inert configuration/UUIDs", () => {
  for (const action of ["create", "update", "delete"] as const) {
    const request = {
      ...operation,
      action,
      ...(action === "create" ? {} : { viewId: id(6).toUpperCase(), expectedViewRevision: 4 }),
      ...(action === "delete" ? {} : { configuration: config("  My view  ") }),
    };
    const parsed = parsePlannerViewPlanRequestV1(JSON.stringify(request));
    assert.equal(parsed.valid, true);
    if (!parsed.valid) continue;
    assert.equal(parsed.value.action, action);
    if (parsed.value.action !== "create") assert.equal(parsed.value.viewId, id(6));
    if (parsed.value.action !== "delete") assert.equal(parsed.value.configuration.name, "My view");
    assert.deepEqual(parsed.diagnostics, { issues: [], totalCount: 0, truncated: false });
  }
  for (const extra of [
    { viewId: id(6) },
    { expectedViewRevision: 0 },
    { actorId: id(1) },
    { visibility: "shared" },
  ])
    assert.equal(
      validatePlannerViewPlanRequestV1({
        ...operation,
        action: "create",
        configuration: config(),
        ...extra,
      }).valid,
      false,
    );
  assert.equal(
    validatePlannerViewPlanRequestV1({
      ...operation,
      action: "delete",
      viewId: id(6),
      expectedViewRevision: 4,
      configuration: config(),
    }).valid,
    false,
  );
  assert.equal(
    validatePlannerViewPlanRequestV1({
      ...operation,
      action: "update",
      viewId: id(6),
      expectedViewRevision: 0,
      configuration: config(),
    }).valid,
    false,
  );
});

test("validate/projection/apply requests are strict typed envelopes without caller ownership or defaults", () => {
  assert.equal(
    parsePlannerViewValidateRequestV1(JSON.stringify({ configuration: config() })).valid,
    true,
  );
  assert.equal(
    parsePlannerViewProjectionRequestV1(
      JSON.stringify({ configuration: config(), expectedScheduleRevision: 17 }),
    ).valid,
    true,
  );
  for (const value of [
    config(),
    { configuration: config(), actorId: id(1) },
    { configuration: config(), presentation: {} },
    {},
  ])
    assert.equal(parsePlannerViewValidateRequestV1(JSON.stringify(value)).valid, false);
  assert.equal(
    parsePlannerViewProjectionRequestV1(JSON.stringify({ configuration: config() })).valid,
    false,
  );
  const value = review();
  const reviewedDigest = calculatePlannerViewReviewDigestV1(value, sha256);
  assert.equal(
    parsePlannerViewApplyRequestV1(JSON.stringify({ review: value, reviewedDigest })).valid,
    true,
  );
  for (const extra of [{ configuration: config() }, { expectedViewRevision: 0 }, { planId: id(5) }])
    assert.equal(
      parsePlannerViewApplyRequestV1(JSON.stringify({ review: value, reviewedDigest, ...extra }))
        .valid,
      false,
    );
  assert.equal(parsePlannerViewApplyRequestV1(JSON.stringify({ review: value })).valid, false);
});

test("original-byte lexer preserves duplicate decoded keys at every container", () => {
  throwsCode('{"action":"create","\\u0061ction":"delete"}', "DUPLICATE_JSON_KEY");
  throwsCode('{"configuration":{"name":"first","\\u006eame":"second"}}', "DUPLICATE_JSON_KEY");
  throwsCode(
    '{"review":{"desiredConfiguration":{"presentation":{"sort":{"field":"name","field":"native"}}}}}',
    "DUPLICATE_JSON_KEY",
  );
  throwsCode('{"unknown-secret":"a","unknown-secret":"b"}', "DUPLICATE_JSON_KEY");
  throwsCode('{"\\u005f_proto__":1}', "UNSAFE_PROPERTY");
  throwsCode('{"constructor":{}}', "UNSAFE_PROPERTY");
});

test("original numeric spellings are rejected before JS rounding, with no fraction/exponent coercion", () => {
  for (const number of [
    "9007199254740993",
    "9007199254740992",
    "1.0000000000000000001",
    "1e0",
    "1e9999",
    "-0",
    "NaN",
    "Infinity",
    "01",
    "-01",
    "+1",
  ])
    throwsCode(`{"expectedScheduleRevision":${number}}`, "INVALID_JSON");
  const largest = parsePlannerViewPlanRequestV1(
    JSON.stringify({
      ...operation,
      action: "create",
      configuration: config(),
      expectedScheduleRevision: Number.MAX_SAFE_INTEGER,
    }),
  );
  assert.equal(largest.valid, true);
  for (const value of [-1, -0, 1.5, Number.POSITIVE_INFINITY])
    assert.equal(
      validatePlannerViewPlanRequestV1({
        ...operation,
        action: "create",
        configuration: config(),
        expectedScheduleRevision: value,
      }).valid,
      false,
    );
});

test("UTF-8, BOM, unpaired surrogates, grammar and non-string input are rejected", () => {
  for (const bytes of [
    new Uint8Array([0xc0, 0xaf]),
    new Uint8Array([0xed, 0xa0, 0x80]),
    new Uint8Array([0x80]),
  ])
    throwsCode(bytes, "INVALID_UTF8");
  for (const source of [
    '{"name":"\\ud800"}',
    '{"name":"\\udfff"}',
    '"\ud800"',
    "\ufeff{}",
    "{} trailing",
    '{"x":true,}',
    '{"x":"\n"}',
    "[1,]",
  ])
    throwsCode(source, "INVALID_JSON");
  throwsCode(new TextEncoder().encode("\ufeff{}"), "INVALID_JSON");
  throwsCode({} as Uint8Array, "INVALID_VALUE");
  assert.deepEqual(
    parsePlannerViewOperationsJsonV1('{"pair":"\\ud83d\\ude00","flag":true,"empty":null}'),
    Object.assign(Object.create(null), { pair: "😀", flag: true, empty: null }),
  );
});

test("transport limits bind original UTF-8 bytes including whitespace/escapes and ignore shadowed byteLength", () => {
  const exact = `${" ".repeat(PLANNER_VIEW_MAX_OPERATION_BYTES - 2)}{}`;
  assert.deepEqual(parsePlannerViewOperationsJsonV1(exact), Object.create(null));
  throwsCode(` ${exact}`, "TRANSPORT_TOO_LARGE");
  throwsCode(`"${"é".repeat(PLANNER_VIEW_MAX_OPERATION_BYTES / 2)}"`, "TRANSPORT_TOO_LARGE");
  const tooLarge = new Uint8Array(PLANNER_VIEW_MAX_OPERATION_BYTES + 1);
  Object.defineProperty(tooLarge, "byteLength", { value: 1 });
  throwsCode(tooLarge, "TRANSPORT_TOO_LARGE");
  const escapePadded =
    '{"configuration":' +
    JSON.stringify(config()).replace("My view", "\\u004d".repeat(11000)) +
    "}";
  assert.equal(parsePlannerViewValidateRequestV1(escapePadded).valid, false);
});

test("eight container nesting is accepted; nine is rejected for objects and arrays", () => {
  assert.doesNotThrow(() => parsePlannerViewOperationsJsonV1(`${"[".repeat(8)}0${"]".repeat(8)}`));
  throwsCode(`${"[".repeat(9)}0${"]".repeat(9)}`, "MAX_DEPTH_EXCEEDED");
  throwsCode(`${'{"x":'.repeat(9)}0${"}".repeat(9)}`, "MAX_DEPTH_EXCEEDED");
});

test("diagnostics never expose unknown property names or submitted values", () => {
  const secret = "secret-user-password-123";
  const value = {
    configuration: {
      ...config(),
      [secret]: secret,
      presentation: { ...config().presentation, [secret]: secret },
    },
    [secret]: secret,
  };
  const invalid = validatePlannerViewValidateRequestV1(value);
  assert.equal(invalid.valid, false);
  assert.ok(!JSON.stringify(invalid).includes(secret));
  const duplicate = parsePlannerViewApplyRequestV1(
    `{"review":{"${secret}":1,"${secret}":2},"reviewedDigest":"${secret}"}`,
  );
  assert.equal(duplicate.valid, false);
  assert.ok(!JSON.stringify(duplicate).includes(secret));
  const malformed = parsePlannerViewValidateRequestV1(`{"${secret}":"${secret}`);
  assert.ok(!JSON.stringify(malformed).includes(secret));
});

test("diagnostics are capped at 20 with truthful total/truncated and 256-unit well-formed fields", () => {
  const value = {
    configuration: {
      ...config(),
      ...Object.fromEntries(
        Array.from({ length: 80 }, (_, index) => [
          `unknown_${index}_${"😀".repeat(200)}`,
          "secret",
        ]),
      ),
    },
  };
  const invalid = validatePlannerViewValidateRequestV1(value);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.diagnostics.issues.length, 20);
  assert.equal(invalid.diagnostics.totalCount, 80);
  assert.equal(invalid.diagnostics.truncated, true);
  for (const issue of invalid.diagnostics.issues) {
    assert.ok(issue.path.length <= 256 && issue.path.isWellFormed());
    assert.ok(issue.message.length <= 256 && issue.message.isWellFormed());
    assert.equal(issue.path, "configuration");
  }
});

test("object validators inspect descriptors without getters, merge, or exotic objects", () => {
  let reads = 0;
  const getter = Object.defineProperty({ configuration: config() }, "action", {
    enumerable: true,
    get() {
      reads++;
      throw new Error("secret");
    },
  });
  assert.equal(validatePlannerViewPlanRequestV1(getter).valid, false);
  assert.equal(reads, 0);
  assert.equal(
    validatePlannerViewValidateRequestV1(Object.create({ configuration: config() })).valid,
    false,
  );
  assert.equal(
    validatePlannerViewValidateRequestV1({ configuration: config(), [Symbol("secret")]: "secret" })
      .valid,
    false,
  );
  assert.equal(validatePlannerViewValidateRequestV1(new Date()).valid, false);
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("secret");
      },
    },
  );
  assert.equal(validatePlannerViewPlanRequestV1(proxy).valid, false);
  assert.equal(validatePlannerViewValidateRequestV1(proxy).valid, false);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("review closed shape enforces every version/action/null/base/time invariant", () => {
  for (const action of ["create", "update", "delete"] as const)
    assert.equal(
      parsePlannerViewReviewV1(serializePlannerViewReviewV1(review(action))).valid,
      true,
    );
  const original = review();
  for (const change of [
    { schemaVersion: 2 },
    { protocolVersion: 2 },
    { projectionVersion: 2 },
    { normalizationVersion: 2 },
    { viewId: id(6) },
    { expectedViewRevision: 1 },
    { baseConfigHash: "a".repeat(64) },
    { baseConfiguration: config() },
    { desiredConfigHash: null },
    { desiredConfiguration: null },
    { actorId: "not-a-uuid" },
    { extra: "secret" },
    { issuedAt: "2026-10-03T12:00:00Z" },
    { expiresAt: original.issuedAt },
    { expiresAt: "2026-10-03T12:15:00.001Z" },
    { operationWindowId: "2026-10-04" },
  ])
    assert.equal(
      validatePlannerViewReviewV1({ ...original, ...change }).valid,
      false,
      JSON.stringify(change),
    );
  assert.equal(
    validatePlannerViewReviewV1({ ...review("update"), expectedViewRevision: 0 }).valid,
    false,
  );
  assert.equal(
    validatePlannerViewReviewV1({ ...review("delete"), desiredConfiguration: config() }).valid,
    false,
  );
  const missing = { ...original } as Partial<PlannerViewReviewV1>;
  delete missing.sessionId;
  assert.equal(validatePlannerViewReviewV1(missing).valid, false);
});

test("canonical review binds complete normalized config, identities, revisions, operation and times", () => {
  const original = review("update");
  const digest = calculatePlannerViewReviewDigestV1(original, sha256);
  assert.deepEqual(verifyPlannerViewReviewDigestV1(original, digest, sha256), { valid: true });
  const reversed = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(
    serializePlannerViewReviewV1(reversed as unknown as PlannerViewReviewV1),
    serializePlannerViewReviewV1(original),
  );
  assert.equal(sha256(serializePlannerViewReviewHashPreimageV1(original)), digest);
  assert.ok(
    new TextEncoder().encode(serializePlannerViewReviewV1(original)).length <=
      PLANNER_VIEW_MAX_OPERATION_BYTES,
  );
  for (const field of [
    "actorId",
    "sessionId",
    "organizationId",
    "projectId",
    "viewId",
    "operationId",
  ] as const)
    assert.deepEqual(
      verifyPlannerViewReviewDigestV1({ ...original, [field]: id(99) }, digest, sha256),
      { valid: false, reason: "view_review_changed" },
    );
  for (const change of [
    { expectedViewRevision: 5 },
    { expectedScheduleRevision: 18 },
    { baseConfigHash: "b".repeat(64) },
    { desiredConfigHash: "b".repeat(64) },
    { desiredConfiguration: config("Tampered") },
    { baseConfiguration: config("Tampered") },
    { issuedAt: "2026-10-03T12:00:01.000Z" },
    { expiresAt: "2026-10-03T12:14:00.000Z" },
  ])
    assert.deepEqual(verifyPlannerViewReviewDigestV1({ ...original, ...change }, digest, sha256), {
      valid: false,
      reason: "view_review_changed",
    });
  assert.deepEqual(verifyPlannerViewReviewDigestV1(original, digest.toUpperCase(), sha256), {
    valid: false,
    reason: "view_review_changed",
  });
  assert.deepEqual(verifyPlannerViewReviewDigestV1(original, "a".repeat(64), sha256), {
    valid: false,
    reason: "view_review_changed",
  });
});

test("a caller recomputing a digest cannot hide inconsistent configuration hashes", () => {
  const value = { ...review("update"), desiredConfiguration: config("Changed after preview") };
  const changedDigest = calculatePlannerViewReviewDigestV1(value, sha256);
  assert.deepEqual(verifyPlannerViewReviewDigestV1(value, changedDigest, sha256), {
    valid: false,
    reason: "view_review_changed",
  });
  value.desiredConfigHash = calculatePlannerViewConfigurationHashV1(
    value.desiredConfiguration,
    sha256,
  );
  // Consistent authorized stateless payloads are permitted; digest is not a signature/human approval.
  assert.deepEqual(
    verifyPlannerViewReviewDigestV1(
      value,
      calculatePlannerViewReviewDigestV1(value, sha256),
      sha256,
    ),
    { valid: true },
  );
});

test("live identity and current base checks are separate from syntactic digest verification", () => {
  const value = review("update");
  const digest = calculatePlannerViewReviewDigestV1(value, sha256);
  const base = {
    viewId: value.viewId,
    viewRevision: 4,
    scheduleRevision: 17,
    configHash: value.baseConfigHash,
  };
  assert.deepEqual(verifyPlannerViewReviewBindingV1(value, identity), { valid: true });
  for (const field of ["actorId", "sessionId", "organizationId", "projectId"] as const)
    assert.deepEqual(verifyPlannerViewReviewBindingV1(value, { ...identity, [field]: id(99) }), {
      valid: false,
      reason: "session_changed",
    });
  assert.deepEqual(verifyPlannerViewReviewBaseV1(value, base), { valid: true });
  for (const change of [
    { viewId: null },
    { viewRevision: 5 },
    { scheduleRevision: 18 },
    { configHash: "a".repeat(64) },
  ])
    assert.deepEqual(verifyPlannerViewReviewBaseV1(value, { ...base, ...change }), {
      valid: false,
      reason: "view_base_changed",
    });
  assert.deepEqual(
    verifyPlannerViewReviewV1(value, digest, { ...identity, ...timeContext, ...base }, sha256),
    { valid: true },
  );
});

test("server review lifetime is bounded by 15min, session expiry, and current UTC-day window", () => {
  assert.deepEqual(plannerViewReviewTimesV1(timeContext), {
    operationWindowId: "2026-10-03",
    issuedAt: now,
    expiresAt: "2026-10-03T12:15:00.000Z",
  });
  assert.deepEqual(
    plannerViewReviewTimesV1({ ...timeContext, sessionExpiresAt: "2026-10-03T12:03:01.123Z" }),
    { operationWindowId: "2026-10-03", issuedAt: now, expiresAt: "2026-10-03T12:03:01.123Z" },
  );
  const late = plannerViewReviewTimesV1({
    now: "2026-10-03T23:59:59.500Z",
    sessionExpiresAt: "2026-10-04T08:00:00.000Z",
  });
  assert.equal(late.expiresAt, "2026-10-04T00:00:00.000Z");
  assert.throws(
    () => plannerViewReviewTimesV1({ ...timeContext, sessionExpiresAt: now }),
    PlannerViewOperationsError,
  );
  assert.throws(
    () => plannerViewReviewTimesV1({ ...timeContext, now: "2026-02-30T12:00:00.000Z" }),
    PlannerViewOperationsError,
  );
  assert.equal(
    Date.parse(review().expiresAt) - Date.parse(review().issuedAt),
    PLANNER_VIEW_MAX_REVIEW_AGE_MS,
  );
});

test("operation windows are calendar UTC days with bounded 24h-after-close receipt horizon", () => {
  assert.deepEqual(plannerViewOperationWindowV1("2026-12-31T23:59:59.999Z"), {
    operationWindowId: "2026-12-31",
    opensAt: "2026-12-31T00:00:00.000Z",
    closesAt: "2027-01-01T00:00:00.000Z",
    replayUntil: "2027-01-02T00:00:00.000Z",
  });
  assert.deepEqual(plannerViewOperationWindowV1("2028-02-29T03:00:00.000Z"), {
    operationWindowId: "2028-02-29",
    opensAt: "2028-02-29T00:00:00.000Z",
    closesAt: "2028-03-01T00:00:00.000Z",
    replayUntil: "2028-03-02T00:00:00.000Z",
  });
  assert.throws(
    () => plannerViewOperationWindowV1("2026-10-03T12:00:00+00:00"),
    PlannerViewOperationsError,
  );
});

test("new admission rejects future, expired, closed-window and shorter-live-session reviews", () => {
  const value = review();
  assert.deepEqual(verifyPlannerViewReviewTimeV1(value, timeContext), { valid: true });
  assert.deepEqual(
    verifyPlannerViewReviewTimeV1(value, { ...timeContext, now: "2026-10-03T11:59:59.999Z" }),
    { valid: false, reason: "view_review_changed" },
  );
  assert.deepEqual(verifyPlannerViewReviewTimeV1(value, { ...timeContext, now: value.expiresAt }), {
    valid: false,
    reason: "view_review_expired",
  });
  assert.deepEqual(
    verifyPlannerViewReviewTimeV1(value, {
      ...timeContext,
      now: "2026-10-04T00:00:00.000Z",
      sessionExpiresAt: "2026-10-04T08:00:00.000Z",
    }),
    { valid: false, reason: "view_operation_window_closed" },
  );
  assert.deepEqual(
    verifyPlannerViewReviewTimeV1(value, {
      ...timeContext,
      sessionExpiresAt: "2026-10-03T12:14:59.999Z",
    }),
    { valid: false, reason: "session_changed" },
  );
  assert.deepEqual(
    verifyPlannerViewReviewTimeV1(value, { ...timeContext, sessionExpiresAt: now }),
    { valid: false, reason: "session_changed" },
  );
  // A retained exact same-session receipt can still replay after expiry, following live auth.
  assert.deepEqual(
    verifyPlannerViewReviewDigestV1(
      value,
      calculatePlannerViewReviewDigestV1(value, sha256),
      sha256,
    ),
    { valid: true },
  );
  assert.deepEqual(verifyPlannerViewReviewBindingV1(value, identity), { valid: true });
});

test("compact receipts cover create/update/delete/no_op without storing configurations", () => {
  for (const action of ["create", "update", "delete"] as const) {
    const value = review(action);
    const record = receipt(value);
    const serialized = serializePlannerViewReceiptV1(record);
    assert.ok(new TextEncoder().encode(serialized).length <= PLANNER_VIEW_MAX_RECEIPT_BYTES);
    assert.ok(!serialized.includes("presentation") && !serialized.includes("Original view"));
    assert.equal(parsePlannerViewReceiptV1(serialized).valid, true);
    assert.equal(verifyPlannerViewReceiptBindingV1(record, value, record.reviewedDigest), true);
  }
  const value = review("update");
  value.desiredConfiguration = value.baseConfiguration;
  value.desiredConfigHash = value.baseConfigHash;
  const noOp = {
    ...receipt(value),
    outcome: "no_op" as const,
    committedViewRevision: value.expectedViewRevision,
  };
  assert.equal(validatePlannerViewReceiptV1(noOp).valid, true);
  assert.equal(verifyPlannerViewReceiptBindingV1(noOp, value, noOp.reviewedDigest), true);
  assert.equal(validatePlannerViewReceiptV1({ ...noOp, committedViewRevision: 5 }).valid, false);
  assert.equal(validatePlannerViewReceiptV1({ ...noOp, outcome: "applied" }).valid, false);
});

test("receipt guards reject inconsistent historical revisions/hashes/outcomes/identities/extra fields", () => {
  const value = review();
  const record = receipt(value);
  for (const change of [
    { previousViewRevision: 1 },
    { committedViewRevision: 2 },
    { outcome: "deleted" },
    { baseConfigHash: "a".repeat(64) },
    { desiredConfigHash: null },
    { kind: "different" },
    { protocolVersion: 2 },
    { recordedAt: "2026-10-04T00:00:00.000Z" },
    { configuration: config() },
  ])
    assert.equal(validatePlannerViewReceiptV1({ ...record, ...change }).valid, false);
  assert.equal(
    validatePlannerViewReceiptV1({ ...receipt(review("delete")), committedViewRevision: 5 }).valid,
    false,
  );
  for (const field of [
    "actorId",
    "sessionId",
    "organizationId",
    "projectId",
    "operationId",
    "auditId",
  ] as const)
    assert.equal(
      verifyPlannerViewReceiptBindingV1(
        { ...record, [field]: field === "auditId" ? "invalid" : id(99) },
        value,
        record.reviewedDigest,
      ),
      false,
    );
  assert.equal(verifyPlannerViewReceiptBindingV1(record, value, "a".repeat(64)), false);
  assert.equal(
    verifyPlannerViewReceiptBindingV1(
      { ...record, recordedAt: "2026-10-03T11:59:59.999Z" },
      value,
      record.reviewedDigest,
    ),
    false,
  );
  assert.equal(
    verifyPlannerViewReceiptBindingV1(
      { ...record, recordedAt: value.expiresAt },
      value,
      record.reviewedDigest,
    ),
    false,
  );
});

test("receipt parsing enforces ORIGINAL 2KiB bytes, duplicates, and normalized safe issues", () => {
  const serialized = serializePlannerViewReceiptV1(receipt());
  const exact = " ".repeat(PLANNER_VIEW_MAX_RECEIPT_BYTES - serialized.length) + serialized;
  assert.equal(parsePlannerViewReceiptV1(exact).valid, true);
  const over = parsePlannerViewReceiptV1(` ${exact}`);
  assert.equal(over.valid, false);
  assert.equal(over.diagnostics.issues[0]?.code, "TRANSPORT_TOO_LARGE");
  const duplicate = parsePlannerViewReceiptV1(
    serialized.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
  );
  assert.equal(duplicate.valid, false);
  assert.equal(duplicate.diagnostics.issues[0]?.code, "DUPLICATE_JSON_KEY");
});

test("hash-helper diagnostics also sanitize unknown keys, and review checks use descriptor copies", () => {
  const secret = "sensitive-unknown-key";
  const invalidConfiguration = { ...config(), [secret]: secret };
  assert.throws(
    () => calculatePlannerViewConfigurationHashV1(invalidConfiguration, sha256),
    (error: unknown) =>
      error instanceof PlannerViewOperationsError &&
      !JSON.stringify(error.diagnostics).includes(secret),
  );
  const value = review("update");
  let reads = 0;
  const proxy = new Proxy(value, {
    get() {
      reads++;
      throw new Error("Sensitive accessor must not run");
    },
  });
  assert.deepEqual(
    verifyPlannerViewReviewDigestV1(
      proxy,
      calculatePlannerViewReviewDigestV1(value, sha256),
      sha256,
    ),
    { valid: true },
  );
  assert.deepEqual(verifyPlannerViewReviewBindingV1(proxy, identity), { valid: true });
  assert.deepEqual(verifyPlannerViewReviewTimeV1(proxy, timeContext), { valid: true });
  assert.deepEqual(
    verifyPlannerViewReviewBaseV1(proxy, {
      viewId: value.viewId,
      viewRevision: 4,
      scheduleRevision: 17,
      configHash: value.baseConfigHash,
    }),
    { valid: true },
  );
  assert.equal(reads, 0);
});

test("all schedule-bound operation DTOs reject revision zero while create view revision remains zero", () => {
  const projection = parsePlannerViewProjectionRequestV1(
    JSON.stringify({ configuration: config(), expectedScheduleRevision: 0 }),
  );
  const plan = parsePlannerViewPlanRequestV1(
    JSON.stringify({
      ...operation,
      action: "create",
      configuration: config(),
      expectedScheduleRevision: 0,
    }),
  );
  const invalidReview = parsePlannerViewReviewV1(
    JSON.stringify({ ...review(), expectedScheduleRevision: 0 }),
  );
  const invalidReceipt = parsePlannerViewReceiptV1(
    JSON.stringify({ ...receipt(), expectedScheduleRevision: 0 }),
  );
  for (const checked of [projection, plan, invalidReview, invalidReceipt]) {
    assert.equal(checked.valid, false);
    assert.ok(
      checked.diagnostics.issues.some(
        (issue) => issue.path === "expectedScheduleRevision" && issue.code === "INVALID_VALUE",
      ),
    );
  }
  assert.equal(review().expectedViewRevision, 0);
  assert.equal(validatePlannerViewReviewV1(review()).valid, true);
  assert.equal(receipt().previousViewRevision, 0);
  assert.equal(validatePlannerViewReceiptV1(receipt()).valid, true);
});

test("operation windows fail closed before close/replay would produce an extended ISO year", () => {
  assert.throws(
    () => plannerViewOperationWindowV1("0000-01-01T00:00:00.000Z"),
    PlannerViewOperationsError,
  );
  assert.equal(
    validatePlannerViewPlanRequestV1({
      action: "create",
      ...operation,
      configuration: config(),
      operationWindowId: "0000-01-01",
    }).valid,
    false,
  );

  assert.deepEqual(plannerViewOperationWindowV1("9999-12-29T23:59:59.999Z"), {
    operationWindowId: "9999-12-29",
    opensAt: "9999-12-29T00:00:00.000Z",
    closesAt: "9999-12-30T00:00:00.000Z",
    replayUntil: "9999-12-31T00:00:00.000Z",
  });
  for (const day of ["9999-12-30", "9999-12-31"]) {
    assert.throws(
      () => plannerViewOperationWindowV1(`${day}T12:00:00.000Z`),
      (error: unknown) =>
        error instanceof PlannerViewOperationsError && error.code === "INVALID_VALUE",
    );
    assert.throws(
      () =>
        plannerViewReviewTimesV1({
          now: `${day}T12:00:00.000Z`,
          sessionExpiresAt: `${day}T12:15:00.000Z`,
        }),
      PlannerViewOperationsError,
    );
    assert.equal(
      parsePlannerViewPlanRequestV1(
        JSON.stringify({
          ...operation,
          operationWindowId: day,
          action: "create",
          configuration: config(),
        }),
      ).valid,
      false,
    );
    assert.equal(
      validatePlannerViewReviewV1({
        ...review(),
        operationWindowId: day,
        issuedAt: `${day}T12:00:00.000Z`,
        expiresAt: `${day}T12:15:00.000Z`,
      }).valid,
      false,
    );
    assert.equal(
      validatePlannerViewReceiptV1({
        ...receipt(),
        operationWindowId: day,
        recordedAt: `${day}T12:01:00.000Z`,
      }).valid,
      false,
    );
  }
  const value = plannerViewOperationWindowV1(now);
  assert.equal(value.operationWindowId, "2026-10-03");
  assert.equal(value.closesAt, "2026-10-04T00:00:00.000Z");
  assert.equal(value.replayUntil, "2026-10-05T00:00:00.000Z");
});
