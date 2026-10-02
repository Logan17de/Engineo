# Engineo Scheduling Engine Specification

## Purpose

The scheduling engine is Engineo's trust core. It converts project logic, calendars, constraints, and progress into authoritative calculated dates and diagnostics.

It is independent of UI, database, AI, and external interchange formats.

## M0 domain model

### Project
- stable ID
- planned start
- optional required finish
- data date
- default calendar
- scheduling options

### Activity
- stable ID
- WBS reference
- name
- kind: task, start milestone, finish milestone
- original/remaining duration
- calendar reference
- progress fields
- optional constraints

### Relationship
- predecessor
- successor
- type: FS, SS, FF, SF
- lag in working-time units
- explicit lag-calendar policy

### Calendar
- timezone
- recurring work week
- one or more work intervals per day
- holidays
- date-specific exceptions

## Calculation phases

1. Normalize and validate input.
2. Resolve calendars and working-time rules.
3. Build directed dependency graph.
4. Detect cycles and invalid/open logic.
5. Topologically order activities.
6. Run forward pass.
7. Establish controlling project finish.
8. Run backward pass.
9. Calculate float and criticality.
10. Trace controlling path(s).
11. Emit diagnostics and calculation trace.

## Validation

Before calculation:
- referenced entities exist;
- durations are valid;
- relationship endpoints differ;
- standard CPM graph is acyclic;
- calendars have valid non-overlapping intervals;
- milestones have zero duration;
- unsupported constraints fail explicitly.

No silent coercion of invalid schedule data.

## Working-time arithmetic

Calendar operations are first-class primitives:
- `add_work_duration(datetime, duration, calendar)`
- `subtract_work_duration(datetime, duration, calendar)`
- `work_duration_between(a, b, calendar)`
- `next_work_instant(datetime, calendar)`
- `previous_work_instant(datetime, calendar)`

Scheduling code must never use naive wall-clock addition for activity duration.

## Relationship semantics

M0 supports:
- Finish-to-Start (FS)
- Start-to-Start (SS)
- Finish-to-Finish (FF)
- Start-to-Finish (SF)
- positive and negative lag

Relationship date evaluation is calendar-aware and covered by cross-product tests of relationship type, lag sign, and calendar boundary.

## Forward pass

Traverse topological order and calculate each activity's earliest feasible start/finish from:
- project start;
- predecessor relationship bounds;
- working calendar;
- supported constraints.

Activities with multiple predecessors take the most restrictive feasible bound.

## Backward pass

Starting from calculated project finish or configured required-finish policy, traverse reverse topological order to derive latest permissible dates without delaying the controlling finish.

## Float

Engineo calculates at least:
- total float;
- free float.

Exact cross-calendar formulas are treated as tested scheduling semantics, not UI formulas.

## Criticality and paths

M0 exposes:
- total-float criticality under an explicit threshold;
- a controlling path to project finish.

M2 expands to longest-path and multiple-path analysis.

## Constraints

Constraints are typed rules, not hidden date mutations.

Each constraint defines:
- start/finish target;
- lower/upper-bound behavior;
- forward-pass effect;
- backward-pass effect;
- float consequence;
- diagnostic representation.

## Progress model

Progress work begins after unprogressed CPM is stable.

The model distinguishes:
- actual start/finish;
- remaining duration;
- data date;
- forecast dates;
- suspend/resume;
- out-of-sequence conditions.

Out-of-sequence behavior is an explicit option, never an invisible default.

## Calculation output

Per activity:
- early start/finish;
- late start/finish;
- total float;
- free float;
- critical flag;
- controlling predecessor/successor information;
- warnings/diagnostics.

Per project:
- forecast finish;
- critical/controlling path;
- schedule diagnostics;
- calculation version/hash;
- timing/performance statistics.

## Determinism

Given identical normalized input and engine version, output must be identical.

System time, locale, unordered map iteration, AI output, and database ordering may not affect authoritative calculations.

## Testing strategy

### Unit tests
Calendar arithmetic, each relationship type, lag, constraints, milestones, float.

### Table-driven matrix tests
Cross product of calendars, relationships, lags, boundaries, and constraints.

### Property tests
Examples:
- adding a non-driving predecessor cannot make a successor earlier;
- extending a driving duration cannot make project finish earlier;
- forward dates always lie on valid working instants;
- schedule output is invariant to input activity ordering.

### Golden fixtures
Version-controlled project inputs with expected full calculation output.

### Performance fixtures
Synthetic DAGs at 1k, 10k, and 100k+ activities with sparse and dense relationship profiles.

## Resource leveling

Resource leveling is intentionally outside the M0 CPM kernel. It consumes a valid schedule, resource availability, assignments, priorities, and policy, then proposes delays/changes and re-runs deterministic scheduling.

This keeps precedence calculation and optimization separate.
