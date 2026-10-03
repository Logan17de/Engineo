# Durable calculation API verification — 2026-10-03

## Scope and baseline

Newly reconstructed local increment on published draft #59
`b29dd49f7d16bb79ab647d7f7875222d2b384d1a`, branch
`feat/durable-calculation-api`. The unavailable unpublished checkpoint was not
recovered. No browser UI, remote branch, repository setting, credential, license,
paid service, merge or deployment was changed.

Implemented: append-only completed-result migration, immutable canonical input
and result bytes/hashes, tenant/project/audit foreign keys, transactional
authorization/current-input rechecks, atomic result/audit writes, same-key reuse
and cross-replica dedupe, current-only GET result endpoint, shared metadata and
stable result serialization, bounded self-reported Rust bridge identity and
calculation identity pin. Behavior and remaining boundaries are documented in
[the API specification](../specs/m1-durable-calculations.md).

## Executed checks

Environment: Node 24.19.0, pnpm 12.8.0, Rust 1.99.0, release bridge, disposable
PostgreSQL 17.11 on loopback. The provided helper started and stopped PostgreSQL
in the same command namespace; no DB check ran concurrently with other work.
`ENGINEO_SCHEDULER_BIN` pointed to this worktree's release executable.

| Check | Outcome |
| --- | --- |
| Frozen-lockfile official dependency installation | passed; lockfile unchanged |
| Release Rust bridge build, locked | passed |
| `pnpm check` final aggregate | passed |
| Contracts tests | 8/8 passed, no skips |
| API tests, real PostgreSQL and release Rust | 76/76 passed, no skips |
| Security script tests | 6/6 passed, no skips |
| Rust tests | 51 active passed; existing manual scale benchmark ignored |
| TypeScript, e2e typecheck, API/web production builds | passed |
| Biome format, Rustfmt, Clippy with warnings denied | passed |
| Biome lint | passed with five existing warnings and existing config-deprecation info |
| `pnpm audit --audit-level high` | passed; no known vulnerabilities reported |
| Rust/API time-zone catalogue consistency | passed |
| `git diff --check` | passed |

Next.js generated its conventional `next-env.d.ts` during the production build;
that generated change was restored to the baseline and format checks passed
again. No web source change is included in this increment.

## Meaningful acceptance coverage

- Null current result before any run, viewer read permission, authentication and tenant denial
- Genuine Rust finish/date/hash agreement, bounded metadata and atomic audit reference
- Same-key successful POST reuse without launching Rust again
- Two replica-equivalent actual Rust calculations converge on one immutable run and audit
- API restart and new DB connections restore the exact result and calculation metadata
- Revision or declared engine identity changes return both null while retaining history
- Same-key different valid result fails closed without altering the existing run/audit
- Composite tenant/project foreign-key denial and UPDATE/DELETE/TRUNCATE rejection
- Invalid stored result fails integrity checks without returning private payload
- Revoked/expired session, deleted org/project membership, and downgraded org/project role
- Committed edit during Rust work, plus changed canonical input without a revision bump
- Cancellation while waiting for a project lock and session expiry during that wait
- Audit insertion fault and result insertion fault each roll back both records
- Cancellation after audit insertion, while result INSERT is independently blocked, rolls back both
- GET cannot use a membership inserted after its earlier empty locked membership lookup
- Malformed/oversized injected output and deeply nested unknown result extensions
- Scalar ID/relationship fields reject arrays, including a 10,000-deep known-field array
- Bounded/retryable/cached engine identity handshake and real CLI identity-pin rejection
- Existing HTTP disconnect cancellation and real-engine retry remain passing

The lock-wait/grant/insert tests use real independent PostgreSQL connections and
genuine SQL results; gates coordinate delivery without substituting DB outcomes.

## Failed attempts corrected before final aggregate

- Offline-only dependency installation lacked an optional platform package's
  registry metadata; the authorized normal frozen install passed
- One new test initially compared equivalent RFC3339 spellings (`Z` and
  `+00:00`); comparison now uses the represented instant
- One new CLI test initially named a nonexistent fixture; it now uses the
  existing canonical contract fixture
- An intermediate format check found a just-edited assertion; it was formatted
  before the final aggregate

## Unrun and remaining boundaries

Browser runtime acceptance for this increment was not run locally: this executor's
Chromium launch has the previously verified Unix-socket restriction. The parent
browser increment and exact-head remote browser tests own restoration UI behavior.
Local TypeScript/e2e typechecks and production builds are not browser acceptance.

Exact-head remote CI, CodeQL query/extraction completeness, Rust dependency audit,
Dependency Review and independent full-stack approval remain publication/review
gates. No claim is made that local aggregate checks clear those remote gates.
The parent owns publication and the production acceptance ledger update.

Cancellation during PostgreSQL COMMIT is best effort; committed lost-response
results can be recovered through authorized GET. Engine identity is a declared
source compatibility fingerprint, not binary provenance or attestation. Project
deletion is restricted by retained immutable history. Async jobs, distributed
admission/tenant quotas, retention administration, signing/provenance, hardened
deployment, encrypted backups/restore drills and complete M1 acceptance remain
outside this scoped API increment.
