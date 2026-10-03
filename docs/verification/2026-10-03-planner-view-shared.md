# Shared private-view configuration and pure projection — 2026-10-03

## PR #67 empty-source result-map correction

Independent review of published head
`ce3637431fadb361dfd3d44d51712714377694b1`, tree
`d72a6b384107066efc2be6ec9bab93420cb2f412`, found that an empty saved
source could treat `activities: 7` or `activities: true` as an empty result map.
Correctly typed, independently verified callers are unaffected, but the pure
boundary's malformed-result contract must still reject those values.

The result map is now explicitly a non-null object and not an array before
`Object.keys`. Six negative selector vectors (critical/date/float with each
primitive) reproduce the exact baseline failure and now return
`calculation_invalid`; three valid empty-object positives keep successful zero
row/group counts and the consumed provenance. No authorization, source marker,
schedule math, serializer, date key or existing assertion changed.

Fresh corrected local full-stack checks passed: **92 contracts**, **107 CLI**,
**211 genuine-DB API**, **127 scripts**, **59 built HTTP**, **15 TLS**, **51
active Rust**, and **27 focused SQL/BIGINT invariants**, with zero TS/DB failures
or skips and only the existing manual Rust benchmark ignored. Focused projector
tests passed **25/25**, including actual 1,000-row Rust output. All types, builds,
format/lint/Clippy and final source/runtime/Rust/ledger/inventory guards passed;
Next-generated drift was restored and generated databases removed/PG stopped.
The supported wrapper collects **51 browser cases only**. Fresh corrective-head
remote browser/security gates and renewed independent review remain required.
The sections below retain the original shared-layer candidate's historical
90-test evidence; they are not the corrected-head counts.

This is a shared-contract slice, **not saved-view feature acceptance**. It starts
from reviewed main `1f18f945c3b598c51965d1bda86e7bde0d495cca`, tree
`609307de35a0a4b4e81f48f44422d2cccbba3a9b`. Eight implementation/specification
paths were validated as tree `f2f94449f5e3c52c979795a7ec7ce26a5563e73c` before
this record and the acceptance-ledger closeout were added. Final publication and
remote gate identities belong to its forthcoming draft.

## Implemented boundary

- Inert private-view JSON v1, explicit projection/normalization versions, 8KiB
  bytes, eight container levels, bounded diagnostics and fixed-field canonical
  hash preimage distinct from schedule serializers. Fatal UTF-8, decoded duplicate
  keys, invalid numeric/Unicode tokens, unknown fields, unsupported versions,
  accessors/exotic prototypes and non-JSON data fail closed. No interpolation,
  executable expression, credential/scope field or network lookup exists.
- Shared pure Native/AND-filter/single-key sort/direct-WBS grouping. Native uses
  the native snapshot sequence, not canonical UUID export order. Descending only
  reverses the primary key; ties retain native order. Name/ID matching preserves
  documented literal Unicode case behavior. Date comparisons preserve up to
  nanoseconds and UTC offsets without rewriting timestamps or deriving schedule
  dates. Unsupported leap-second, extended-year or excess precision is explicit
  unavailability, not silently truncated data.
- Result-dependent views require matching saved source/revision/engine metadata
  and well-formed real result rows. Unsaved, missing, stale, invalid or deleted-WBS
  activation returns typed unavailable results. Source/caller markers are **not
  authentication or hash verification**: future API/GUI/CLI wrappers must verify
  current authorization, coherent source, real-engine compatibility and actual
  hashes independently. No source input/result or entity order is mutated.
- Existing direct configuration validation additionally rejects numeric-looking
  own array properties outside actual length, including `"4294967295"`. The exact
  baseline accepted and dropped them; two new tests reproduce that failure then
  assert 192 extra-key and six accessor vectors across all nested array kinds.
  Accessors are never read, diagnostic paths retain their quoted-key syntax,
  dense valid arrays and canonical schedule bytes remain unchanged. HTTP JSON
  cannot represent these extra properties; no HTTP schema was weakened.

See [the shared v1 specification](../specs/planner-views-v1.md). The separately
owned six-file layer was frozen on the earlier equivalent dependency base; its
source remains unchanged except the integration's native-fixture environment
fallback described below. Original author worktrees/patches remain preserved.

## Fresh combined local execution

Pinned Node **24.19.0**, pnpm **12.8.0**, Rust **1.99.0**, PostgreSQL **17.11**
and the freshly compiled real optimized Rust executable were used. The frozen
install reused 91 packages and downloaded none, with normal supply-chain policy.

| Check | Executed result |
| --- | --- |
| Full `pnpm check` | exit 0: formatting, all package/E2E types, lint, complete production builds, Rust formatting/all-target Clippy `-D warnings` and tests |
| Contracts | **90/90**, zero failures/cancelled/skipped, including 44 new shared-view tests and two direct-array regressions |
| CLI unit / genuine-DB API / scripts | **107 / 211 / 127 passed**, zero failures/skips |
| Rust 1.99.0 | **51 active passed**, one documented manual benchmark ignored |
| Built HTTP / TLS | **59 / 15 passed**, zero failures/skips; isolated TLS fixture removed |
| Focused existing SQL/BIGINT invariants | **27 passed**, zero failures/skips |
| Supported browser wrapper | **51 cases in 6 files collected only**; no local Chromium execution |
| Final source/runtime/Rust integrity | all comparisons exit 0 |
| Original database ledger/inventory | identical; generated fixtures removed; PostgreSQL stopped |

The shared native fixture builds 1,000 mixed activities, 999 relationships, two
calendars and empty/nonempty WBS groups, invokes actual unchanged Rust and checks
filter/group/Native behavior and immutability. Its warm pure-projection timing is
named runtime/container characterization only, excluding API/auth/hash/UI work;
it is not an end-to-end latency or universal budget promise. Independent author
review also checked 10,000 date comparisons and 14 hostile accessor vectors.
The integrated run used an AMD EPYC 9V74 80-Core Processor, Node 24.19.0/V8
13.6.233.17-node.51: three first-call samples followed by twenty warm samples,
warm median **8.155 ms**, p95 **12.139 ms**, maximum **13.059 ms**. GC was
uncontrolled; these samples do not establish allocation or production budgets.

An initial aggregate correctly reported **89 passed / one skipped** because the
new native fixture only honored its dedicated test variable. Its original proof
is retained. The integration accepts the existing `ENGINEO_SCHEDULER_BIN` as
fallback, so ordinary CI's already compiled bridge runs that same test. The full
stable-source aggregate above was repeated and all **90** cases executed. No
production module or assertion was changed for that correction. A separate early
regression-fixture failure used a dot path instead of the existing quoted numeric
key path; that failed output is retained and the exact established syntax is now
asserted, not relaxed.

Next-generated `next-env.d.ts` drift was captured/restored before identity checks.
Five existing test lint warnings, one Biome deprecation info and the existing Node
module-type warning remain. The existing source database with its older `0005`
checksum was never migrated/reset; only unique `TEMPLATE template0` fixtures
were used, with compiled production migration entry and six correct checksums.

## Remaining gates and feature work

Fresh draft-head CI, actual 51-case browser execution, dependency review/audits,
CodeQL/extraction and independent PM review remain required. No fresh remote
result for this new shared slice is implied by #66's green main. #66's separate
main closeout is recorded accurately in the acceptance ledger.

Saved records, operations/revisions/receipts, live own-view authorization, coherent
server reads, finite storage/audit admission, maintenance/restore, actual controls
and focus/virtualization, built CLI commands and cross-surface parity remain
unaccepted. M1 progress/views, Windows/external HTTPS, physical retention/capacity,
operational deployment/backup identity and M2–M6 exits remain open. No deployment,
credentials, settings, license choice or Terraform provider was performed.
