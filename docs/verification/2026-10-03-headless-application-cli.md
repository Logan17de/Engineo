# Private application CLI verification — 2026-10-03

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
