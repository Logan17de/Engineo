# Project configuration API v1 — local scoped verification

## Identity and scope

- Baseline: reviewed actual main `586efb4494312f584b5d56b70658866121b96566`,
  tree `db66c3f72490d2a570159382c588f369576f3220`
- Work branch: `feat/headless-project-configuration`
- This record describes the local uncommitted API increment. Parent publication,
  exact commit/tree identity, independent review and remote gates must be recorded
  before this increment is accepted; no push, merge or deployment was performed
- Public protocol: [configuration v1](../specs/project-configuration-v1.md)
- Existing headless acceptance remains [separate](../specs/headless-automation-v1.md)

Implemented existing-project configuration read/export, persistence-compatible
validate, immutable actor/session/tenant-bound reviewed plans, durable cancel,
atomic apply/no-op, historical receipts and known-identity retry/query. This uses
existing cookie/RBAC/Origin/CSRF rules plus mandatory current session intent.
There is no CLI exemption, real automation identity or Terraform provider.
Calculation mathematics and existing schedule canonicalization are unchanged;
validation explicitly returns `calculationChecked: false`.

## Executed local gates

On 2026-10-03, Node 24.19.0, pinned pnpm 12.8.0, Rust 1.99.0 and disposable
PostgreSQL 17.11 were used. The pinned helper starts/stops PG5439 in the same
execution namespace. Each final run created and dropped a uniquely named
`config_*` fixture database; production identities/data were not provisioned.

`pnpm check` passed on the final source increment:

- Biome formatting, lint and Rustfmt passed; five existing test-only non-null
  assertion warnings and a deprecated-config informational message remain
- Contracts/API/web/e2e TypeScript checks passed
- 41 contract tests passed, zero failures/skips/cancellations/todos
- 184 API tests passed with real PostgreSQL and the existing real Rust bridge;
  zero failures/skips/cancellations/todos
- 27 script/security tests passed, zero failures/skips/cancellations/todos
- Contracts/API and Next.js production builds passed
- Rustfmt, Clippy with `-D warnings`, and 51 active Rust tests passed
- The one pre-existing manual scale benchmark was explicitly ignored, not passed
- Generated `apps/web/next-env.d.ts` was restored after the build
- `git diff --check` passed; dependency declarations and JS/Rust lockfiles are
  unchanged from the reviewed main baseline
- After explicit owner approval for package names/versions disclosure to the public
  npm registry, the exact previously denied `pnpm audit --audit-level high` call
  was retried once and passed with exit 0: no known vulnerabilities reported

The final `pnpm check` execution passed on the corrected source. A subsequent
source-mode maintenance launch failed because the tsx CLI attempted an
executor-denied Unix IPC pipe; no socket bypass was attempted. The new maintenance
script was changed to the standard production-built Node entry point, matching
API start. Fresh compiled migration + one-batch maintenance then passed with
`{"schemaVersion":1,"removedArtifacts":0,"batchLimit":64}`. Its database was
created/dropped in the same wrapper command.

A separate fresh e2e typecheck and supported `pnpm test:browser --list` wrapper
passed, collecting 44 tests in five files, including the three new GUI/headless
parity cases. The collection used a genuine per-run marked fixture and observed
server pin; it did not launch Chromium or run browser assertions. Root authored
those three E2E cases separately and integrated only their test source.

The retained execution logs are local verification artifacts. They are not CI
results or immutable reviewed publication identities.

## Behavior evidence

Pure contract tests cover strict JSON grammar, decoded duplicate keys, UTF-8 and
Unicode, unsupported versions, recursive unknown properties, exact integer-token
precision, UUID-case normalization, references/cycles/calendars, native WBS-code
and relationship-tuple uniqueness, project millisecond precision, preserved
constraint strings, array permutations, complete before/after diffs, and fail-closed
1 MiB/32-container/4 MiB/8 MiB bounds. Diagnostics are bounded by count and text.
Shared review serialization and strict runtime configuration/plan/receipt/wrapper
guards pass, including the separate strict 16 MiB review-file parser. Exhaustive
16,142 property-key permutations yield the same normalized/canonical bytes and
no-op diff. Configuration normalization reconstructs every known field in native
snapshot/JSONB order rather than preserving arbitrary incoming key insertion.

PostgreSQL/API tests cover all 16 organization/project-role intersections, every
endpoint's cookie/current-intent requirement, Origin and CSRF, cross-tenant/project/
actor/session substitution, and generic foreign-native-ID rejection. Configuration
does not invoke the scheduling runner. Native reconcile tests demonstrate WBS-code
swaps/reparenting/dependent deletion, unchanged surviving entity IDs and metadata,
activity GUI order/creation times, relationship UUIDs by tuple, UUID-sorted new
activity append order, and exact canonical committed reconstruction. Material
project settings with .123/.456/.789 precision survive native persistence,
configuration/schedule exports and the GUI-loaded API snapshot; a separate real
Rust run stores the identical input hash.

Actual independent PostgreSQL locks cover committed revocation/expiry/membership
removal/role downgrade, missing-member read that cannot be rescued retroactively,
wall-clock expiry after project-lock blocking, abort while blocked, and expiry or
abort during terminal outcome insertion. Injected SQL triggers at schedule-edit
and provenance audits, plan/artifact creation and terminal outcomes prove atomic
rollback; exact retry then succeeds where appropriate. Stored canonical input,
review/diff/request hashes and receipts are corrupted only in disposable fixtures
to prove fail-closed reads/apply/replay. Native submillisecond settings reject
without hidden truncation. Later ID allocation is rechecked before apply.

Same-plan concurrent creation/apply across independent API instances stores one
review/outcome and reserves bytes once. Different material plans on one revision
cannot both apply. Cancellation/apply races produce one terminal winner. No-op
preserves revision/edit audits/native order and returns durable provenance.
Historical receipts and exact replay survive TTL, collected review data, later
edits/unsupported current input and app/database-client restart while reauthorizing.

A real loopback HTTP test destroys a response only after the apply transaction
commits, then queries the known plan receipt and exactly retries through a restarted
app/client. Separate real HTTP tests submit malformed original UTF-8 bytes and an
escaped lone surrogate, observing 422 with no mutation/plan/credential leakage.
These are socket API tests, not built application-CLI or browser parity evidence.

SQL storage tests allocate real integrity-hashed, JSON-valid padded artifact bytes
up to the independent 128 MiB/project and 1 GiB/global logical ceilings. These
fixtures are intentionally not application-normalized schedule reviews; they test
the native storage guard, are completely rolled back and do not claim physical
PostgreSQL disk usage. Counter drift, concurrent cross-project admission and
reservation rollback fail closed. Admission/release no longer recomputes retained
table SUMs: protected exact byte/count transitions and O(1) scoped state-hash checks
run under global→project locks. Direct reset/rekey/INSERT/DELETE/TRUNCATE and a
forged nested writer reject. Stale byte/count state and missing global or nonempty
project counters reject admission/release without reinitializing retained data.
Hashes are non-secret consistency checks for trusted migration/application
transitions; privileged DDL/trigger bypass or coordinated state/hash forgery is
outside that boundary. Cleanup tests demonstrate exact 64+16 batch
collection, byte release, compact receipt/identity preservation, injected cleanup
failure rollback, SKIP LOCKED and concurrent reader/maintenance/admission ordering.
Migration tests exercise immutable UPDATE/DELETE/TRUNCATE restrictions, retained
artifact rules, composite project/session/audit references and audit bindings.
EXPLAIN ANALYZE demonstrates stable indexed empty/eligible collection and bounded
actor-created/project-created-or-expiry range probes with 2,048 archived identities,
distinguishing a dead index entry from live output. Repeated plan/cancel cycles
prove exact min(created+15m,session expiry), with one materialized clock stamp.

Independent source review identified the incoming-key-order,
volatile-cutoff/unbounded SUM, missing-counter initialization and duplicate clock
stamp issues. These were corrected before the final rerun; earlier green gates alone did not
establish those properties. Final exact-source review remains a parent gate.
Subsequent narrowly corrected fixture assertions distinguish PostgreSQL bitmap
index dead entries and legitimate indexed planner alternatives from live rows.
The final counts above include all corrected regressions.

## Blocked, ignored and never-run checks

- The separate local npm audit was initially rejected before execution for
  unapproved dependency-metadata disclosure. The owner explicitly approved sending
  package names/versions to the public npm registry at 10:51 UTC, with no source
  code or credentials. The exact denied call was then retried once and passed,
  exit 0, with no known vulnerabilities reported. No alternate destination or
  indirect workaround was used. Fresh exact-head CI auditing remains required
- New-head remote CI/browser, CodeQL extraction/query gates and Dependency Review
  are never run until parent publication/approval. Reviewed main's green gates do
  not clear the new increment
- Local Chromium remains unavailable due the previously verified executor Unix
  socket restriction; no browser bypass was attempted
- Rust minimum-compiler execution and a new Rust dependency audit were not run
  locally; Rust sources/dependency inputs are unchanged, and fresh CI must verify
  the required matrix
- Application CLI authoring/production-built HTTP acceptance is a separate
  increment. This API record does not establish its runtime outcome. The three
  new 1,000-activity/configuration cancellation/denial browser cases are implemented
  and collected but runtime-unrun locally; combined built CLI/API/Rust/export/GUI
  acceptance remains gated on separate execution
- No new performance, RSS, latency, physical disk/WAL, archival, production
  maintenance deployment, encrypted backup/restore or operational release claim
  is made. M0–M6 and the operational/license/production gates remain incomplete

## Shared timestamp correction and audit compatibility

The only existing scheduling reader changes are its three project-setting instant
fields: PostgreSQL Date objects now use Date.toISOString directly, avoiding
String(Date)'s millisecond loss. Private configuration timestamp handling does the
same. Legacy canonical serialization and Rust math remain unchanged; no migration,
revision bump or data/result/audit rewrite is performed by this correction.
Previously saved .000-key calculations remain immutable historical evidence and
are not returned/reused for corrected nonzero-millisecond input at the same
revision. Real Rust regression tests prove current result reads return null until
a new corrected-input run is committed while the old row/audit stay exact.

Material configuration edits use the established `project.schedule.edit` action,
with a compact explicitly versioned `engineo-configuration-schedule-edit` payload,
operation `configuration.apply` and hash basis `engineo-schedule-input-v1-canonical`.
It carries canonical base/committed hashes, revision/previousRevision, plan/digest/
session identity without inventing the legacy edit payload's JSON.stringify
beforeHash/afterHash or full snapshots. SQL bindings and tests enforce that format;
no-op emits neither material-edit action. Complete reviewed changes have the
explicit bounded artifact retention horizon.

## Retention and known operational tradeoffs

Pending limits and byte admission are shared SQL state, not process-local timers.
Heavy review becomes collection-eligible at 24h; at most 64 expired artifacts are
collected per batch. Lack of traffic can delay deletion, while the hard logical
byte ceilings prevent unbounded heavy-artifact admission. A separate one-batch
maintenance command is implemented but has not been installed/scheduled in a
production environment. Compact immutable identities/receipts prevent reuse and
retain referenced project/user/session/audit rows. Revocation works; physical
session/account deletion, history archival and finite total database growth need a
separately reviewed lifecycle design. Hashes/digests are consistency evidence, not
credentials, human-review proof or cryptographic binary attestation.
