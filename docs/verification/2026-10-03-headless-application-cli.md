# Private application CLI verification — 2026-10-03

## PR #65 diagnostic and TLS-test remediation

This focused local correction starts at published head
`8a6df65f217504163ce5d67cd1ee2ecfb90caeb7`, tree
`579c701baca2502b4f604eadbd14e9d3896ef1ba`. It changes only CLI source/tests
and this verification record. The sections below describe earlier historical
increments; their counts are not the counts for this corrected head.

Configuration credential screening now consumes the shared duplicate-aware strict
parser's decoded value, never native JSON's last-key-wins view. Every strict
parse-failure path is reduced to the root, including underflow, excessive depth
and duplicate decoded keys in otherwise native-parseable JSON. Safe contract
issue codes, counts and character offsets remain useful. Schema diagnostics
retain field paths only after successful strict parsing and decoded credential
screening. This does not claim arbitrary secret detection or relax any shared
schema, duplicate, transport, depth or numeric rule.

The long-lived unit-test host no longer assigns
`process.env.NODE_TLS_REJECT_UNAUTHORIZED`. The negative unsafe-environment
scenario remains in the existing built-CLI TLS subprocess harness, with its
calibrated no-dial observer proving refusal before DNS/TCP. That harness also
asserts the parent's TLS environment stays unchanged. No query suppression,
waiver, trust-store change or production transport exception was introduced.

Final local checks of the corrected CLI passed:

- Real frozen pnpm 12.8.0 install: 91 packages reused, zero packages downloaded;
  unchanged release-age/build/supply-chain policies and ordinary local install
- Root formatting, lint, all workspace/e2e TypeScript checks and complete
  production contracts/CLI/API/web build: exit 0; five existing lint warnings
  and the existing Biome configuration-deprecation information item remain
- Complete CLI unit suite: **107/107**, zero failed, cancelled or skipped;
  the previous 80 tests minus the unsafe global-TLS unit test plus 27 strict
  failure regressions and one safe schema-path regression
- Real built TCP/API/PostgreSQL/Rust acceptance: **59/59**, zero failed,
  cancelled or skipped, **15517.767961 ms**; 58 subtests and their parent
- Real built TLS acceptance: **15/15**, zero failed, cancelled or skipped,
  **1609.01947 ms**; 14 subtests and their parent, including child-only unsafe
  TLS environment refusal, certificate-chain/hostname and redirect isolation

The original 18 malformed unit regressions and 18 malformed TCP regressions
remain. Nine additional native-parseable specimens run through offline validate,
authoritative validate and plan in both suites (27 additional cases per suite).
They cover the exact duplicate-shadowed escaped-tab Bearer underflow, plain and
Unicode/escaped whitespace variants, duplicate-shadowed excessive depth,
duplicate decoded keys, and an opaque key that no credential-shape heuristic
recognizes. All actual command runs require one safe versioned exit-3
`configuration_invalid` envelope, empty stderr, no credential-bearing paths,
no project POST or saved review, and unchanged revision. Safe strict issue
codes and numeric character offsets are asserted rather than discarded.

The fresh TCP run used its own uniquely named `TEMPLATE template0` fixture
database. The source database was not migrated or changed, the harness dropped
its fixture, and the coordinated wrapper stopped PostgreSQL afterward.
Sorted CLI/contracts/API source and runtime SHA-256 manifests, including the
existing real Rust executable, matched before and after that run.

This correction did not execute the API unit suite, Rust tests/Clippy, browser
acceptance, dependency audit or CodeQL. Those checks belong to the integration
owner's exact combined-head review. Local Chromium remained denied and was not
retried. No publication, merge, settings change, deployment, real identity or
credential was used. Removing the flagged source is not a claim that a new
CodeQL analysis has already passed.

### Final combined local validation

The final combined repair was validated from base
`8a6df65f217504163ce5d67cd1ee2ecfb90caeb7` with the eleven corrective paths
staged as tree `2348b9e7c9daffc7c7b388b7e271c9cfdccfff91`. It includes the
independently reviewed CLI correction, SARIF rule-resolution repair and bounded
CLI-envelope/E2E wrapper correction. The separate configuration-hardening
migration `0006` is not included. Only this results subsection was appended after
validation; every implementation byte remained unchanged.

A fresh, uniquely named `TEMPLATE template0` database was used for `pnpm check`.
The final combined local results were:

- Full `pnpm check`: **exit 0**, including all package/e2e types, production
  contracts/CLI/API/web builds, formatting, Rust formatting and all-targets
  Clippy with `-D warnings`
- Contracts **41/41**, CLI **107/107**, genuine PostgreSQL/Rust API **184/184**
  and aggregate script security **127/127**; zero failed, cancelled or skipped
- Rust **51 passed**, zero failed; one documented manual performance benchmark
  ignored, not represented as an executed pass
- Complete built HTTP **59/59**, zero failed/cancelled/skipped,
  **17429.070457 ms**
- Complete built TLS **15/15**, zero failed/cancelled/skipped,
  **1562.76619 ms**; private ephemeral fixture removal verified
- Separate e2e typecheck passed; supported browser-wrapper collection discovered
  **48 tests in 6 files**, without executing Chromium or browser scenarios
- Corrected SARIF gate against the original PR #65 report: expected **exit 1**,
  retaining `js/disabling-certificate-validation`, severity **7.5**, effective
  level **error**, at the original `cli.test.ts:577`; no suppression or waiver
- Corrected gate against the retained green actual-main JavaScript and Rust
  reports: **exit 0** and zero high/error findings for both. These are gate
  compatibility checks, not fresh corrected-head CodeQL analyses

Lint passed with the same five preexisting non-null-assertion warnings and one
Biome configuration-deprecation information item. The aggregate script run also
retained Node's existing module-type warning for the web helper. A separate
source-extracted E2E helper proof supplied by the integration owner passed
**36 checks** on **four retained real review artifacts**; it is not browser
runtime acceptance.

Before/after all eleven corrective source hashes, all **114 protected production
API/contracts/Rust/web and root configuration files**, the combined CLI/script/E2E
source manifest and the real release Rust executable were identical. The build
regenerated `apps/web/next-env.d.ts`; its exact expected diff was captured and
its baseline bytes restored before source comparison. The production build also
replaced the stale earlier `dist/run.js` with the corrected output:

- Corrected `src/run.ts` SHA-256:
  `70e1b07e5e51ac8463d732fee40617ecf389772cd0399dbd4e988816f0bb689d`
- Corrected `dist/run.js` SHA-256:
  `61dea8b1cb9288b0ebdeb479d1feb1e91fb3e54fcfecda106ea9215da13e986b`

All **49 rebuilt CLI/contracts/API runtime files** then remained byte-identical
through the complete HTTP/TLS/collection/gate execution. The old pre-build output
manifest is retained separately and is not used as the successful runtime pairing.
The full-check database and independently generated HTTP/browser-wrapper fixture
databases were removed; the existing `engineo` database and old migration ledger
were never migrated or reset. PostgreSQL was stopped and ownership released.

The original-head CI/browser failures remain failed historical evidence. No
local browser execution was attempted after the denial, no fresh corrected-head
CodeQL analysis or dependency audit was run here, and no corrected committed-head
CI result is claimed. The earlier dependency audit belongs to its earlier source
head. All 48 actual browser cases and retained GUI evidence review, fresh
exact-corrected-head CI/CodeQL/dependency gates and publication approval remain.
No publication, merge, credentials, deployment, settings or license change was
performed. The final evidence index is one-way: it excludes itself, the manifest
that refers to it and mutable summaries; old circular checksum-ledger snapshots
are retained as historical exceptions rather than reused as integrity roots.

## Scope and baseline

The private `@engineo/cli` increment was authored from reviewed main commit
`586efb4494312f584b5d56b70658866121b96566`, tree
`db66c3f72490d2a570159382c588f369576f3220`, on
`feat/headless-application-cli`. It requires the separately reviewed configuration
API increment before integration/publication. Temporary mirrored contract source
was used only to build and test this dependent increment; it is excluded from
this CLI patch. No production credentials, real identity provisioning, license
selection, publication, merge or deployment occurred.

The socket-tested API implementation matches frozen tree
`b03e4c36ff11909e0b4ade96b0d80a378dd167c5`; documentation-only updates produced
the subsequently staged tree `c9e637ee9cbc83f639e9e6b4d658c331d1e282b9`.
Its paired source/compiled hashes
appear in the acceptance manifest; this CLI increment is not a standalone
buildable extension of the baseline without that API's contracts.

The existing Rust `engineo-schedule` command and ordinary package versions remain
unchanged. The lockfile adds only the private CLI workspace importer, reusing
the already pinned contracts/Node types/tsx/TypeScript versions. A real frozen
worktree install used the existing content-addressable store, not a directory
symlink substitution.

The package also exposes `test:tls` (`node --test test/tls.test.mjs`) for a separately
owned TLS fixture which root will integrate; that fixture is not part of these
nineteen CLI-owned files. This script-only metadata alignment followed socket
acceptance and does not change its frozen runtime/source pairing.

Commands cover offline/authoritative validation, canonical read/export, caller-ID
plan, saved-review apply/cancel, status/receipt and existing Rust-backed
calculate/result. See [the CLI contract](../../packages/cli/README.md).

## Integrated local verification — 2026-10-03

The isolated integration worktree was based on published configuration API draft
PR #64, commit `2282ca2974273a40e7226bc2ed5fe1051854ef1b`, tree
`c9e637ee9cbc83f639e9e6b4d658c331d1e282b9`. All nineteen CLI-owned files,
three GUI acceptance files and six TLS fixture/evidence files were integrated
without changing production API, contracts, Rust, web or script source. The
integration owner subsequently completed the guarded API merge as main commit
`a9d67cdfb24c4fe4848f109b699de63296127ae8`, whose tree is exactly the same
`c9e637ee9cbc83f639e9e6b4d658c331d1e282b9`. The integration worktree fetched and
verified that main and was reanchored to the merge commit with its staged tree,
patch bytes and all owned file bytes verified unchanged. The checks below ran
against the API `2282ca2` implementation, identical to the merged main tree;
expensive suites were not repeated solely for the changed parent identity.

A real frozen pnpm 12.8.0 installation reused **91 cached packages**, downloaded
zero packages, passed unchanged supply-chain policies and created local
`node_modules` rather than substituting a whole-directory symlink. Tools were
Node 24.19.0 and Rust 1.99.0. A newly named synthetic `TEMPLATE template0`
PostgreSQL database was used for the aggregate check. The existing source database
and migration ledger were not migrated or modified.

The final integrated local execution passed:

- Full `pnpm check`: exit 0; formatting, all workspace/e2e types, production
  contracts/CLI/API/web builds, Rust formatting and Clippy with `-D warnings`
- Contracts **41/41**, CLI **80/80**, genuine PostgreSQL/Rust API **184/184** and
  script security **27/27**, with zero failed, cancelled or skipped tests
- Rust **51 passed**, zero failed; **one ignored** documented manual performance
  benchmark (`benchmark_m0_scale_profiles`), not an executed acceptance pass
- Explicit built HTTP acceptance **32/32**, zero failed/skipped,
  **11517.501159 ms**
- Explicit built TLS acceptance **15/15**, zero failed/skipped,
  **1586.548892 ms**; private ephemeral fixture removal was verified
- A separate e2e typecheck passed; supported `pnpm test:browser --list`
  collected **48 tests in 6 files**, including all four new CLI/GUI cases
- Normal `pnpm audit --audit-level high`: exit 0, **no known vulnerabilities
  found**, using the approved package-name/version metadata scope at the public
  npm registry
- `git diff --check` and staged-path ownership checks passed

Lint passed with the same **five existing non-null-assertion warnings** and one
Biome configuration deprecation information item. The script security run also
emitted Node's existing `MODULE_TYPELESS_PACKAGE_JSON` warning for the web helper;
this was not a failed type or build check.

Before/after SHA-256 manifests were byte-identical for all **28 original owned
files**, **109 baseline production files**, **49 compiled CLI/contracts/API runtime
files** and the actual release Rust executable. All **53 rows** in the author's
source/compiled acceptance pairing matched the integrated build, including the
corrected `run.ts` and `run.js` values. Only this verification record was then
refreshed with the integration owner's permission; every owned implementation
byte remains unchanged from the frozen inputs. Next-generated
`apps/web/next-env.d.ts` was restored. All generated test databases were removed,
PostgreSQL was stopped, and its exclusive validation ownership was released.

This supersedes the earlier local aggregate/audit gaps below. It establishes local
built CLI/API/socket verification, not actual browser execution or exact committed
head CI. Chromium execution remains unrun after the earlier denial; it was not
retried or bypassed. The **48 browser scenarios**, their retained GUI evidence,
exact-head CI and final independent CLI acceptance review remain gates. No CLI
publication, merge or deployment was performed by this integration run.

## Earlier author-side checks

- Final corrected CLI unit/security suite: 80/80 passed, zero skipped
- CLI typecheck and production TypeScript build: passed
- Focused Biome check: passed
- Workspace lint: passed with five pre-existing non-null-assertion warnings and
  Biome configuration deprecation information
- Workspace formatter plus Rust formatter check: passed
- Workspace typecheck before the diagnostic correction, including
  web/API/contracts/CLI and browser-test types: passed
- Workspace production build before the diagnostic correction: passed;
  generated `apps/web/next-env.d.ts` restored. Corrected CLI production build and
  typecheck were rerun separately and passed
- Earlier workspace TypeScript test invocation: contract baseline 8/8, CLI 59/59
  before the initial complete 60/60 and final corrected 80/80 CLI invocations,
  API 15 passed/13 skipped
  because `DATABASE_URL` was not configured for that invocation
- Existing script security suite: 23 passed/1 skipped because `DATABASE_URL`
  was not configured for the real disposable login-quota test
- `test:http` without explicit opt-in: one suite correctly skipped, not a pass
- `git diff --check`: passed

The separately tested final contract source used for local client
builds has SHA-256
`7cae8e0da515edc28efca63895d05d55902b82b78e30c9f7ac27235bfda6b545`.
The separate API verification owns its additional contract tests, PostgreSQL
boundary tests and Rust aggregate evidence; those are not attributed to this
CLI checkout's workspace test run.

## Actual socket acceptance

Final complete socket acceptance passed **32/32**, zero failed/skipped, in
**13.968 seconds** against the frozen corrected API. Source/compiled/test/Rust
SHA-256 manifests were identical immediately before and after the run. The initial
narrower 11-case and pre-review 14-case runs were superseded. The final fixture
contains thirty-one
subprocess scenarios plus its enclosing test, using the production-built Node
CLI, production-built API, real TCP transport and real Rust executable.
It creates only a uniquely named
`TEMPLATE template0` PostgreSQL database, verifies the actual name and exact
source-server address/port before migration, then drops that exact database.
The configured source database is not migrated or reset.

The exact executed command from this CLI checkout was:

```sh
/workspace/shared/engineo-native-tools/with-env.sh bash -c 'export ENGINEO_CLI_HTTP_TEST=1 ENGINEO_CLI_HTTP_API_ROOT=/workspace/shared/engineo-headless-config/apps/api; pnpm --filter @engineo/cli test:http'
```

The disposable database and temporary files were removed and PostgreSQL stopped
after the run. The complete pairing manifest is
[recorded separately](2026-10-03-headless-application-cli.sha256).

The fixture checks:

- Export/read, direct persisted snapshot, input hash and audited export parity
- Invalid/versioned/credential-bearing JSON, actor/session/CSRF/Origin and foreign
  tenant denial, explicit viewer read/validation versus forbidden mutation
- Eighteen malformed credential-key regressions across offline validation,
  authoritative validation and plan: raw, Unicode-escaped and escaped-tab
  cookie/Bearer keys produce one safe exit-3 envelope, empty stderr, no project
  POST or saved review, and unchanged persisted revision
- Complete saved plan, material/no-op apply, replay, durable cancel, receipt and
  provenance/schedule-edit audit/hash parity
- Stale intent, competing and same-plan concurrent spawned CLI applications
- Production API restart preserving review, receipt and real Rust result/metadata
- Lost post-commit plan/apply/cancel/calculation responses through a transparent
  fault proxy, with one exact authorized recovery GET and no duplicate POST
- Unavailable/pending recovery and SIGINT after real commit, never treating a
  closed socket as cancellation or rollback
- Revocation after committed apply but before lost-reply recovery, preserving
  explicit authorization denial and original `outcomeKnown:false`; a fresh same
  actor session may then read historical receipt
- Held-open auth descriptor deadline/SIGINT, proving prompt JSON exit and empty
  stderr without waiting for a writer to close its pipe
- Tampered configuration/changes/destination/digest and calculation hashes
- Session credential scanning across every CLI stdout/stderr and saved artifact
- Millisecond project setting instants (`.123Z`) through actual persistence,
  configuration and calculation input/hash checks

A real subprocess test exposed a held-pipe deadline bug during development.
Thread-pool filesystem reads could hang libuv teardown after interruption.
Dedicated already supplied pipe/socket descriptors now use nonblocking polling;
regular files remain bounded filesystem reads and device/TTY/FIFO file paths are
refused. A direct held-pipe timeout of 250 ms produced one transport exit-8 JSON
envelope and empty stderr, terminating in approximately 321 ms. The full socket
fixture retains that regression. A separate real FIFO descriptor smoke test also
returned exit 8 / `input_timeout` with empty stderr while its writer remained open.

Independent review identified a malformed-JSON diagnostic leakage bug in the
initial increment: unsuccessful ordinary JSON preflight could bypass decoded
credential screening, while the shared strict parser reported a literal key in
its diagnostic path. The correction is CLI-only. All three configuration command
paths share one helper which retains strict parser rejection and safe bounded
issue codes/counts/truncation/character-offset messages, but reports malformed
diagnostic paths at the root (`""`). Diagnostic details and complete failure
envelopes are credential-screened even offline. The fresh 80-case unit/security
run and 32-case production-built socket run include the correction; the previous
60/14 evidence is historical. Focused Biome, CLI typecheck/build, workspace
lint/format and script security checks were rerun after the correction. No frozen
API or contracts source was changed.

## Unrun and remaining gates

- No GUI/CLI 1,000-activity parity is claimed here; root integration owns that
  acceptance through exact-head CI. No denied Chromium/socket action was bypassed
- Real external HTTPS/certificate infrastructure and Windows behavior were not
  exercised; private file permission checks are documented as POSIX
- Actual socket-suite wall-clock expiry/retention, quota and maximum-payload
  stress are not established by this CLI fixture; separate API coverage does
  not substitute for a future complete CLI stress run
- The earlier CLI audit gap was superseded by the passed authorized integrated
  audit above; no alternative registry or CI route was used to bypass the earlier
  metadata-transmission denial
- Exact-head CI, actual browser acceptance and final independent CLI acceptance
  review remain root integration gates; the local full quality/security/build,
  audit and explicit HTTP/TLS checks passed as recorded above
- No scoped long-lived automation identity, credential provisioning, operational
  backup/restore/monitoring/SLO or production deployment/license gate is supplied
- Receipts establish historical terminal evidence, not current project state;
  hashes and engine declarations are not cryptographic binary attestations

This is a scoped private increment, not a production-readiness claim or a
completion claim for M0–M6.
