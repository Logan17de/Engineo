# Backward Pass and Float v1

## Purpose

The backward pass calculates the latest activity dates that preserve the controlling project finish, then derives total and free float.

## Project finish anchor

- `CALCULATED`: use the maximum early finish from the forward pass.
- `REQUIRED_FINISH`: use the project's explicit required-finish instant.

An earlier required finish can therefore create negative total float.

## Relationship upper bounds

The backward pass applies the inverse of each precedence lower bound.

For predecessor A and successor B:

```text
FS: A.finish <= B.late_start  - lag
SS: A.start  <= B.late_start  - lag
FF: A.finish <= B.late_finish - lag
SF: A.start  <= B.late_finish - lag
```

Lag subtraction uses the same configured lag calendar as the forward pass.

When a relationship constrains A's finish, A's duration is subtracted on A's own activity calendar to obtain its candidate late start.

Multiple successors combine by selecting the earliest candidate late start.

## Total float

Total float is measured on the activity's own work calendar:

```text
total_float = working_minutes_between(early_start, late_start)
```

This can be negative when the required project finish is earlier than the calculated finish.

## Free float

For each outgoing relationship, Engineo applies the backward relationship rule to the successor's **early** dates. This gives the latest predecessor start that would not move that successor.

The minimum relationship slack is the activity's free float.

Terminal activities currently use total float as free float because no downstream activity can be delayed.

## Critical threshold

An activity is marked critical when:

```text
total_float_minutes <= critical_float_threshold_minutes
```

This is the initial float-based criticality rule. Controlling/longest-path semantics are implemented separately.
