import assert from "node:assert/strict";
import test from "node:test";
import {
  diffProjectConfigurationV1,
  MAX_WORK_MINUTES,
  parseConfigurationJsonV1,
  parseProjectConfigurationV1,
  parseProjectConfigurationReviewJsonV1,
  PROJECT_CONFIGURATION_MAX_ARTIFACT_BYTES,
  PROJECT_CONFIGURATION_MAX_BYTES,
  PROJECT_CONFIGURATION_MAX_DEPTH,
  PROJECT_CONFIGURATION_MAX_DIAGNOSTICS,
  PROJECT_CONFIGURATION_MAX_DIAGNOSTIC_TEXT_LENGTH,
  PROJECT_CONFIGURATION_MAX_DIFF_BYTES,
  PROJECT_CONFIGURATION_MAX_REVIEW_BYTES,
  ProjectConfigurationError,
  type ProjectConfigurationIssueCode,
  type ProjectConfigurationV1,
  type ProjectConfigurationPlanV1,
  type ProjectConfigurationReceiptV1,
  type ProjectConfigurationPlanReadV1,
  type ProjectConfigurationReadV1,
  relationshipConfigurationKeyV1,
  serializeScheduleInputV1,
  serializeProjectConfigurationReviewV1,
  validateProjectConfigurationV1,
  validateProjectConfigurationPlanV1,
  validateProjectConfigurationReceiptV1,
  validateProjectConfigurationReadV1,
  validateProjectConfigurationPlanReadV1,
} from "./index.js";
function present<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value as T;
}

const PROJECT = "00000000-0000-0000-0000-000000000001";
const CALENDAR = "00000000-0000-0000-0000-000000000002";
const ROOT = "00000000-0000-0000-0000-000000000003";
const FIRST = "abcdefab-abcd-abcd-abcd-000000000004";
const SECOND = "00000000-0000-0000-0000-000000000005";
const uuid = (index: number) => `10000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`;
function configuration(): ProjectConfigurationV1 {
  const day = [
    { start: "08:00", end: "12:00" },
    { start: "13:00", end: "17:00" },
  ];
  return {
    schemaVersion: 1,
    kind: "engineo-project-configuration",
    scope: "schedule",
    input: {
      schemaVersion: 1,
      project: {
        id: PROJECT,
        name: "  Native project text  ",
        plannedStart: "2026-10-05T08:00:00+09:00",
        dataDate: "2026-10-05T00:00:00.12Z",
        requiredFinish: null,
        defaultCalendarId: CALENDAR,
      },
      scheduleOptions: {
        criticalFloatThresholdMinutes: 0,
        lagCalendarPolicy: "SUCCESSOR",
        projectFinishPolicy: "CALCULATED",
      },
      calendars: [
        {
          id: CALENDAR,
          name: "Standard",
          timeZone: "Asia/Tokyo",
          week: {
            MONDAY: [...day],
            TUESDAY: [...day],
            WEDNESDAY: [...day],
            THURSDAY: [...day],
            FRIDAY: [...day],
            SATURDAY: [],
            SUNDAY: [],
          },
          exceptions: [
            { date: "2026-12-25", workingIntervals: [] },
            { date: "2026-12-24", workingIntervals: [...day] },
          ],
        },
      ],
      wbs: [{ id: ROOT, parentId: null, code: "1", name: "Root", sortOrder: 0 }],
      activities: [
        {
          id: FIRST,
          wbsId: ROOT,
          name: "Start",
          kind: "START_MILESTONE",
          durationMinutes: 0,
          calendarId: CALENDAR,
          constraints: [],
        },
        {
          id: SECOND,
          wbsId: ROOT,
          name: "Work",
          kind: "TASK",
          durationMinutes: 2400,
          calendarId: CALENDAR,
          constraints: [
            { type: "FINISH_ON_OR_BEFORE", instant: "2026-10-09T17:00:00.123456789+09:00" },
            { type: "START_ON_OR_AFTER", instant: "2026-10-05T08:00:00+09:00" },
          ],
        },
      ],
      relationships: [{ predecessorId: FIRST, successorId: SECOND, type: "FS", lagMinutes: -10 }],
    },
  };
}
function valid(value = configuration()) {
  const result = validateProjectConfigurationV1(value);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.ok(result.valid);
  return result;
}
function hasIssue(value: unknown, code: ProjectConfigurationIssueCode, path?: string): void {
  const result = validateProjectConfigurationV1(value);
  assert.equal(result.valid, false);
  assert.ok(
    result.diagnostics.issues.some(
      (issue) => issue.code === code && (path === undefined || issue.path === path),
    ),
    JSON.stringify(result.diagnostics),
  );
  assert.equal(result.calculationChecked, false);
  assert.equal(Object.hasOwn(result, "normalizedInput"), false);
  assert.equal(Object.hasOwn(result, "canonicalInput"), false);
}
function parseIssue(source: string, code: ProjectConfigurationIssueCode): void {
  const result = parseProjectConfigurationV1(source);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.issues[0]?.code, code);
}
function errorCode(error: unknown, code: ProjectConfigurationIssueCode): boolean {
  return (
    error instanceof ProjectConfigurationError &&
    error.code === code &&
    error.diagnostics.totalCount === 1
  );
}
test("configuration normalization uses native UUID semantics and unchanged canonical schedule bytes", () => {
  const original = configuration();
  present(original.input.activities[0]).id = FIRST.toUpperCase();
  present(original.input.relationships[0]).predecessorId = FIRST.toUpperCase();
  original.input.project.requiredFinish = "2026-12-01T12:45:01.1-08:00";
  const untouched = structuredClone(original);
  const result = valid(original);
  assert.deepEqual(original, untouched);
  assert.equal(
    result.normalizedInput.activities.find((activity) => activity.name === "Start")?.id,
    FIRST,
  );
  assert.equal(result.normalizedInput.project.plannedStart, "2026-10-04T23:00:00.000Z");
  assert.equal(result.normalizedInput.project.dataDate, "2026-10-05T00:00:00.120Z");
  assert.equal(result.normalizedInput.project.requiredFinish, "2026-12-01T20:45:01.100Z");
  assert.equal(result.normalizedInput.project.name, "  Native project text  ");
  assert.deepEqual(
    result.normalizedInput.activities
      .find((activity) => activity.name === "Work")
      ?.constraints.map((constraint) => constraint.instant)
      .sort(),
    present(original.input.activities[1])
      .constraints.map((constraint) => constraint.instant)
      .sort(),
  );
  assert.equal(result.canonicalInput, serializeScheduleInputV1(result.normalizedInput));
  assert.deepEqual(result.diagnostics, { issues: [], totalCount: 0, truncated: false });
  assert.equal(result.calculationChecked, false);
  const parsed = parseProjectConfigurationV1(JSON.stringify(original));
  assert.ok(parsed.valid);
  assert.equal(parsed.canonicalInput, result.canonicalInput);
  present(present(result.normalizedInput.calendars[0]).week.MONDAY[0]).start = "09:00";
  assert.deepEqual(original, untouched, "nested candidate values must not alias caller values");
});
test("strict generic JSON parser accepts ordinary JSON and never invokes special object keys", () => {
  const parsed = parseConfigurationJsonV1(
    ' \n{"string":"quote \\" \\\\ \\u0061 😀","number":-1.5e2,"values":[true,false,null,{}],"__proto__":{"polluted":true}}\t',
  );
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), {
    string: 'quote " \\ a 😀',
    number: -150,
    values: [true, false, null, {}],
    ["__proto__"]: { polluted: true },
  });
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});
test("strict parsing rejects duplicate decoded keys at every nesting level", () => {
  for (const source of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"outer":[{"x":false,"x":false}]}',
    '{"__proto__":1,"__proto__":2}',
  ]) {
    assert.throws(
      () => parseConfigurationJsonV1(source),
      (error) => errorCode(error, "DUPLICATE_JSON_KEY"),
    );
    parseIssue(source, "DUPLICATE_JSON_KEY");
  }
  parseIssue(
    JSON.stringify(configuration()).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    ),
    "DUPLICATE_JSON_KEY",
  );
});
test("strict JSON grammar rejects malformed, non-JSON, overflow and invalid Unicode", () => {
  for (const source of [
    "",
    "undefined",
    "NaN",
    "Infinity",
    "1e999",
    "+1",
    "01",
    "1.",
    "1e",
    "true false",
    "nullx",
    "[1,]",
    "[,1]",
    "{a:1}",
    '{"a":1,}',
    '{"a" 1}',
    '{"a":}',
    '"unterminated',
    '"bad\\x"',
    '"bad\n"',
    '"\\uD800"',
    '"\\uDC00"',
    '"\ud800"',
    "\uFEFF{}",
    "{} //comment",
    "/*comment*/{}",
  ]) {
    assert.throws(
      () => parseConfigurationJsonV1(source),
      (error) => errorCode(error, "INVALID_JSON"),
      source,
    );
    parseIssue(source, "INVALID_JSON");
  }
  assert.equal(parseConfigurationJsonV1('"\\uD83D\\uDE00"'), "😀");
});
test("transport bound uses UTF-8 bytes and accepts the exact limit", () => {
  const exact = `"${"x".repeat(PROJECT_CONFIGURATION_MAX_BYTES - 2)}"`;
  assert.equal(Buffer.byteLength(exact), PROJECT_CONFIGURATION_MAX_BYTES);
  assert.equal(
    (parseConfigurationJsonV1(exact) as string).length,
    PROJECT_CONFIGURATION_MAX_BYTES - 2,
  );
  assert.throws(
    () => parseConfigurationJsonV1(`${exact} `),
    (error) => errorCode(error, "TRANSPORT_TOO_LARGE"),
  );
  const unicode = `"${"😀".repeat(PROJECT_CONFIGURATION_MAX_BYTES / 4)}"`;
  assert.ok(unicode.length < PROJECT_CONFIGURATION_MAX_BYTES);
  parseIssue(unicode, "TRANSPORT_TOO_LARGE");
});
test("container nesting is bounded before recursion and includes the root", () => {
  assert.equal(PROJECT_CONFIGURATION_MAX_DEPTH, 32);
  const nested = (depth: number) => `${"[".repeat(depth)}0${"]".repeat(depth)}`;
  assert.doesNotThrow(() => parseConfigurationJsonV1(nested(PROJECT_CONFIGURATION_MAX_DEPTH)));
  assert.throws(
    () => parseConfigurationJsonV1(nested(PROJECT_CONFIGURATION_MAX_DEPTH + 1)),
    (error) => errorCode(error, "MAX_DEPTH_EXCEEDED"),
  );
  parseIssue(nested(20000), "MAX_DEPTH_EXCEEDED");
});
test("every configuration object rejects unknown properties recursively", () => {
  const paths = [
    [],
    ["input"],
    ["input", "project"],
    ["input", "scheduleOptions"],
    ["input", "calendars", 0],
    ["input", "calendars", 0, "week"],
    ["input", "calendars", 0, "week", "MONDAY", 0],
    ["input", "calendars", 0, "exceptions", 1],
    ["input", "calendars", 0, "exceptions", 1, "workingIntervals", 0],
    ["input", "wbs", 0],
    ["input", "activities", 1],
    ["input", "activities", 1, "constraints", 0],
    ["input", "relationships", 0],
  ];
  for (const path of paths) {
    const value: unknown = configuration();
    let target = value as Record<string | number, unknown>;
    for (const component of path) target = target[component] as Record<string | number, unknown>;
    target.extra = "reject";
    hasIssue(value, "UNKNOWN_PROPERTY");
  }
  const malicious = JSON.stringify(configuration()).replace('"kind":', '"__proto__":{},"kind":');
  parseIssue(malicious, "UNKNOWN_PROPERTY");
});
test("configuration is complete and versions/kind/scope are explicit", () => {
  for (const value of [null, [], 1, "configuration", new Date(), undefined])
    hasIssue(value, "INVALID_VALUE");
  const value = configuration() as unknown as Record<string, unknown>;
  delete value.input;
  hasIssue(value, "MISSING_PROPERTY", "input");
  for (const version of [0, 2, "1", null]) {
    const value = configuration();
    (value as unknown as Record<string, unknown>).schemaVersion = version;
    hasIssue(value, "INVALID_SCHEMA_VERSION", "schemaVersion");
    const nested = configuration();
    (nested.input as unknown as Record<string, unknown>).schemaVersion = version;
    hasIssue(nested, "INVALID_SCHEMA_VERSION", "input.schemaVersion");
  }
  for (const field of ["kind", "scope"] as const) {
    const value = configuration();
    (value as unknown as Record<string, unknown>)[field] = "unknown";
    hasIssue(value, "INVALID_VALUE", field);
  }
  const missing = configuration();
  delete (missing.input.activities[1] as unknown as Record<string, unknown>).constraints;
  hasIssue(missing, "MISSING_PROPERTY", "input.activities[1].constraints");
  const accessor = configuration();
  let invoked = false;
  Object.defineProperty(accessor, "input", {
    enumerable: true,
    get: () => {
      invoked = true;
      return configuration().input;
    },
  });
  hasIssue(accessor, "INVALID_VALUE", "input");
  assert.equal(invoked, false);
});
test("native identifiers and lowercase collisions are rejected across all references", () => {
  const paths: (string | number)[][] = [
    ["project", "id"],
    ["project", "defaultCalendarId"],
    ["calendars", 0, "id"],
    ["wbs", 0, "id"],
    ["wbs", 0, "parentId"],
    ["activities", 0, "id"],
    ["activities", 0, "wbsId"],
    ["activities", 0, "calendarId"],
    ["relationships", 0, "predecessorId"],
    ["relationships", 0, "successorId"],
  ];
  for (const path of paths) {
    const value = configuration();
    let parent = value.input as unknown as Record<string | number, unknown>;
    for (const component of path.slice(0, -1))
      parent = parent[component] as Record<string | number, unknown>;
    parent[present(path.at(-1))] = "not-native";
    hasIssue(value, "INVALID_UUID");
  }
  for (const kind of ["calendars", "wbs", "activities"] as const) {
    const value = configuration();
    const array = value.input[kind];
    const first = structuredClone(present(array[0]));
    first.id = first.id.toUpperCase();
    (
      array as {
        id: string;
      }[]
    ).push(first);
    hasIssue(value, "DUPLICATE_ID");
  }
  const references = configuration();
  present(references.input.activities[0]).id = FIRST.toUpperCase();
  assert.ok(valid(references));
});
test("WBS codes and relationship identity tuples have native uniqueness", () => {
  const wbs = configuration();
  wbs.input.wbs.push({ ...present(wbs.input.wbs[0]), id: uuid(1) });
  hasIssue(wbs, "DUPLICATE_WBS_CODE");
  present(wbs.input.wbs[1]).code = "1 ";
  assert.ok(valid(wbs), "text/code are not trimmed or case-folded");
  const relationships = configuration();
  relationships.input.relationships.push({
    ...present(relationships.input.relationships[0]),
    predecessorId: FIRST.toUpperCase(),
  });
  hasIssue(relationships, "DUPLICATE_RELATIONSHIP");
  present(relationships.input.relationships[1]).lagMinutes++;
  assert.ok(valid(relationships), "different lags have different relationship identities");
  present(relationships.input.relationships[1]).lagMinutes--;
  present(relationships.input.relationships[1]).type = "SS";
  assert.ok(valid(relationships));
  assert.equal(
    relationshipConfigurationKeyV1(present(relationships.input.relationships[0])),
    relationshipConfigurationKeyV1({
      ...present(relationships.input.relationships[0]),
      predecessorId: FIRST.toUpperCase(),
    }),
  );
});
test("existing references, calendars, graph and schedule semantics remain enforced", () => {
  const cases: [ProjectConfigurationIssueCode, (value: ProjectConfigurationV1) => void][] = [
    [
      "MISSING_REFERENCE",
      (value) => {
        value.input.project.defaultCalendarId = uuid(100);
      },
    ],
    [
      "MISSING_REFERENCE",
      (value) => {
        present(value.input.wbs[0]).parentId = uuid(100);
      },
    ],
    [
      "MISSING_REFERENCE",
      (value) => {
        present(value.input.activities[1]).wbsId = uuid(100);
      },
    ],
    [
      "MISSING_REFERENCE",
      (value) => {
        present(value.input.activities[1]).calendarId = uuid(100);
      },
    ],
    [
      "MISSING_REFERENCE",
      (value) => {
        present(value.input.relationships[0]).successorId = uuid(100);
      },
    ],
    [
      "INVALID_TIME_ZONE",
      (value) => {
        present(value.input.calendars[0]).timeZone = "Mars/Olympus";
      },
    ],
    [
      "INVALID_WORK_INTERVAL",
      (value) => {
        present(present(value.input.calendars[0]).week.MONDAY[0]).end = "08:00";
      },
    ],
    [
      "INVALID_WORK_INTERVAL",
      (value) => {
        present(present(value.input.calendars[0]).week.MONDAY[1]).start = "11:00";
      },
    ],
    [
      "INVALID_WORK_INTERVAL",
      (value) => {
        present(
          present(present(value.input.calendars[0]).exceptions[1]).workingIntervals[0],
        ).start = "24:00";
      },
    ],
    [
      "DUPLICATE_EXCEPTION_DATE",
      (value) => {
        present(present(value.input.calendars[0]).exceptions[1]).date = "2026-12-25";
      },
    ],
    [
      "INVALID_INSTANT",
      (value) => {
        present(present(value.input.calendars[0]).exceptions[1]).date = "2026-02-30";
      },
    ],
    [
      "WBS_CYCLE",
      (value) => {
        present(value.input.wbs[0]).parentId = ROOT;
      },
    ],
    [
      "SELF_RELATIONSHIP",
      (value) => {
        present(value.input.relationships[0]).successorId = FIRST;
      },
    ],
    [
      "RELATIONSHIP_CYCLE",
      (value) => {
        value.input.relationships.push({
          predecessorId: SECOND,
          successorId: FIRST,
          type: "SS",
          lagMinutes: 0,
        });
      },
    ],
    [
      "INVALID_MILESTONE_DURATION",
      (value) => {
        present(value.input.activities[0]).durationMinutes = 1;
      },
    ],
    [
      "MISSING_REQUIRED_FINISH",
      (value) => {
        value.input.scheduleOptions.projectFinishPolicy = "REQUIRED_FINISH";
      },
    ],
    [
      "INVALID_INSTANT",
      (value) => {
        present(present(value.input.activities[1]).constraints[0]).instant = "2026-02-30T08:00:00Z";
      },
    ],
  ];
  for (const [code, mutate] of cases) {
    const value = configuration();
    mutate(value);
    hasIssue(value, code);
  }
});
test("project instants normalize without rounding and constraints preserve validated text", () => {
  for (const field of ["plannedStart", "dataDate", "requiredFinish"] as const) {
    for (const invalid of [
      "2026-02-30T08:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:00:00+24:00",
    ]) {
      const value = configuration();
      value.input.project[field] = invalid;
      hasIssue(value, "INVALID_INSTANT", `input.project.${field}`);
    }
    for (const precision of ["0000", "1234", "123456789"]) {
      const value = configuration();
      value.input.project[field] = `2026-01-01T00:00:00.${precision}Z`;
      hasIssue(value, "EXCESS_INSTANT_PRECISION", `input.project.${field}`);
    }
    for (const [source, expected] of [
      ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z"],
      ["2026-01-01T00:00:00.1Z", "2026-01-01T00:00:00.100Z"],
      ["2026-01-01T00:00:00.12Z", "2026-01-01T00:00:00.120Z"],
      ["2026-01-01T00:00:00.123+01:30", "2025-12-31T22:30:00.123Z"],
    ]) {
      const value = configuration();
      value.input.project[field] = present(source);
      assert.equal(valid(value).normalizedInput.project[field], expected);
    }
  }
  for (const instant of [
    "0000-01-01T00:00:00Z",
    "0001-01-01T00:00:00+01:00",
    "9999-12-31T23:59:59-01:00",
  ]) {
    const value = configuration();
    value.input.project.plannedStart = instant;
    hasIssue(value, "INVALID_INSTANT");
  }
  const value = configuration();
  present(present(value.input.activities[1]).constraints[0]).instant =
    "2026-01-01T00:00:00.123456789-05:00";
  assert.equal(
    present(
      present(
        valid(value).normalizedInput.activities.find((activity) => activity.id === SECOND),
      ).constraints.find((constraint) => constraint.type === "FINISH_ON_OR_BEFORE"),
    ).instant,
    present(present(value.input.activities[1]).constraints[0]).instant,
  );
  present(present(value.input.activities[1]).constraints[0]).instant =
    "2026-01-01T00:00:00.1234567890Z";
  hasIssue(value, "INVALID_VALUE");
});
test("native value and entity bounds match the normal persistence surface", () => {
  const mutations: ((value: ProjectConfigurationV1) => void)[] = [
    (value) => {
      value.input.project.name = " ";
    },
    (value) => {
      value.input.project.name = "x".repeat(501);
    },
    (value) => {
      value.input.project.name = "NUL\0name";
    },
    (value) => {
      present(value.input.wbs[0]).code = "x".repeat(101);
    },
    (value) => {
      present(value.input.wbs[0]).sortOrder = MAX_WORK_MINUTES + 1;
    },
    (value) => {
      present(value.input.activities[1]).durationMinutes = -1;
    },
    (value) => {
      present(value.input.activities[1]).durationMinutes = MAX_WORK_MINUTES + 1;
    },
    (value) => {
      present(value.input.activities[1]).durationMinutes = 1.5;
    },
    (value) => {
      present(value.input.activities[1]).durationMinutes = Number.NaN;
    },
    (value) => {
      present(value.input.relationships[0]).lagMinutes = -(MAX_WORK_MINUTES + 1);
    },
    (value) => {
      value.input.scheduleOptions.criticalFloatThresholdMinutes = MAX_WORK_MINUTES + 1;
    },
    (value) => {
      value.input.calendars = [];
    },
    (value) => {
      value.input.wbs = [];
    },
    (value) => {
      value.input.calendars = Array.from({ length: 101 }, () => present(value.input.calendars[0]));
    },
    (value) => {
      value.input.activities = Array.from({ length: 10001 }, () =>
        present(value.input.activities[0]),
      );
    },
    (value) => {
      value.input.relationships = Array.from({ length: 80001 }, () =>
        present(value.input.relationships[0]),
      );
    },
    (value) => {
      present(value.input.calendars[0]).week.MONDAY = Array.from({ length: 25 }, () => ({
        start: "08:00",
        end: "09:00",
      }));
    },
    (value) => {
      present(value.input.calendars[0]).exceptions = Array.from({ length: 3661 }, () => ({
        date: "2026-01-01",
        workingIntervals: [],
      }));
    },
    (value) => {
      present(value.input.activities[1]).constraints = Array.from({ length: 17 }, () => ({
        type: "START_ON_OR_AFTER",
        instant: "2026-01-01T00:00:00Z",
      }));
    },
  ];
  for (const mutate of mutations) {
    const value = configuration();
    mutate(value);
    hasIssue(value, "INVALID_VALUE");
  }
  for (const kind of ["kind", "type"] as const) {
    const value = configuration();
    if (kind === "kind")
      (value.input.activities[1] as unknown as Record<string, unknown>).kind = "INVALID";
    else (value.input.relationships[0] as unknown as Record<string, unknown>).type = "INVALID";
    hasIssue(value, "INVALID_VALUE");
  }
  for (const lag of [-MAX_WORK_MINUTES, MAX_WORK_MINUTES]) {
    const value = configuration();
    present(value.input.relationships[0]).lagMinutes = lag;
    assert.ok(valid(value));
  }
});
test("diagnostics are capped but retain complete counts and fail closed", () => {
  const value = configuration() as unknown as Record<string, unknown>;
  for (let i = 0; i < 137; i++) value[`unknown${i}`] = i;
  const result = validateProjectConfigurationV1(value);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.issues.length, PROJECT_CONFIGURATION_MAX_DIAGNOSTICS);
  assert.equal(result.diagnostics.totalCount, 137);
  assert.equal(result.diagnostics.truncated, true);
  const semantic = configuration();
  semantic.input.activities = Array.from({ length: 150 }, (_, index) => ({
    ...present(semantic.input.activities[1]),
    id: uuid(index),
    wbsId: uuid(200),
  }));
  semantic.input.relationships = [];
  const many = validateProjectConfigurationV1(semantic);
  assert.equal(many.valid, false);
  assert.equal(many.diagnostics.totalCount, 150);
  assert.equal(many.diagnostics.issues.length, 100);
  assert.equal(many.diagnostics.truncated, true);
});
function permute(value: ProjectConfigurationV1): ProjectConfigurationV1 {
  const result = structuredClone(value);
  for (const collection of [
    result.input.calendars,
    result.input.wbs,
    result.input.activities,
    result.input.relationships,
  ])
    collection.reverse();
  for (const calendar of result.input.calendars) {
    calendar.exceptions.reverse();
    for (const intervals of Object.values(calendar.week)) intervals.reverse();
    for (const exception of calendar.exceptions) exception.workingIntervals.reverse();
  }
  for (const activity of result.input.activities) activity.constraints.reverse();
  return result;
}
test("all non-ordering configuration arrays canonicalize as sets and yield a no-op", () => {
  const first = configuration();
  first.input.calendars.push({
    ...structuredClone(present(first.input.calendars[0])),
    id: uuid(1),
  });
  first.input.wbs.push({
    ...present(first.input.wbs[0]),
    id: uuid(2),
    parentId: ROOT,
    code: "2",
    sortOrder: 1,
  });
  first.input.relationships.push({
    ...present(first.input.relationships[0]),
    type: "SS",
    lagMinutes: 10,
  });
  const original = valid(first),
    shuffled = valid(permute(first));
  assert.equal(original.canonicalInput, shuffled.canonicalInput);
  const diff = diffProjectConfigurationV1(original.normalizedInput, shuffled.normalizedInput);
  assert.deepEqual(diff, { changes: [], noOp: true, serializedDiff: "[]\n" });
  const offset = structuredClone(first);
  offset.input.project.plannedStart = "2026-10-04T23:00:00.000Z";
  present(offset.input.activities[0]).id = FIRST.toUpperCase();
  assert.equal(
    diffProjectConfigurationV1(original.normalizedInput, valid(offset).normalizedInput).noOp,
    true,
  );
});
test("complete deterministic diffs include all create/update/delete values and tuple identity", () => {
  const original = configuration();
  original.input.calendars.push({
    ...structuredClone(present(original.input.calendars[0])),
    id: uuid(1),
    name: "Removed",
  });
  original.input.wbs.push({
    ...present(original.input.wbs[0]),
    id: uuid(2),
    code: "removed",
    parentId: ROOT,
  });
  original.input.activities.push({
    ...present(original.input.activities[1]),
    id: uuid(3),
    wbsId: uuid(2),
    calendarId: uuid(1),
    name: "Removed",
  });
  original.input.relationships.push({
    predecessorId: FIRST,
    successorId: uuid(3),
    type: "SS",
    lagMinutes: 0,
  });
  const candidate = structuredClone(original);
  candidate.input.project.name = "Changed project";
  candidate.input.scheduleOptions.criticalFloatThresholdMinutes = 60;
  candidate.input.calendars = candidate.input.calendars.filter((value) => value.id !== uuid(1));
  present(candidate.input.calendars[0]).name = "Changed calendar";
  candidate.input.calendars.push({
    ...structuredClone(present(candidate.input.calendars[0])),
    id: uuid(4),
    name: "Created",
  });
  candidate.input.wbs = candidate.input.wbs.filter((value) => value.id !== uuid(2));
  present(candidate.input.wbs[0]).name = "Changed root";
  candidate.input.wbs.push({
    ...present(candidate.input.wbs[0]),
    id: uuid(5),
    code: "created",
    parentId: ROOT,
  });
  candidate.input.activities = candidate.input.activities.filter((value) => value.id !== uuid(3));
  present(candidate.input.activities[1]).name = "Changed activity";
  candidate.input.activities.push({
    ...present(candidate.input.activities[1]),
    id: uuid(6),
    name: "Created",
    wbsId: uuid(5),
    calendarId: uuid(4),
  });
  candidate.input.relationships = [
    { ...present(candidate.input.relationships[0]), lagMinutes: 1 },
    { predecessorId: FIRST, successorId: uuid(6), type: "SS", lagMinutes: 0 },
  ];
  const base = valid(original).normalizedInput,
    desired = valid(candidate).normalizedInput;
  const untouchedBase = structuredClone(base),
    untouchedDesired = structuredClone(desired);
  const diff = diffProjectConfigurationV1(base, desired);
  assert.equal(diff.noOp, false);
  assert.equal(diff.changes.length, 15);
  assert.deepEqual(JSON.parse(diff.serializedDiff), diff.changes);
  const operations = diff.changes.map((change) => `${change.entity}:${change.operation}`).sort();
  assert.deepEqual(
    operations,
    [
      "project:update",
      "scheduleOptions:update",
      "calendar:create",
      "calendar:update",
      "calendar:delete",
      "wbs:create",
      "wbs:update",
      "wbs:delete",
      "activity:create",
      "activity:update",
      "activity:delete",
      "relationship:create",
      "relationship:create",
      "relationship:delete",
      "relationship:delete",
    ].sort(),
  );
  for (const change of diff.changes) {
    assert.equal(Object.hasOwn(change, "before"), true);
    assert.equal(Object.hasOwn(change, "after"), true);
    if (change.operation === "create") assert.equal(change.before, null);
    else assert.ok(change.before);
    if (change.operation === "delete") assert.equal(change.after, null);
    else assert.ok(change.after);
  }
  const projectChange = diff.changes.find((change) => change.entity === "project");
  assert.deepEqual(projectChange?.before, base.project);
  assert.deepEqual(projectChange?.after, desired.project);
  assert.equal(
    diff.serializedDiff,
    diffProjectConfigurationV1(
      valid(permute(original)).normalizedInput,
      valid(permute(candidate)).normalizedInput,
    ).serializedDiff,
  );
  assert.deepEqual(base, untouchedBase);
  assert.deepEqual(desired, untouchedDesired);
  const update = diff.changes.find(
    (change) => change.entity === "activity" && change.operation === "update",
  );
  assert.ok(update?.after);
  update.after.name = "Cannot mutate source through review";
  assert.deepEqual(desired, untouchedDesired);
});
function largeInput(count: number, name: string) {
  const value = configuration();
  value.input.activities = Array.from({ length: count }, (_, index) => ({
    id: uuid(index),
    wbsId: ROOT,
    name,
    kind: "TASK",
    durationMinutes: 1,
    calendarId: CALENDAR,
    constraints: [],
  }));
  value.input.relationships = [];
  return value;
}
test("candidate/base canonical artifact limits fail closed without a partial result", () => {
  const tooLarge = largeInput(6000, "x".repeat(500));
  assert.ok(
    Buffer.byteLength(serializeScheduleInputV1(tooLarge.input)) >
      PROJECT_CONFIGURATION_MAX_ARTIFACT_BYTES,
  );
  hasIssue(tooLarge, "ARTIFACT_TOO_LARGE");
  const small = valid().normalizedInput;
  assert.throws(
    () => diffProjectConfigurationV1(small, tooLarge.input),
    (error) => errorCode(error, "ARTIFACT_TOO_LARGE"),
  );
  assert.throws(
    () => diffProjectConfigurationV1(tooLarge.input, small),
    (error) => errorCode(error, "ARTIFACT_TOO_LARGE"),
  );
});
test("complete diff exceeds 8 MiB even with two individually permitted artifacts and is rejected", () => {
  const base = largeInput(5100, "x".repeat(500));
  const candidate = largeInput(5100, "y".repeat(500));
  assert.ok(
    Buffer.byteLength(serializeScheduleInputV1(base.input)) <=
      PROJECT_CONFIGURATION_MAX_ARTIFACT_BYTES,
  );
  assert.ok(
    Buffer.byteLength(serializeScheduleInputV1(candidate.input)) <=
      PROJECT_CONFIGURATION_MAX_ARTIFACT_BYTES,
  );
  const changes = base.input.activities.map((activity, index) => ({
    entity: "activity",
    key: activity.id,
    operation: "update",
    before: activity,
    after: present(candidate.input.activities[index]),
  }));
  assert.ok(
    Buffer.byteLength(`${JSON.stringify(changes, null, 2)}\n`) >
      PROJECT_CONFIGURATION_MAX_DIFF_BYTES,
  );
  assert.throws(
    () => diffProjectConfigurationV1(base.input, candidate.input),
    (error) => errorCode(error, "DIFF_TOO_LARGE"),
  );
  const modest = largeInput(1000, "x".repeat(500));
  const changed = largeInput(1000, "y".repeat(500));
  const review = diffProjectConfigurationV1(modest.input, changed.input);
  assert.equal(review.changes.length, 1000);
  assert.equal(review.noOp, false);
  assert.ok(Buffer.byteLength(review.serializedDiff) < PROJECT_CONFIGURATION_MAX_DIFF_BYTES);
});

test("Unicode native text bounds count code points and preserve exact text", () => {
  const value = configuration();
  value.input.project.name = "😀".repeat(500);
  assert.equal(valid(value).normalizedInput.project.name, value.input.project.name);
  value.input.project.name += "😀";
  hasIssue(value, "INVALID_VALUE", "input.project.name");
});

test("diff generation rejects ambiguous duplicate entity identities without losing changes", () => {
  const base = valid().normalizedInput;
  for (const entity of ["calendars", "wbs", "activities", "relationships"] as const) {
    const candidate = structuredClone(base);
    (candidate[entity] as unknown[]).push(structuredClone(present(candidate[entity][0])));
    const code = entity === "relationships" ? "DUPLICATE_RELATIONSHIP" : "DUPLICATE_ID";
    assert.throws(
      () => diffProjectConfigurationV1(base, candidate),
      (error) => errorCode(error, code),
    );
    assert.throws(
      () => diffProjectConfigurationV1(candidate, base),
      (error) => errorCode(error, code),
    );
  }
});

test("strict numeric parsing never rounds a fractional token into an accepted protocol integer", () => {
  for (const source of [
    "1.00000000000000000001",
    "0.99999999999999999999",
    "1e-325",
    "-1e-325",
    "1e-999999999999999999999999",
    "0.00000001e-325",
  ]) {
    assert.throws(
      () => parseConfigurationJsonV1(source),
      (error) => errorCode(error, "INVALID_JSON"),
    );
    parseIssue(
      JSON.stringify(configuration()).replace(
        '"durationMinutes":2400',
        `"durationMinutes":${source}`,
      ),
      "INVALID_JSON",
    );
  }
  for (const [source, expected] of [
    ["1.0", 1],
    ["1e3", 1000],
    ["1.25e2", 125],
    ["1000e-3", 1],
    ["0e-999999999999999999999999", 0],
    ["1.5", 1.5],
    ["1e-3", 0.001],
  ] as const) {
    assert.equal(parseConfigurationJsonV1(source), expected);
  }
});

test("direct validation rejects non-JSON array properties and accessors without executing them", () => {
  const extra = configuration();
  Object.assign(extra.input.activities, { unexpected: true });
  hasIssue(extra, "UNKNOWN_PROPERTY");
  const sparse = configuration();
  delete sparse.input.activities[0];
  hasIssue(sparse, "INVALID_VALUE");
  const getter = configuration();
  let invoked = false;
  Object.defineProperty(getter.input.activities, "0", {
    enumerable: true,
    get: () => {
      invoked = true;
      return configuration().input.activities[0];
    },
  });
  hasIssue(getter, "INVALID_VALUE");
  assert.equal(invoked, false);
});

test("diagnostic detail text stays bounded for attacker-controlled oversized JSON keys", () => {
  const key = "x".repeat(PROJECT_CONFIGURATION_MAX_BYTES - 10_000);
  const source = JSON.stringify({ ...configuration(), [key]: true });
  assert.ok(Buffer.byteLength(source) <= PROJECT_CONFIGURATION_MAX_BYTES);
  const result = parseProjectConfigurationV1(source);
  assert.equal(result.valid, false);
  assert.equal(result.diagnostics.totalCount, 1);
  const issue = present(result.diagnostics.issues[0]);
  assert.equal(issue.code, "UNKNOWN_PROPERTY");
  assert.equal(issue.path.length, PROJECT_CONFIGURATION_MAX_DIAGNOSTIC_TEXT_LENGTH);
  assert.ok(issue.path.endsWith("..."));
  const unicode = `${"😀".repeat(1000)}x`;
  const invalid = validateProjectConfigurationV1({ ...configuration(), [unicode]: true });
  assert.ok(present(invalid.diagnostics.issues[0]).path.isWellFormed());
  const duplicate = `{"${key}":1,"${key}":2}`;
  // Use a smaller key so the duplicate-key request fits within the transport bound.
  const fittingDuplicate = duplicate.replaceAll(key, key.slice(0, 20_000));
  assert.throws(
    () => parseConfigurationJsonV1(fittingDuplicate),
    (error) => {
      assert.ok(error instanceof ProjectConfigurationError);
      assert.equal(error.code, "DUPLICATE_JSON_KEY");
      assert.ok(
        present(error.diagnostics.issues[0]).path.length <=
          PROJECT_CONFIGURATION_MAX_DIAGNOSTIC_TEXT_LENGTH,
      );
      assert.ok(
        present(error.diagnostics.issues[0]).message.length <=
          PROJECT_CONFIGURATION_MAX_DIAGNOSTIC_TEXT_LENGTH,
      );
      return true;
    },
  );
});

function reviewPlan(noOp = false): ProjectConfigurationPlanV1 {
  const original = valid();
  const desired = structuredClone(original.normalizedConfiguration);
  if (!noOp) {
    desired.input.project.name = "Changed project";
    desired.input.scheduleOptions.criticalFloatThresholdMinutes = 60;
    present(desired.input.calendars[0]).name = "Changed calendar";
    present(desired.input.wbs[0]).name = "Changed root";
    present(desired.input.activities[0]).name = "Changed activity";
    present(desired.input.relationships[0]).lagMinutes = 1;
  }
  const candidate = valid(desired);
  const diff = diffProjectConfigurationV1(original.normalizedInput, candidate.normalizedInput);
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    normalizationVersion: 1,
    planId: uuid(100),
    organizationId: uuid(101),
    projectId: PROJECT,
    actorId: uuid(102),
    sessionId: uuid(103),
    createdAt: "2026-10-03T09:00:00.000Z",
    expiresAt: "2026-10-03T09:15:00.000Z",
    baseRevision: 5,
    baseInputHashSha256: "a".repeat(64),
    desiredInputHashSha256: (noOp ? "a" : "b").repeat(64),
    configuration: candidate.normalizedConfiguration,
    changes: diff.changes,
    noOp,
    reviewedDigest: "c".repeat(64),
  };
}
function receiptFor(
  plan = reviewPlan(),
  outcome: "applied" | "no_op" | "cancelled" = plan.noOp ? "no_op" : "applied",
): ProjectConfigurationReceiptV1 {
  const common = {
    schemaVersion: 1 as const,
    planId: plan.planId,
    organizationId: plan.organizationId,
    projectId: plan.projectId,
    previousRevision: plan.baseRevision,
    baseInputHashSha256: plan.baseInputHashSha256,
    reviewedDigest: plan.reviewedDigest,
    provenanceAuditId: uuid(104),
    recordedAt: "2026-10-03T09:01:00.000Z",
  };
  return outcome === "cancelled"
    ? {
        ...common,
        outcome,
        committedRevision: null,
        committedInputHashSha256: null,
        scheduleEditAuditId: null,
      }
    : {
        ...common,
        outcome,
        committedRevision: plan.baseRevision + (outcome === "applied" ? 1 : 0),
        committedInputHashSha256: plan.desiredInputHashSha256,
        scheduleEditAuditId: outcome === "applied" ? uuid(105) : null,
      };
}

test("shared review serializer fixes outer field order and excludes digest without changing descriptor bytes", () => {
  const plan = reviewPlan();
  const expected = {
    schemaVersion: plan.schemaVersion,
    protocolVersion: plan.protocolVersion,
    normalizationVersion: plan.normalizationVersion,
    planId: plan.planId,
    organizationId: plan.organizationId,
    projectId: plan.projectId,
    actorId: plan.actorId,
    sessionId: plan.sessionId,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    baseRevision: plan.baseRevision,
    baseInputHashSha256: plan.baseInputHashSha256,
    desiredInputHashSha256: plan.desiredInputHashSha256,
    configuration: plan.configuration,
    changes: plan.changes,
    noOp: plan.noOp,
  };
  assert.equal(serializeProjectConfigurationReviewV1(plan), JSON.stringify(expected));
  assert.equal(serializeProjectConfigurationReviewV1(expected), JSON.stringify(expected));
  const reverse = Object.fromEntries(
    Object.entries(plan).reverse(),
  ) as unknown as ProjectConfigurationPlanV1;
  assert.equal(validateProjectConfigurationPlanV1(reverse), true);
  assert.equal(serializeProjectConfigurationReviewV1(reverse), JSON.stringify(expected));
  assert.equal(
    Object.hasOwn(JSON.parse(serializeProjectConfigurationReviewV1(plan)), "reviewedDigest"),
    false,
  );
  assert.equal(serializeProjectConfigurationReviewV1(plan).endsWith("\n"), false);
});

test("strict runtime plan guards validate complete material/no-op reviews without mutation", () => {
  for (const noOp of [false, true]) {
    const plan = reviewPlan(noOp),
      untouched = structuredClone(plan);
    assert.equal(validateProjectConfigurationPlanV1(plan), true);
    assert.equal(validateProjectConfigurationPlanV1(JSON.parse(JSON.stringify(plan))), true);
    assert.deepEqual(plan, untouched);
  }
  for (const value of [null, [], {}, "plan", undefined])
    assert.equal(validateProjectConfigurationPlanV1(value), false);
  for (const key of Object.keys(reviewPlan())) {
    const value = reviewPlan() as unknown as Record<string, unknown>;
    delete value[key];
    assert.equal(validateProjectConfigurationPlanV1(value), false, key);
  }
  assert.equal(validateProjectConfigurationPlanV1({ ...reviewPlan(), unknown: true }), false);
});

test("runtime review guards reject identity/version/hash/revision/timestamp normalization conflicts", () => {
  const mutations: ((value: ProjectConfigurationPlanV1) => void)[] = [
    (value) => {
      (value as unknown as Record<string, unknown>).schemaVersion = 2;
    },
    (value) => {
      (value as unknown as Record<string, unknown>).protocolVersion = 2;
    },
    (value) => {
      (value as unknown as Record<string, unknown>).normalizationVersion = 2;
    },
    (value) => {
      value.planId = FIRST.toUpperCase();
    },
    (value) => {
      value.organizationId = "not-uuid";
    },
    (value) => {
      value.projectId = uuid(200);
    },
    (value) => {
      value.actorId = "not-uuid";
    },
    (value) => {
      value.sessionId = "not-uuid";
    },
    (value) => {
      value.baseInputHashSha256 = "A".repeat(64);
    },
    (value) => {
      value.desiredInputHashSha256 = "b".repeat(63);
    },
    (value) => {
      value.reviewedDigest = "z".repeat(64);
    },
    (value) => {
      value.baseRevision = 0;
    },
    (value) => {
      value.baseRevision = Number.MAX_SAFE_INTEGER;
    },
    (value) => {
      value.baseRevision = 1.5;
    },
    (value) => {
      value.createdAt = "2026-10-03T09:00:00Z";
    },
    (value) => {
      value.createdAt = "2026-02-30T09:00:00.000Z";
    },
    (value) => {
      value.createdAt = "0000-10-03T09:00:00.000Z";
    },
    (value) => {
      value.expiresAt = value.createdAt;
    },
    (value) => {
      value.expiresAt = "2026-10-03T09:15:00.001Z";
    },
    (value) => {
      value.expiresAt = "2026-10-03T08:59:59.999Z";
    },
    (value) => {
      value.configuration.input.project.plannedStart = "2026-10-05T08:00:00+09:00";
    },
    (value) => {
      value.configuration.input.activities.reverse();
    },
    (value) => {
      value.noOp = true;
    },
    (value) => {
      value.desiredInputHashSha256 = value.baseInputHashSha256;
    },
  ];
  for (const mutate of mutations) {
    const value = reviewPlan();
    mutate(value);
    assert.equal(validateProjectConfigurationPlanV1(value), false);
  }
  const noop = reviewPlan(true);
  noop.desiredInputHashSha256 = "d".repeat(64);
  assert.equal(validateProjectConfigurationPlanV1(noop), false);
});

test("runtime plan validation reconstructs both schedules and rejects ambiguous/incomplete change shape", () => {
  const mutations: ((value: ProjectConfigurationPlanV1) => void)[] = [
    (value) => {
      value.changes.reverse();
    },
    (value) => {
      value.changes.push(structuredClone(present(value.changes[0])));
    },
    (value) => {
      present(value.changes[0]).key = uuid(200);
    },
    (value) => {
      (present(value.changes[0]) as unknown as Record<string, unknown>).entity = "unknown";
    },
    (value) => {
      (present(value.changes[0]) as unknown as Record<string, unknown>).operation = "unknown";
    },
    (value) => {
      Object.assign(present(value.changes[0]), { unknown: true });
    },
    (value) => {
      (present(value.changes[0]) as unknown as Record<string, unknown>).before = null;
    },
    (value) => {
      (present(value.changes[0]) as unknown as Record<string, unknown>).after = null;
    },
    (value) => {
      const change = value.changes.find((change) => change.entity === "activity");
      assert.ok(change?.before);
      change.before.name = " ";
    },
    (value) => {
      const change = value.changes.find((change) => change.entity === "activity");
      assert.ok(change?.after);
      change.after.name = "Wrong target";
    },
    (value) => {
      const change = value.changes.find((change) => change.entity === "activity");
      assert.ok(change?.before);
      change.before.calendarId = uuid(999);
    },
    (value) => {
      const change = value.changes.find((change) => change.entity === "calendar");
      assert.ok(change?.before);
      change.before.timeZone = "Mars/Olympus";
    },
    (value) => {
      const change = value.changes.find((change) => change.entity === "project");
      assert.ok(change?.before);
      change.before.plannedStart = "2026-10-05T08:00:00+09:00";
    },
    (value) => {
      const change = value.changes.find(
        (change) => change.entity === "relationship" && change.operation === "delete",
      );
      assert.ok(change);
      (change as unknown as Record<string, unknown>).after = structuredClone(change.before);
    },
    (value) => {
      const change = value.changes.find(
        (change) => change.entity === "relationship" && change.operation === "create",
      );
      assert.ok(change);
      (change as unknown as Record<string, unknown>).before = structuredClone(change.after);
    },
  ];
  for (const mutate of mutations) {
    const value = reviewPlan();
    mutate(value);
    assert.equal(validateProjectConfigurationPlanV1(value), false);
  }
  const original = configuration();
  const removed = { ...present(original.input.activities[1]), id: uuid(200) };
  original.input.activities.push(removed);
  const candidate = structuredClone(original);
  candidate.input.activities = candidate.input.activities.filter(
    (activity) => activity.id !== removed.id,
  );
  candidate.input.activities.push({ ...removed, id: uuid(201) });
  const plan = reviewPlan();
  const base = valid(original),
    desired = valid(candidate);
  plan.configuration = desired.normalizedConfiguration;
  plan.changes = diffProjectConfigurationV1(base.normalizedInput, desired.normalizedInput).changes;
  assert.equal(
    validateProjectConfigurationPlanV1(plan),
    true,
    "create/delete entity changes have fully validated before/after values",
  );
  const create = plan.changes.find((change) => change.operation === "create");
  assert.ok(create?.after);
  Object.assign(create.after, { extra: true });
  assert.equal(validateProjectConfigurationPlanV1(plan), false);
});

test("runtime receipt guards enforce terminal outcomes and exact revision/hash/audit evidence", () => {
  const material = reviewPlan(),
    noop = reviewPlan(true);
  for (const receipt of [
    receiptFor(material),
    receiptFor(noop),
    receiptFor(material, "cancelled"),
    receiptFor(noop, "cancelled"),
  ]) {
    assert.equal(validateProjectConfigurationReceiptV1(receipt), true);
    const untouched = structuredClone(receipt);
    assert.equal(validateProjectConfigurationReceiptV1(JSON.parse(JSON.stringify(receipt))), true);
    assert.deepEqual(receipt, untouched);
    for (const key of Object.keys(receipt)) {
      const missing = structuredClone(receipt) as unknown as Record<string, unknown>;
      delete missing[key];
      assert.equal(validateProjectConfigurationReceiptV1(missing), false, key);
    }
  }
  for (const value of [null, [], {}, "receipt", undefined])
    assert.equal(validateProjectConfigurationReceiptV1(value), false);
  const appliedMutations: Record<string, unknown>[] = [
    { unknown: true },
    { schemaVersion: 2 },
    { planId: "not-uuid" },
    { organizationId: FIRST.toUpperCase() },
    { previousRevision: 0 },
    { previousRevision: Number.MAX_SAFE_INTEGER },
    { committedRevision: 5 },
    { committedRevision: 7 },
    { committedRevision: null },
    { committedInputHashSha256: null },
    { committedInputHashSha256: material.baseInputHashSha256 },
    { committedInputHashSha256: "z".repeat(64) },
    { scheduleEditAuditId: null },
    { scheduleEditAuditId: uuid(104) },
    { provenanceAuditId: "bad" },
    { recordedAt: "2026-10-03T09:01:00Z" },
    { recordedAt: "2026-02-30T09:01:00.000Z" },
    { outcome: "unknown" },
  ];
  for (const patch of appliedMutations)
    assert.equal(
      validateProjectConfigurationReceiptV1({ ...receiptFor(material), ...patch }),
      false,
      JSON.stringify(patch),
    );
  for (const patch of [
    { committedRevision: 6 },
    { committedInputHashSha256: material.desiredInputHashSha256 },
    { scheduleEditAuditId: uuid(105) },
  ])
    assert.equal(validateProjectConfigurationReceiptV1({ ...receiptFor(noop), ...patch }), false);
  for (const patch of [
    { committedRevision: 5 },
    { committedInputHashSha256: material.baseInputHashSha256 },
    { scheduleEditAuditId: uuid(105) },
  ])
    assert.equal(
      validateProjectConfigurationReceiptV1({ ...receiptFor(material, "cancelled"), ...patch }),
      false,
    );
});

test("runtime export/read wrappers verify normalized configuration, availability and terminal bindings", () => {
  const plan = reviewPlan();
  const exported: ProjectConfigurationReadV1 = {
    schemaVersion: 1,
    revision: plan.baseRevision,
    inputHashSha256: plan.desiredInputHashSha256,
    configuration: plan.configuration,
  };
  assert.equal(validateProjectConfigurationReadV1(exported), true);
  for (const patch of [
    { schemaVersion: 2 },
    { revision: 0 },
    { inputHashSha256: "invalid" },
    { extra: true },
  ])
    assert.equal(validateProjectConfigurationReadV1({ ...exported, ...patch }), false);
  const noncanonical = structuredClone(exported);
  noncanonical.configuration.input.project.plannedStart = "2026-10-05T08:00:00+09:00";
  assert.equal(validateProjectConfigurationReadV1(noncanonical), false);
  const pending: ProjectConfigurationPlanReadV1 = {
    plan,
    planId: plan.planId,
    status: "pending",
    artifactsAvailable: true,
    receipt: null,
  };
  const applied: ProjectConfigurationPlanReadV1 = {
    ...pending,
    status: "applied",
    receipt: receiptFor(plan),
  };
  assert.equal(validateProjectConfigurationPlanReadV1(pending), true);
  assert.equal(validateProjectConfigurationPlanReadV1({ ...pending, status: "expired" }), true);
  assert.equal(
    validateProjectConfigurationPlanReadV1({
      ...pending,
      status: "expired",
      artifactsAvailable: false,
      plan: null,
    }),
    true,
  );
  assert.equal(validateProjectConfigurationPlanReadV1(applied), true);
  assert.equal(
    validateProjectConfigurationPlanReadV1({ ...applied, artifactsAvailable: false, plan: null }),
    true,
  );
  for (const patch of [
    { extra: true },
    { artifactsAvailable: false },
    { plan: null },
    { planId: uuid(999) },
    { status: "no_op" },
    { receipt: receiptFor(plan) },
  ])
    assert.equal(validateProjectConfigurationPlanReadV1({ ...pending, ...patch }), false);
  for (const patch of [
    { receipt: null },
    { status: "cancelled" },
    { receipt: { ...receiptFor(plan), organizationId: uuid(999) } },
    { receipt: { ...receiptFor(plan), reviewedDigest: "d".repeat(64) } },
    { receipt: { ...receiptFor(plan), previousRevision: 4, committedRevision: 5 } },
  ])
    assert.equal(validateProjectConfigurationPlanReadV1({ ...applied, ...patch }), false);
  const noop = reviewPlan(true);
  assert.equal(
    validateProjectConfigurationPlanReadV1({
      ...pending,
      plan: noop,
      status: "no_op",
      receipt: receiptFor(noop),
    }),
    true,
  );
  assert.equal(
    validateProjectConfigurationPlanReadV1({
      ...pending,
      status: "cancelled",
      receipt: receiptFor(plan, "cancelled"),
    }),
    true,
  );
});

test("separate review parser retains strict JSON checks and permits bounded review artifacts above mutation transport", () => {
  const source = `"${"x".repeat(PROJECT_CONFIGURATION_MAX_BYTES)}"`;
  assert.throws(
    () => parseConfigurationJsonV1(source),
    (error) => errorCode(error, "TRANSPORT_TOO_LARGE"),
  );
  assert.equal(
    (parseProjectConfigurationReviewJsonV1(source) as string).length,
    PROJECT_CONFIGURATION_MAX_BYTES,
  );
  const exact = `"${"x".repeat(PROJECT_CONFIGURATION_MAX_REVIEW_BYTES - 2)}"`;
  assert.equal(
    (parseProjectConfigurationReviewJsonV1(exact) as string).length,
    PROJECT_CONFIGURATION_MAX_REVIEW_BYTES - 2,
  );
  assert.throws(
    () => parseProjectConfigurationReviewJsonV1(`${exact} `),
    (error) => errorCode(error, "TRANSPORT_TOO_LARGE"),
  );
  for (const [source, code] of [
    ['{"a":1,"a":2}', "DUPLICATE_JSON_KEY"],
    ["1.00000000000000000001", "INVALID_JSON"],
    ['"\\uD800"', "INVALID_JSON"],
    [`${"[".repeat(33)}0${"]".repeat(33)}`, "MAX_DEPTH_EXCEEDED"],
  ] as const)
    assert.throws(
      () => parseProjectConfigurationReviewJsonV1(source),
      (error) => errorCode(error, code),
    );
});

const configurationObjectPaths: (string | number)[][] = [
  [],
  ["input"],
  ["input", "project"],
  ["input", "scheduleOptions"],
  ["input", "calendars", 0],
  ["input", "calendars", 0, "week"],
  ["input", "calendars", 0, "week", "MONDAY", 0],
  ["input", "calendars", 0, "exceptions", 1],
  ["input", "calendars", 0, "exceptions", 1, "workingIntervals", 0],
  ["input", "wbs", 0],
  ["input", "activities", 1],
  ["input", "activities", 1, "constraints", 0],
  ["input", "relationships", 0],
];
function objectAt(value: unknown, path: readonly (string | number)[]): Record<string, unknown> {
  let result = value as Record<string | number, unknown>;
  for (const key of path) result = result[key] as Record<string | number, unknown>;
  return result;
}
function reorderObjectAt(
  value: ProjectConfigurationV1,
  path: readonly (string | number)[],
  order: readonly string[],
): ProjectConfigurationV1 {
  const result = structuredClone(value);
  const target = objectAt(result, path);
  const reordered = Object.fromEntries(order.map((key) => [key, target[key]]));
  if (path.length === 0) return reordered as unknown as ProjectConfigurationV1;
  const parent = objectAt(result, path.slice(0, -1));
  parent[present(path.at(-1))] = reordered;
  return result;
}
function* propertyOrders(keys: readonly string[]): Generator<string[]> {
  if (keys.length === 0) {
    yield [];
    return;
  }
  for (const [index, key] of keys.entries()) {
    for (const rest of propertyOrders(keys.filter((_, other) => index !== other)))
      yield [key, ...rest];
  }
}
function reorderEveryObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderEveryObject);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reorderEveryObject(child)]),
  );
}

test("all 16,142 property-key permutations normalize to identical bytes and no-op reviews", () => {
  const source = configuration();
  const expected = valid(source);
  const normalizedJson = JSON.stringify(expected.normalizedConfiguration);
  let checked = 0;
  for (const path of configurationObjectPaths) {
    const keys = Object.keys(objectAt(source, path));
    for (const order of propertyOrders(keys)) {
      const reordered = reorderObjectAt(source, path, order);
      const result = valid(reordered);
      assert.equal(result.canonicalInput, expected.canonicalInput);
      assert.equal(JSON.stringify(result.normalizedConfiguration), normalizedJson);
      const review = diffProjectConfigurationV1(expected.normalizedInput, result.normalizedInput);
      assert.deepEqual(review, { changes: [], noOp: true, serializedDiff: "[]\n" });
      checked++;
    }
  }
  assert.equal(checked, 16_142);
  const reversed = valid(reorderEveryObject(source) as ProjectConfigurationV1);
  assert.equal(reversed.canonicalInput, expected.canonicalInput);
  assert.equal(JSON.stringify(reversed.normalizedConfiguration), normalizedJson);
});

test("configuration normalization explicitly matches native snapshot and JSONB field order", () => {
  const input = valid().normalizedInput;
  assert.deepEqual(Object.keys(present(input.wbs[0])), [
    "id",
    "parentId",
    "code",
    "name",
    "sortOrder",
  ]);
  assert.deepEqual(Object.keys(present(input.activities[0])), [
    "id",
    "wbsId",
    "name",
    "kind",
    "durationMinutes",
    "calendarId",
    "constraints",
  ]);
  assert.deepEqual(Object.keys(present(input.relationships[0])), [
    "predecessorId",
    "successorId",
    "type",
    "lagMinutes",
  ]);
  const calendar = present(input.calendars[0]);
  assert.deepEqual(Object.keys(calendar), ["id", "name", "timeZone", "week", "exceptions"]);
  assert.deepEqual(Object.keys(calendar.week), [
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ]);
  assert.deepEqual(Object.keys(present(calendar.week.MONDAY[0])), ["end", "start"]);
  assert.deepEqual(Object.keys(present(calendar.exceptions[0])), ["date", "workingIntervals"]);
  assert.deepEqual(Object.keys(present(present(calendar.exceptions[0]).workingIntervals[0])), [
    "end",
    "start",
  ]);
  const activity = present(input.activities.find((activity) => activity.id === SECOND));
  assert.deepEqual(Object.keys(present(activity.constraints[0])), ["type", "instant"]);
  assert.equal(
    serializeScheduleInputV1(input),
    valid({ schemaVersion: 1, kind: "engineo-project-configuration", scope: "schedule", input })
      .canonicalInput,
  );
});

test("property-key permutations preserve material plan bytes and strict review guard consistency", () => {
  const base = valid().normalizedInput;
  for (const noOp of [false, true]) {
    const plan = reviewPlan(noOp);
    const expectedReview = serializeProjectConfigurationReviewV1(plan);
    const candidates = [reorderEveryObject(plan.configuration) as ProjectConfigurationV1];
    for (const originalPath of configurationObjectPaths) {
      const path = [...originalPath];
      // Canonical collection sorting changes which activity/exception carries
      // constraints/working intervals, so select a populated representative.
      if (path[1] === "activities" && path.includes("constraints"))
        path[2] = plan.configuration.input.activities.findIndex(
          (activity) => activity.constraints.length > 0,
        );
      if (path[1] === "calendars" && path.includes("workingIntervals"))
        path[4] = present(plan.configuration.input.calendars[0]).exceptions.findIndex(
          (exception) => exception.workingIntervals.length > 0,
        );
      candidates.push(
        reorderObjectAt(
          plan.configuration,
          path,
          Object.keys(objectAt(plan.configuration, path)).reverse(),
        ),
      );
    }
    for (const raw of candidates) {
      const desired = valid(raw);
      const diff = diffProjectConfigurationV1(base, desired.normalizedInput);
      const normalizedPlan = {
        ...plan,
        configuration: desired.normalizedConfiguration,
        changes: diff.changes,
        noOp: diff.noOp,
      };
      assert.equal(validateProjectConfigurationPlanV1(normalizedPlan), true);
      assert.equal(serializeProjectConfigurationReviewV1(normalizedPlan), expectedReview);
    }
  }
});
