# Multi-tab identity fault-fixture correction — 2026-10-03

Base: main `b36ecc4d9483b925583bbf9a673c0040436a63e1`, tree
`f626302e6bf0ffa68e55c6d060c0ca62b3bdddee`.
Branch: `fix/held-identity-fixture`.

## Observed failure and scope

[Main PUSH CI 37102898437](https://github.com/Logan17de/Engineo/actions/runs/37102898437)
passed 24 of 25 browser cases. In TypeScript job `111145778968`, the existing
held-identity case expected its first routed `/auth/me` response to be B's
authenticated 200, but the real server returned 401 during the interval between
A logging out and B logging in. The fixture marked that first request as selected
before inspecting its phase or identity. The unavailable/offline variants had the
same first-request assumption, without checking which account they faulted.

The same-tree integration PR #60 passed all 25 browser cases, both PR #59 recovery
regressions passed on main, and main CodeQL reported 19 clean / 0 erroneous / 19
expected Rust files. Those results do not invalidate the failed run. No trace was
retained from that failure, so the exact focus/timer interleaving cannot be rebuilt.
The observed 401 and the first-request assumption justify this narrow harness
correction; they do not establish a production authorization or recovery bug.

Only the existing browser fixture, evidence retention, and this record change.
Production code, contracts, migrations, locks, security settings and deployment
are unchanged. Separate durable-calculation work is excluded.

## Deterministic regression and retained assertions

The three original fault modes retain their ordinary two-tab switch flows. An
additional held-mode regression pauses the second tab after real logout, before
B login. Focus verification in the first tab must obtain and
deliver a genuine server 401 with `unauthenticated`, and the UI must show session
expiry while the B fault remains unselected. Earlier genuine A responses are
forwarded normally. No unauthorized response is relabelled, fabricated or ignored.

Every response selected for 503/offline/hold injection must first come from real
`route.fetch()`, return 200, and identify B by the fixture's immutable user ID.
Unexpected statuses or users still fail. Repeated genuine B probes stay in the
same fault phase until deliberate A reauthentication succeeds, preventing a
one-second cookie-check retry from accidentally verifying B and changing the
scenario on a slow runner. Real A responses and 401s continue normally.

The existing visible-data clearing, focused error, enabled sign-in and recovered
A draft assertions remain. The held response stays behind its barrier until the
unchanged production five-second verification deadline produces the failure
message, with the existing seven-second assertion allowance. After deliberate
A sign-in, all held B responses are released; A's identity and dirty recovered
draft are checked again. A release count records attempted late fulfillment,
including requests already aborted by their deadline, not acceptance of B by
the application. This is fault-injection coverage, not a production latency claim.

## Evidence and verification gates

The four cases save `identity-verification-evidence.json` in their Playwright
output directories and attach that file. It records observed statuses, disposable
user IDs, whether B was faulted, the failure-message checkpoint, and held-release
count. It contains no passwords or cookie values. Existing `retain-on-failure`
traces remain enabled. CI uploads `test-results/` as `browser-acceptance` with
`actions/upload-artifact@v4`, `always()`, missing-files ignored, and seven-day
retention. This is the same retention step as the separate durable-work increment.

Local verification uses Node 24.19.0, pinned pnpm 12.8.0 / Rust 1.99.0 and a
disposable loopback PostgreSQL 17.11. The frozen install passed all 156 lockfile
supply-chain entries and reused 91 cached packages without changing the lockfile.
Executed final checks:

- `cargo build --release --locked -p engineo-scheduling --bin engineo-schedule`
  passed, building this worktree's unchanged main Rust bridge.
- `pnpm check:ts` passed against that bridge: formatting/lint, workspace and
  browser-test typing, 7 contracts / 47 real PostgreSQL/Rust API / 6 security
  regressions, and both production builds. Zero tests skipped; the existing five
  Biome warnings remain. Next's generated `next-env.d.ts` rewrite was restored.
- `pnpm exec playwright test --list` discovered all 26 cases, including the new
  forced-gap case. Discovery and typing are not behavioral browser execution.
- `git diff --check` passed. The disposable database was stopped afterward.

Exact-head remote browser/security results and independent review remain pending.

Local Chromium execution is already known to be blocked before browser test
bodies by the executor's Unix-socket restriction, including an approved retry;
the pinned browser archive is truncated. Neither restriction was bypassed and
this patch claims no local browser pass. Fresh full CI, including all 26 browser
cases on the new head, and independent exact-head review are required before
any merge. The complete suite now has 26 browser cases: the original 25 plus
the forced logout-gap regression. Broader M1, security and operational acceptance
remains open.
