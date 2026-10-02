# M1 Planner API increment

This reconciles the existing `feat/m1-project-api` branch at
`d2aa71235bb7474dbef0257bab92b3088c791ea2` with the reviewed auth repairs. The
original branches are preserved. It implements the API boundary for a Planner;
it does not complete M1's browser, progress, saved-view or spreadsheet exits.

## HTTP interface

All organization/project IDs and persisted child IDs are UUIDs. Authenticated
responses use `Cache-Control: no-store`. Reads require a live session and project
permission. Mutations additionally require allowed Origin, session-bound CSRF
and server-side write/run permission. Organization planners may create their own
projects and receive manager membership; viewers cannot create or mutate them.

| Endpoint | Behavior |
| --- | --- |
| GET /organizations | Caller memberships only, including names and roles |
| POST /organizations | Atomic organization, owner membership and audit; slug conflict 409 |
| GET /organizations/:organizationId/projects | Caller-accessible project summaries |
| POST /organizations/:organizationId/projects | Atomic project, 5x8 calendar, root WBS, settings, manager and audit |
| GET /organizations/:organizationId/projects/:projectId | Project plus write/run permissions |
| GET …/schedule | `{ revision, input, relationshipIds }` from one read-only repeatable-read snapshot |
| PUT …/schedule | `{ expectedRevision, input }`; complete validated canonical schedule edit |
| POST …/wbs, …/calendars, …/activities, …/relationships | Validated creation with expectedRevision |
| DELETE …/activities/:activityId, …/relationships/:relationshipId | Scoped deletion/cascade with expectedRevision |
| POST …/schedule/run | `{ expectedRevision }`; coherent canonical input to the real Rust process; `{ revision, result }` |
| GET …/schedule/export | Authorized, audited canonical v1 JSON download; no authentication state |

Malformed shape/type/UUID returns 400; semantic invalidity or missing child
reference returns 422; stale revision/duplicate returns 409; scoped missing
child returns 404; permission/CSRF denial returns 403. Internal errors expose no
SQL or process diagnostics. Engine availability/capacity/deadline failures return
503 with Retry-After. Requests are bounded at 1 MiB, including bulk edits; arrays
have additional explicit limits. The measured acceptance here is 1,000 activities,
not an assertion that 100,000 fit this API boundary.

## Mutation and calculation semantics

The project revision UPDATE serializes writers. Every material mutation,
revision increment, before/after schedule and audit commit in one transaction.
Failure rolls all of them back. A concurrent or repeated edit using an old
revision gets 409; reload is required before an explicit reapply. Calendar/child
IDs from other projects cannot overwrite or link tenant data. Full-schedule PUT
is currently a transactional replacement of the M1 input tables; new references
from baseline/resource milestones must evolve that strategy before adoption.

The Rust kernel owns dates, float, controlling paths and constraint violations.
The API validates structure, references and acyclic input; it does not implement
schedule arithmetic. The JSON bridge rejects bad schema versions/enums and
returns typed v1 results. Audit records bind runs/exports to input hash and
revision; runs also retain result hash and engine contract version.

The API time-zone catalogue is generated from the pinned Rust chrono-tz data.
Case-sensitive identifiers and aliases agree with the engine; Intl-only offsets
and spellings are rejected. Regenerate after dependency updates:

```bash
cargo build --release --locked -p engineo-scheduling --bin engineo-schedule
node scripts/generate-time-zones.mjs
node scripts/generate-time-zones.mjs --check
```

## Process boundary and remaining controls

Set ENGINEO_SCHEDULER_BIN to the built engineo-schedule executable. No shell is
used; children receive PATH only, not application credentials. Input/output are
bounded at 32 MiB and execution at 30 seconds. The CLI bounds standalone stdin
too. Each API instance admits two calculations and one per project; cancellation,
timeout, unexpected output and synchronous spawn failure recover admission.
Client disconnects before/during calculation propagate cancellation. Admission
is retained until terminated processes actually exit.

This is a process wrapper, not an OS sandbox or distributed job system. Tenant
quotas across replicas, hardened runtime/deployment, Rust binary provenance,
production ingress trust, durable job/result persistence, full role matrix,
MFA/SSO and operational release gates remain in `docs/ACCEPTANCE.md`.
