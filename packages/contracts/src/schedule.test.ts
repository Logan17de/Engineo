import assert from "node:assert/strict";
import test from "node:test";
import {
  type EngineProjectInputV1,
  MAX_WORK_MINUTES,
  serializeScheduleInputV1,
  validateScheduleInputV1,
} from "./index.js";

function validInput(): EngineProjectInputV1 {
  const workday = [{ start: "08:00", end: "17:00" }];

  return {
    schemaVersion: 1,
    project: {
      id: "project-demo",
      name: "Engineo contract test",
      plannedStart: "2026-10-05T08:00:00+09:00",
      dataDate: "2026-10-05T08:00:00+09:00",
      requiredFinish: null,
      defaultCalendarId: "calendar-standard",
    },
    scheduleOptions: {
      criticalFloatThresholdMinutes: 0,
      lagCalendarPolicy: "SUCCESSOR",
      projectFinishPolicy: "CALCULATED",
    },
    calendars: [
      {
        id: "calendar-standard",
        name: "Standard",
        timeZone: "Asia/Tokyo",
        week: {
          MONDAY: workday,
          TUESDAY: workday,
          WEDNESDAY: workday,
          THURSDAY: workday,
          FRIDAY: workday,
          SATURDAY: [],
          SUNDAY: [],
        },
        exceptions: [],
      },
    ],
    wbs: [
      {
        id: "wbs-root",
        parentId: null,
        code: "1",
        name: "Project",
        sortOrder: 0,
      },
    ],
    activities: [
      {
        id: "A100",
        wbsId: "wbs-root",
        name: "Start",
        kind: "START_MILESTONE",
        durationMinutes: 0,
        calendarId: "calendar-standard",
        constraints: [],
      },
      {
        id: "A110",
        wbsId: "wbs-root",
        name: "First work package",
        kind: "TASK",
        durationMinutes: 2400,
        calendarId: "calendar-standard",
        constraints: [],
      },
    ],
    relationships: [
      {
        predecessorId: "A100",
        successorId: "A110",
        type: "FS",
        lagMinutes: 0,
      },
    ],
  };
}

test("signed relationship lag agrees with the engine's u32 magnitude range", () => {
  for (const sign of [-1, 1]) {
    const input = validInput();
    const relationship = input.relationships[0];
    assert.ok(relationship);
    relationship.lagMinutes = sign * MAX_WORK_MINUTES;
    assert.equal(validateScheduleInputV1(input).valid, true);
    relationship.lagMinutes = sign * (MAX_WORK_MINUTES + 1);
    assert.ok(validateScheduleInputV1(input).issues.some((issue) => issue.code === "INVALID_LAG"));
  }
});

test("valid M0 input passes semantic validation", () => {
  const result = validateScheduleInputV1(validInput());

  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});

test("validation returns machine-readable duplicate and relationship errors", () => {
  const input = validInput();
  input.activities.push({ ...input.activities[0]! });
  input.relationships.push({
    predecessorId: "A110",
    successorId: "A110",
    type: "FS",
    lagMinutes: 0,
  });

  const result = validateScheduleInputV1(input);
  const codes = new Set(result.issues.map((issue) => issue.code));

  assert.equal(result.valid, false);
  assert.equal(codes.has("DUPLICATE_ID"), true);
  assert.equal(codes.has("SELF_RELATIONSHIP"), true);
});

test("milestones reject non-zero duration", () => {
  const input = validInput();
  input.activities[0] = {
    ...input.activities[0]!,
    durationMinutes: 60,
  };

  const result = validateScheduleInputV1(input);

  assert.equal(
    result.issues.some((issue) => issue.code === "INVALID_MILESTONE_DURATION"),
    true,
  );
});

test("serialization is deterministic across collection ordering", () => {
  const first = validInput();
  const second: EngineProjectInputV1 = {
    ...first,
    activities: [...first.activities].reverse(),
    relationships: [...first.relationships].reverse(),
    wbs: [...first.wbs].reverse(),
    calendars: [...first.calendars].reverse(),
  };

  assert.equal(serializeScheduleInputV1(first), serializeScheduleInputV1(second));
});

test("calendar and constraint dates reject normalized impossible dates", () => {
  const input = validInput();
  input.project.plannedStart = "2026-02-31T08:00:00Z";
  const calendar = input.calendars[0];
  const activity = input.activities[1];
  assert.ok(calendar);
  assert.ok(activity);
  calendar.exceptions.push({ date: "2026-02-30", workingIntervals: [] });
  activity.constraints.push({ type: "START_ON_OR_AFTER", instant: "2026-01-01T24:00:00Z" });
  const issues = validateScheduleInputV1(input).issues;
  assert.ok(issues.some((issue) => issue.path === "project.plannedStart"));
  assert.ok(issues.some((issue) => issue.path === "calendars[0].exceptions[0].date"));
  assert.ok(issues.some((issue) => issue.path.endsWith("constraints[0].instant")));
});

test("relationship loops are rejected and deep WBS chains validate without recursion", () => {
  const input = validInput();
  input.relationships.push({
    predecessorId: "A110",
    successorId: "A100",
    type: "SS",
    lagMinutes: 0,
  });
  assert.ok(
    validateScheduleInputV1(input).issues.some((issue) => issue.code === "RELATIONSHIP_CYCLE"),
  );
  input.relationships.pop();
  for (let i = 0; i < 10_000; i++)
    input.wbs.push({
      id: `node-${i}`,
      parentId: i ? `node-${i - 1}` : "wbs-root",
      code: String(i + 2),
      name: "Deep node",
      sortOrder: i,
    });
  assert.equal(validateScheduleInputV1(input).valid, true);
  const root = input.wbs[0];
  assert.ok(root);
  root.parentId = "node-9999";
  assert.ok(validateScheduleInputV1(input).issues.some((issue) => issue.code === "WBS_CYCLE"));
});
