# Production acceptance ledger

Engineo is complete only when the exits in `ROADMAP.md` and the eight feature
criteria (model, deterministic behavior, validation, UI, interoperability, audit,
tests, performance) are evidenced. A merged milestone issue is not acceptance.

Status vocabulary: **passed** = executed with evidence; **implemented** = code
exists but acceptance is unverified; **pending** = work remains; **failed** = an
executed check failed; **never run** = no execution evidence. Update this ledger
and add an evidence record under `docs/verification/` with each reviewed increment.

## Reconciled main — 2026-10-03

- Foundation integration PR #60 merged atomically at
  `b36ecc4d9483b925583bbf9a673c0040436a63e1`; tree
  `f626302e6bf0ffa68e55c6d060c0ca62b3bdddee` matches independently reviewed
  head `b29dd49f` and tested integration merge `008a2275`. Original branches
  remain preserved. The unfixed PR #53 baseline was not merged separately.
- Full main-diff Dependency Review `37102353955`, CI `37102353966` and
  CodeQL `37102353980` passed: 25 browser cases, 7 contract / 47 API /
  6 security tests, 50 active Rust tests, 19 clean Rust sources / zero errors,
  no high/error query findings or high audited vulnerabilities. New main-push
  CI/CodeQL are independent checks, still running at preparation time.
- Durable completed calculations and restoration are the next separate draft;
  local combined gates pass but exact publication/security/browser acceptance
  is not inferred. Full M1 and production release remain incomplete.
- The main-push 24/25 fixture failure after #60 was corrected separately in
  reviewed PR #62, exact head `d067ee9`, tree `b2a52da1`. Fresh CI `37104811376`
  passed all 26 cases; CodeQL `37104811379` and Dependency Review `37104811438`
  passed. Actual main is now `54678e0e055d9450f328541b2551a1372b9ba3b3`, with that
  exact tree and preserved branches. Independent actual-main CI `37105521355`
  subsequently passed all 26 cases in 49.9s; CodeQL `37105521386` passed with
  empty high/error findings and 19 individually matched clean Rust sources.
  The main-push failure is closed. See [fixture phase evidence](verification/2026-10-03-held-identity-fixture.md).

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
| S0 Rust analysis coverage | Security query gates and extraction completeness are separate acceptance checks | integration #60 CodeQL `37102353980` passes both query gates and fail-closed coverage: 19 clean tracked Rust files, zero errors, 19 expected; new durable Rust source/identity files require fresh exact-head coverage: [coverage record](verification/2026-10-03-rust-security.md) |
| M1 identity | Org/project creation, sessions/revocation/CSRF/Origin, server RBAC, audit, abuse controls and negative cross-tenant tests | auth/API and scoped browser negatives pass: [auth](verification/2026-10-02-auth.md), [API](verification/2026-10-02-planner-api.md), [browser](verification/2026-10-02-planner-browser.md); full identity administration/role matrix and production controls pending |
| M1 Planner | WBS CRUD/restructure, virtualized grid and synchronized Gantt, relationships/calendars/constraints, schedule controls, 1k+ activities created/edited/recalculated in browser | scoped browser increment passed: [execution record](verification/2026-10-02-planner-browser.md); durable completed results and reload/retry UI reconstructed with full local API/static/Rust checks, remote browser/exact-head review pending: [durable record](verification/2026-10-03-durable-calculation-ui.md); full latency characterization and remaining workflow exits pending |
| M1 data/workflow | Data date + basic progress, filters/group/sort/saved views, project summary, CSV/spreadsheet import/export, explicit failures, data ownership | activity CSV export + existing-activity preview/apply passed locally, including 1,000 edits, preservation, audit/tenant/replay/failure checks: [CSV record](verification/2026-10-03-activity-csv.md); WBS/relationship/new-activity import templates, native XLSX, remaining progress/views and complete #51 acceptance pending |
| M1 GUI/headless automation | Documented application API/CLI, machine-readable I/O, versioned project configuration and validate/plan/apply with GUI-equivalent auth/RBAC/audit/revision/idempotency | graphical Planner and engine JSON CLI exist; HTTP/CSV foundations pass scoped checks. Application CLI, full configuration plan/apply, automation authentication and end-to-end parity remain pending: [headless acceptance](specs/headless-automation-v1.md). No Terraform provider is assumed necessary |
| S1 production controls | Encrypted transport/storage and secret-store integration; automated encrypted backups; measured restore; project authorization and audit | populated disposable PostgreSQL 17.11 dump/empty-DB restore matches all table inventories and authenticated 1,000-activity calculation/provenance: [local drill](verification/2026-10-03-durable-calculation-ui.md); encrypted automated production backup, scoped identity, production RPO/RTO and infrastructure remain never run |
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

- `feat/durable-calculation-recovery` adds a newly reconstructed immutable
  completed-calculation API and browser restoration to reviewed `b29dd49f`.
  The old unpublished checkpoint is still unavailable, not counted as recovered.
  Full combined local gates pass; remote browser/security and exact-head review
  belong to the separate durable draft. The prior foundation is integrated
  atomically in merged PR #60 against main, preserving the original branches.

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
