# Planner API execution evidence

Sources reconciled: project API `d2aa71235bb7474dbef0257bab92b3088c791ea2`,
auth/security `de1b88f9efbccb1e536f625fbb99cb2a6e1a88fc`. New work is isolated
on `feat/planner-api-ready`; both original concurrent branches are unchanged.

Same saved cloud environment and named hardware as the M0 performance record:
Node 24.19, pnpm 12.8, Rust 1.99, PostgreSQL 18.4, EPYC 9V74, four CPU quota,
16 GiB memory limit. Nothing is written to the user's PC.

```bash
pnpm install --frozen-lockfile
cargo build --release --locked -p engineo-scheduling --bin engineo-schedule
node scripts/generate-time-zones.mjs --check
NODE_ENV=test DATABASE_URL=<disposable-loopback-database> \
  ENGINEO_SCHEDULER_BIN=<absolute-built-binary> pnpm check:ts
pnpm check:rust
pnpm audit --audit-level moderate --json
```

Full TypeScript format/lint/typecheck, contract/API/SARIF tests and API/Next
production builds passed after reconciliation. The API suite ran 33 tests with
zero skips; contracts 6 and SARIF regressions 2. Existing non-null lint warnings
remain. Rust format/Clippy and 47 active tests passed, including two new JSON
bridge tests. The manual 100k benchmark remains separately documented; it is
not a skipped success. Frozen dependency installation passed.

The final export/permission/cache additions were additionally typechecked and
the two relevant PostgreSQL Planner suites rerun (13 tests, no skips). GitHub
checks for the published exact SHA are still required. Browser flows have never
run in this API increment; no operational release is claimed.

Verified behavior includes:

- Org/project create with atomic membership, settings and audit.
- Strict malformed/enum/UUID/revision/date validation; overlapping calendar and
  nonzero milestone rejection; cycle detection; unchanged revision on failure.
- Genuine foreign-tenant WBS, calendar, parent and activity IDs rejected; foreign
  project reads denied and other-tenant activity retained.
- Real Rust 5x8 calculation: 480 + 960 working minutes linked FS from Monday
  2026-10-05 08:00 UTC finish Wednesday 17:00 UTC; zero total float and exact path.
- 1,000 persisted activities saved, calculated by the release binary and read
  back. One measured loopback injection run took 104.1 ms for save + run + read;
  this excludes browser/network, password login, setup, RSS and repetitions.
  It is a measurement, not a universal performance budget.
- Competing edits admit one revision; repeated/stale apply and stale run fail
  explicitly. Reader held across a committed writer returns a complete older
  snapshot/revision rather than mixed component rows.
- Successful activity/link deletion, relationship cascade, stale/missing delete
  rollback and before/after audit verification.
- Real trigger-induced audit failures roll edits and creation back; retry commits
  one event. Export authorization, private cache headers, canonical contract,
  absence of session/CSRF values and audit hash verified.
- Actual loopback socket disconnect after a full POST body aborts the runner;
  retry calculates successfully. Independent read-only HTTP probes also covered
  disconnect during held snapshot reads. Spawn failure, invalid/oversized output,
  timeout, cancellation and repeated-click capacity recovery have regressions.
- TypeScript's exact generated time-zone catalogue matches the pinned Rust
  binary; offset-only and wrong-case Intl names cannot be persisted.

gpt-6.1-sol Max independent review found process admission, time-zone mismatch
and disconnect defects; each was fixed and tested. Review found no remaining
concrete implementation blocker. Browser 1k/accessibility/import/export journeys,
full permission matrix, measured RSS and deployment/backup/proxy gates remain.

## Lag contract delta after PM review

API shape and semantic gates and the Rust JSON parser now share the signed
working-minute magnitude range `[-4294967295, 4294967295]`. Values one minute
beyond either edge fail before save; legacy out-of-range database rows fail
before a run starts. Positive/negative 480-minute lags save and run against Rust
with exact finish assertions. Numeric edge values save and pass JSON parsing;
the API edge-run fixtures intentionally use an empty calendar and assert its
bounded `NoWorkingTime` failure, avoiding millions of calendar iterations in CI.
This does not claim that every calendar/date combination at a numeric edge has
an attainable finish within operational limits.

Delta validation in the same cloud environment: `pnpm check:ts` passes with
7 contract, 35 API and 2 SARIF-gate tests, no skips, and both builds. Rust
fmt/Clippy/50 active tests pass; the dedicated scale benchmark remains separately
measured and intentionally ignored by the routine suite. Dependency audit at
moderate threshold reports zero findings. GitHub exact-head checks must run
again on this new delta; previous PM approval applies to the prior API SHA.
