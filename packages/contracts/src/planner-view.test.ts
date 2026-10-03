import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  NATIVE_PLANNER_PRESENTATION_V1,
  parsePlannerViewConfigurationV1,
  PLANNER_VIEW_MAX_BYTES,
  PLANNER_VIEW_MAX_DEPTH,
  PLANNER_VIEW_MAX_DIAGNOSTIC_TEXT_LENGTH,
  PLANNER_VIEW_MAX_DIAGNOSTICS,
  PLANNER_VIEW_NORMALIZATION_VERSION,
  PLANNER_VIEW_PROJECTION_VERSION,
  PLANNER_VIEW_SCHEMA_VERSION,
  type PlannerPresentationV1,
  type PlannerViewConfigurationV1,
  type PlannerViewConfigurationValidationV1,
  PlannerViewConfigurationError,
  type PlannerViewIssueCodeV1,
  serializePlannerViewConfigurationV1,
  serializePlannerViewHashPreimageV1,
  validatePlannerPresentationV1,
  validatePlannerViewConfigurationV1,
} from "./planner-view.js";

const UUID = "a0b1c2d3-e4f5-4678-9012-abcdef012345";
const CANONICAL =
  '{"schemaVersion":1,"kind":"engineo-planner-view","name":"Critical by WBS","visibility":"private","presentation":{"search":"","kind":"all","wbsId":null,"critical":"critical","sort":{"field":"earlyStart","direction":"asc"},"groupBy":"wbs"}}';
const PREIMAGE =
  '{"kind":"engineo-planner-view-v1-canonical","projectionVersion":1,"normalizationVersion":1,"configuration":' +
  CANONICAL +
  "}";

function configuration(): PlannerViewConfigurationV1 {
  return {
    schemaVersion: 1,
    kind: "engineo-planner-view",
    name: "Critical by WBS",
    visibility: "private",
    presentation: {
      search: "",
      kind: "all",
      wbsId: null,
      critical: "critical",
      sort: { field: "earlyStart", direction: "asc" },
      groupBy: "wbs",
    },
  };
}

function valid(result: PlannerViewConfigurationValidationV1) {
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.ok(result.valid);
  assert.deepEqual(result.diagnostics, { issues: [], totalCount: 0, truncated: false });
  return result;
}

function invalid(result: PlannerViewConfigurationValidationV1, code?: PlannerViewIssueCodeV1) {
  assert.equal(result.valid, false);
  assert.ok(!result.valid);
  assert.ok(result.diagnostics.totalCount > 0);
  assert.ok(result.diagnostics.issues.length <= PLANNER_VIEW_MAX_DIAGNOSTICS);
  if (code)
    assert.ok(
      result.diagnostics.issues.some((issue) => issue.code === code),
      code,
    );
  for (const issue of result.diagnostics.issues) {
    assert.ok(issue.path.length <= PLANNER_VIEW_MAX_DIAGNOSTIC_TEXT_LENGTH);
    assert.ok(issue.message.length <= PLANNER_VIEW_MAX_DIAGNOSTIC_TEXT_LENGTH);
    assert.ok(issue.path.isWellFormed());
    assert.ok(issue.message.isWellFormed());
  }
  return result.diagnostics;
}

test("private configuration has an exact fixed-order canonical and caller-owned SHA-256 preimage", () => {
  assert.equal(PLANNER_VIEW_SCHEMA_VERSION, 1);
  assert.equal(PLANNER_VIEW_PROJECTION_VERSION, 1);
  assert.equal(PLANNER_VIEW_NORMALIZATION_VERSION, 1);
  const original = configuration();
  const result = valid(validatePlannerViewConfigurationV1(original));
  assert.deepEqual(result.normalizedConfiguration, original);
  assert.notEqual(result.normalizedConfiguration, original);
  assert.notEqual(result.normalizedConfiguration.presentation, original.presentation);
  assert.notEqual(result.normalizedConfiguration.presentation.sort, original.presentation.sort);
  assert.equal(result.canonicalConfiguration, CANONICAL);
  assert.equal(result.hashPreimage, PREIMAGE);
  assert.equal(serializePlannerViewConfigurationV1(original), CANONICAL);
  assert.equal(serializePlannerViewHashPreimageV1(original), PREIMAGE);
  assert.equal(
    createHash("sha256").update(PREIMAGE, "utf8").digest("hex"),
    "0b60167cefa299e4ac774cda2aa78eb76a96eef17fd07d1280ee95328e12a346",
  );
  assert.notEqual(
    createHash("sha256").update(CANONICAL, "utf8").digest("hex"),
    createHash("sha256").update(PREIMAGE, "utf8").digest("hex"),
  );
  assert.ok(!CANONICAL.endsWith("\n"));
  assert.equal(valid(parsePlannerViewConfigurationV1(CANONICAL)).canonicalConfiguration, CANONICAL);
  assert.equal(
    valid(parsePlannerViewConfigurationV1(new TextEncoder().encode(CANONICAL)))
      .canonicalConfiguration,
    CANONICAL,
  );
});

test("Native is explicit, deeply frozen, independent of a configuration or result", () => {
  assert.deepEqual(NATIVE_PLANNER_PRESENTATION_V1, {
    search: "",
    kind: "all",
    wbsId: null,
    critical: "all",
    sort: { field: "native", direction: "asc" },
    groupBy: "none",
  });
  assert.ok(Object.isFrozen(NATIVE_PLANNER_PRESENTATION_V1));
  assert.ok(Object.isFrozen(NATIVE_PLANNER_PRESENTATION_V1.sort));
  assert.throws(() => {
    NATIVE_PLANNER_PRESENTATION_V1.search = "changed";
  }, TypeError);
  assert.throws(() => {
    NATIVE_PLANNER_PRESENTATION_V1.sort.direction = "desc";
  }, TypeError);
  const validated = validatePlannerPresentationV1(NATIVE_PLANNER_PRESENTATION_V1);
  assert.ok(validated.valid);
  assert.deepEqual(validated.normalizedPresentation, NATIVE_PLANNER_PRESENTATION_V1);
  assert.notEqual(validated.normalizedPresentation, NATIVE_PLANNER_PRESENTATION_V1);
});

test("normalization trims field edges, lowercases UUID only and preserves inert Unicode text", () => {
  const original = configuration();
  original.name = "\u00a0\u2003Crİtical ß Σ 𝔘 e\u0301\u3000";
  original.presentation.search = " \t\r\nİßΣ\tA\nB\rC e\u0301 \u00a0";
  original.presentation.wbsId = UUID.toUpperCase();
  Object.freeze(original.presentation.sort);
  Object.freeze(original.presentation);
  Object.freeze(original);
  const result = valid(validatePlannerViewConfigurationV1(original));
  assert.equal(result.normalizedConfiguration.name, "Crİtical ß Σ 𝔘 e\u0301");
  assert.equal(result.normalizedConfiguration.presentation.search, "İßΣ\tA\nB\rC e\u0301");
  assert.equal(result.normalizedConfiguration.presentation.wbsId, UUID);
  assert.equal(original.presentation.wbsId, UUID.toUpperCase());
  assert.equal(
    valid(parsePlannerViewConfigurationV1(result.canonicalConfiguration)).canonicalConfiguration,
    result.canonicalConfiguration,
  );
  const equivalent = configuration();
  equivalent.name = result.normalizedConfiguration.name;
  equivalent.presentation = result.normalizedConfiguration.presentation;
  assert.equal(serializePlannerViewHashPreimageV1(equivalent), result.hashPreimage);
  const composed = configuration();
  composed.name = "é";
  const decomposed = configuration();
  decomposed.name = "e\u0301";
  assert.notEqual(
    serializePlannerViewConfigurationV1(composed),
    serializePlannerViewConfigurationV1(decomposed),
  );
});

test("all fixed enum choices are accepted; native descending and unsupported enums are rejected", () => {
  let combinations = 0;
  for (const kind of ["all", "TASK", "START_MILESTONE", "FINISH_MILESTONE"] as const)
    for (const critical of ["all", "critical", "noncritical"] as const)
      for (const field of [
        "native",
        "name",
        "durationMinutes",
        "earlyStart",
        "totalFloatMinutes",
      ] as const)
        for (const direction of ["asc", "desc"] as const)
          for (const groupBy of ["none", "wbs"] as const) {
            const value = configuration();
            value.presentation = {
              search: "",
              kind,
              wbsId: null,
              critical,
              sort: { field, direction },
              groupBy,
            };
            const result = validatePlannerViewConfigurationV1(value);
            if (field === "native" && direction === "desc") invalid(result, "INVALID_VALUE");
            else valid(result);
            combinations++;
          }
  assert.equal(combinations, 240);
  for (const patch of [
    { kind: "task" },
    { critical: "non-critical" },
    { groupBy: "calendar" },
    { sort: { field: "finish", direction: "asc" } },
    { sort: { field: "name", direction: "ascending" } },
    { sort: [{ field: "name", direction: "asc" }] },
  ]) {
    const value = configuration();
    Object.assign(value.presentation, patch);
    invalid(validatePlannerViewConfigurationV1(value), "INVALID_VALUE");
  }
});

test("every configuration, presentation and sort field is required without defaults or coercion", () => {
  for (const path of [[], ["presentation"], ["presentation", "sort"]] as const) {
    const sample = configuration() as unknown as Record<string, unknown>;
    let object = sample;
    for (const key of path) object = object[key] as Record<string, unknown>;
    for (const field of Object.keys(object)) {
      const value = configuration() as unknown as Record<string, unknown>;
      let target = value;
      for (const key of path) target = target[key] as Record<string, unknown>;
      delete target[field];
      invalid(validatePlannerViewConfigurationV1(value), "MISSING_PROPERTY");
    }
  }
  for (const value of [undefined, null, true, 1, "configuration", [], {}, new Map(), new Date()])
    invalid(validatePlannerViewConfigurationV1(value));
  for (const replacement of [undefined, null, 1, true, {}, [], new String("all")]) {
    const value = configuration();
    (value.presentation as unknown as Record<string, unknown>).kind = replacement;
    invalid(validatePlannerViewConfigurationV1(value), "INVALID_VALUE");
  }
  for (const replacement of [1, true, {}, [], new String("View")]) {
    const value = configuration();
    (value as unknown as Record<string, unknown>).name = replacement;
    invalid(validatePlannerViewConfigurationV1(value), "INVALID_VALUE");
  }
});

test("schema versions, private ownership and future projection/normalization fields are closed", () => {
  for (const schemaVersion of [
    0,
    2,
    -1,
    1.5,
    "1",
    true,
    null,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    invalid(
      validatePlannerViewConfigurationV1({ ...configuration(), schemaVersion }),
      "UNSUPPORTED_VERSION",
    );
  for (const visibility of ["shared", "public", "PRIVATE", null])
    invalid(
      validatePlannerViewConfigurationV1({ ...configuration(), visibility }),
      "INVALID_VALUE",
    );
  for (const patch of [
    { kind: "engineo-project-configuration" },
    { owner: UUID },
    { ownerUserId: UUID },
    { audience: "team" },
    { organizationId: UUID },
    { projectId: UUID },
    { sessionId: UUID },
    { credentials: "inert" },
    { projectionVersion: 1 },
    { projectionVersion: 2 },
    { normalizationVersion: 1 },
    { normalizationVersion: 2 },
    { input: {} },
    { activityIds: [] },
  ])
    invalid(validatePlannerViewConfigurationV1({ ...configuration(), ...patch }));
  for (const extra of [
    "expression",
    "sql",
    "regex",
    "script",
    "jsx",
    "css",
    "template",
    "include",
    "extensions",
    "$schema",
    "url",
    "dataDate",
    "columnWidths",
  ])
    for (const path of [[], ["presentation"], ["presentation", "sort"]]) {
      const value = configuration() as unknown as Record<string, unknown>;
      let target = value;
      for (const key of path) target = target[key] as Record<string, unknown>;
      target[extra] = { nested: "inert" };
      invalid(validatePlannerViewConfigurationV1(value), "UNKNOWN_PROPERTY");
    }
});

test("name/search bounds are UTF-16 based with explicit controls and reserved Native", () => {
  for (const name of [
    "",
    " ",
    "Native",
    "native",
    "NATIVE",
    " nAtIvE ",
    "\u00a0Native\u00a0",
    "x".repeat(121),
    "😀".repeat(61),
    " ".repeat(121),
  ])
    invalid(validatePlannerViewConfigurationV1({ ...configuration(), name }), "INVALID_VALUE");
  for (const name of ["x".repeat(120), "😀".repeat(60), "漢".repeat(120), "Native view"])
    valid(validatePlannerViewConfigurationV1({ ...configuration(), name }));
  for (let code = 0; code <= 0x9f; code++) {
    if (code >= 0x20 && code < 0x7f) continue;
    const control = String.fromCharCode(code);
    invalid(
      validatePlannerViewConfigurationV1({ ...configuration(), name: `${control}View` }),
      "INVALID_VALUE",
    );
    const value = configuration();
    value.presentation.search = `A${control}B`;
    if (code === 9 || code === 10 || code === 13) valid(validatePlannerViewConfigurationV1(value));
    else invalid(validatePlannerViewConfigurationV1(value), "INVALID_VALUE");
  }
  for (const search of ["x".repeat(256), "😀".repeat(128), "漢".repeat(256), " \t\n\r "]) {
    const value = configuration();
    value.presentation.search = search;
    valid(validatePlannerViewConfigurationV1(value));
  }
  for (const search of ["x".repeat(257), "😀".repeat(129), " ".repeat(257)]) {
    const value = configuration();
    value.presentation.search = search;
    invalid(validatePlannerViewConfigurationV1(value), "INVALID_VALUE");
  }
});

test("UUID normalization is syntax-only and does not invent WBS existence/scope validation", () => {
  for (const wbsId of [UUID, UUID.toUpperCase(), "00000000-0000-0000-0000-000000000000", null]) {
    const value = configuration();
    value.presentation.wbsId = wbsId;
    assert.equal(
      valid(validatePlannerViewConfigurationV1(value)).normalizedConfiguration.presentation.wbsId,
      wbsId?.toLowerCase() ?? null,
    );
  }
  for (const wbsId of [
    "",
    ` ${UUID}`,
    `${UUID} `,
    "not-a-uuid",
    UUID.replaceAll("-", ""),
    1,
    undefined,
    {},
    [],
  ]) {
    const value = configuration();
    (value.presentation as unknown as Record<string, unknown>).wbsId = wbsId;
    invalid(validatePlannerViewConfigurationV1(value), "INVALID_VALUE");
  }
});

test("literal URL/code/template search content is preserved, never evaluated or fetched", () => {
  const literals = [
    "https://example.invalid/include.json",
    "javascript:alert(1)",
    `\${process.env.SECRET}`,
    "<script>alert(1)</script>",
    "SELECT * FROM activities",
    ".*",
    "{{activity.name}}",
    "../secret",
  ];
  for (const literal of literals) {
    const value = configuration();
    value.presentation.search = literal;
    assert.equal(
      valid(parsePlannerViewConfigurationV1(JSON.stringify(value))).normalizedConfiguration
        .presentation.search,
      literal,
    );
  }
});

test("decoded duplicate properties are rejected at every container before normalization", () => {
  for (const [from, to] of [
    ['"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1'],
    ['"name":"Critical by WBS"', '"name":"Critical by WBS","\\u006eame":"Other"'],
    ['"search":""', '"search":"","\\u0073earch":"other"'],
    ['"field":"earlyStart"', '"field":"earlyStart","fi\\u0065ld":"name"'],
    ['"direction":"asc"', '"direction":"asc","direction":"asc"'],
  ] as const)
    invalid(parsePlannerViewConfigurationV1(CANONICAL.replace(from, to)), "DUPLICATE_JSON_KEY");
  invalid(parsePlannerViewConfigurationV1('{"unknown":{"é":1,"\\u00e9":1}}'), "DUPLICATE_JSON_KEY");
  invalid(
    parsePlannerViewConfigurationV1('{"unknown":{"😀":1,"\\ud83d\\ude00":1}}'),
    "DUPLICATE_JSON_KEY",
  );
  invalid(parsePlannerViewConfigurationV1('{"unknown":{"e\\u0301":1,"é":1}}'), "UNKNOWN_PROPERTY");
  // An earlier malformed duplicate cannot disappear through a last-value-wins JSON parser.
  invalid(
    parsePlannerViewConfigurationV1(
      CANONICAL.replace('"name":"Critical by WBS"', '"name":true,"name":"Critical by WBS"'),
    ),
    "DUPLICATE_JSON_KEY",
  );
});

test("prototype-related keys reject encoded and direct sources without polluting objects", () => {
  for (const key of [
    "__proto__",
    "constructor",
    "prototype",
    "\\u005f_proto__",
    "constr\\u0075ctor",
  ])
    for (const source of [
      `{"${key}":{}}`,
      `{"presentation":{"${key}":{}}}`,
      `{"presentation":{"sort":{"${key}":{}}}}`,
    ])
      invalid(parsePlannerViewConfigurationV1(source), "UNSAFE_PROPERTY");
  for (const key of ["__proto__", "constructor", "prototype"])
    for (const path of [[], ["presentation"], ["presentation", "sort"]]) {
      const value = configuration() as unknown as Record<string, unknown>;
      let target = value;
      for (const field of path) target = target[field] as Record<string, unknown>;
      Object.defineProperty(target, key, { value: { polluted: true }, enumerable: true });
      invalid(validatePlannerViewConfigurationV1(value), "UNSAFE_PROPERTY");
    }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("nonplain prototypes, accessor, symbol and hidden fields are rejected without getters", () => {
  let calls = 0;
  for (const path of [[], ["presentation"], ["presentation", "sort"]]) {
    for (const descriptor of [
      {
        get: () => {
          calls++;
          throw new Error("Getter must not execute");
        },
        enumerable: true,
      },
      {
        set: () => {
          calls++;
        },
        enumerable: true,
      },
      { value: "inert", enumerable: false },
    ]) {
      const value = configuration() as unknown as Record<string, unknown>;
      let target = value;
      for (const field of path) target = target[field] as Record<string, unknown>;
      Object.defineProperty(target, Object.keys(target)[0] ?? "extra", descriptor);
      invalid(validatePlannerViewConfigurationV1(value), "INVALID_VALUE");
    }
    const accessor = configuration() as unknown as Record<string, unknown>;
    let target = accessor;
    for (const field of path) target = target[field] as Record<string, unknown>;
    Object.defineProperty(target, "unknown", {
      get: () => {
        calls++;
        return "inert";
      },
      enumerable: true,
    });
    invalid(validatePlannerViewConfigurationV1(accessor), "INVALID_VALUE");
    const symbol = configuration() as unknown as Record<string, unknown>;
    target = symbol;
    for (const field of path) target = target[field] as Record<string, unknown>;
    Object.defineProperty(target, Symbol("unknown"), { value: "inert", enumerable: true });
    invalid(validatePlannerViewConfigurationV1(symbol), "UNKNOWN_PROPERTY");
    const exotic = configuration() as unknown as Record<string, unknown>;
    target = exotic;
    for (const field of path) target = target[field] as Record<string, unknown>;
    Object.setPrototypeOf(target, { extra: "inherited" });
    invalid(validatePlannerViewConfigurationV1(exotic), "INVALID_VALUE");
  }
  const methods = {
    ...configuration(),
    toJSON: () => {
      calls++;
      return configuration();
    },
    toString: () => {
      calls++;
      return CANONICAL;
    },
  };
  invalid(validatePlannerViewConfigurationV1(methods), "UNKNOWN_PROPERTY");
  assert.equal(calls, 0);
  const nullPrototype = Object.assign(Object.create(null), configuration());
  nullPrototype.presentation = Object.assign(Object.create(null), nullPrototype.presentation);
  nullPrototype.presentation.sort = Object.assign(
    Object.create(null),
    nullPrototype.presentation.sort,
  );
  valid(validatePlannerViewConfigurationV1(nullPrototype));
  const revoked = Proxy.revocable(configuration(), {});
  revoked.revoke();
  invalid(validatePlannerViewConfigurationV1(revoked.proxy), "INVALID_VALUE");
});

test("JSON lexer rejects malformed grammar, numeric rounding and noncanonical version tokens", () => {
  for (const source of [
    "",
    " ",
    "undefined",
    "NaN",
    "Infinity",
    "null trailing",
    "{}{}",
    "{",
    "[",
    '{"x":}',
    '{"x" 1}',
    "{x:1}",
    '{"x":1,}',
    "[1,]",
    "//comment\n{}",
    "/*comment*/{}",
    "\uFEFF{}",
    '{"x":"line\nfeed"}',
    '{"x":"\\q"}',
    '{"x":"\\u123"}',
    '{"x":"unterminated}',
    '{"x":"\\"}',
  ])
    invalid(parsePlannerViewConfigurationV1(source), "INVALID_JSON");
  for (const token of [
    "1.0",
    "1e0",
    "1E+0",
    "1.00000000000000000001",
    "-0",
    "0.0",
    "1e9999",
    "1e-9999",
    "9007199254740993",
    "-9007199254740993",
    "01",
    "+1",
    ".1",
    "1.",
    "0x1",
    "1_0",
  ])
    invalid(
      parsePlannerViewConfigurationV1(
        CANONICAL.replace('"schemaVersion":1', `"schemaVersion":${token}`),
      ),
      "INVALID_JSON",
    );
  for (const source of ["null", "true", "false", "0", "-1", "9007199254740991", "[]", '"text"'])
    invalid(parsePlannerViewConfigurationV1(source), "INVALID_VALUE");
});

test("Unicode escape parsing accepts scalar pairs and rejects all unpaired surrogate placements", () => {
  for (const fragment of [
    "\\ud800",
    "\\udfff",
    "\\ud800x",
    "x\\udfff",
    "\\ud800\\ud800",
    "\\udfff\\ud800",
  ])
    for (const source of [CANONICAL.replace("Critical by WBS", fragment), `{"${fragment}":1}`])
      invalid(parsePlannerViewConfigurationV1(source), "INVALID_JSON");
  for (const fragment of ["\ud800", "\udfff", "x\ud800", "\udfffy"])
    invalid(
      parsePlannerViewConfigurationV1(CANONICAL.replace("Critical by WBS", fragment)),
      "INVALID_JSON",
    );
  for (const field of ["name", "search"] as const) {
    const value = configuration();
    if (field === "name") value.name = "\ud800";
    else value.presentation.search = "\udfff";
    invalid(validatePlannerViewConfigurationV1(value), "INVALID_VALUE");
  }
  for (const [literal, escaped] of [
    ["😀", "\\ud83d\\ude00"],
    ["é", "\\u00e9"],
    ["𝔘", "\\ud835\\udd18"],
    ["e\u0301", "e\\u0301"],
    ["\u2028\u2029", "\\u2028\\u2029"],
  ]) {
    const original = configuration();
    original.name = `View ${literal} X`;
    const source = CANONICAL.replace("Critical by WBS", `View ${escaped} X`);
    assert.equal(
      valid(parsePlannerViewConfigurationV1(source)).canonicalConfiguration,
      serializePlannerViewConfigurationV1(original),
    );
  }
  const escaped = CANONICAL.replace("Critical by WBS", 'quote\\" slash\\/ backslash\\\\');
  assert.equal(
    valid(parsePlannerViewConfigurationV1(escaped)).normalizedConfiguration.name,
    'quote" slash/ backslash\\',
  );
});

test("original malformed UTF-8 is rejected, including overlong, surrogate and truncated byte forms", () => {
  for (const bytes of [
    [0x80],
    [0xc0, 0xaf],
    [0xc1, 0xbf],
    [0xc2],
    [0xe0, 0x80, 0xaf],
    [0xe2, 0x82],
    [0xed, 0xa0, 0x80],
    [0xed, 0xbf, 0xbf],
    [0xf0, 0x80, 0x80, 0xaf],
    [0xf4, 0x90, 0x80, 0x80],
    [0xf5, 0x80, 0x80, 0x80],
    [0xff],
  ]) {
    invalid(parsePlannerViewConfigurationV1(Uint8Array.from(bytes)), "INVALID_UTF8");
    invalid(
      parsePlannerViewConfigurationV1(Uint8Array.from([0x22, ...bytes, 0x22])),
      "INVALID_UTF8",
    );
  }
  invalid(
    parsePlannerViewConfigurationV1(
      Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(CANONICAL)]),
    ),
    "INVALID_JSON",
  );
  const source = new TextEncoder().encode(CANONICAL);
  const container = new Uint8Array(source.length + 4);
  container.set(source, 2);
  assert.equal(
    valid(parsePlannerViewConfigurationV1(container.subarray(2, -2))).canonicalConfiguration,
    CANONICAL,
  );
  assert.equal(
    valid(parsePlannerViewConfigurationV1(Buffer.from(CANONICAL))).canonicalConfiguration,
    CANONICAL,
  );
});

test("byte transport uses actual internal byte length without calling user byteLength accessors", () => {
  let calls = 0;
  for (const bytes of [
    new TextEncoder().encode(CANONICAL),
    new Uint8Array(PLANNER_VIEW_MAX_BYTES + 1),
  ]) {
    Object.defineProperty(bytes, "byteLength", {
      get: () => {
        calls++;
        return 0;
      },
    });
    const result = parsePlannerViewConfigurationV1(bytes);
    if (bytes.length > PLANNER_VIEW_MAX_BYTES) invalid(result, "TRANSPORT_TOO_LARGE");
    else valid(result);
  }
  assert.equal(calls, 0);
  for (const source of [
    new Uint16Array([1]),
    new ArrayBuffer(1),
    new DataView(new ArrayBuffer(1)),
    null,
    1,
    {},
  ])
    invalid(parsePlannerViewConfigurationV1(source as string | Uint8Array), "INVALID_VALUE");
  const revoked = Proxy.revocable(new Uint8Array(1), {});
  revoked.revoke();
  invalid(parsePlannerViewConfigurationV1(revoked.proxy), "INVALID_VALUE");
});

test("8 KiB limit is on original UTF-8 bytes including padding/escapes, not compacted JSON", () => {
  const padding = PLANNER_VIEW_MAX_BYTES - new TextEncoder().encode(CANONICAL).byteLength;
  const exact = CANONICAL + " ".repeat(padding);
  valid(parsePlannerViewConfigurationV1(exact));
  valid(parsePlannerViewConfigurationV1(new TextEncoder().encode(exact)));
  invalid(parsePlannerViewConfigurationV1(`${exact} `), "TRANSPORT_TOO_LARGE");
  invalid(
    parsePlannerViewConfigurationV1(new TextEncoder().encode(`${exact} `)),
    "TRANSPORT_TOO_LARGE",
  );
  const oversized = new Uint8Array(PLANNER_VIEW_MAX_BYTES + 1).fill(0xff);
  invalid(parsePlannerViewConfigurationV1(oversized), "TRANSPORT_TOO_LARGE");
  const unicodeBytes = `"${"漢".repeat(Math.floor(PLANNER_VIEW_MAX_BYTES / 3) + 1)}"`;
  assert.ok(unicodeBytes.length < PLANNER_VIEW_MAX_BYTES);
  invalid(parsePlannerViewConfigurationV1(unicodeBytes), "TRANSPORT_TOO_LARGE");
  const escapedPadding = `${CANONICAL.slice(0, -1)},"${"\\u0061".repeat(1400)}":0}`;
  invalid(parsePlannerViewConfigurationV1(escapedPadding), "TRANSPORT_TOO_LARGE");
});

test("nesting is bounded at eight containers even under unknown fields and mixed arrays", () => {
  const within = `${"[".repeat(PLANNER_VIEW_MAX_DEPTH)}null${"]".repeat(PLANNER_VIEW_MAX_DEPTH)}`;
  invalid(parsePlannerViewConfigurationV1(within), "INVALID_VALUE");
  const excess = `${"[".repeat(PLANNER_VIEW_MAX_DEPTH + 1)}null${"]".repeat(PLANNER_VIEW_MAX_DEPTH + 1)}`;
  invalid(parsePlannerViewConfigurationV1(excess), "MAX_DEPTH_EXCEEDED");
  const nested = `${'{"x":'.repeat(PLANNER_VIEW_MAX_DEPTH + 1)}null${"}".repeat(PLANNER_VIEW_MAX_DEPTH + 1)}`;
  invalid(parsePlannerViewConfigurationV1(nested), "MAX_DEPTH_EXCEEDED");
  const cycle = configuration();
  Object.assign(cycle.presentation.sort, { unknown: cycle });
  invalid(validatePlannerViewConfigurationV1(cycle), "UNKNOWN_PROPERTY");
});

test("diagnostics count all found issues but bound issue lists and well-formed text", () => {
  const value = configuration() as unknown as Record<string, unknown>;
  for (let index = 0; index < 30; index++) value[`unknown${index}`] = null;
  const diagnostics = invalid(validatePlannerViewConfigurationV1(value), "UNKNOWN_PROPERTY");
  assert.equal(diagnostics.totalCount, 30);
  assert.equal(diagnostics.issues.length, 20);
  assert.equal(diagnostics.truncated, true);
  const longKey = `${"x".repeat(250)}😀${"x".repeat(100)}`;
  const long = invalid(
    validatePlannerViewConfigurationV1({ ...configuration(), [longKey]: null }),
    "UNKNOWN_PROPERTY",
  );
  assert.equal(long.totalCount, 1);
  assert.equal(long.truncated, false);
  assert.ok(long.issues[0]?.path.endsWith("..."));
  const unusual = invalid(
    validatePlannerViewConfigurationV1({ ...configuration(), 'one.two["three"]': null }),
  );
  assert.equal(unusual.issues[0]?.path, '["one.two[\\"three\\"]"]');
  const lexical = invalid(
    parsePlannerViewConfigurationV1(`{"${"x".repeat(500)}":1,"${"x".repeat(500)}":2}`),
    "DUPLICATE_JSON_KEY",
  );
  assert.equal(lexical.totalCount, 1);
  assert.equal(lexical.truncated, false);
});

function* permutations(keys: readonly string[]): Generator<string[]> {
  if (keys.length === 0) {
    yield [];
    return;
  }
  for (const [index, key] of keys.entries())
    for (const rest of permutations(keys.filter((_, other) => index !== other)))
      yield [key, ...rest];
}

test("all 842 individual object-field permutations and alternate JSON escapes have identical bytes", () => {
  let count = 0;
  for (const path of [[], ["presentation"], ["presentation", "sort"]]) {
    const source = configuration() as unknown as Record<string, unknown>;
    let object = source;
    for (const key of path) object = object[key] as Record<string, unknown>;
    for (const order of permutations(Object.keys(object))) {
      const reordered = Object.fromEntries(order.map((key) => [key, object[key]]));
      const candidate = configuration() as unknown as Record<string, unknown>;
      let parent = candidate;
      for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
      const key = path.at(-1);
      if (key) parent[key] = reordered;
      const value = key ? candidate : reordered;
      const result = valid(parsePlannerViewConfigurationV1(JSON.stringify(value)));
      assert.equal(result.canonicalConfiguration, CANONICAL);
      assert.equal(result.hashPreimage, PREIMAGE);
      count++;
    }
  }
  assert.equal(count, 842);
  const escaped = CANONICAL.replace("Critical by WBS", "\\u0043ritical by WBS").replace(
    '"search"',
    '"\\u0073earch"',
  );
  assert.equal(valid(parsePlannerViewConfigurationV1(escaped)).canonicalConfiguration, CANONICAL);
});

test("serializers reject invalid configuration rather than dropping or coercing unsupported fields", () => {
  for (const value of [
    { ...configuration(), name: "Native" },
    { ...configuration(), visibility: "shared" },
    { ...configuration(), normalizationVersion: 2 },
    { ...configuration(), projectionVersion: 2 },
    { ...configuration(), unknown: true },
  ])
    for (const serialize of [
      serializePlannerViewConfigurationV1,
      serializePlannerViewHashPreimageV1,
    ])
      assert.throws(
        () => serialize(value as PlannerViewConfigurationV1),
        PlannerViewConfigurationError,
      );
  assert.equal(
    validatePlannerPresentationV1({
      ...NATIVE_PLANNER_PRESENTATION_V1,
      sort: { field: "native", direction: "desc" },
    }).valid,
    false,
  );
  const mutable: PlannerPresentationV1 = {
    ...NATIVE_PLANNER_PRESENTATION_V1,
    sort: { field: "name", direction: "desc" },
  };
  assert.equal(validatePlannerPresentationV1(mutable).valid, true);
});
