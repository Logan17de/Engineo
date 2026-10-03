# Durable Planner calculations

This increment persists an auditable forecast for a saved project revision and
loads it after a browser/application restart. It is a partial M1 increment;
baselines, progress policies and later roadmap exits remain separate.

## Boundary and API

`POST /organizations/:organizationId/projects/:projectId/schedule/run` still
requires the actual authenticated session, project `schedule.run` permission,
CSRF/Origin checks and `expectedRevision`. The API reads a consistent saved
input, validates it and invokes the existing Rust JSON bridge. No scheduling
mathematics moves into the API or browser.

The successful response includes the existing `revision` and `result`, plus
`run`: immutable ID, revision, engine contract version, input/result SHA-256 and
completion time. `GET .../schedule` includes `calculation`, which is null when
the current saved revision has no completed run. Reads, exports and other
mutations do not load unrelated historical result payloads.

`schedule_runs` stores the exact canonical input export bytes, including the
newline, and the compact serialization of the validated result. Hashes cover
those stored text bytes. PostgreSQL `jsonb` is not the byte authority because it
can change object-key order. Input integrity, result integrity and typed result
shape are verified when loading a current calculation. History is append-only,
scoped by organization/project and retained after further revisions.

Both stored payloads have a 32 MiB UTF-8 limit, matching migration 0004's database
constraints. Canonical input size is checked before Rust; compact transport size
alone is insufficient. Input and serialized result size are checked again before
the persistence transaction. An oversized payload returns 422
`schedule_too_large` rather than a database 500 after a successful calculation.

## Commit and interruption

Rust runs outside the database transaction. A short commit transaction locks the
actual session and organization/project membership rows, applies the same RBAC
policy to those locked roles, and locks the project's current revision. Missing
membership rows never gain authority from a subsequent unlocked read. Changed
permission, revoked/expired session or a changed revision rejects persistence.

The result row and `schedule.run` audit event commit together or both roll back.
The event records the actor, run ID, revision, engine contract version and byte
hashes. A final database-clock expiry check covers SQL lock waits. Cancellation
is checked before persistence, after audit insertion and after the final SQL
check. An aborted client cannot leave a result or audit through these waits.

Input, revision and current calculation are read in one repeatable-read
transaction. A concurrent writer cannot mix an old input with a new forecast or
vice versa. Old completed runs remain history, while edits hide their dates for
the new current revision.

## Planner behavior

Opening or reloading a project uses its authorized current calculation. Restoring
a volatile dirty draft clears the displayed result because its input differs
from saved state. A viewer can read authorized dates but cannot run the engine.
Existing offline retry, cancellation, conflict choices and audited export remain
part of the browser scenario matrix.

## Remaining acceptance

The independent local review found no blocking defect. Local static/API/browser
checks are recorded in the execution record. This branch remains separate from
the reviewed account correction until PM approves that head; combined multi-tab
account and durable-result acceptance must then run on the reconciled source.
New exact-head CI/CodeQL and Dependency Review must pass before merge.

Result-history browsing/retention policy, binary build provenance, distributed
calculation admission/tenant quotas and production timeout/shutdown budgets are
pending. Contract version 1 is recorded; it does not identify a complete deployed
binary build. Operational restore and application rollback drills remain open.
