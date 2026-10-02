# Schedule Input Contract v1

Status: M0 canonical input contract

## Purpose

This contract is Engineo's own normalized scheduling input. It is not a database schema, UI state shape, or representation of any external scheduling format.

The application layer converts project state into this contract before invoking deterministic schedule calculation.

## Versioning

Every payload carries:

```json
{ "schemaVersion": 1 }
```

Breaking changes require a new schema version. Existing versions remain readable for as long as compatibility policy requires.

## Identity

Entity IDs are stable opaque strings.

Allowed v1 characters:

```text
A-Z a-z 0-9 . _ : -
```

IDs are 1-128 characters, start with an alphanumeric character, and are unique within their entity collection.

Human-readable codes and names are separate from IDs.

## Time model

### Instants

Project dates and constraints use RFC 3339 timestamps with an explicit UTC offset, for example:

```text
2026-10-05T08:00:00+09:00
2026-10-04T23:00:00Z
```

An instant represents one point on the timeline.

### Calendar timezone

Each work calendar carries an IANA time-zone identifier such as:

```text
Asia/Tokyo
America/New_York
Europe/London
```

This is separate from the offset in an instant because civil-time rules can change.

### Duration and lag

All M0 durations and relationship lags are integer **working minutes**.

No implicit "hours per day" conversion exists in the engine contract.

Examples:
- 480 = 8 working hours
- 2400 = 40 working hours
- -120 lag = 2 working hours of lead

Presentation layers may display days/hours according to user preferences, but conversion happens outside authoritative calculation.

## Project

A project defines:
- stable ID and name;
- planned start;
- data date;
- optional required finish;
- default work calendar.

The data date is explicit even before progress calculation is implemented so the contract does not need a breaking change when status logic arrives.

## WBS

WBS nodes form a parent-linked hierarchy.

Each node has:
- stable ID;
- nullable parent ID;
- human-readable code;
- name;
- non-negative sort order.

Contract validation rejects missing parents and parent cycles.

## Activities

Activity kinds:
- `TASK`
- `START_MILESTONE`
- `FINISH_MILESTONE`

Milestones always have zero duration.

Every activity belongs to one WBS node and references one work calendar.

## Relationships

Supported relationship kinds:
- `FS` finish-to-start
- `SS` start-to-start
- `FF` finish-to-finish
- `SF` start-to-finish

Lag is a signed integer number of working minutes.

Self-relationships are invalid. Full dependency-cycle detection belongs to the scheduling graph layer rather than basic contract validation.

## Calendars

A calendar contains:
- stable ID and name;
- IANA timezone;
- recurring Monday-Sunday work intervals;
- date-specific exceptions.

Work intervals use local civil `HH:mm` values. Intervals within one day may not overlap.

A date exception replaces the recurring day's intervals for that local calendar date. An empty interval list therefore represents a non-working exception day.

## Constraints

M0 contract constraint kinds:
- `START_ON_OR_AFTER`
- `START_ON_OR_BEFORE`
- `FINISH_ON_OR_AFTER`
- `FINISH_ON_OR_BEFORE`

Constraints carry RFC 3339 instants.

The scheduling engine owns their forward/backward-pass semantics.

## Schedule options

### criticalFloatThresholdMinutes

Non-negative integer threshold used when deriving a float-based critical flag.

### lagCalendarPolicy

One of:
- `PREDECESSOR`
- `SUCCESSOR`
- `PROJECT`

This is explicit because relationship-lag calendar semantics must never be a hidden default.

### projectFinishPolicy

- `CALCULATED` — backward pass anchors to calculated project finish.
- `REQUIRED_FINISH` — required finish participates in the late-date/float policy.

`REQUIRED_FINISH` requires `project.requiredFinish`.

## Validation

Semantic validation returns machine-readable issues:

```ts
{
  code: "MISSING_REFERENCE",
  path: "activities[3].calendarId",
  message: "Unknown calendar: night-shift"
}
```

The code is stable for automation. The message is diagnostic text and may improve over time.

Contract validation covers shape-level scheduling invariants and references. Calculation-specific diagnostics such as activity dependency cycles belong to the scheduling engine.

## Deterministic serialization

`serializeScheduleInputV1` canonicalizes collection ordering before JSON serialization.

This provides stable fixtures, hashes, cache keys, and reproducible calculation inputs without treating incidental UI ordering as schedule meaning.

Meaningful ordering, such as WBS `sortOrder`, remains explicit data.

## Boundary rule

External formats are translated into this model through adapters:

```text
External format
      |
      v
Import adapter
      |
      v
Engineo canonical contract
      |
      v
Deterministic scheduling engine
```

The canonical contract must not acquire fields solely because another product or file format happens to expose them.
