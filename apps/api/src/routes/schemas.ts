import { WEEKDAYS } from "@engineo/contracts";

export const uuid = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
};
const text = { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" };
const instant = {
  type: "string",
  maxLength: 40,
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?(?:Z|[+-]\\d{2}:\\d{2})$",
};
const integer = { type: "integer", minimum: 0, maximum: 4_294_967_295 };
export const expectedRevision = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER - 1,
};
export function object(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return { type: "object", additionalProperties: false, required, properties };
}
const nullable = (value: object) => ({ anyOf: [value, { type: "null" }] });
const array = (items: object, maxItems = 10_000) => ({ type: "array", items, maxItems });
const interval = object({
  start: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
  end: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
});
const week = object(Object.fromEntries(WEEKDAYS.map((day) => [day, array(interval, 24)])));
const exceptions = array(
  object({
    date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    workingIntervals: array(interval, 24),
  }),
  3660,
);
const constraints = array(
  object({
    type: {
      enum: [
        "START_ON_OR_AFTER",
        "START_ON_OR_BEFORE",
        "FINISH_ON_OR_AFTER",
        "FINISH_ON_OR_BEFORE",
      ],
    },
    instant,
  }),
  16,
);
const calendarProperties = {
  name: text,
  timeZone: { type: "string", minLength: 1, maxLength: 100 },
  week,
  exceptions,
};
const activityProperties = {
  wbsId: uuid,
  calendarId: uuid,
  name: text,
  kind: { enum: ["TASK", "START_MILESTONE", "FINISH_MILESTONE"] },
  durationMinutes: integer,
  constraints,
};
const relationshipProperties = {
  predecessorId: uuid,
  successorId: uuid,
  type: { enum: ["FS", "SS", "FF", "SF"] },
  lagMinutes: {
    type: "integer",
    minimum: -Number.MAX_SAFE_INTEGER,
    maximum: Number.MAX_SAFE_INTEGER,
  },
};
const wbsProperties = {
  parentId: nullable(uuid),
  code: { ...text, maxLength: 100 },
  name: text,
  sortOrder: integer,
};
export const organizationParams = object({ organizationId: uuid });
export const projectParams = object({ organizationId: uuid, projectId: uuid });
export const revisionBody = object({ expectedRevision });
export const createProjectBody = object(
  {
    name: text,
    code: nullable({ type: "string", maxLength: 100 }),
    description: nullable({ type: "string", maxLength: 10_000 }),
    plannedStart: instant,
    timeZone: calendarProperties.timeZone,
  },
  ["name", "plannedStart", "timeZone"],
);
export const wbsBody = object({ expectedRevision, ...wbsProperties }, [
  "expectedRevision",
  "code",
  "name",
]);
export const calendarBody = object({ expectedRevision, ...calendarProperties }, [
  "expectedRevision",
  "name",
  "timeZone",
  "week",
]);
export const activityBody = object(
  { expectedRevision, ...activityProperties, sortOrder: integer },
  ["expectedRevision", "wbsId", "calendarId", "name", "kind", "durationMinutes"],
);
export const relationshipBody = object({ expectedRevision, ...relationshipProperties }, [
  "expectedRevision",
  "predecessorId",
  "successorId",
  "type",
]);
export const scheduleInputSchema = object({
  schemaVersion: { const: 1 },
  project: object({
    id: uuid,
    name: text,
    plannedStart: instant,
    dataDate: instant,
    requiredFinish: nullable(instant),
    defaultCalendarId: uuid,
  }),
  scheduleOptions: object({
    criticalFloatThresholdMinutes: integer,
    lagCalendarPolicy: { enum: ["PREDECESSOR", "SUCCESSOR", "PROJECT"] },
    projectFinishPolicy: { enum: ["CALCULATED", "REQUIRED_FINISH"] },
  }),
  calendars: { ...array(object({ id: uuid, ...calendarProperties }), 100), minItems: 1 },
  wbs: { ...array(object({ id: uuid, ...wbsProperties })), minItems: 1 },
  activities: array(object({ id: uuid, ...activityProperties })),
  relationships: array(object(relationshipProperties), 80_000),
});
export const replaceScheduleBody = object({ expectedRevision, input: scheduleInputSchema });
