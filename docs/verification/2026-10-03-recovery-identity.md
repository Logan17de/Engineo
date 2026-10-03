# Verified-account recovery boundary — 2026-10-03

Base: draft PR #58, `feat/planner-csv-roundtrip`,
`bd85a6f8ee4b559376db475cedcbd04d74651314`.
Branch: `fix/planner-recovery-identity`. Existing stack branches and `main`
are preserved; the draft PR records the exact published review SHA and CI.

## Correction

Addresses [PM review of PR #56](https://github.com/Logan17de/Engineo/pull/56#issuecomment-5964211525).
`initialize()` now discards recovery belonging to another immutable user ID
immediately after accepting a guarded `/auth/me` response and binding its session,
before requesting organizations or projects. A later organization-loading failure
cannot keep the previous account's recovery notice/unload warning or let a later
login resurrect that draft. Same-account recovery remains available after transient
loading failures and still requires current project access/write permission.

No API, schema, dependency, lockfile, Rust calculation or repository-setting change.
This fixes a client discard boundary; the review did not demonstrate an API
authorization bypass.

## Executed local validation

| Check | Result |
| --- | --- |
| Frozen dependency install | passed, pinned pnpm 12.8.0 |
| Full `check:ts` | passed: format/lint, all workspace and browser-test typing, 7 contract tests, 47 PostgreSQL/real-Rust API tests, 6 security regression tests, both production builds |
| Full `check:rust` | passed: rustfmt, Clippy with warnings denied, 50 active tests; one manual scale benchmark ignored by the existing suite |
| JavaScript high-severity dependency audit | passed, no known vulnerabilities reported |
| Final browser-test typing/formatting after test synchronization refinement | passed |
| Local production-browser execution | blocked before test bodies by Chromium Unix-socket denial; no behavioral pass claimed |
| Exact-head remote CI/security/browser checks | pending publication; inspect the draft PR |

The existing Biome configuration deprecation and five non-null-assertion warnings
remain. No new lint errors were added.

Two combined browser regressions use real login cookies, immutable identity,
PostgreSQL sessions and persisted project state. They hold organization I/O after
real identity verification, check the notice and unload guard before releasing a
503, keep all later identity probes unavailable, and attempt original-account
login afterward. The different-account case must not restore the draft; the
same-account case waits for a settled failed fallback probe and must retain it.
Both assert that the database revision and saved activity were unchanged.

## Executor findings and limits

This fresh cloud checkout uses Node 24.19.0, pnpm 12.8.0, official Rust 1.99.0
and disposable Debian PostgreSQL 17.11 on loopback. Runtime dependencies were
installed under the cloud workspace, with no host system installation.

The first database/browser attempts could not reach a database started in a
different command sandbox. Validation now starts PostgreSQL and test processes
in the same command namespace and stops the database afterward. Chromium
154.0.8037.57 fails at startup with `socket() failed: Operation not permitted`;
the approved escalation retry has the same restriction. The pinned Playwright
Chromium archive also downloads as an invalid/truncated ZIP. No sandbox or
security setting was changed to bypass either restriction. CI's pinned browser
and PostgreSQL 18 remain independent, required exact-head execution evidence.

At reconciliation, PR #58 CI `37098688583` and CodeQL `37098688578` passed.
Dependency Review `37098688595` failed on the existing disabled Dependency Graph
setting. That gate is not waived. This correction still needs independent
exact-head review; all merges and production deployment remain held.

## Previously unpublished durable calculations

The previously reported local checkpoint
`149286af790dcdb8580f62f671a1f64236b8b316` is not retrievable from GitHub:
the commit endpoint returned 422 / no commit found during reconciliation. Its
source checkout and handoff are not present in this executor. It has not been
recovered, published or counted as current acceptance. A later durable-calculation
increment must be freshly reconstructed from the reviewed current stack and
revalidated, with this gap retained in its evidence.

Remaining M1 workflows, M2–M6 and operational release gates remain incomplete.
