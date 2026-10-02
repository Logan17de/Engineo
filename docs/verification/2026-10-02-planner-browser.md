# Planner browser execution record

Saved Engineo cloud environment, 2026-10-02. The increment is based on approved
API head `f53c2619c414650b95487611aa19d83c7454a376`; the auth/API and original
concurrent branches were preserved. Node 24.19.0, pnpm 12.8.0, Rust 1.99.0,
PostgreSQL 18.4, Chromium 151 and Playwright 1.63.0. No production deployment,
external credentials, paid services or user-PC filesystem were used.

## Reproduce

Use a disposable loopback PostgreSQL database. API tests reset their own schema;
browser tests migrate and create unique local fixture accounts/projects. Never
point either suite at customer or production data. Browser configuration rejects
non-loopback database hosts, but loopback alone does not make data disposable.

```bash
pnpm install --frozen-lockfile
cargo build --release --locked -p engineo-scheduling --bin engineo-schedule
node scripts/generate-time-zones.mjs --check
export ENGINEO_SCHEDULER_BIN="$PWD/target/release/engineo-schedule"
DATABASE_URL=<disposable-api-database> pnpm check:ts
pnpm exec playwright install --with-deps chromium
DATABASE_URL=<disposable-browser-database> pnpm test:browser
pnpm audit --audit-level moderate --json
```

The cloud validation used its installed `/usr/bin/chromium` through
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. CI installs Playwright's pinned Chromium.
Playwright owns compiled API and `next start` processes on loopback ports 4000
and 3100. It does not silently reuse existing servers or retry failures.

## Executed results

| Check | Result |
| --- | --- |
| Full TypeScript format/lint/typecheck, including browser sources | passed |
| Contract tests | 7 passed, zero skipped |
| API/real PostgreSQL/real Rust bridge tests | 35 passed, zero skipped |
| SARIF fail-closed regression tests | 2 passed, zero skipped |
| API and Next production builds | passed |
| Final production-mode browser suite | 5 passed, zero skipped/retried, 20.5 seconds total |
| Browser unhandled page errors | zero in all five cases |
| Final web typecheck/build and browser source typecheck/lint after small message/test corrections | passed |
| JavaScript dependency audit at moderate threshold | zero vulnerabilities in every severity |
| Rust engine suite | unchanged from reviewed API head; 50 active tests passed there, manual scale fixture separately executed |
| Exact-head GitHub CI/CodeQL | pending publication; must pass before merge |
| Dependency Review | upstream runs failed because Dependency Graph is disabled; owner decision pending, gate retained |
| Production ingress/proxy, encrypted backup/restore and deployment drills | never run |

The five cases exercise:

1. Wrong sign-in/error focus; organization/project creation and double click;
   1,000 activities with only 24 normal DOM rows; inline editing, WBS code reuse,
   constraint selection, duplicate/cyclic logic, working intervals and an
   exception; deterministic finish agreement with API/Rust; keyboard access and
   editing at row 1,000; filtering; dirty-export denial; canonical download and
   byte-for-byte hash binding to its export audit event.
2. Offline failure with retained draft and explicit retry; one mutation on double
   click; cancellation after confirmed commit and before delivery of a committed
   response; stale revision rejection/reload choices; failed organization load
   cannot show the previous organization's project.
3. Real database session revocation; same-account draft recovery after fresh
   authorization; logout discard rejection; different-account recovery denial;
   subsequent logout/sign-in cannot expose the previous account's project.
4. Session expiry after a confirmed save; recovery loads current persisted state
   instead of resurrecting an old expected revision as an unsaved draft.
5. A viewer navigates 1,000 rows using keyboard range controls and page scrolling,
   reaches the disabled last row with 18 DOM rows at the bottom; direct write/run
   requests return 403; a foreign project substitution returns 403 without data.

## Failures retained in the record

Earlier browser executions exposed assertions that confused Next's route
announcer with the app error, expected hidden viewer controls to be disabled,
or assumed logout preserved project URL selection. Those assertions were fixed
to match the intended observable behavior. The expanded viewer check initially
found the last row in the table but below the outer browser viewport; the final
test uses keyboard Control+End to scroll the page and then verifies visibility.
It does not use forced clicks or directly modify DOM scroll state.

Independent source review also identified actual defects before publication:
account-state leakage, lost expired-session drafts, stale async writes, calendar
text truncation, missing date years, stale constraint choices, reused WBS codes,
failed organization-load state, recovery after a confirmed save, premature
virtual range termination, and noncanonical export bytes. These were corrected
and relevant assertions executed. No security finding or failed check is hidden.

## Accessibility and performance limits

Manual agent-browser verification inspected sign-in and a calculated 1,000-row
Planner, including screenshots, browser errors and overlay state. An axe 4.12.1
scan found zero violations, 43 passes and one incomplete contrast rule affecting
10 nodes on the page gradient. Conservative WCAG contrast calculation against
the brightest gradient endpoint `#123047` gives 6.58:1 for muted `#a3b7c5` and
12.27:1 for normal `#edf4f8`; this checks those specified colors, not every
interactive state or device. Full screen-reader, mobile and accessibility
certification remain pending.

The 20.5-second suite time is execution evidence, not a latency budget. Input and
API outputs were verified for 1,000 activities, with DOM virtualization asserted.
Named-hardware repeated UI/API latency and RSS measurements remain pending. The
separate M0 scale record covers measured Rust sparse/dense 100k scheduling.

## Remaining product work

Durable schedule results, data-date progress, grouping/sorting/saved views,
spreadsheet import/export, full identity administration and operational controls
remain open in M1/S1. All later baseline/scenario/resource/cost/EVM/portfolio/AI/
integration and release exits remain governed by `ACCEPTANCE.md`. This increment
does not establish complete-product or production readiness.
