# Engineo Roadmap

The roadmap is capability-driven rather than date-driven. Every milestone has an exit criterion so progress means working software, not accumulated code.

## M0 — Foundation & deterministic scheduling kernel

**Goal:** prove Engineo can calculate a trustworthy professional schedule.

Deliverables:
- monorepo/tooling/CI foundation;
- project/activity/relationship/calendar domain model;
- dependency graph and cycle validation;
- working-time calendar arithmetic;
- FS, SS, FF, SF relationships with lag;
- forward and backward passes;
- early/late dates;
- total and free float;
- critical/controlling path and project finish;
- milestones and initial constraints;
- deterministic JSON input/output;
- golden fixtures, property tests, and 100k-activity benchmarks.

Exit:
- identical input produces stable normalized output;
- invalid logic produces explicit diagnostics;
- calendar/relationship/float matrix passes;
- 100k benchmark is measured and documented;
- scheduling crate has no database or UI dependency.

## M1 — Planner MVP

**Goal:** a scheduler can create and maintain a real project.

Deliverables:
- organization/project creation;
- WBS editor;
- virtualized activity table;
- synchronized Gantt;
- relationship editor;
- project/activity calendars;
- constraints;
- schedule controls;
- data date and basic progress;
- filters, grouping, sorting, saved views;
- project summary;
- CSV/spreadsheet import/export;
- authentication, basic project roles, and audit trail.

Exit:
- user can build a 1,000+ activity project without leaving Engineo;
- edits and recalculation remain responsive;
- every calculated date in UI comes from deterministic engine;
- project data is exportable.

## M2 — Professional schedule controls

**Goal:** support dedicated planner/scheduler workflows.

Deliverables:
- baseline snapshots and variance;
- richer constraints;
- suspend/resume;
- actual/remaining dates and durations;
- out-of-sequence progress policies;
- longest path and multiple path analysis;
- schedule diagnostics;
- activity/project codes and custom fields;
- bulk/global changes with preview;
- logic/network view;
- look-aheads, layouts, reporting;
- import/export adapter framework and first professional interchange adapter.

Exit:
- scheduler can status a project and explain forecast movement;
- schedule run emits diagnostics and traceable date reasons;
- baseline variance is auditable;
- supported imports have round-trip tests.

## M3 — Resources, cost & earned value

**Goal:** integrate time, capacity, and money.

Deliverables:
- resources, roles, crews, calendars, rates;
- assignments and time-phased demand;
- histograms and overload detection;
- deterministic leveling heuristics;
- scenario-based optimized leveling;
- expenses and cost accounts;
- budget, actual, remaining, forecast cost;
- EVM engine and dashboards.

Exit:
- conflicts can be identified and resolved in isolated scenarios;
- EVM formulas have fixtures;
- cost/schedule changes trace to source data.

## M4 — Programs, portfolios & enterprise controls

**Goal:** coordinate many projects and organizations.

Deliverables:
- programs and portfolios;
- cross-project dependencies;
- shared resource pools;
- portfolio milestones and rollups;
- capacity planning;
- enterprise codes/calendars;
- advanced RBAC and SSO;
- approvals and notifications;
- API/webhooks;
- enterprise audit/export;
- reporting service.

Exit:
- projects share resources without corrupting project-level state;
- permissions are server-enforced and security-tested;
- portfolio rollups reproduce from project snapshots.

## M5 — Engineo Intelligence

**Goal:** make complex project controls dramatically easier without weakening correctness.

Deliverables:
- natural-language project query;
- schedule quality audit;
- explain-why date analysis;
- delay/root-cause tracing;
- schedule generation assistant;
- recovery scenario generation;
- resource conflict recommendations;
- document-to-plan drafting;
- field-report progress suggestions;
- Monte Carlo schedule-risk analysis;
- executive summaries.

Exit:
- AI answers about dates/float/cost cite deterministic tool results;
- AI edits are previewed as scenarios;
- hallucinated schedule mathematics cannot enter authoritative state;
- automated changes are auditable and reversible.

## M6 — Ecosystem & scale

**Goal:** make Engineo a platform.

Deliverables:
- public API;
- plugin/extension model;
- integration SDK;
- richer interchange adapters;
- optional desktop/offline mode;
- deployment packaging;
- observability;
- localization and accessibility hardening;
- very-large-portfolio performance work.

## Definition of complete

A professional feature is complete only when it has:
1. domain model;
2. deterministic behavior where applicable;
3. validation;
4. UI;
5. interoperability behavior where relevant;
6. auditability;
7. tests;
8. performance characterization.


## Cross-cutting security & trust roadmap

Security is not deferred to an enterprise milestone. Each product milestone carries a security exit criterion.

### S0 — Security foundation (runs with M0)

- dependency vulnerability gates for JavaScript and Rust;
- explicit dependency build-script policy;
- minimal CI permissions and secret hygiene;
- initial threat model and security architecture;
- deterministic engine requires no internet access;
- secure configuration conventions;
- tenant-scoped data-access design before persistence;
- hostile-input posture for future importers.

**Exit:** known high-severity dependency findings fail CI; secrets are not stored in the repository; trust boundaries are documented; auth/persistence work has explicit tenant-isolation requirements.

### S1 — Identity, tenant isolation & audit (runs with M1)

- secure sessions and CSRF protection;
- organization/project RBAC;
- tenant-scoped persistence and negative cross-tenant tests;
- append-oriented audit-event foundation;
- rate limiting and secure headers;
- encrypted production transport/storage;
- secrets manager/KMS integration;
- automated backup plus restore test.

**Exit:** changing an ID cannot expose another tenant; privileged changes are audited; session revocation works; restore procedure is demonstrated.

### S2 — Secure interoperability & customer networking (runs with M2)

- hostile-file import bounds and isolation;
- import provenance and hashes;
- export authorization tests;
- standard HTTP/HTTPS proxy and NO_PROXY support;
- shared egress/SSRF policy;
- configurable enterprise CA trust;
- direct-egress-disable option for private deployments.

**Exit:** proxy support cannot become an arbitrary network tunnel; malicious import fixtures pass; imports/exports are tenant-safe and auditable.

### S3 — Sensitive controls data (runs with M3)

- authorization for cost/resource data;
- scoped service/integration credentials;
- data-classification policy;
- enhanced export controls;
- resource-intensive job quotas and abuse limits.

**Exit:** cost/resource access follows explicit permissions and high-volume calculations cannot trivially exhaust shared service capacity.

### S4 — Enterprise identity & private connectivity (runs with M4)

- OIDC federation;
- SAML/SCIM where required;
- IP allowlists;
- mTLS for selected API/integration clients;
- site-to-site VPN/private endpoint deployment patterns;
- customer reverse-proxy/WAF guidance;
- private/self-hosted deployment hardening;
- SIEM/security-log export.

**Exit:** enterprise identity lifecycle and private connectivity preserve the same authorization/audit guarantees as public SaaS access.

### S5 — AI security (runs with M5)

- authorization-aware AI tools;
- no blanket AI database credentials;
- prompt-injection regression suite;
- scenario-first write behavior;
- deterministic validation before material changes;
- explicit approval/permission for scenario application;
- model-context secret/PII minimization;
- enterprise provider/data-handling controls.

**Exit:** untrusted prompt/document content cannot grant permissions, cross tenant boundaries, or place unvalidated schedule math into authoritative state.

### S6 — Release assurance & ecosystem security (runs with M6)

- SBOMs;
- signed releases;
- build provenance/attestations;
- hardened deployment images;
- plugin capability/permission model;
- public API security review;
- formal penetration testing cadence;
- SOC 2/ISO 27001 readiness work if commercially justified.

**Exit:** users can verify release provenance and extensions cannot silently acquire unrestricted platform capabilities.

See `docs/SECURITY.md` and `docs/THREAT_MODEL.md`.
