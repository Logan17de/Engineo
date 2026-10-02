import { WEEKDAYS, type EngineProjectInputV1, type WeekdayV1 } from "./schedule.js";

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "en");
}

function compareNullableText(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareText(a, b);
}

export function canonicalizeScheduleInputV1(input: EngineProjectInputV1): EngineProjectInputV1 {
  const calendars = [...input.calendars]
    .sort((a, b) => compareText(a.id, b.id))
    .map((calendar) => {
      const weekEntries = WEEKDAYS.map(
        (day: WeekdayV1) =>
          [day, [...calendar.week[day]].sort((a, b) => compareText(a.start, b.start))] as const,
      );

      const week = Object.fromEntries(
        weekEntries,
      ) as EngineProjectInputV1["calendars"][number]["week"];

      return {
        id: calendar.id,
        name: calendar.name,
        timeZone: calendar.timeZone,
        week,
        exceptions: [...calendar.exceptions]
          .sort((a, b) => compareText(a.date, b.date))
          .map((exception) => ({
            date: exception.date,
            workingIntervals: [...exception.workingIntervals].sort((a, b) =>
              compareText(a.start, b.start),
            ),
          })),
      };
    });

  const wbs = [...input.wbs].sort(
    (a, b) =>
      compareNullableText(a.parentId, b.parentId) ||
      a.sortOrder - b.sortOrder ||
      compareText(a.id, b.id),
  );

  const activities = [...input.activities]
    .sort((a, b) => compareText(a.id, b.id))
    .map((activity) => ({
      ...activity,
      constraints: [...activity.constraints].sort(
        (a, b) => compareText(a.type, b.type) || compareText(a.instant, b.instant),
      ),
    }));

  const relationships = [...input.relationships].sort(
    (a, b) =>
      compareText(a.predecessorId, b.predecessorId) ||
      compareText(a.successorId, b.successorId) ||
      compareText(a.type, b.type) ||
      a.lagMinutes - b.lagMinutes,
  );

  return {
    schemaVersion: input.schemaVersion,
    project: {
      id: input.project.id,
      name: input.project.name,
      plannedStart: input.project.plannedStart,
      dataDate: input.project.dataDate,
      requiredFinish: input.project.requiredFinish,
      defaultCalendarId: input.project.defaultCalendarId,
    },
    scheduleOptions: {
      criticalFloatThresholdMinutes: input.scheduleOptions.criticalFloatThresholdMinutes,
      lagCalendarPolicy: input.scheduleOptions.lagCalendarPolicy,
      projectFinishPolicy: input.scheduleOptions.projectFinishPolicy,
    },
    calendars,
    wbs,
    activities,
    relationships,
  };
}

export function serializeScheduleInputV1(input: EngineProjectInputV1): string {
  return `${JSON.stringify(canonicalizeScheduleInputV1(input), null, 2)}\n`;
}
