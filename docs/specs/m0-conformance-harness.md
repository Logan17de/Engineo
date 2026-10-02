# M0 Conformance and Performance Harness

## Purpose

M0 is complete only when Engineo's schedule engine is not merely implemented, but continuously challenged by executable specifications.

## Correctness layers

### Golden fixtures

Version-controlled JSON fixtures under `fixtures/schedules/m0/` contain small schedules and exact expected CPM outputs.

The fixture runner compares:
- project finish;
- controlling path;
- activity early dates;
- total float;
- free float;
- criticality.

A scheduling bug that reaches production should become a new permanent fixture before the fix is merged.

### Generated property checks

The conformance suite generates deterministic schedules and checks invariants rather than only individual examples.

Current invariants:
- increasing a driving-chain duration cannot make project finish earlier;
- adding a predecessor cannot make its successor earlier;
- reversing activity/relationship input ordering cannot change normalized output;
- every activity's early start is a working instant;
- working minutes between early start and early finish equal the activity duration.

### Deterministic fingerprint

The harness renders CPM output into a stable canonical string and computes a dependency-free FNV-1a 64-bit fingerprint.

This fingerprint is a regression/determinism aid only. It is **not** a cryptographic integrity mechanism.

## Synthetic schedules

Two deterministic relationship profiles are available:

- `Sparse`: chain-like schedule with roughly one outgoing edge per activity.
- `Dense`: multiple forward offsets per activity to create a much higher relationship count while preserving a DAG.

IDs, durations, calendars, and relationships are generated deterministically.

## Performance

CI executes a 1,000-activity smoke benchmark for basic performance regression visibility without enforcing a machine-dependent timing threshold.

Manual scale benchmark:

```bash
cargo test -p engineo-scheduling --test performance -- --ignored --nocapture
```

It runs:
- 1,000 activities;
- 10,000 activities;
- 100,000 activities;

against sparse and dense relationship profiles.

Output format:

```text
engineo_benchmark profile=Sparse activities=10000 relationships=9999 elapsed_ms=... engine_contract=1
```

Benchmark results should be recorded with:
- Engineo commit SHA;
- Rust version;
- operating system/architecture;
- CPU and memory;
- profile;
- activity/relationship count;
- elapsed time.

M0 does not set a hard universal millisecond threshold because CI hardware varies. Performance budgets will be established from repeated measurements on a named reference machine.

## Regression workflow

When a calculation bug is found:

1. Reduce it to the smallest schedule that still fails.
2. Add a JSON golden fixture or focused regression test.
3. Confirm the new test fails before the code fix.
4. Fix the engine.
5. Keep the fixture permanently.
6. If the bug affected a hot path, rerun the scale benchmark.
