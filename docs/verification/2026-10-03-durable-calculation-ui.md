# Durable calculation restoration — 2026-10-03

Newly reconstructed increment from reviewed recovery head
`b29dd49f7d16bb79ab647d7f7875222d2b384d1a`, now reconciled onto corrected main
`54678e0e055d9450f328541b2551a1372b9ba3b3` / tree
`b2a52da18c7df2fdc5602d2263049677a99bae96`.
Branch: `feat/durable-calculation-recovery`. The unavailable unpublished
`149286af790dcdb8580f62f671a1f64236b8b316` checkpoint was not recovered or
silently replayed. The draft PR records the exact published SHA/tree/checks.

## User-visible behavior

- Current saved dates, Gantt and calculation provenance restore on project open
  or reload, including authorized viewers without recalculation permission
- Every restored result must match the loaded project revision, declared
  contract/engine metadata, canonical input SHA-256 and canonical result SHA-256
- Unsaved edits and restored expiry drafts clear previously calculated dates;
  saved dates cannot be attached to unsaved input
- Before every calculation, read the authoritative saved snapshot and require
  the intended revision. This also handles a confirmed save followed by a failed
  normalization/read without repeating the edit
- Interrupted transport, truncated committed JSON, or unclassified server
  responses recover through an authorized matching GET, without a blind second POST
- Explicit engine integrity/conflict/limit failures remain errors, clear dates
  and cannot be converted into a successful cached calculation
- Transient optional result-read failure keeps the saved plan editable with a
  retry notice. Stored integrity errors are surfaced. Startup expiry after a
  verified identity clears the partly initialized account/workspace
- Delayed reads cannot repopulate an old account after a session change

The backend commit/recheck/dedupe and immutable-history semantics are described
in [the API specification](../specs/m1-durable-calculations.md) and
[API verification](2026-10-03-durable-calculation-api.md). No new scheduling
mathematics, dependency/lockfile change, async queue or production deployment.
The source compatibility fingerprint is declared FNV-1a identity, not binary
attestation. Input/result integrity hashes are SHA-256.

## Executed combined local checks

| Check | Result |
| --- | --- |
| Release bridge and generated time-zone catalogue | passed, locked Rust 1.99.0 |
| Full combined `pnpm check` | passed: contracts 8, API 76, security/consistency scripts 11, all TypeScript/e2e typing, format/lint, API/web production builds, Rustfmt/Clippy and 51 active Rust tests |
| Skips | no contract/API/security skips; one existing manual Rust scale benchmark ignored |
| JavaScript high-severity audit | passed; no known vulnerabilities reported |
| Final TypeScript/build/test gate after retry/500-response refinements | passed again: contracts 8, API 76, security/consistency scripts 11, all typing/format/lint and both builds |
| Browser-test collection | 39 cases across four files after the independently reviewed fixture correction; collection is not behavioral execution |
| Local browser runtime | unrun behavior: verified Chromium Unix-socket launch restriction and truncated pinned Playwright downloads remain |
| Remote exact-head CI/CodeQL/extraction/dependency/browser gates | pending publication; inspect the draft PR |

The five pre-existing Biome warnings and configuration deprecation remain;
generated Next.js declarations are restored and excluded from the increment.
No sandbox or network restriction was bypassed.

Twelve initial restoration cases plus an unclassified committed-500 response
case cover persistent reload/provenance, viewer read-only behavior, post-save
read failure and no-repeat edit, lost/malformed response and no duplicate audit,
explicit integrity conflict, optional read retry, stored integrity failure,
startup 401, concurrent-revision reads, dirty recovery and delayed account switch.
Existing 26 CSV/Planner/session cases remain required, including 1,000 activities
and the forced logout-gap regression.
The CI workflow retains a screenshot of actual provenance and failure traces for
seven days so visual inspection is possible after remote execution.

## Independent source review findings resolved

Review caught byte differences between draft and persisted v1 inputs (activity
property order and RFC3339 spelling). Canonical v1 was not silently changed;
all calculations now verify the authoritative saved snapshot, including retries.
Review also caught overly broad 5xx recovery hiding explicit engine drift,
truncated JSON not being treated as ambiguous, partially initialized startup 401,
an insufficient concurrent-read barrier, differing engine-version bounds, and
an ambiguous hidden new-project date selector. Code and regressions address each.
Pure consistency tests cover reordered JSON keys, changed inputs/results,
malformed metadata, revision mismatch and the 128-character engine identity rule.
Source review and test collection are not substitutes for the remote browser run.

## Populated disposable backup/restore drill

The previous missing-client limitation is resolved in this cloud executor.
Official Debian PostgreSQL 17.11 client tools dumped a disposable database to
custom format and restored it into a new empty database. A representative fixture
contained a 1,000-activity project, a genuine Rust calculation, live owner/session
permissions and linked audits. All 16 tables' ordered row SHA-256 inventories
and counts matched: 1,042 total rows. An authenticated restored API GET reproduced
the exact result, calculation ID/timestamp/hashes and provenance.

One warm local run: dump 161,602 bytes; dump 68.4 ms, restore 79.7 ms. These are
descriptive fixture measurements, not production RPO/RTO. The first trial used
only leftover sparse test data and was not counted as representative acceptance;
the populated drill above is the relevant evidence. No production data, encrypted
backup automation, separately scoped backup identity, retention policy or disaster
recovery SLA was established. Baselines are not yet implemented/tested.

## Review and remaining scope

The corrected #53–#59 foundation was independently reviewed and merged atomically
in PR #60 at `b36ecc4`, exactly the reviewed `f626302e` tree. Its main-push suite
then exposed an existing held-identity fixture phase race (24/25 cases).
The separately reviewed test-only PR #62 passed fresh CI `37104811376` with all
26 cases, CodeQL `37104811379` and Dependency Review `37104811438`. Retained phase
evidence shows real logout-gap 401s, verified B200 fault injection and A200
restoration. Route callbacks are drained before evidence/teardown.
PR #62 was merged at `54678e0e055d9450f328541b2551a1372b9ba3b3`, exactly tree
`b2a52da18c7df2fdc5602d2263049677a99bae96`; all prior branches remain preserved.
Independent actual-main CI `37105521355` and CodeQL `37105521386` subsequently
passed at that exact main checkout: all 26 browser cases in 49.9 seconds, both
language query gates with empty high/error findings, and 19 clean Rust sources /
zero errors / 19 individually matched expected files. Retained browser and SARIF
digests match GitHub metadata; actual-main phase evidence confirms the real
401→B200→A200 sequence. That failed post-merge loop is closed. This durable
increment remains separate for its own exact-head review and fresh 21-file Rust
coverage (build/identity test files are new).
Dependency Graph was enabled by an explicitly authorized settings-only action;
new-head dependency/security gates still must run rather than be inferred.
The durable increment is not merged or deployed.

M1 progress, richer views/grouping/sorting, fuller interchange and identity
administration remain incomplete, as do M2–M6, distributed quotas/jobs, release
packaging/provenance, encryption, operational backup/restore and production
deployment. This is a scoped durable-completed-result increment, not a release.
