# Durable calculation execution record

The source delta is on `feat/planner-durable-runs`, based on Planner
`898863995600bf2ea329f49619ebf1c0b8d936c9`, in the saved Engineo cloud environment.
It remains unpublished until the account correction is reviewed and reconciled.
The final local commit is reported in the engineering handoff; this record does
not represent completion of M1 or the production product.

## Executed checks

| Check | Result |
| --- | --- |
| Dedicated PostgreSQL/real Rust durable suite | 14 passed, zero skipped/failed; 57.3s |
| Full format/lint/typecheck/contracts/API/security and both production builds | passed; 7 contract, 49 API and 2 inherited SARIF-gate tests; 5 existing lint warnings |
| Production-mode Chromium browser suite on this separate base | 5 passed in 20.9s, zero retries/skips/unhandled page errors |
| Read-only independent review of the durable delta | no remaining blocking defect |
| Combined account/durable multi-tab acceptance on corrected PR #56 source | never run; reconciliation awaits PM review |
| Durable increment exact-head remote CI/CodeQL | never run; no draft PR published yet |
| Backup/restore and application rollback | never run; see the operational drill |

The 14 durable checks are included in the 49 API checks, not an additional suite
to add to that total. The browser suite on this branch contains the original
five flows; it does not contain the 13 new account regressions on PR #56. That
separate PR's exact head `14240f0258d0b74b9c31d6c5daf132a4ec234b5a`
passed all 18 cases and CI 37085477145.

Local command sequence, with a disposable loopback PostgreSQL database:

```bash
. /workspace/engineo-tools/env.sh
export DATABASE_URL=postgres://engineo:engineo@127.0.0.1:5432/engineo_api_delta
export ENGINEO_SCHEDULER_BIN=/workspace/Engineo/target/release/engineo-schedule
pnpm --filter @engineo/contracts build
pnpm --filter @engineo/api typecheck
# From apps/api:
node --import tsx --test src/schedule-runs.test.ts
# From repository root:
pnpm check:ts
DATABASE_URL=postgres://engineo:engineo@127.0.0.1:5432/engineo_browser \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm test:browser
```

The disposable API suite intentionally resets its public schema. The dedicated
large-calendar fixture was consequently removed by the later full suite; the
executed assertions and log retain its evidence.

## What the checks establish

- Real engine dates, exact stored byte hashes, one atomic audit per committed run,
  application restart, viewer reads and foreign-tenant denial.
- Audit-insert failure rolls back both rows; a retry commits successfully.
- New revisions hide old dates while prior snapshots reject mutation/deletion.
- Real calculations held before commit reject concurrent edits, role changes,
  session revocation and expiry.
- Genuine audit-table lock barriers exercise expiry and HTTP client disconnect
  after the result insert but before the audit can complete. Both rows roll back.
- Cancellation received after the final real SQL session check still rolls back.
- A real repeatable-read snapshot is held after reading its revision while a
  second transaction edits and calculates a new revision. The held read returns
  the old input/result/revision together; the subsequent API read returns the
  new triplet together.
- A valid custom-runner result with oversized nonnumeric cause metadata is
  rejected before SQL. Its dates and float are from the real engine.
- 55 unused calendars, each with 3,660 one-hour exceptions, are admitted through
  the actual calendar API. The resulting input with 56 calendars and 201,300 exceptions is
  below 32 MiB compact but above 32 MiB canonical. The run endpoint returns 422
  before any runner invocation or run/audit insert. Calling the real Rust engine
  with that same compact input succeeds, proving the canonical-size mismatch.
- Browser reload retains the same run ID, dates and 24 visible Gantt rows in a
  1,000-activity project. Dirty recovery shows no forecast. A viewer loads a
  persisted 1,000-activity forecast under actual server RBAC.

Retained cloud logs:

- `/workspace/scratch/engineo-durable-boundary-tests.log`
- `/workspace/scratch/engineo-durable-final-check-ts.log`
- `/workspace/scratch/engineo-durable-browser.log`

Rust release binary SHA-256:
`81c4fe061bfe5a6aa592dc1602daeed92abf037ffc0bd8b5d78f412d1c7a252d`.
Migration 0004 SHA-256:
`7c017657e8d913d8176bd684e9f82f6e26ab1c187cc026af57634d7dc8964955`.
No Rust algorithm/Cargo.lock change is part of this increment.

## Separate security clearance

PR #57 `c8bd175875b4514d65549814fd56b5c2d461338e` passed CI 37086703440
and CodeQL 37086703382: 19 clean Rust files, zero erroneous files, complete
per-source evidence and no high/error findings. Its real SARIF artifact 11261345618
was downloaded and rechecked with both gates. Archive digest:
`d1801dbe9f3616f4bd20d90e3b9da4aeb413a45d3dcd469e2c860842129e636d`.
This clearance covers that separate head, not the new durable API code.
Dependency Review 37086703368 failed on disabled Dependency Graph. Owner
permission remains unanswered; no setting or merge changed.
