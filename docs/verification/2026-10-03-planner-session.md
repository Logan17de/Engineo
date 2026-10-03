# Planner account/session reconciliation

Resumed in the same saved Engineo cloud environment on 2026-10-03 after the
owner explicitly approved retrying following the historical quota error. A fresh
limit would stop work. Saved worktrees, Node 24.19.0, pnpm 12.8.0, Rust 1.99.0,
PostgreSQL 18.4 and Chromium 151 remained usable. No old web/API process was
listening; prior process entries were zombies. The disposable UI database is
`engineo_ui_guard` on loopback. No user-PC files or production access were used.

PR #56 head `898863995600bf2ea329f49619ebf1c0b8d936c9` was rejected by PM
review despite passing CI/security-query gates: another tab could change the
shared cookie while the Planner displayed the old identity, and explicit logout
after expiry could restore a deliberately discarded draft. The correction is
isolated in `/workspace/engineo-ui-review`, on `feat/planner-workspace`. Approved
PR #54 `de1b88f9efbccb1e536f625fbb99cb2a6e1a88fc` and PR #55
`f53c2619c414650b95487611aa19d83c7454a376` are unchanged. Unpublished durable
result work remains separate in `/workspace/Engineo`.

## Executed checks

```bash
pnpm install --frozen-lockfile
DATABASE_URL=<disposable-loopback-database> \
  ENGINEO_SCHEDULER_BIN=<built-engineo-schedule> pnpm check:ts
DATABASE_URL=<disposable-loopback-database> \
  ENGINEO_SCHEDULER_BIN=<built-engineo-schedule> \
  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium pnpm test:browser
pnpm audit --audit-level moderate --json
git diff --check
```

API, Next production builds, source formatting/lint/typechecks passed. Contracts
have 7 passes; API has 36 passes, including the new real-session/server-binding
regression; fail-closed SARIF regressions have 2 passes. No tests were skipped.
After the final recovery/tab-observation fixes, the full `check:ts` gate was
rerun successfully. All 11 production-mode Chromium browser cases passed
in 32.4 seconds with zero retries/skips and no unhandled page errors. The original
five Planner/error/retry/recovery/export cases remain, including same-account
expiry recovery. The moderate-threshold JS audit reports zero vulnerabilities.
New exact-head CI/security results and PM review are required before merging.

## Additional genuine browser cases

Each case creates unique local fixture users and uses two pages in the same
browser context, with shared real cookies, real login/logout and PostgreSQL.
No authentication, RBAC, scheduling result or database response is fabricated.

- Shared project: B has planner/write permission. Changing accounts clears A's
  tab and draft; a request with B's actual cookie/CSRF and A's old session binding
  returns 409 without mutation. A deliberately B-bound edit succeeds and its
  audit actor is B.
- Forbidden project: B has no membership in A's organization/project. The old
  tab clears; B's direct project read returns 403 without schedule data.
- A genuine authorized project response is held before delivery. B logs in;
  delivering the old response cannot repopulate A's workspace. BroadcastChannel
  is unavailable in this case to exercise cookie/focus checks.
- A genuine save commits and is audited as A before its response is held. After
  B logs in, delivery cannot calculate using B's session or restore A's state.
  The committed A edit remains, correctly attributed. No cancellation promise
  claims that a committed mutation can be undone.
- A delayed initial `/auth/me` response cannot restore the previous account
  after another tab changes the session.
- A accepts discard and signs out after real session revocation. Subsequent
  same-account login loads saved data and never restores that discarded draft.

The server regression also verifies that mismatched bindings cannot read/export,
save, calculate or log out the replacement session. It verifies the replacement
session remains live and an explicitly matching writer can save with the correct
audit attribution. Binding checks supplement session/CSRF/RBAC, not replace them.

## Failures and follow-up evidence

An initial 11-case run passed 9 and failed 2. A keyboard observation awaited an
activity DOM node after virtualization removed it; the test now observes the
active element without waiting for an absent row. The final case navigates by
Enter/Tab, focuses activity 1,000 and types its name using keyboard events.
There is no Playwright `fill` for that edit. The delayed-save case exposed a
transient recovery while the shared cookie was empty between logout and login;
pending recovery now verifies a new cookie's immutable account and discards it
for a different account. Targeted reruns passed 2/2, then the full 11/11 passed.

The prior axe 4.12.1 evidence was retained and inspected at
`/workspace/scratch/engineo-planner-a11y.json`, SHA-256
`45d648ebdb9176c3d5ca38275540c07bf39eb8d256cf3d7d042c0491ab3a2bc8`.
It records zero violations, 43 passes and one incomplete contrast rule on 10
gradient-backed nodes. The conservative color checks are in the previous
[browser record](2026-10-02-planner-browser.md). This is evidence for that scan,
not fresh automated axe coverage of every new session state or screen-reader
certification.

## Security coverage and remaining gates

CodeQL run `37021742356` on the old PR #56 head passed both high/error SARIF
query gates. Inspection of the actual Rust job log confirms **17 files extracted
without error and 2 with errors**, with unbuilt proc-macro diagnostics in
`crates/scheduling/src/io.rs` and `crates/scheduling/tests/conformance.rs`.
Complete Rust extraction has therefore failed; a green query gate does not
establish full coverage. Remediation and exact-head extraction metrics remain
open; nothing is suppressed or described as cleared.

Dependency Review `37021742359` failed because Dependency Graph is disabled.
The owner's permission is unanswered; no setting or merge is changed. Production
proxy/ingress quotas/timeouts, durable results, remaining M1 workflows, later
roadmap capabilities and operational gates remain pending in `ACCEPTANCE.md`.

## Independent review follow-up

The first correction was published as `0f18291829aa28ca1d276044243d92b75bb77f65`.
Its CI `37083434654` passed all 11 browser cases, Rust checks and both audits.
CodeQL `37083434608` passed the query gates but still had 17 clean / 2 erroneous
Rust files. Dependency Review `37083434645` failed on the disabled graph.

Independent review found two further P2 behaviors and requested changes:
login broadcasts discarded a same-account expiry draft, and a failed or hung
fallback identity probe could leave old data visible. Both are corrected in a
separate follow-up commit on this PR. A definite changed cookie now clears
visible state and cancels old operations immediately. A bounded five-second
probe only decides whether original-account escrow may remain; failures cannot
repopulate a workspace or block later deliberate sign-in. Login notifications
preserve scoped escrow until identity verification; explicit logout carries
discard intent. Fresh initialization consumes it only with current write
permission, and retains the original revision for conflict checking.

Five additional production-browser cases exercise same-account reauthentication
with retained or removed write permission and unavailable/offline/held identity
verification without BroadcastChannel. All five passed in 16.2 seconds. The
held case verifies an actual B response, leaves it undelivered past the probe's
deadline, then delivers it after deliberate A reauthentication; it cannot
restore B or overwrite A's recovered workspace. Identity and RBAC use real
cookies/PostgreSQL; the 503/offline failures are deliberate fault injection.

An initial targeted run passed the two reauthentication cases and failed three
test selectors because Next also has a route-announcer alert. Selecting the
labelled Engineo error alert fixes the ambiguity; the targeted 5/5 rerun passed.
The final full `check:ts` gate passed again (7 contracts, 36 API, 2 SARIF
regressions and both builds). All 16 production-browser cases passed in 45.8
seconds, zero retries/skips/unhandled page errors. New exact-head CI/PM review
is required before merging. Rust extraction remediation is isolated on a
separate branch.
