# Project schedule configuration v1 — implementation contract

Status: scoped API source increment from reviewed main
`586efb4494312f584b5d56b70658866121b96566`. Configuration API source and local
verification are implemented; exact-head independent review, remote CI/browser
and full application CLI/GUI parity remain required before acceptance. The existing Rust engine CLI is not a persisted
project automation client. No Terraform provider or production identity is created
by this work.

## Scope and configuration

Operate on one explicitly selected existing organization/project. Configuration
is inert JSON, never evaluated code, templates, URLs or environment expressions:

```json
{
  "schemaVersion": 1,
  "kind": "engineo-project-configuration",
  "scope": "schedule",
  "input": { "schemaVersion": 1 }
}
```

The illustrated input is abbreviated: a complete `EngineProjectInputV1` is
required. It covers project schedule settings/name, calendars, WBS, activities,
constraints, relationships and scheduling options. API destination, credentials,
organization identity and permissions stay outside configuration. Project
code/description, memberships, saved calculations, audit history, progress,
views and deployment are not implicitly overwritten. Project/organization
creation remain separate existing API operations.

## Normalization and complete review

- Reject unknown properties recursively, unknown versions, duplicate JSON keys,
  malformed values, excessive nesting and bounded-size violations
- Apply existing engine-input semantic validation plus native UUIDs, unique WBS
  codes, unique relationship tuples and tenant-safe native-ID availability
- Normalize UUIDs to lowercase and project-setting instants to UTC milliseconds;
  reject precision above three fractional digits instead of silently truncating
- Constraint instant strings remain unchanged because persistence retains them
  in JSONB. Preserve text exactly after validation
- Configuration arrays are non-ordering sets. Preserve surviving GUI activity
  order/creation timestamps; append new activities in documented UUID order
- Preserve surviving relationship UUIDs by predecessor/successor/type/lag tuple
- Rebuild known object fields into the native snapshot/JSONB read order before
  review so JSON key insertion order cannot alter intent (including interval
  end/start and constraint type/instant fields)
- Reuse existing v1 canonical schedule serialization for hashes; do not silently
  change durable-calculation canonicalization
- Return complete deterministic create/update/delete changes with before/after
  values. Never truncate a diff and still issue an applyable digest
- Reconstruct committed persistence and require exact canonical target bytes/hash
  to equal the reviewed normalized candidate; otherwise roll back

Existing `replaceSchedule` is not a suitable reconcile writer: it replaces all
entity rows, derives activity order from request-array order and regenerates
relationship IDs. Use one transaction-local identity-preserving writer with
native dependency/uniqueness handling, including valid WBS-code swaps/reparenting.

## HTTP interface

All paths are below `/organizations/:organizationId/projects/:projectId`.
All protected configuration endpoints require the current session-intent header
in addition to normal cookie/RBAC rules. Mutations retain Origin/CSRF checks.

- `GET /configuration`: coherent authorized canonical configuration, revision
  and input hash; no-store; audited export
- `POST /configuration/validate`: syntax/semantic/persistence-compatible
  validation without project edits or plan creation. Return normalized input,
  desired hash and bounded diagnostics. `calculationChecked: false` explicitly
  distinguishes validation from authoritative Rust calculation
- `POST /configuration/plans`: caller-supplied UUID planId, expectedRevision and
  configuration; requires project.write. Persist the immutable reviewed plan.
  Same scoped identity/request replays; changed request returns idempotency conflict
- `GET /configuration/plans/:planId`: creator actor/session-scoped immutable
  review and derived pending/expired/cancelled/applied/no_op status
- `POST /configuration/plans/:planId/apply`: only expectedRevision and
  reviewedDigest. Accept no replacement input or patch; use the stored candidate
- `POST /configuration/plans/:planId/cancel`: reviewedDigest; explicit durable
  cancellation. Apply-winning races return the recorded receipt, never undo data
- `GET /configuration/plans/:planId/receipt`: read-only terminal evidence for
  the same actor under a current live session; reauthentication may read receipt
  but cannot adopt/apply an old-session pending plan

A plan binds protocol/configuration/normalization versions, generated timestamps,
plan/tenant/project/actor/session identities, base revision/hash, desired hash,
complete changes, no-op classification and SHA-256 reviewed digest. The digest
is consistency evidence, not a credential or proof of human review.

An apply receipt binds plan, tenant/project, applied/no_op outcome, previous and
committed revisions, base/committed input hashes, reviewed digest, provenance
and schedule-edit audit IDs and database recording time. Return success only
after commit. Receipts are historical and do not claim later project state.

## Persistence, transaction and replay

Persist immutable scoped plans/artifacts and one append-only terminal outcome;
use composite tenant/project/audit references, never process-local idempotency.
Use the durable-calculation live-authorization pattern. Consistent locks are
session, organization membership, project, project membership, then plan. Reject
missing memberships immediately; independently authorize under those locks and
recheck wall-clock expiry/cancellation after blocking operations and before commit.
No network call or Rust calculation runs under these locks.

Fresh apply requires the original creator session and current project.write.
Verify stored bytes/hashes and the exact submitted revision/digest. Matching
same-session replay returns the existing receipt without new mutation/audit,
including after TTL or later project edits; it still reauthorizes. Otherwise reject
cancelled/expired/unsupported plans, changed revision or changed canonical base.
Revalidate, reconcile, verify persisted target, and commit mutation plus audits
and receipt atomically. No-op emits a durable provenance receipt/audit without
incrementing revision or emitting an edit audit.

Same-plan concurrent applies across API replicas commit once. Different material
plans on one revision cannot both apply. Cancel/apply serialize to one outcome.
Abort before transaction completion rolls back; a disconnect after commit starts
is uncertain, never proof of rollback. Known planId permits response-loss query
and exact retry without blindly creating a new identity, rebasing or guessing
success from similar current input. Restart must preserve these results.

## Product bounds and storage

Initial documented limits retain the existing 1 MiB transport bound and engine
entity bounds. Candidate/base canonical artifacts may each be at most 4 MiB;
complete reviewed diff at most 8 MiB; at most 100 returned diagnostics with total
count/truncation metadata. Limit pending plans to eight per actor/project and
32 per project, and authenticated new-plan creation to 60 per actor/project/hour
through shared SQL state. TTL is at most 15 minutes and no later than creator
session expiry. These are product limits, not performance-release claims.

TTL alone does not bound storage: terminal/expired heavy artifacts need bounded
maintenance, while compact identity tombstones/terminal receipts prevent planId
reuse. Preserve immutable history and specify retention/error behavior explicitly.
Cleanup/storage failures and concurrent quota admission must have tests.

## Application CLI follow-up

A separate Node application CLI calls this API and existing calculation/result
APIs. Provide versioned machine-readable stdout and stable exit categories for
validation, stale/intent conflict, auth/permission, capacity, unresolved commit
uncertainty and interruption. Destination/target/authentication are separate
from tracked configuration and reviewed plan files. HTTPS is default; disposable
loopback HTTP is explicit. Never forward credentials on cross-origin redirects,
log tokens, accept them in query/command-line/configuration, silently extract GUI
cookies, bypass TLS warnings, relax CSRF/Origin/session intent, or silently re-plan.

The first client may consume explicitly supplied ephemeral session material via
file descriptor/file; real credentials/persistent access are not provisioned or
saved incidentally. Scoped automation identities require a separately reviewed
protocol and owner-approved real provisioning. No permissive CLI exemption or
administrator token is substituted for authorization.

## Required evidence

Contract tests cover strict JSON/version/property/UUID/reference/calendar/graph,
normalization, native uniqueness, permutation/no-op and complete bounded diffs.
Real PostgreSQL API tests cover every role/tenant/actor/session denial, CSRF/
Origin/intent, lock-wait expiry/revocation/role races, concurrent/replayed/stale
plans, cancel/apply winners, lost responses/restart, corruption, rollback at each
audit/outcome boundary, no-op, identity/order preservation, WBS swaps and dependent
deletions, quotas/storage maintenance and migration integrity.

Built CLI acceptance uses real HTTP against disposable production-built services,
including dropped post-commit responses, restart, cancellation, exit categories,
credential/output leak scanning and 1,000 activities. Compare persisted input,
receipts/audits, Rust result/provenance, API exports and GUI-loaded state. Unit
checks and Fastify inject do not substitute for this socket/GUI parity evidence.

Each scoped draft still needs exact-head full CI/browser/security/dependency
checks and independent review. Full M1, later planning/control milestones and
production operational/license/deployment gates remain incomplete.

## Implemented v1 API contract

The scoped source increment implements the seven endpoints above. It does not
complete the full built application CLI/GUI parity or operational acceptance.
Public TypeScript DTOs are exported by `@engineo/contracts` from
`project-configuration.ts`. Configuration request parsing is encapsulated in the
new routes; existing authentication and Planner parsing are unchanged.

`GET /configuration` returns `ProjectConfigurationReadV1`: `schemaVersion`,
`revision`, `inputHashSha256`, and `configuration`. The configuration uses the
existing schedule v1 canonical serialization/property ordering. Export is
transactionally coherent under the current live read permission and appends a
`project.export` audit with the revision, format, input hash and session identity.

`POST /configuration/validate` accepts the configuration object itself. Successful
validation returns `valid: true`, `normalizedConfiguration`,
`desiredInputHashSha256`, `calculationChecked: false`, and `diagnostics`.
Diagnostics contain `issues`, the complete `totalCount`, and `truncated`; at most
100 issues are returned, and each path/message is at most 512 UTF-16 units.
Validation checks native ID availability and append-order feasibility without
reserving IDs or creating a plan. Another project's later ID allocation can
still invalidate a plan before apply. Validation does not calculate the schedule.

Plan creation accepts exactly `{ planId, expectedRevision, configuration }`.
The response and subsequent plan read are `ProjectConfigurationPlanReadV1`:
`planId`, `plan`, `status`, `artifactsAvailable`, and `receipt`. `plan` is the
complete `ProjectConfigurationPlanV1`, including the normalized configuration,
complete changes and digest. Each change has `entity`, `key`, `operation`,
`before`, and `after`. Entity order is project, scheduleOptions, calendar, WBS,
activity, relationship, with deterministic keys within collections. A relationship
key is the JSON tuple of predecessor, successor, type and lag. Its tuple changes
are delete/create changes, preserving surviving native relationship identities.

The reviewed descriptor contains, in order: schemaVersion, protocolVersion,
normalizationVersion, planId, organizationId, projectId, actorId, sessionId,
createdAt, expiresAt, baseRevision, baseInputHashSha256,
desiredInputHashSha256, configuration, changes, noOp. `reviewedDigest` is SHA-256
of its exact compact UTF-8 JSON, without a trailing newline or the digest field.
The shared `serializeProjectConfigurationReviewV1` emits these bytes; runtime
DTO guards check shape and diff consistency. Digest/hash checks provide
consistency and intent binding, not cryptographic authentication or proof of
human review. Schedule input hashes remain SHA-256 of the existing pretty-printed
schedule v1 canonical bytes, including their trailing newline.

Apply accepts exactly `{ expectedRevision, reviewedDigest }`; cancellation
accepts exactly `{ reviewedDigest }`. Neither endpoint accepts replacement input.
Apply and cancellation return `ProjectConfigurationReceiptV1`. All receipts
contain schemaVersion, planId, organizationId, projectId, previousRevision,
baseInputHashSha256, reviewedDigest, provenanceAuditId and recordedAt.
Applied/no-op receipts also contain committedRevision, committedInputHashSha256
and scheduleEditAuditId (null for no-op). A cancellation receipt has outcome
`cancelled` and null committedRevision, committedInputHashSha256 and
scheduleEditAuditId; it makes no claim about current schedule state.

`GET /configuration/plans/:planId/receipt` returns a terminal receipt or
`configuration_not_terminal`. Receipt reads require the same actor and a live
current project.read permission, including after reauthentication. Plan reads,
apply and cancellation require the original session. Fresh plan/apply/cancel
require project.write; export/validate/plan read/receipt require project.read.
Organization owner/admin bypass project membership as in the existing RBAC
protocol. Every endpoint requires the explicit current `X-Engineo-Session`
header, normal cookie authentication, and mutations retain the existing
`X-CSRF-Token`/CSRF-cookie/session and Origin checks. No CLI authentication
exception is added. All responses are no-store.

Normalized-equivalent plan requests (including UUID case or array permutations)
with the same selected project, actor, session, planId and expectedRevision
replay the same review. Changed requests with an existing identity fail closed.
A material apply increments revision once and appends `project.schedule.edit` plus
`configuration.apply` provenance; no-op appends only configuration provenance
and a receipt. The common material-edit action is the existing
`project.schedule.edit`, with a compact payload explicitly identified by
schemaVersion1, kind `engineo-configuration-schedule-edit`, operation
`configuration.apply` and inputHashSerialization
`engineo-schedule-input-v1-canonical`. Its baseInputHashSha256 and
committedInputHashSha256 use canonical schedule v1 bytes, alongside revision,
previousRevision, planId, digest and session. It does not pretend to have the
legacy edit payload's JSON.stringify beforeHash/afterHash or full before/after
snapshots; reviewed complete changes live in the bounded-retention artifact. Explicit cancel appends `configuration.cancel`. Matching apply
replay requires the original session, current write permission and exact
revision/digest, and returns the historical receipt even after TTL or later
edits. Cancellation may record an expired or collected plan as cancelled; if
apply already won, cancel returns its existing receipt. A cancelled apply is
rejected. None of these flows infer success from similar current input.

### Errors and failure behavior

Errors use `{ error }`, optionally with bounded diagnostics and
`calculationChecked: false` for invalid configuration. The initial stable codes
are:

- 401: `unauthenticated`
- 403: `forbidden`, `csrf_validation_failed`, `origin_not_allowed`
- 404: `project_not_found`, `configuration_plan_not_found` (also actor/session
  substitution; no other creator's review is exposed)
- 409: `session_intent_required`, `session_changed`, `revision_conflict`,
  `configuration_base_changed`, `configuration_idempotency_conflict`,
  `configuration_review_changed`, `configuration_expired`,
  `configuration_cancelled`, `configuration_not_terminal`,
  `configuration_interrupted`
- 410: `configuration_artifact_unavailable` for a fresh apply lacking its
  complete stored review; normally expired plans are rejected first
- 413: `configuration_invalid` with TRANSPORT_TOO_LARGE diagnostic
- 422: `configuration_invalid`, `configuration_id_conflict` (generic native-ID
  or native append-order unavailability, without ownership details)
- 429: `configuration_capacity`, `configuration_rate_limit`
- 503: `configuration_integrity_error`; other unavailable database/application
  failures retain the existing sanitized `temporarily_unavailable`/`internal_error`
  responses

Syntax/duplicate-key/version/unknown-property/nesting/numeric-token precision,
UTF-8, native shape and complete-diff bounds reject without an applyable plan.
Submitted project instants with more than three fractional digits reject;
existing native submillisecond project settings fail integrity checks rather
than being silently truncated. The shared native reader preserves Date-object
milliseconds in exactly the three project-setting instant fields. This corrects
prior String(Date) rounding without changing the legacy serializer/Rust math or
rewriting revisions/data/results; erroneous old .000-key runs stay historical and
are not reused for corrected nonzero-millisecond input. Constraint instant text remains unchanged.
Disconnect/abort checks run after blocking operations and just before transaction
completion. Once COMMIT starts, a lost response is unresolved client-side until
known-identity query or exact retry establishes the durable outcome.

### Storage and maintenance semantics

The SQL migration makes scoped plan identities and outcomes append-only, including
TRUNCATE protection. Artifacts cannot be rewritten; deletion is allowed only at
or after their stored collection horizon. Composite project/audit references,
creator actor/session references and audit action/payload checks enforce scope.
Stored canonical/review/receipt bytes and their SHA-256 values are checked before
success; corruption fails closed. New plans serialize admission through the
project lock, including the eight actor/project pending, 32 project pending and
60 actor/project/hour limits. Existing exact identity replay does not consume a
new quota slot. TTL is no later than the creator session's original expiry, derived from one
materialized creation instant so its 15-minute cap cannot drift across a clock tick.

Heavy review collection becomes eligible 24 hours after creation, not an
unconditional physical deletion deadline. Configuration operations perform at
most 64 indexed expired-artifact deletions per maintenance batch, skipping locked
rows. After the API production build,
`pnpm --filter @engineo/api db:configuration-maintenance` executes one
bounded batch and emits a versioned count; it provisions no database identity or
schedule. An operator may arrange repeated invocations using an already approved
deployment identity. No traffic means artifacts can remain past the horizon.

Shared SQL admission enforces at most 1 GiB globally and 128 MiB per project of
logical retained artifact bytes. Generated byte counts include base, candidate,
complete diff and review JSON. Individual base/candidate artifacts cap at 4 MiB,
diff at 8 MiB and descriptor storage at 16 MiB. Reservations/releases occur in
the same transaction as artifact creation/collection, global counter before
project counter. Protected counters use exact generated artifact-byte and count deltas and a
non-secret scope/bytes/count state hash checked under those locks. INSERT/UPDATE/
DELETE/TRUNCATE guards prohibit direct counter reset, rekey or deletion; supported
updates must come from the actual artifact-budget trigger with the exact scoped
transition, nesting and byte/count delta. Missing nonempty project counters,
stale state and underflow fail closed. No retained-table SUM scan runs per admission
or deletion. This establishes consistency for trusted migration/application SQL
transitions; privileged DDL/trigger disabling or coordinated forged state/hash is
outside that integrity boundary, and the hash is not authentication or attestation. Maintenance captures one wall-clock cutoff as an indexed bound, then runs in a
separate short transaction without authorization/project/plan locks. Hourly and
pending admission use stable actor/project-created ranges and saturated threshold
probes capped at 60/8/32, rather than scanning permanent project history. Cleanup failure
propagates and never bypasses admission or implies a project commit. Large reviews
may hit byte admission before pending-count limits. These are logical data bounds,
not PostgreSQL disk, WAL/TOAST, memory, latency or performance-release guarantees.

After collection, plan read explicitly returns `plan: null` and
`artifactsAvailable: false` with derived status and any intact terminal receipt.
No truncated review or applyable digest is fabricated. Permanent compact plan
identity/request hash/digest and terminal receipts prevent planId reuse.
Referenced project/user/session/audit rows are retained by RESTRICT foreign keys,
so revocation remains possible but physical session/account/history deletion and
archival need a separately reviewed lifecycle design. Indefinite compact history,
indexes, session rows and audits still grow. Finite total database size, production
archival, automatic maintenance deployment, encryption/backup/restore and operational
release acceptance remain pending.
