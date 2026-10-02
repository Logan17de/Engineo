export const ENGINE_CONTRACT_VERSION = 1 as const;
export const MAX_WORK_MINUTES = 4_294_967_295;

export const WEEKDAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
] as const;

export type WeekdayV1 = (typeof WEEKDAYS)[number];
export type ActivityKindV1 = "TASK" | "START_MILESTONE" | "FINISH_MILESTONE";
export type RelationshipTypeV1 = "FS" | "SS" | "FF" | "SF";
export type ConstraintTypeV1 =
  | "START_ON_OR_AFTER"
  | "START_ON_OR_BEFORE"
  | "FINISH_ON_OR_AFTER"
  | "FINISH_ON_OR_BEFORE";
export type LagCalendarPolicyV1 = "PREDECESSOR" | "SUCCESSOR" | "PROJECT";
export type ProjectFinishPolicyV1 = "CALCULATED" | "REQUIRED_FINISH";

export interface WorkIntervalV1 {
  start: string;
  end: string;
}

export interface CalendarExceptionV1 {
  date: string;
  workingIntervals: WorkIntervalV1[];
}

export interface CalendarV1 {
  id: string;
  name: string;
  timeZone: string;
  week: Record<WeekdayV1, WorkIntervalV1[]>;
  exceptions: CalendarExceptionV1[];
}

export interface WbsNodeV1 {
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  sortOrder: number;
}

export interface ActivityConstraintV1 {
  type: ConstraintTypeV1;
  instant: string;
}

export interface ActivityInputV1 {
  id: string;
  wbsId: string;
  name: string;
  kind: ActivityKindV1;
  durationMinutes: number;
  calendarId: string;
  constraints: ActivityConstraintV1[];
}

export interface RelationshipInputV1 {
  predecessorId: string;
  successorId: string;
  type: RelationshipTypeV1;
  lagMinutes: number;
}

export interface ScheduleOptionsV1 {
  criticalFloatThresholdMinutes: number;
  lagCalendarPolicy: LagCalendarPolicyV1;
  projectFinishPolicy: ProjectFinishPolicyV1;
}

export interface EngineProjectInputV1 {
  schemaVersion: typeof ENGINE_CONTRACT_VERSION;
  project: {
    id: string;
    name: string;
    plannedStart: string;
    dataDate: string;
    requiredFinish: string | null;
    defaultCalendarId: string;
  };
  scheduleOptions: ScheduleOptionsV1;
  calendars: CalendarV1[];
  wbs: WbsNodeV1[];
  activities: ActivityInputV1[];
  relationships: RelationshipInputV1[];
}
