# Private Planner view API v1

## Scope

This API/persistence slice builds on the separate inert
[configuration/projector contract](planner-views-v1.md). It stores only private
named presentation records and compact historical operation receipts. It is not
saved-view feature acceptance: GUI controls/focus/virtualization, application CLI
commands, actual browser/headless end-to-end parity and exact-head full review
remain separate work. No schedule input/result serializer or Rust algorithm is
changed. Native remains a client built-in, not a stored editable record.

## Ownership, authorization and source protection

Every endpoint requires a verified live cookie session plus `X-Engineo-Session`.
Every POST, including validation/projection/preview, requires exact configured
`Origin` and current double-submit CSRF. Errors and successes are `no-store`.
The view route scope authenticates, checks scope and charges a shared read quota
before body parsing or semantic validation, so rejected hostile bodies also count.
The bounded original-byte JSON parser is local to this route scope; existing
Planner/auth/configuration parsing and limits are unchanged.

`view.private.write` explicitly derives from live `project.read`. Existing
organization/project intersection rules and owner/admin project-access overrides
are unchanged. A project viewer may save their own presentation and gains no
project/schedule write or calculate permission. Every record query includes the
current actor owner; even organization owners/admins cannot enumerate another
actor's private names/configurations/counts. A foreign and an unknown view ID both
return `view_not_found` (404). Unauthorized/foreign/unknown project scope has the
same generic `forbidden` (403). This is application privacy, not protection against
an already privileged database administrator.

Live lock order is session SHARE, organization membership SHARE, project SHARE,
project membership SHARE; writes then acquire feature-global budget UPDATE,
project budget UPDATE, own view UPDATE, operation UPDATE. Missing memberships
reject before later locks. Wall-clock session expiry and cancellation are checked
after waits and immediately before commit. Personal views never acquire an
exclusive schedule/project lock, bump project.revision, modify entity IDs/native
orders/times, reconcile an engine input, or invoke a calculation.

Calculated projection first charges/authenticates, then uses the existing configured
runner's engine-version resolver outside database locks. This is a compatibility
declaration, not binary attestation. The protected source transaction reauthorizes
and holds project SHARE while reading native schedule components and the matching
immutable current calculation on one executor. It independently checks native
input validity/entity bounds, exact unchanged canonical input bytes/hash,
calculation revision/supported versions/current engine declaration, exact result
bytes/hash, result shape/ID coverage and unchanged result serialization. Separate
snapshot/result repository transactions and client-supplied result markers are
never used to establish coherence. Input-only projection does not probe or verify
a calculation; corrupt/missing/stale calculation cannot poison that path.

## HTTP endpoints

Base: `/organizations/:organizationId/projects/:projectId/views`

- `GET /`: only the caller's summaries, immutable Native metadata, deterministic
  normalized-name UTF-8/C-collation then UUID order, limit 1–50, opaque own-view UUID
  cursor. Cursor resolution is owned/scoped. No name/config bytes enter a URL
- `GET /:viewId`: strict owned normalized configuration, independent revision/hash,
  timestamps. This is also the configuration export; no schedule/result is included
- `GET /capabilities`: bounded protocol/limits/enums and server UTC-day window,
  closing time and replay horizon. It grants no permission or identity
- `POST /validate`: `{configuration}`. Returns normalized config/hash, observed
  schedule revision, diagnostics, `calculationChecked:false`, and
  `activationAvailable:true` only for input-only configuration. Calculated views
  report false without pretending a calculation was checked. No record/plan/audit
- `POST /projection`: `{configuration,expectedScheduleRevision}` against the coherent
  saved source. `GET /:viewId/projection` projects the latest owned record/current
  saved source. Success is the bounded shared rows/counts/binding DTO, no full result
- `POST /plan`: `{action,operationWindowId,operationId,expectedScheduleRevision,...}`.
  Create/update include configuration; update/delete additionally include viewId
  and expectedViewRevision. Response is `{review,reviewedDigest}`. No server plan,
  pending artifact, view mutation or preview audit is stored
- `POST /apply`: `{review,reviewedDigest}` only. Returns an immutable compact receipt
- `GET /operations/:operationWindowId/:operationId`: current live session may read
  this actor's retained receipt after reauthentication. Response is `recorded` or
  `not_recorded`, with `windowClosed` and `absenceDefinitive`. Open-window absence
  cannot rule out an in-flight commit. Closed-window absence is serialized with
  apply and is definitive. Expired horizon is `view_operation_expired` (410)

There is no server cancel/pending status. Discarding a stateless local preview
cannot cancel a committed write. Deleting a known record requires a separate
explicit revision-bound delete operation.

## Strict data, diagnostics and projection

Configuration is the exact complete private v1 shape in the shared specification.
New request/review bodies are at most 64 KiB UTF-8 and eight containers; normalized
config is at most 8 KiB. Original bytes are parsed with fatal UTF-8, decoded
property duplicate detection, safe-integer original numeric spelling and Unicode
checks before shape validation. There is no coercion, executable content, default
injection, unknown extension, or owner/audience field. Diagnostics have at most 20
issues/256 UTF-16 units and totalCount/truncated. API errors replace diagnostic
paths/messages with fixed safe vocabulary. Raw config/search, unknown keys and
underlying exception text are not logged. Only this new plugin uses silent request
logging, preventing even rejected raw query/path text from entering default
pre-hook request logs; legacy logging and compact DB audits remain unchanged. The later CLI parse-failure redaction
work is not included here.

WBS references are exact direct UUID membership, validated against this protected
local project snapshot. Deleted, unknown and foreign WBS all return the same
`view_reference_stale` (409), without foreign labels. Existing stale preferences
remain stored/readable for repair or explicit deletion. No silent widening occurs.
Calculated predicates/sorts require a verified supported saved result and return
`view_result_required` (409) if unavailable; a corrupt matching result fails with
`view_integrity_error` (503). Projection never calculates or guesses dates/float.
A successful response is at most 4 MiB and uses existing entity ceilings; an
oversized projection fails `view_projection_too_large` rather than truncating.

Configuration hashes use the unchanged view canonical envelope with explicit
projection/normalization versions. They never reuse schedule/result hash domains.
Reviews have their own canonical `engineo-planner-view-review-v1-canonical` envelope.
Every review binds full base/desired configurations and hashes, action/view identity,
view/schedule revisions, actor/current creator session, organization/project,
protocol/projection/normalization versions, operation identity and issued/expiry
UTC timestamps. Digest and full field checks are consistency/intent checks, not
credentials, signatures, proof of human approval or authorization. An authorized
caller may construct an equivalent complete valid presentation review directly.
The server independently verifies identity, current base, hashes, versions, scope,
references and time boundaries.

## Atomic apply, CAS and historical replay

Create chooses a fresh server UUID only when committed and starts viewRevision 1.
Material update increments only that view revision once; same normalized config
returns `no_op` at the same view revision. Delete physically removes only that
owned record and returns `deleted` with null committed revision/hash. Record
identity/owner/createdAt cannot change during updates. Safe-integer view revision
exhaustion fails before a material update; no-op/delete remain possible.

Operation identity is caller UUID plus server-derived current UTC-day window.
Supported operation days are 0001-01-01 through 9999-12-29, matching PostgreSQL and
keeping the complete two-day replay horizon within four-digit ISO years.
Only the currently open day admits an absent key. A retained exact same
actor/session/request key replays its original historical receipt before current
view/schedule revision or review-time checks, even after later edits/deletion.
Changed payload for that key returns `view_idempotency_conflict`. A new live session
may read its actor's receipt but cannot apply/replay an old-session preview.

Fresh reviews expire no later than 15 minutes, creator session expiry or midnight
window close. The server rechecks these bounds after lock waits and before commit.
Receipts retain through 24 hours after the window closes, at most 48 hours after
recording. Closed absent keys never reexecute; expired keys return410 even if a
stale retained row has not yet been collected. A reused UUID in a new day is a
distinct identity and does not adopt the original view.

A fixed protected global UTC-day high-water checkpoint is included in the storage
integrity hash. Admission and maintenance sample the trusted SQL UTC day after
the global lock; a day earlier than the persisted checkpoint, a missing day or
an unsupported day fails closed before allocation or key admission. A later day
advances the checkpoint through a clock-only protected transition with all other
counters unchanged. There is no per-key clock tombstone or strict millisecond
request ordering. Successful pruning preserves the checkpoint, so rolling the
server day back cannot readmit an absent key whose window was already collected.
The date reader has no caller parameter/GUC override; production uses only the
actual SQL wall clock. Operators must restore a trustworthy clock rather than
resetting the checkpoint through this API. Same-day time/session/expiry checks
still rely on the trusted wall clock; this is a day-window fence, not a distributed
monotonic-time service.

Mutation/no-op, accepted write budget/rate transition, one compact `view.apply`
audit and one receipt are one transaction. Any fault rolls them all back.
Replay creates no new record/audit/receipt/write admission. The view audit contains
only fixed identity/revision/hash/window fields, no configuration/source content;
existing `project.schedule.edit`/`schedule.run` audit behavior is untouched. Receipt
is at most 2 KiB, hash-verified, immutable during retention and bound by composite
scope/creator-session/audit references. It describes the historical outcome, not
current record state. Abort before commit is best-effort rollback; response loss
once commit starts is uncertain. Recover by querying/retrying exactly the original
identity, never by guessing from a same-named view or creating a new key.

## Finite logical admission and maintenance

Migration 0007 is forward-only; all six applied migration bytes remain unchanged.
Trigger-managed counters and non-secret integrity hashes serialize global then
project reservations. Direct counter update/delete/truncate and forged settable
GUC transitions are rejected; missing/drifted state fails closed. Request admission
does not SUM retained history or rely on process timers. Counts/bytes use database
computed allocation sizes, never client-provided byte claims.

Limits are server-controlled:

- 20 active views per actor/project; 128 per project; 8 KiB configuration
- 1 MiB active configuration/project;64 MiB global active configuration
- 4 MiB/project and 128 MiB global combined configuration, receipt, rate and charged
  project-budget scope allocation; receipt count hard limit 100,000
- Shared read/validate/projection/plan/apply pre-parser admission 120/actor/project
  and 600/project per fixed UTC minute. Rejected bodies count. Separate from login
  limiter, fail closed if limiter storage is unavailable
- Fresh accepted writes 60/actor/project and 300/project in a trailing hour, via
  indexed LIMIT 60/300 retained-operation probes under admission locks, plus shared
  protected fixed-UTC-hour write counters. Exact replay is excluded
- Rate records 256 logical bytes, at most 1,024/project and 32,768 global, indexed
  expiry. Permanent project-budget rows 256 logical bytes each, at most 32,768 global;
  their allocation is charged and cannot grow forever for free from read traffic
- Lifetime feature audit-admission ceiling 100,000 compact events globally, each
  bounded to 2 KiB. Initial no-op counts; exact replay does not. Audit has no TTL or
  lifecycle. At the ceiling writes hard-stop. Product/operations must approve a
  later audited archival decision before raising/removing it; existing audit
  append-only triggers are not weakened, and non-view audit growth is unchanged

`node dist/db/planner-view-maintenance-cli.js` executes one indexed batch of at
most 64 expired receipts/rate rows combined. It provisions no cron/identity/grant.
The privileged function's PUBLIC execute is revoked. It locks global/project
accounting before rows, uses SKIP LOCKED for busy rows, checks exact identity/call
stack and wall-clock horizon, and atomically releases reservations. It cannot
collect open/admissible windows or reset counters/audits. No maintenance traffic
means capacity may hard-stop; admission does not silently expand bounds.

These are logical byte/count ceilings, not physical PostgreSQL acceptance. Pages,
indexes, dead tuples, WAL, operating latency/RSS, encrypted production backups,
RPO/RTO and separately scoped operational identities remain unmeasured/unaccepted.
Retained operation references temporarily constrain physical creator-session and
audit deletion; revocation does not require physical session deletion. Project
budget/audit scope history is intentionally finite retained state. The protected
project-budget FK also constrains physical project deletion; any future physical
delete/archival/reset protocol needs explicit design. There is no project-delete
API or implicit budget/audit reset in this slice.
