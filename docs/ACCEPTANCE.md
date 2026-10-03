# Production acceptance ledger

Engineo is complete only when the exits in `ROADMAP.md` and the eight feature
criteria (model, deterministic behavior, validation, UI, interoperability, audit,
tests, performance) are evidenced. A merged milestone issue is not acceptance.

Status vocabulary: **passed** = executed with evidence; **implemented** = code
exists but acceptance is unverified; **pending** = work remains; **failed** = an
executed check failed; **never run** = no execution evidence. Update this ledger
and add an evidence record under `docs/verification/` with each reviewed increment.

## Reconciled baseline — 2026-10-02

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
| S0 supply chain | JS/Rust lockfiles, frozen/locked installs, high vulnerability gates, build-script policy, minimal CI permissions, threat model, no secrets, dependency review | frozen/locked inputs and CI/CodeQL passed on PR #54 `de1b88f`; dependency review failed because Dependency Graph is disabled, owner approval pending |
| S0 Rust analysis coverage | Security query gates and extraction completeness are separate acceptance checks | PR #56 `0f18291` query gates passed, but Rust extraction still reports 17 clean files and 2 with errors. Separate compiler-compatibility and fail-closed inventory gate implemented/tested locally; exact-head extraction remains pending: [coverage record](verification/2026-10-03-rust-security.md) |
| M1 identity | Org/project creation, sessions/revocation/CSRF/Origin, server RBAC, audit, abuse controls and negative cross-tenant tests | auth/API and scoped browser negatives pass: [auth](verification/2026-10-02-auth.md), [API](verification/2026-10-02-planner-api.md), [browser](verification/2026-10-02-planner-browser.md); full identity administration/role matrix and production controls pending |
| M1 Planner | WBS CRUD/restructure, virtualized grid and synchronized Gantt, relationships/calendars/constraints, schedule controls, 1k+ activities created/edited/recalculated in browser | scoped browser increment passed: [execution record](verification/2026-10-02-planner-browser.md); durable results, full latency characterization and remaining workflow exits pending |
| M1 data/workflow | Data date + basic progress, filters/group/sort/saved views, project summary, CSV/spreadsheet import/export, explicit failures, data ownership | pending |
| S1 production controls | Encrypted transport/storage and secret-store integration; automated encrypted backups; measured restore; project authorization and audit | never run operationally; no production credentials or infrastructure |
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
