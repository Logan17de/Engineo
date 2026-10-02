# Calendar Engine v1

## Purpose

The calendar engine converts local work schedules into deterministic UTC working-time arithmetic for the scheduling engine.

## Semantics

- Calendar definitions use an IANA time zone.
- Recurring work intervals are local civil times.
- Date exceptions replace, rather than append to, the recurring intervals for that date.
- Work intervals are half-open: `[start, end)`.
- Multiple intervals per day are supported.
- Activity duration is measured in elapsed working minutes inside those intervals.
- Public calculations operate on UTC instants so one point in time has one identity.

## DST policy

Timezone transitions are resolved from IANA timezone data.

For a repeated local time during a fall-back transition:
- an interval start uses the earliest matching instant;
- an interval end uses the latest matching instant.

This includes the repeated real hour in working duration.

If a configured interval boundary falls inside a spring-forward gap and therefore does not exist, calculation fails explicitly with `NonexistentLocalBoundary`. Engineo does not silently invent a replacement time.

This policy is intentionally explicit and test-covered. It can be revisited through an ADR if professional scheduling requirements demand nominal wall-clock duration instead of elapsed working duration.

## Operations

- `next_work_instant`
- `previous_work_instant`
- `add_work_duration`
- `subtract_work_duration`
- `working_minutes_between`

## Validation

Compilation rejects:
- invalid IANA timezone names;
- invalid local dates/times;
- start >= end intervals;
- overlapping intervals;
- duplicate weekday definitions;
- duplicate exception dates.

The canonical TypeScript contract performs equivalent shape validation before data reaches the Rust engine.

## Search horizon

Navigation is bounded to 100 years when searching for the next/previous working instant. A calendar with no reachable work returns `NoWorkingTime` rather than looping forever.

## Security and determinism

The calendar engine:
- has no network access;
- reads no system-local timezone;
- does not depend on current time;
- uses the timezone identifier in project data;
- produces deterministic results for the same engine/tzdata version and inputs.

Timezone database version therefore forms part of Engineo's calculation environment and should be captured in future calculation metadata.
