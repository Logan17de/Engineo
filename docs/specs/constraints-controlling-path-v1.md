# Constraints and Controlling Path v1

## Constraint model

M0 supports four explicit constraint rules:

- `START_ON_OR_AFTER`
- `START_ON_OR_BEFORE`
- `FINISH_ON_OR_AFTER`
- `FINISH_ON_OR_BEFORE`

Constraints are typed scheduling rules. They are not hidden date overrides.

## Forward-pass behavior

Lower-bound constraints participate in early-date calculation:

```text
START_ON_OR_AFTER:
  early_start >= constraint instant

FINISH_ON_OR_AFTER:
  early_finish >= constraint instant
```

A finish lower bound is converted to a start candidate by subtracting the activity's working duration on its own calendar.

Upper-bound constraints do not pull early dates backward.

## Backward-pass behavior

Upper-bound constraints participate in late-date calculation:

```text
START_ON_OR_BEFORE:
  late_start <= constraint instant

FINISH_ON_OR_BEFORE:
  late_finish <= constraint instant
```

If an upper constraint is earlier than the precedence-driven early date, Engineo preserves the early forecast and reports negative float plus a constraint violation. It does not silently move the forecast backward through its predecessors.

## Constraint diagnostics

After CPM calculation, Engineo evaluates every constraint against the calculated early start/finish.

A violated constraint records:
- activity ID;
- constraint type;
- constraint instant;
- actual calculated instant.

This keeps infeasible requirements visible rather than hiding them in date mutation.

## Driving causes

Each activity early start records every lower bound tied for the controlling value:

- project start;
- predecessor relationship;
- lower-bound constraint.

Ties are preserved. This matters when, for example, a relationship and a contractual constraint both land on the same date.

## Controlling path

The M0 controlling path begins at the activity that sets project early finish and follows driving predecessor relationships backward.

If a constraint is later than all predecessor bounds, the path stops at that constrained activity because the constraint, not its predecessor, is controlling the downstream forecast.

When multiple activities tie for project finish, Engineo selects the lexicographically first stable activity ID for the single M0 path. Multiple-path analysis is a later capability.

The path is an explanation of the current early-date calculation. It is separate from float-based criticality.
