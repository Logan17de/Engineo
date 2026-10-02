# Forward Pass v1

## Purpose

The M0 forward pass calculates deterministic early start and early finish instants from project start, activity duration, work calendars, and precedence relationships.

Constraints and progress are separate milestones and are not applied in this version.

## Relationship lower bounds

For predecessor A and successor B:

```text
FS: B.start  >= A.finish + lag
SS: B.start  >= A.start  + lag
FF: B.finish >= A.finish + lag
SF: B.finish >= A.start  + lag
```

For FF and SF, Engineo converts the finish lower bound into a candidate start by subtracting B's working duration using B's activity calendar.

Each relationship is a lower bound, not an equality requirement. Multiple predecessors therefore combine by selecting the latest candidate early start.

## Lag calendar

Lag is measured as working minutes on the configured policy calendar:

- predecessor activity calendar;
- successor activity calendar;
- project default calendar.

Positive lag moves forward through working time. Negative lag moves backward through working time.

After relationship evaluation, the successor's early start is normalized onto its own work calendar.

## Project start

Every activity has the project planned start as a lower bound. Activities with no predecessors begin at the first working instant on or after project start according to their own calendar.

## Activity finish

```text
early_finish = add_work_duration(early_start, duration, activity_calendar)
```

Milestones have zero duration, so their early start and finish are the same normalized working instant.

## Determinism

- graph traversal uses deterministic topological order;
- incoming relationships are sorted before evaluation;
- calendar and activity lookup uses ordered maps;
- input collection ordering cannot change output.

## Deferred semantics

The following intentionally remain outside Forward Pass v1:

- activity constraints;
- data-date/progress logic;
- actual dates;
- suspend/resume;
- resource-dependent activities;
- resource leveling;
- backward pass;
- float;
- driving-relationship explanation metadata.

Those features build on this forward-pass contract rather than being mixed into the first implementation.
