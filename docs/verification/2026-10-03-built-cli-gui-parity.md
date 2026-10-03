# Built application CLI → API → GUI acceptance increment

Date: 2026-10-03. Private, unpublished integration work based on main
`586efb4494312f584b5d56b70658866121b96566`.

## Verification status

This record describes implemented acceptance source and successful **static
checks / test discovery**, not a completed browser or database execution.

- Root e2e TypeScript compilation passed with the frozen configuration API and
  shared contract integrated into the isolated test worktree
- Biome check passed for `e2e/cli-configuration.spec.mts`
- Playwright `test --list` discovered **48 tests in 6 files**, including all four
  new built-CLI scenarios and the existing 44 browser scenarios
- The CI change is two adjacent explicit opt-in HTTP and TLS acceptance steps
  after `pnpm check:ts`, which already builds the workspace packages
- No PostgreSQL process, application server, Chromium process, live browser
  scenario, audit, CI run, publication, account provisioning or deployment was
  started for this increment
- Runtime PNG/JSON evidence has **not** been generated locally. The filenames
  below are the deterministic output/attachment contract for the future run

The corrected CLI source/generated entry point was recopied and verified against
the CLI author's final SHA-256 pairing before the final static checks. The
separately owned TLS fixture and `test:tls` script were also confirmed as
integration inputs; they are outside this three-file test increment's ownership.

The configuration API source is the authoritative frozen 20-file input recorded
by the integration owner, tree `b03e4c36ff11909e0b4ade96b0d80a378dd167c5`.
This test increment does not modify that API, the shared contract, the CLI or its
private-session protocol. It must be integrated on top of both API and CLI
increments; applying it alone to old main is insufficient.

## New executable scenarios

`e2e/cli-configuration.spec.mts` starts the built Node entry point
`packages/cli/dist/main.js` in real subprocesses. Missing build artifacts fail
rather than silently skipping. No call to the CLI implementation's `runCli`,
Fastify injection or mock HTTP transport stands in for a command execution.

1. **1,000 activities and native parity.** The built CLI exports an existing
   project's configuration to a file, validates a changed full configuration
   offline and authoritatively, saves the complete review, exactly replays its
   caller-selected plan ID to a second file, queries status, applies and exactly
   replays the apply, and reads the receipt. A new synthetic live session for the
   same actor can read the same historical receipt. The test then queries the
   absent result, calculates through the real HTTP/Rust API, and reads the saved
   result. Input and result SHA-256 values use the shared canonical serializers.
   The result and engine version must also match an independent invocation of the
   explicit built Rust scheduler on that committed input.

   The project planned start, data date and required finish retain native
   `.123`, `.456` and `.789` millisecond instants. Preserved activities retain
   their UUIDs, native sort order and creation timestamps; one removed activity
   is replaced with one new native UUID at the end. Relationship UUIDs and
   project code/description remain unchanged. The real GET responses consumed
   by a GUI reload must contain identical committed content, all native IDs in
   persisted order, project revision/metadata and complete calculation/result
   provenance. Visible first/second/last rows, WBS selection, Rust dates, Gantt,
   project code and saved provenance must agree. Exact audit counts prevent a
   replay from introducing extra plan/apply/calculation events.

   Canonical configuration activity order is UUID-based; the GUI's native
   display order is checked against preserved database sort order separately.
   The test deliberately seeds a different native order so an accidental full
   rebuild/reordering cannot pass by coincidence. Engine version equality is a
   compatibility check, not executable attestation.

2. **Competing saved revisions in both directions.** A saved CLI review loses
   to a newer real GUI save with exit 4 / `revision_conflict`. A newer CLI commit
   then causes the old GUI draft's actual PUT save to return 409. The GUI retains
   its unsaved text, shows the conflict and no calculated dates, and cannot
   overwrite the CLI commit. An explicit confirmed reload restores the CLI
   revision. Only the winning CLI apply and winning GUI calculation are audited.

3. **Cancellation and exact replay.** The built CLI calculates the initial
   revision, cancels a saved review, exactly replays cancellation, queries its
   historical receipt and receives the explicit cancelled conflict when apply
   is attempted. GUI reload must still use the unchanged original revision and
   the identical saved Rust result/calculation ID. Cancellation has one audit;
   configuration apply has none.

4. **Authorization and immutable session binding.** A viewer may read but its
   built-CLI plan and calculation receive server-side 403. A foreign actor's
   read receives 403 without project content. Viewer and changed-session plan
   queries receive actor/session-scoped 404. Another session for the same actor
   cannot apply the saved original-session review. Revoking the original
   disposable session causes CLI read to fail with 401. The viewer GUI remains
   read-only and the owner's GUI stays on the unchanged revision. No denied
   command creates an apply or calculation audit.

## Authentication and evidence handling

All users, passwords and sessions are explicit synthetic test fixtures in the
browser wrapper's uniquely named, server-pinned disposable database. Before
migrations/seeding, this suite verifies the wrapper's database/run guard.

The CLI never extracts browser cookies or real credentials. Each CLI session
file is explicitly created under a private OS temporary directory outside the
checkout and test-results directory, with exclusive creation and mode 0600.
Only these disposable fixture descriptors are passed through `--auth-file`.
Subprocess environments contain no database URL, inherited account credential
or token. The fixture revokes its issued sessions and removes its private
directory in teardown, including after a failed test. The outer browser wrapper
continues to own disposal of the entire fixture database.

Every CLI stdout/stderr and every retained configuration, review and evidence
JSON is checked for the known disposable tokens/password and session cookie or
credential-property text before it is parsed, asserted or written. Token values
are never used as assertion diagnostics. Credential filenames/arguments are not
recorded in evidence; only command names are retained. Trace, video and automatic
screenshots are disabled for this spec because archives can contain login bodies
and cookie headers. Explicit PNG screenshots show the signed-in Planner state.

Stable evidence names under the normal ignored `test-results/` output include:

- `cli-gui-1000-parity.json` / `.png`, containing the committed configuration,
  receipt, full native order/identity record, GUI-loaded IDs, result/provenance,
  independent native result hash and audit counts
- `cli-gui-1000-last-native-row.png`
- `cli-gui-1000-provenance.png`
- `cli-gui-stale-draft-retained.json` / `.png`
- `cli-gui-stale-authoritative-reload.json` / `.png`
- `cli-gui-cancelled-replay.json` / `.png`
- `cli-gui-viewer-denial.json` / `.png`
- `cli-gui-session-denial.json` / `.png`

Exported configurations and complete saved/replayed review JSON also remain in
the test's output directory. The existing CI artifact step retains this
`test-results/` directory; no new upload destination or artifact permission is
introduced.

## CI and remaining runtime gate

The two adjacent workflow insertions after quality checks are:

```yaml
- name: Built application CLI HTTP acceptance
  run: ENGINEO_CLI_HTTP_TEST=1 pnpm --filter @engineo/cli test:http

- name: Built application CLI TLS acceptance
  run: ENGINEO_CLI_TLS_TEST=1 pnpm --filter @engineo/cli test:tls
```

The browser acceptance step automatically includes the new spec. The explicit
HTTP opt-in prevents the dedicated socket/PostgreSQL/Rust acceptance test from
remaining skipped in CI. The separately owned real HTTPS acceptance is also
explicitly enabled through `ENGINEO_CLI_TLS_TEST=1`. HTTP acceptance uses its
own disposable database and the existing
built Rust executable; browser acceptance retains its separately guarded
fixture database and production-built API/web servers.

Remaining checks are the exact integrated-head full quality/build run, explicit
CLI HTTP/TLS runtime, all 48 browser scenarios with the real built CLI/API/web/Rust
artifacts, review of retained evidence, and CI/dependency audits when authorized.
A local Chromium execution was previously denied; it was not retried or bypassed.
This worker did not run dependency audits or trigger CI. Exact integrated-head
execution and publication remain with the integration owner and their permission
gate; no denied source upload or browser execution was retried or bypassed.
Static success does not establish
runtime success, deployment readiness, or permission to publish/trigger CI.
