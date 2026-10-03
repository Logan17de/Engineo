# Production acceptance ledger

Engineo is complete only when the exits in `ROADMAP.md` and the eight feature
criteria (model, deterministic behavior, validation, UI, interoperability, audit,
tests, performance) are evidenced. A merged milestone issue is not acceptance.

Status vocabulary: **passed** = executed with evidence; **implemented** = code
exists but acceptance is unverified; **pending** = work remains; **failed** = an
executed check failed; **never run** = no execution evidence. Update this ledger
and add an evidence record under `docs/verification/` with each reviewed increment.

## Reconciled main — 2026-10-03

- Shared Planner views and dense-array guards PR #67 merged at
  `4d38a05f6c4d03551340e45691d8118df9368b50`, independently approved head
  `5e2a50460c761e69302b41f817d5d3e69b4f5c27`, tree
  `c63f892d0736ed329f301fe3a08110364c5d7e88`. Corrected-head CI
  `37136159592`, CodeQL `37136159563` and Dependency Review `37136159601`
  passed before the guarded merge. Fresh actual-main CI `37137394084` and
  CodeQL `37137394112` then passed: all 51 browser / 92 contract / 107 CLI
  unit / 211 genuine-DB API / 127 script / 59 built HTTP / 15 built TLS tests,
  and 51 active Rust tests on both compilers. All six checkout SHAs, three
  artifact digests, empty query reports and all 21 clean Rust sources were
  independently verified. Current-main screenshots and sanitized records retain
  the native 1,000-activity ordering, input/result hashes, millisecond times,
  audit and identity outcomes. The shared modules supply strict inert view
  configuration and pure presentation projection; saved-view API/GUI/CLI and
  release acceptance remain separate. See [shared view evidence](verification/2026-10-03-planner-view-shared.md).
- Configuration material-state and confirmed-summary PR #66 merged at
  `1f18f945c3b598c51965d1bda86e7bde0d495cca`, approved head
  `6159bb3f13ac299ba2ae7149e92bd45e4e7e6d21`, tree
  `609307de35a0a4b4e81f48f44422d2cccbba3a9b`. Exact-head CI
  `37127845441`, CodeQL `37127845429` and Dependency Review `37127845419`
  passed before merge. Fresh actual-main CI `37128598692` and CodeQL
  `37128598684` then passed: 51 browser / 44 contract / 107 CLI unit / 211
  genuine-DB API / 127 script / 59 built HTTP / 15 built TLS tests, and 51
  active Rust tests on both compilers. All six actual-main checkout SHAs, three
  artifact digests, empty query reports and all 21 clean Rust extractions were
  verified. A fresh independent real Rust invocation reproduced the retained
  1,000-activity input/result hashes, native order, exact millisecond times and
  audited outcomes. Three representative current-main screenshots show matching
  card/editor revisions and stable wrapped toolbar slots. The separate direct
  helper's numeric-looking extra-array-key finding is addressed in the next
  shared-contract slice; HTTP JSON is unaffected.
- Configuration API PR #64 merged at
  `a9d67cdfb24c4fe4848f109b699de63296127ae8`, reviewed tree
  `c9e637ee9cbc83f639e9e6b4d658c331d1e282b9`. Fresh actual-main CI
  `37119397845` and CodeQL `37119397836` passed: 44 browser / 41 contract /
  184 genuine-DB API / 27 script / 51 active Rust tests, including the declared
  minimum compiler. All eight browser images and nine sanitized records were
  inspected; input/result hashes, native order, permissions and audited outcomes
  matched. The separately populated 21-table restore drill remains scoped
  disposable-database evidence, not production backup acceptance.
- Application CLI PR #65 merged at
  `e83e399660fa21efe832de11f9ae601c9abca8cd`, independently approved head
  `9a5fe2d575939e81cfc93b6d4395fe1c782538a8`, tree
  `bcd03d7ea8cfd0972b57f5f8b2c6828fbfde68e6`. Corrected-head CI
  `37124288261`, CodeQL `37124288264` and Dependency Review `37124288276`
  passed before the guarded merge. Fresh actual-main CI `37126065271` and
  CodeQL `37126065280` then passed: 48 browser / 41 contract / 107 CLI unit /
  184 genuine-DB API / 127 script / 59 built HTTP / 15 built TLS tests, and
  51 active Rust tests on both compilers. All six job checkout SHAs and the
  digest-matched browser/SARIF artifacts were verified; all eight CLI images
  and six sanitized evidence records were inspected. The real Rust hash/native
  ordering/millisecond parity and stale, cancel, replay and identity outcomes
  passed. Rust extraction covers all 21 tracked files with zero errors; query
  reports contain no high/error findings. Original-head browser and CodeQL
  failures are retained historical failures, not successful evidence. The CLI
  scope is accepted; full M1, stable automation identities and operational
  release acceptance remain incomplete.
- Foundation integration PR #60 merged atomically at
  `b36ecc4d9483b925583bbf9a673c0040436a63e1`; tree
  `f626302e6bf0ffa68e55c6d060c0ca62b3bdddee` matches independently reviewed
  head `b29dd49f` and tested integration merge `008a2275`. Original branches
  remain preserved. The unfixed PR #53 baseline was not merged separately.
- Full main-diff Dependency Review `37102353955`, CI `37102353966` and
  CodeQL `37102353980` passed: 25 browser cases, 7 contract / 47 API /
  6 security tests, 50 active Rust tests, 19 clean Rust sources / zero errors,
  no high/error query findings or high audited vulnerabilities. The independent
  corrected actual-main checks are recorded below.
- Durable completed calculations and restoration were reviewed separately.
  Initial PR #63 at `ca58d83a` passed nonbrowser
  gates, dependency review and 21-file Rust extraction/query gates, but its
  initial browser run `37106301443` failed 9/39 cases. Stable toolbar geometry
  and disposable quota-state isolation are source-reviewed; fresh combined
  local gates pass (8 contracts / 76 API / 24 scripts / 51 active Rust tests),
  and the corrected command collects 41 cases. Fresh full remote CI and renewed
  exact-head review are still required. Its first correction run `37108813901`
  stopped before browser/build/audit because the fixture confused a local
  Docker-mapped client endpoint with the server-side address; supported topology
  pinning is source-reviewed without production or broad-network exceptions.
  The final combined local gates pass 8 contracts / 76 API / 27 scripts / 51
  active Rust tests and collect 41 cases; real Docker/browser execution and
  renewed exact-head review were still required at that historical stage.
- The final durable increment, head `7f1cb07e35a1756476878267fcf47c490493222c`,
  passed fresh CI `37109786879` (all 41 browser cases), CodeQL `37109786839`
  (21 clean tracked Rust sources / zero errors / empty findings) and Dependency
  Review `37109786846`. Independent review approved that exact head/tree.
  PR #63 merged at `586efb4494312f584b5d56b70658866121b96566`, tree
  `db66c3f72490d2a570159382c588f369576f3220`, with all branches preserved.
  Fresh actual-main PUSH CI `37110281415` and CodeQL `37110281436` passed:
  41 browser / 8 contract / 76 API / 27 script tests, 51 active Rust tests on
  both compilers, audits and complete 21-file extraction. Digest-matched main
  browser/SARIF evidence was inspected, including all five PNGs, exact desktop/
  wrapped-toolbar geometry and genuine 401→B200→A200 phase proof. The failure
  loop is closed. This is scoped increment acceptance; M1/headless and release
  exits remain incomplete.
- The main-push 24/25 fixture failure after #60 was corrected separately in
  reviewed PR #62, exact head `d067ee9`, tree `b2a52da1`. Fresh CI `37104811376`
  passed all 26 cases; CodeQL `37104811379` and Dependency Review `37104811438`
  passed. PR #62 merged at `54678e0e055d9450f328541b2551a1372b9ba3b3`, with that
  exact tree and preserved branches. Independent actual-main CI `37105521355`
  subsequently passed all 26 cases in 49.9s; CodeQL `37105521386` passed with
  empty high/error findings and 19 individually matched clean Rust sources.
  The main-push failure is closed. See [fixture phase evidence](verification/2026-10-03-held-identity-fixture.md).

## Private views API candidate — 2026-10-03

The private named-view API/persistence slice was authored against
`1f18f945c3b598c51965d1bda86e7bde0d495cca` and is now integrated over verified
actual main `4d38a05f6c4d03551340e45691d8118df9368b50` / tree
`c63f892d0736ed329f301fe3a08110364c5d7e88`, which includes the accepted shared
configuration/projector and array-index guards. See the
[private API protocol](specs/planner-private-view-api-v1.md) and its precise
[verification record](verification/2026-10-03-private-planner-view-api.md).
Private ownership, own-view capability, coherent source projection, independent
revision/CAS, stateless preview/apply, bounded receipts/storage/rates/maintenance
and a finite append-only feature audit-admission ceiling are in this API scope.
GUI controls/keyboard/focus/virtualization, application CLI views commands,
actual GUI/headless parity, exact-head aggregate CI/security/PM review and physical
operational capacity remain pending. Fresh integrated local gates pass 115
contracts / 311 genuine-DB API / 107 existing CLI / 127 scripts / 59 built HTTP /
15 built TLS / 51 active Rust tests. Source/runtime/engine, original migration
ledger and database inventory guards match. The unchanged 51 browser cases were
collected locally, not executed against this API candidate. Draft publication and
exact-head remote gates do not themselves establish saved-view/M1/release acceptance.

## Historical baseline — 2026-10-02

| Item | Evidence | Status |
| --- | --- | --- |
| Remote main | `eca67208bae54b3b9d22d507f5471ac938c6f380`, rechecked using `git ls-remote` | passed |
| Identity branch / PR | `f92e17d356d4c753cb4215aac0fb099013d8bf6e`, PR #53 open | implemented |
| PR #53 TypeScript CI | run `36999446754`, formatting fails in `security.test.ts`; later checks skipped | failed |
| PR #53 Rust checks/audit | CI job success; local Rust fmt/Clippy and 45 active tests pass | passed |
| PR #53 CodeQL | run `36999446752` completes; reported high login limiter finding is not clearance | pending |
| Project API branch | `d2aa71235bb7474dbef0257bab92b3088c791ea2` preserved; reconciled and registered on `feat/planner-api-ready`, real Rust/PostgreSQL tests | passed API increment and scoped browser increment |
| Main web / API | static landing page and `/health`; no Planner acceptance | pending |
| Saved cloud runtime | Node 24.19.0, pnpm 12.8.0, Rust 1.99.0; PostgreSQL 18.4 on loopback, all under `/workspace` | passed |
| Publication | Git push dry run succeeds; GitHub connector reads succeed; `gh` token invalid | passed via Git + connector |
| License | undecided; must be chosen by the owner before public software release | pending owner decision |

## Capability exits

| Milestone | Required acceptance | Current status / next evidence |
| --- | --- | --- |
| M0 scheduling | Domain and versioned JSON; graph/cycles; work calendars/DST; FS/SS/FF/SF + lag; early/late dates; float; milestones/constraints; controlling path; deterministic golden/property fixtures | existing Rust tests and reviewed JSON bridge pass; signed numeric lag boundaries do not guarantee a calendar/date can calculate extreme durations |
| M0 scale | Document sparse/dense 1k/10k/100k runs with SHA, compiler, CPU, memory, build profile, counts and timings | passed: [measured scale record](verification/2026-10-02-m0-performance.md); RSS and repeated reference-machine budgets pending |
| S0 supply chain | JS/Rust lockfiles, frozen/locked installs, high vulnerability gates, build-script policy, minimal CI permissions, threat model, no secrets, dependency review | frozen/locked inputs and CI/CodeQL pass; Dependency Graph enabled and full accumulated main-diff Dependency Review passes on integration #60, run `37102353955`; every new head still requires its own gates |
| S0 Rust analysis coverage | Security query gates and extraction completeness are separate acceptance checks | actual CLI main `e83e3996` CodeQL `37126065280` passes 21 clean / zero errors / 21 individually matched tracked sources, empty high/error findings and successful invocations without extraction warnings/errors; informational SARIF notes remain. Prior foundation's 19-file evidence is historical. Every revised head requires fresh coverage: [coverage record](verification/2026-10-03-rust-security.md) |
| M1 identity | Org/project creation, sessions/revocation/CSRF/Origin, server RBAC, audit, abuse controls and negative cross-tenant tests | auth/API and scoped browser negatives pass: [auth](verification/2026-10-02-auth.md), [API](verification/2026-10-02-planner-api.md), [browser](verification/2026-10-02-planner-browser.md); full identity administration/role matrix and production controls pending |
| M1 Planner | WBS CRUD/restructure, virtualized grid and synchronized Gantt, relationships/calendars/constraints, schedule controls, 1k+ activities created/edited/recalculated in browser | scoped foundation and durable completed-result/reload/retry increments passed review plus fresh actual-main 41-case browser/API/static/Rust/security gates: [durable record](verification/2026-10-03-durable-calculation-ui.md); full latency characterization, progress/views and remaining workflow exits pending |
| M1 data/workflow | Data date + basic progress, filters/group/sort/saved views, project summary, CSV/spreadsheet import/export, explicit failures, data ownership | activity CSV export + existing-activity preview/apply passed locally, including 1,000 edits, preservation, audit/tenant/replay/failure checks: [CSV record](verification/2026-10-03-activity-csv.md); WBS/relationship/new-activity import templates, native XLSX, remaining progress/views and complete #51 acceptance pending |
| M1 GUI/headless automation | Documented application API/CLI, machine-readable I/O, versioned project configuration and validate/plan/apply with GUI-equivalent auth/RBAC/audit/revision/idempotency | reviewed configuration API #64 and built application CLI #65 are merged with fresh actual-main checks above. Existing-project versioned schedule read/validate/plan/apply/cancel/status/receipt and calculate/result pass genuine API/GUI/Rust parity, including 1,000 activities, native order and exact milliseconds: [headless acceptance](specs/headless-automation-v1.md), [configuration contract](specs/project-configuration-v1.md), [CLI](../packages/cli/README.md). New M1 features still need the same GUI/headless coverage. Stable scoped automation identities, Windows and external deployment acceptance remain pending; no Terraform provider assumed necessary |
| S1 production controls | Encrypted transport/storage and secret-store integration; automated encrypted backups; measured restore; project authorization and audit | populated disposable PostgreSQL 17.11 drills pass: prior durable calculation [record](verification/2026-10-03-durable-calculation-ui.md) and new configuration schema [record](verification/2026-10-03-project-configuration-restore.md), 21 tables / 2,045 exact rows / 1,000 activities / 999 relationships, restored authenticated receipts/replay/pending apply and bounded 64→1→0 maintenance; encrypted automated production backup, scoped identity, production RPO/RTO and infrastructure remain never run |
| M2 controls | Immutable baselines/variance; richer constraints; suspend/resume, actual/remaining and out-of-sequence policies; longest/multiple paths; diagnostics/date reasons; codes/custom fields | pending |
| M2 workflow/interchange | Auditable bulk preview/apply, isolated scenarios, network view, look-aheads/layouts/reports; adapter framework and first professional format with round-trip fixtures | pending |
| S2 networking/import | Hostile-file bounds/isolation/hash/provenance; authorized exports; HTTP(S)_PROXY/NO_PROXY, deliberate CA trust, SSRF/DNS/redirect defenses, disable direct egress | pending; deterministic engine requires no network |
| M3 capacity | Resources/roles/crews, calendars/rates, assignments/time phases, histograms/overloads; deterministic and scenario leveling with isolated conflict resolution | pending |
| M3 cost/EVM | Accounts/expenses; budget/actual/remaining/forecast; EVM fixtures/dashboards; trace source-data changes | pending |
| S3 sensitive data | Explicit resource/cost permissions, scoped credentials, classification/export controls, calculation concurrency/size/tenant quotas | pending |
| M4 portfolio | Programs/portfolios, cross-project logic, shared pools, reproducible snapshot rollups/milestones/capacity; enterprise codes/calendars | pending |
| M4 enterprise/S4 | Advanced RBAC, SSO/OIDC (SAML/SCIM if required), approvals/notifications, API/webhooks, reporting/audit/export; IP/mTLS/private/VPN/WAF/self-hosted guidance and SIEM | pending |
| M5 intelligence | Tool-backed queries/audits/explanations/delay tracing; plan/document/progress suggestions; recovery/resource scenarios; Monte Carlo; executive summaries | pending; no AI-generated math may enter authoritative state |
| S5 AI assurance | Every tool independently authorizes; untrusted-document prompt-injection tests, scenario-first writes, deterministic validation, explicit apply approval, reversible audit, secret/PII minimization/provider controls | pending |
| M6 ecosystem | Public API, plugin capability model, SDK/adapters, packaging/observability, localization/accessibility, very-large-portfolio characterization; offline mode optional | pending |
| S6 release | SBOM/provenance/signing, hardened non-root images, public API review, penetration-test cadence; formal certification only if justified | pending |

## Required scenario matrix

For each material feature, execute normal flow, invalid/malformed input,
interruption/cancel/retry, repeated click/replay, stale revision, keyboard and
accessible error/focus behavior, permission denial, cross-tenant ID substitution,
and export/audit verification. Browser assertions must agree with API persisted
inputs and Rust calculated output. Mark skipped tests **never run**, not passed.

## Operational release gates

- Reproducible migrations with immutable checksums, concurrent migrator safety,
  failed-migration rollback and forward-recovery drill.
- Backup/restore to an empty database, compared project inputs/baselines/audit,
  measured RPO/RTO, encrypted automation and separately scoped backup identity.
- Deployment/build/run/rollback runbooks, readiness checks, graceful shutdown,
  versioned binaries/contracts, bounded jobs with interruption/retry and quotas.
- CPU/RSS/API/browser latency measurements on named hardware; no universal
  threshold invented from a single run.
- Application CLI acceptance on Windows and a separately approved externally
  hosted HTTPS deployment. Current built TLS tests use an isolated ephemeral
  local CA/process and do not establish production transport or trust setup.
- Configuration artifact quota/retention stress, maintenance contention and
  physical PostgreSQL/index/WAL growth characterization. Logical byte/count
  admission and a bounded disposable maintenance drill do not establish finite
  audit-history lifecycle or production capacity.
- Proxy/egress and hostile import regression suites; security/static/dependency
  gates pass on the exact reviewed SHA. A green CodeQL workflow alone does not
  prove there are no findings.
- Owner decisions: license; any paid service, credentials/persistent access,
  security-sensitive repository setting, and production deployment. These do not
  block ordinary implementation or local cloud-container validation.

## Review protocol

Create scoped branches and draft PRs. Preserve concurrent branches. Record exact
SHA, diff, executed/failed/skipped checks and CI/security state before PM review;
merge only after that review. Continue independent implementation while waiting.

## Current review stack

- `fix/configuration-array-index-guard` combines a strict non-index-array-key
  correction with the separately owned shared private-view configuration and
  pure presentation layer from actual main `1f18f945`. Local combined gates pass
  90 contracts / 107 CLI / 211 API / 127 scripts / 59 HTTP / 15 TLS and 51
  active Rust tests, with 51 browser cases collected only. Fresh exact-head remote
  browser/security gates and independent PM review remain required. This layer
  implements no saved-view API, GUI, CLI command, permission or persistence.
  See [shared-layer evidence](verification/2026-10-03-planner-view-shared.md).
- The separate private-view API/persistence slice is in development against the
  shared contracts. Its live authorization, coherent source verification,
  bounded operation receipts/quotas and maintenance require their own actual
  tests before any acceptance. GUI and built CLI parity remain separate work.
- `fix/production-invariant-summary` remains preserved after reviewed #66 and
  green actual-main checks above. Its immutable `0006`, prototype/BIGINT checks
  and confirmed card synchronization are scoped accepted increments.
- `feat/headless-project-configuration` and `feat/headless-application-cli` are
  preserved after independently reviewed merges #64 and #65. Their original
  verification sections describe historical local candidates; successful fresh
  committed-head and actual-main results are recorded above. No real identity,
  access or deployment was provisioned by those implementations.
- `feat/durable-calculation-recovery` is preserved at reviewed `7f1cb07e` and
  integrated through merged PR #63, with green actual-main checks above. Its
  newly reconstructed code did not recover the unavailable unpublished checkpoint.

The following stack records are historical increment evidence. PRs #53–#59
were integrated atomically through #60; their original draft branches remain
preserved. Dependency Graph is now enabled by an explicitly approved action.
Old incremental dependency-review failures are not current merge blockers;
each new head still needs its own full checks. The separate fixture correction
#62 is merged and its actual-main gates passed as recorded above.

- `fix/planner-recovery-identity` follows PR #58 at
  `bd85a6f8ee4b559376db475cedcbd04d74651314`. It corrects PM's verified-user
  discard-boundary finding from PR #56. Full local static/API/Rust/security gates
  pass; two added combined browser cases are implemented but local Chromium
  cannot start under this executor's Unix-socket restriction. Exact-head remote
  browser execution and review are required: [recovery boundary record](verification/2026-10-03-recovery-identity.md).
  The previously unpublished durable-calculation checkpoint is not restored.

- `feat/planner-csv-roundtrip` follows PR #57 at `c8bd175875b4514d65549814fd56b5c2d461338e`.
  Scoped #51 activity CSV preview/apply passes local API and browser validation;
  exact publication SHA, CI and security results belong to its draft PR. This
  increment does not complete #51 or M1 and does not merge the existing stack.

- Draft PR #54: `de1b88f9efbccb1e536f625fbb99cb2a6e1a88fc`, scoped auth
  follow-up; CI and CodeQL passed, dependency-review setting blocker remains.
- Draft PR #55: `f53c2619c414650b95487611aa19d83c7454a376`, reviewed
  Planner API and signed-lag delta. CI `37017343328` and CodeQL `37017343490`
  passed; Dependency Review `37017343803` failed on disabled Dependency Graph.
- The Planner browser increment follows #55; exact publication/checks belong in
  draft PR #56. Head `898863995600bf2ea329f49619ebf1c0b8d936c9` passed CI
  `37021742551` and CodeQL `37021742356`, but PM rejected account/session-state
  behavior. Its correction `0f18291` passed 11 browser cases and CI
  `37083434654`, but independent review identified same-account reauthentication
  and failed/hung identity-probe P2s. Those follow-up cases now pass 5/5 locally;
  all 16 production-browser cases passed locally in 45.8s. Review then identified
  complete-membership-removal escrow cleanup; those two additional browser
  regressions pass 2/2 locally. The final full TS gate and all 18 browser cases
  passed (50.1s); independent review found no remaining concrete code blocker.
  Exact-head CI and PM approval are required. Dependency Review
  `37021742359` failed on disabled Dependency Graph. See the
  [session reconciliation record](verification/2026-10-03-planner-session.md).
- Remaining M1 workflow, baselines/progress/scenarios, resource/cost/EVM,
  enterprise/AI/integrations and operational gates are pending. No release is complete.
