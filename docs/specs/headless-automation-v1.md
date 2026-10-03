# Headless Planner automation acceptance

The release must support both the graphical Planner and code-driven automation.
The requested Terraform-style interaction means versioned declarative inputs and
explicit validate/plan/apply behavior. A Terraform provider is not a release
requirement unless a concrete integration later needs one.

## Current foundation and missing product surface

The Rust `engineo-schedule` CLI already accepts versioned JSON on standard input
and emits machine-readable deterministic results; it does not access project
persistence or substitute for authenticated product automation. HTTP APIs cover
organization/project creation, schedule reads/edits/runs and exports. Scoped CSV
preview/apply exists. Full application CLI, project-configuration plan/apply,
stable automation authentication and release packaging remain pending.

## Required product workflow

1. `validate`: validate versioned configuration syntax, references, scheduling
   semantics and supported schema without writing project state
2. `plan`: authenticate/authorize reads, compare desired input with the current
   project revision, and return bounded machine-readable before/after changes,
   diagnostics and an apply-bound digest. Planning does not silently create/edit
   projects or accept arbitrary executable configuration
3. `apply`: require the intended revision and reviewed digest, independently
   authenticate/authorize every write and validate again, then commit state plus
   provenance/audit atomically. Stale, changed or unauthorized plans fail closed
4. `calculate` and `read/export`: use the same deterministic engine, current-input
   binding, saved-result integrity and tenant-scoped permissions as the GUI

Command names are provisional; these semantics are the acceptance contract.
Configuration is data, never a script evaluated inside the API. Unknown versions
and unsupported properties return actionable machine-readable errors. No secret
or credential belongs in tracked project configuration, plan output or exports.

## Authentication, retry and operational boundaries

- Every application/API action uses the same tenant/project RBAC, session or
  explicitly scoped automation identity, audit actor and session-intent rules
- Automation authentication does not bypass GUI CSRF/Origin/session protections;
  its intended protocol and privilege scope require an explicit reviewed design
- Creation or expansion of real persistent access is an owner-approved setup step;
  implementation and disposable test identities do not provision production access
- Repeated apply/calculation requests have bounded idempotency keys or equivalent
  immutable input/revision identity; a lost response can be queried without a blind
  duplicate mutation. Replay cannot cross tenant, actor or intended project scope
- CLI exit codes and JSON error codes distinguish validation, stale conflict,
  authorization, capacity, interruption and uncertain commit. Apply emits the
  actual committed revision/audit identity and never invents success
- A local JSON configuration change alone cannot alter production. Production
  destination, credentials, permissions and deployment remain explicit operations

## Release evidence

Run representative project create/read, WBS/activity/relationship/calendar edits,
validation/plan/cancel/apply, calculate and export without GUI interaction. Compare
API persisted inputs, Rust outputs, audit/provenance and GUI-loaded state. Include
wrong/expired identity, viewer and cross-tenant denial, malformed/unsupported data,
concurrent edits, repeated apply, cancellation, lost response and restart recovery.

Provide documented request/config schemas, executable examples that contain no
secrets, machine-readable output and a versioned migration/compatibility policy.
Test the application CLI end-to-end against disposable production-built services;
unit tests or the engine-only CLI do not complete this product requirement.

This acceptance expands the Planner release surface without replacing project
planning, progress, views, interchange or later controls/resource/cost/AI goals.
Security, backup/restore, packaging/provenance, observability, license, deployment
and operational validation still gate a production-ready test handoff.
