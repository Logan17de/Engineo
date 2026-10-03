# Configuration invariants and confirmed Planner summaries — 2026-10-03

## Scope and immutable baseline

This follow-up starts from reviewed actual main
`e83e399660fa21efe832de11f9ae601c9abca8cd`, tree
`bcd03d7ea8cfd0972b57f5f8b2c6828fbfde68e6`, after configuration API #64
and application CLI #65. Its nine implementation/test paths were frozen as
tree `f712d18746519c97c1206c330b34c30ad2af8be2` before this record and the
acceptance-ledger closeout were added. Final publication and remote-check
identities belong to the forthcoming draft; this document does not certify them.

- New migration `0006_configuration_outcome_material_state.sql` requires the
  applied/no-op/cancelled material-state expression to be definitely `TRUE`.
  PostgreSQL's acceptance of an unknown nullable `CHECK` result cannot admit
  incomplete applied/no-op rows. Valid cancellation keeps its three null fields.
  Applied migration `0005` and its SHA-256 remain untouched.
- Direct contract callers must provide ordinary arrays. Custom, null and subclass
  prototypes are rejected without running inherited normalization hooks; strict
  parsed JSON and ordinary arrays retain their existing behavior.
- Native reconciliation tests deliberately use reversed UUIDs and exact database
  `sort_order` text above JavaScript's safe-integer range and at PostgreSQL BIGINT
  capacity. UUID-sorted append, retained IDs/times, removed maximum rows, no-op at
  capacity and overflowing apply rollback are asserted. The already correct
  reconciliation implementation and schedule serializers are unchanged.
- One `acceptSavedSnapshot` path synchronizes only the matching cached card's
  name/revision after a guarded authoritative load or acknowledged save. Other
  cards, code/timestamps and schedule/session/permission guards are preserved.
  Draft edits, uncertain replies and stale-draft recovery cannot invent saved
  metadata. CSV refresh uses its authoritative load; redundant whole-list
  refreshes cannot replace confirmed metadata with a stale list response.

## Fresh combined local execution

Node **24.19.0**, the repository-pinned pnpm **12.8.0**, Rust/Cargo **1.99.0**
and PostgreSQL **17.11** were used. A real frozen install passed unchanged
supply-chain policy with **91 packages reused and zero downloaded**. No dependency
versions, lockfiles, engine contracts, Rust scheduling source or permissions changed.

A uniquely named `TEMPLATE template0` database and the real optimized Rust
executable were used. The compiled production Node migration entry was run;
the existing source database with its old checksum was not migrated or reset.

| Check | Executed result |
| --- | --- |
| Full `pnpm check` | exit 0: format, lint, all workspace/E2E types, full production builds, all-target Clippy `-D warnings`, Rust tests |
| Contracts / CLI unit / genuine-DB API / script suites | **44 / 107 / 211 / 127 passed**, zero failed/cancelled/skipped |
| Rust 1.99.0 | **51 active passed**; one existing manual benchmark ignored |
| Focused new genuine-DB invariants | **27 passed**, zero failures/skips; SQL UNKNOWN, populated forward migration, rollback/replay and exact BIGINT ordering |
| Built HTTP CLI/API/PostgreSQL/Rust | **59 passed**, zero failures/skips, **15576.346567 ms** |
| Built HTTPS subprocess transport | **15 passed**, zero failures/skips, **1721.156697 ms**; ephemeral fixture removed |
| Supported browser wrapper | **51 cases in 6 files collected only**, no Chromium execution |
| Migration replay | exit 0, six correct checksums, original `0005` unchanged |
| Final source/runtime/Rust identities | every comparison exit 0 |
| Original database ledger and inventory | identical; generated fixture databases removed; PostgreSQL stopped |

Five existing test non-null lint warnings and one Biome deprecation information
item remain. Node's existing module-type warning remains in script tests. The
Next build regenerated `next-env.d.ts`; its expected diff was retained and its
baseline bytes restored before source comparison. Production output remained
byte-identical through focused invariants, HTTP/TLS, collection and replay.

The first local pass passed every runtime suite, but its full-source guard failed
because the integration owner edited only `docs/ACCEPTANCE.md` during that pass.
That failed proof and its one-path SHA discrepancy are retained. Documentation
was restored and the complete stable-source execution above was repeated, with
every guard passing. Only the two documentation files were then added; the nine
tested implementation paths stayed identical. No assertion was relaxed.

## Reviewed-main closeout and remaining acceptance

The preexisting CLI main had fresh push CI
[37126065271](https://github.com/Logan17de/Engineo/actions/runs/37126065271)
and CodeQL
[37126065280](https://github.com/Logan17de/Engineo/actions/runs/37126065280).
All six jobs checked out exact `e83e3996`; all 48 browser cases passed. Three
artifact digests matched, all eight CLI screenshots and 20 JSON files were
inspected, 27 CLI artifact assertions passed, and fresh SARIF query/extraction
gates passed for all 21 tracked Rust files. Its observed card/editor revision
warning is the specific separate issue addressed here. The acceptance ledger
records the exact #64/#65 review, merge and actual-main gate identities; their
older verification sections are historical local-candidate records.

Fresh exact-draft CI, all **51 actual browser scenarios**, dependency audits/
review, new CodeQL/extraction artifacts and independent PM review remain required.
The new regressions preserve existing native/hash/authorization assertions and
cover confirmed saves, failed follow-up reads, external reload/project switching,
CSV outcomes, request cancellation and stale/changed-identity recovery.

This is scoped local implementation evidence. Windows, approved external HTTPS,
physical quota/retention stress, operations/backup identity and full M1/M2–M6
acceptance remain open. No deployment, real credentials, production settings or
license decision was performed.
