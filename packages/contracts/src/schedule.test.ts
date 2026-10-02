import assert from "node:assert/strict";
import test from "node:test";
import {
  serializeScheduleInputV1,
  validateScheduleInputV1,
  type EngineProjectInputV1,
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
