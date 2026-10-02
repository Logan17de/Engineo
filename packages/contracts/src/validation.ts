import {
  type CalendarV1,
  ENGINE_CONTRACT_VERSION,
  type EngineProjectInputV1,
  MAX_WORK_MINUTES,
  WEEKDAYS,
  type WorkIntervalV1,
} from "./schedule.js";
import { ENGINE_TIME_ZONES } from "./time-zones.generated.js";

export type ScheduleValidationCode =
  | "INVALID_SCHEMA_VERSION"
  | "INVALID_ID"
  | "DUPLICATE_ID"
  | "MISSING_REFERENCE"
  | "INVALID_INSTANT"
  | "INVALID_TIME_ZONE"
  | "INVALID_DURATION"
  | "INVALID_MILESTONE_DURATION"
  | "INVALID_WORK_INTERVAL"
  | "DUPLICATE_EXCEPTION_DATE"
  | "INVALID_SORT_ORDER"
  | "WBS_CYCLE"
  | "SELF_RELATIONSHIP"
  | "RELATIONSHIP_CYCLE"
  | "INVALID_LAG"
  | "INVALID_FLOAT_THRESHOLD"
  | "MISSING_REQUIRED_FINISH";

export interface ScheduleValidationIssue {
  code: ScheduleValidationCode;
  path: string;
  message: string;
}

export interface ScheduleValidationResult {
  valid: boolean;
  issues: ScheduleValidationIssue[];
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function addIssue(
  issues: ScheduleValidationIssue[],
  code: ScheduleValidationCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function isRfc3339Instant(value: string): boolean {
  return (
    RFC3339_PATTERN.test(value) &&
    isRealDate(value.slice(0, 10)) &&
    !Number.isNaN(Date.parse(value)) &&
    /T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
  );
}

const supportedTimeZones = new Set(ENGINE_TIME_ZONES);
export function isIanaTimeZone(value: string): boolean {
  return supportedTimeZones.has(value);
}

function validateId(value: string, path: string, issues: ScheduleValidationIssue[]): void {
  if (!ID_PATTERN.test(value)) {
    addIssue(
      issues,
      "INVALID_ID",
      path,
      "IDs must be 1-128 characters using letters, digits, dot, underscore, colon, or hyphen.",
    );
  }
}

function validateUniqueIds<T extends { id: string }>(
  values: T[],
  path: string,
  issues: ScheduleValidationIssue[],
): Set<string> {
  const ids = new Set<string>();

  for (const [index, value] of values.entries()) {
    validateId(value.id, `${path}[${index}].id`, issues);
    if (ids.has(value.id)) {
      addIssue(issues, "DUPLICATE_ID", `${path}[${index}].id`, `Duplicate ID: ${value.id}`);
    }
    ids.add(value.id);
  }

  return ids;
}

function validateIntervals(
  intervals: WorkIntervalV1[],
  path: string,
  issues: ScheduleValidationIssue[],
): void {
  const sorted = [...intervals].sort((a, b) => a.start.localeCompare(b.start, "en"));
  let previousEnd: string | null = null;

  for (const [index, interval] of sorted.entries()) {
    const currentPath = `${path}[${index}]`;
    const validClock = CLOCK_PATTERN.test(interval.start) && CLOCK_PATTERN.test(interval.end);

    if (!validClock || interval.start >= interval.end) {
      addIssue(
        issues,
        "INVALID_WORK_INTERVAL",
        currentPath,
        "Work intervals require HH:mm values with start strictly before end.",
      );
      continue;
    }

    if (previousEnd !== null && interval.start < previousEnd) {
      addIssue(
        issues,
        "INVALID_WORK_INTERVAL",
        currentPath,
        "Work intervals on the same day must not overlap.",
      );
    }

    previousEnd = interval.end;
  }
}

function validateCalendar(
  calendar: CalendarV1,
  index: number,
  issues: ScheduleValidationIssue[],
): void {
  const base = `calendars[${index}]`;

  if (!isIanaTimeZone(calendar.timeZone)) {
    addIssue(
      issues,
      "INVALID_TIME_ZONE",
      `${base}.timeZone`,
      "Calendar timeZone must be a valid IANA time-zone identifier.",
    );
  }

  for (const day of WEEKDAYS) {
    validateIntervals(calendar.week[day], `${base}.week.${day}`, issues);
  }

  const exceptionDates = new Set<string>();
  for (const [exceptionIndex, exception] of calendar.exceptions.entries()) {
    const path = `${base}.exceptions[${exceptionIndex}]`;
    if (!isRealDate(exception.date)) {
      addIssue(issues, "INVALID_INSTANT", `${path}.date`, "Exception date must be YYYY-MM-DD.");
    }

    if (exceptionDates.has(exception.date)) {
      addIssue(
        issues,
        "DUPLICATE_EXCEPTION_DATE",
        `${path}.date`,
        `Duplicate calendar exception date: ${exception.date}`,
      );
    }
    exceptionDates.add(exception.date);
    validateIntervals(exception.workingIntervals, `${path}.workingIntervals`, issues);
  }
}

function validateWbsCycles(input: EngineProjectInputV1, issues: ScheduleValidationIssue[]): void {
  const parentById = new Map(input.wbs.map((node) => [node.id, node.parentId]));

  const completed = new Set<string>();
  for (const node of input.wbs) {
    if (completed.has(node.id)) continue;
    const path = new Set<string>();
    let id: string | null = node.id;
    while (id !== null && parentById.has(id) && !completed.has(id)) {
      if (path.has(id)) {
        addIssue(issues, "WBS_CYCLE", "wbs", `WBS hierarchy contains a cycle involving ${id}.`);
        break;
      }
      path.add(id);
      id = parentById.get(id) ?? null;
    }
    for (const visited of path) completed.add(visited);
  }
}

export function validateScheduleInputV1(input: EngineProjectInputV1): ScheduleValidationResult {
  const issues: ScheduleValidationIssue[] = [];

  if (input.schemaVersion !== ENGINE_CONTRACT_VERSION) {
    addIssue(
      issues,
      "INVALID_SCHEMA_VERSION",
      "schemaVersion",
      `Expected schema version ${ENGINE_CONTRACT_VERSION}.`,
    );
  }

  validateId(input.project.id, "project.id", issues);

  for (const field of ["plannedStart", "dataDate"] as const) {
    if (!isRfc3339Instant(input.project[field])) {
      addIssue(
        issues,
        "INVALID_INSTANT",
        `project.${field}`,
        "Project instants must use RFC 3339 with an explicit UTC offset.",
      );
    }
  }

  if (input.project.requiredFinish !== null && !isRfc3339Instant(input.project.requiredFinish)) {
    addIssue(
      issues,
      "INVALID_INSTANT",
      "project.requiredFinish",
      "requiredFinish must be null or an RFC 3339 instant.",
    );
  }

  if (
    input.scheduleOptions.projectFinishPolicy === "REQUIRED_FINISH" &&
    input.project.requiredFinish === null
  ) {
    addIssue(
      issues,
      "MISSING_REQUIRED_FINISH",
      "project.requiredFinish",
      "REQUIRED_FINISH policy requires project.requiredFinish.",
    );
  }

  if (
    !Number.isInteger(input.scheduleOptions.criticalFloatThresholdMinutes) ||
    input.scheduleOptions.criticalFloatThresholdMinutes < 0
  ) {
    addIssue(
      issues,
      "INVALID_FLOAT_THRESHOLD",
      "scheduleOptions.criticalFloatThresholdMinutes",
      "Critical-float threshold must be a non-negative integer number of minutes.",
    );
  }

  const calendarIds = validateUniqueIds(input.calendars, "calendars", issues);
  const wbsIds = validateUniqueIds(input.wbs, "wbs", issues);
  const activityIds = validateUniqueIds(input.activities, "activities", issues);

  for (const [index, calendar] of input.calendars.entries()) {
    validateCalendar(calendar, index, issues);
  }

  if (!calendarIds.has(input.project.defaultCalendarId)) {
    addIssue(
      issues,
      "MISSING_REFERENCE",
      "project.defaultCalendarId",
      `Unknown calendar: ${input.project.defaultCalendarId}`,
    );
  }

  for (const [index, node] of input.wbs.entries()) {
    if (!Number.isSafeInteger(node.sortOrder) || node.sortOrder < 0) {
      addIssue(
        issues,
        "INVALID_SORT_ORDER",
        `wbs[${index}].sortOrder`,
        "WBS sortOrder must be a non-negative safe integer.",
      );
    }

    if (node.parentId !== null && !wbsIds.has(node.parentId)) {
      addIssue(
        issues,
        "MISSING_REFERENCE",
        `wbs[${index}].parentId`,
        `Unknown WBS parent: ${node.parentId}`,
      );
    }
  }
  validateWbsCycles(input, issues);

  for (const [index, activity] of input.activities.entries()) {
    const base = `activities[${index}]`;

    if (!wbsIds.has(activity.wbsId)) {
      addIssue(issues, "MISSING_REFERENCE", `${base}.wbsId`, `Unknown WBS: ${activity.wbsId}`);
    }

    if (!calendarIds.has(activity.calendarId)) {
      addIssue(
        issues,
        "MISSING_REFERENCE",
        `${base}.calendarId`,
        `Unknown calendar: ${activity.calendarId}`,
      );
    }

    if (!Number.isSafeInteger(activity.durationMinutes) || activity.durationMinutes < 0) {
      addIssue(
        issues,
        "INVALID_DURATION",
        `${base}.durationMinutes`,
        "Activity duration must be a non-negative safe integer number of working minutes.",
      );
    }

    if (activity.kind !== "TASK" && activity.durationMinutes !== 0) {
      addIssue(
        issues,
        "INVALID_MILESTONE_DURATION",
        `${base}.durationMinutes`,
        "Milestones must have zero duration.",
      );
    }

    for (const [constraintIndex, constraint] of activity.constraints.entries()) {
      if (!isRfc3339Instant(constraint.instant)) {
        addIssue(
          issues,
          "INVALID_INSTANT",
          `${base}.constraints[${constraintIndex}].instant`,
          "Constraint instants must use RFC 3339 with an explicit UTC offset.",
        );
      }
    }
  }

  for (const [index, relationship] of input.relationships.entries()) {
    const base = `relationships[${index}]`;

    if (!activityIds.has(relationship.predecessorId)) {
      addIssue(
        issues,
        "MISSING_REFERENCE",
        `${base}.predecessorId`,
        `Unknown predecessor: ${relationship.predecessorId}`,
      );
    }
    if (!activityIds.has(relationship.successorId)) {
      addIssue(
        issues,
        "MISSING_REFERENCE",
        `${base}.successorId`,
        `Unknown successor: ${relationship.successorId}`,
      );
    }
    if (relationship.predecessorId === relationship.successorId) {
      addIssue(
        issues,
        "SELF_RELATIONSHIP",
        base,
        "An activity cannot have a relationship to itself.",
      );
    }
    if (
      !Number.isSafeInteger(relationship.lagMinutes) ||
      Math.abs(relationship.lagMinutes) > MAX_WORK_MINUTES
    ) {
      addIssue(
        issues,
        "INVALID_LAG",
        `${base}.lagMinutes`,
        `Relationship lag must be an integer between -${MAX_WORK_MINUTES} and ${MAX_WORK_MINUTES} working minutes.`,
      );
    }
  }

  // Graph validity is input validation; calculated dates/floats remain in Rust.
  const incoming = new Map(input.activities.map((activity) => [activity.id, 0]));
  const successors = new Map<string, string[]>();
  for (const relationship of input.relationships) {
    if (!incoming.has(relationship.predecessorId) || !incoming.has(relationship.successorId))
      continue;
    incoming.set(relationship.successorId, (incoming.get(relationship.successorId) ?? 0) + 1);
    const edges = successors.get(relationship.predecessorId) ?? [];
    edges.push(relationship.successorId);
    successors.set(relationship.predecessorId, edges);
  }
  const ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < ready.length; index++) {
    for (const successor of successors.get(ready[index] ?? "") ?? []) {
      const count = (incoming.get(successor) ?? 1) - 1;
      incoming.set(successor, count);
      if (count === 0) ready.push(successor);
    }
  }
  if (ready.length !== incoming.size) {
    addIssue(
      issues,
      "RELATIONSHIP_CYCLE",
      "relationships",
      "Relationships contain a cycle. Remove a link in the loop before saving.",
    );
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}
