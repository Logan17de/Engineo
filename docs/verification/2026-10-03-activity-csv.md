# Activity CSV increment — 2026-10-03

Base: PR #57 / `fix/rust-security-coverage`,
`c8bd175875b4514d65549814fd56b5c2d461338e`.
Branch: `feat/planner-csv-roundtrip`. The draft PR records the exact review SHA
and remote CI state. Existing branches and `main` are unchanged by this increment.

## Scope

Partial #51: authorized activity CSV export, strict bounded parsing, existing-row
updates, paginated before/after preview, explicit apply, optimistic concurrency,
transactional provenance and before/after audit. Omitted activities, constraints,
WBS, calendars, relationship identities/logic and project settings are preserved.
See [format and API specification](../specs/activity-csv-v1.md).

No new dependency, lockfile, database migration or Rust source change.

## Executed local checks

| Check | Result |
| --- | --- |
| Frozen pnpm install | passed with pnpm 12.8.0 |
| All workspace TypeScript checks and browser-test typing | passed |
| Contracts suite | 7 passed, 0 skipped |
| Full API suite with PostgreSQL and actual release Rust binary | 47 passed, 0 skipped; includes five parser tests and five CSV integration subtests |
| Production API/web build | passed |
| Full production-browser suite | 23 passed in 48.0 s; 18 existing cases + five CSV cases |
| Biome formatting/lint | passed; existing configuration deprecation and five pre-existing non-null-assertion warnings remain |
| Rust formatting | passed; no Rust source changes |
| Security gate regression scripts | 6 passed |
| Visual inspection | captured and inspected the actual preview page; before/after table, focused preview, counts and apply/cancel controls visible |
| New-head remote CI / CodeQL / dependency review | not claimed by local checks; inspect the draft PR checks |

CSV coverage includes Unicode, quoted multiline/doubled quotes, optional BOM,
formula/apostrophe text round trips, malformed headers/quotes/rows, UTF-8 byte and
row/field bounds, unsupported values, duplicate/foreign IDs, omitted-row
preservation, exact downloaded-byte/audit digest agreement, unauthenticated and
viewer writes, session mismatch, foreign project exports, Origin/CSRF denial,
permission removal after preview, no-op behavior, audit-failure rollback,
concurrent/repeated apply, real-Rust recalculation, keyboard preview/apply,
offline preview/retry, cancellation, unsaved-edit gating, stale conflict/reload,
lost committed response/retry, and 1,000 edits with 50-row review pagination.

The 1,000-activity browser preview, next/previous review page, apply and persisted
snapshot verification took **575.7 ms** in one warm local run. This is descriptive
evidence, not a production latency target or repeated benchmark.

## Environment and first-attempt findings

- Fresh isolated checkout in the current cloud workspace, not the previous
  saved cloud VM. Node 24.19.0, pnpm 12.8.0, Rust 1.99.0, PostgreSQL 16.15 on
  loopback port 5438; Linux x86_64 AMD EPYC 9V74, 9 visible CPUs.
- Playwright 1.63.0 drove a temporary Chrome 154.0.8037.97 executable through the
  repository's existing `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` override. Both
  attempted Playwright archive versions returned invalid/truncated downloads;
  the official Chrome Debian package worked. The pinned CI browser and PostgreSQL
  18 remain separate remote validation.
- Initial API test assumptions were corrected: Origin rejection needs an
  explicit configured origin, and Rust returns activities as an ID-keyed object.
- Initial browser testing exposed a real export bug: `Response.text()` removes
  a UTF-8 BOM, making downloaded bytes differ from the audited export. The text
  response path now decodes an ArrayBuffer with `ignoreBOM: true`; the exact
  downloaded-byte test passes. Test error selectors were also scoped to the
  application's named alert to exclude Next's route announcer.
- The shell initially selected the runtime's pnpm 11 wrapper. Checks use the
  repository-pinned pnpm 12.8.0; no package versions or policies were relaxed.
- Direct git push authentication is unavailable here. Publication uses the
  connected GitHub repository tools with the same base tree and scoped changes.

## Limits and next work

- No native Excel/LibreOffice manual resave certification, XLSX parser, WBS or
  relationship import templates, new/deleted activity import, or complete project
  CSV backup. #51 remains open.
- File size is capped at 512 KiB; large exports require separately previewed
  subsets. This run does not prove maximum-size concurrent-import performance.
- No production deployment, repository security setting change or merge. Prior
  review records report Dependency Graph disabled; exact new-head status must
  be read from GitHub. Owner/PM/release gates in `ACCEPTANCE.md` remain in force.
