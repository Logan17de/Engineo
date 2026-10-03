# M1 durable completed calculations

This increment is newly reconstructed on draft #59 (`b29dd49`); it does not
recover the unavailable unpublished durable checkpoint. It adds completed-run
persistence, not an asynchronous job queue or new schedule mathematics.

## HTTP and contract

`POST /organizations/:organizationId/projects/:projectId/schedule/run` still
accepts `{ expectedRevision }` and returns `{ revision, result }`. It additionally
returns `calculation: ScheduleCalculationMetadataV1` from `@engineo/contracts`:

```ts
interface ScheduleCalculationMetadataV1 {
  schemaVersion: 1;
  calculationId: string;
  projectRevision: number;
  inputHashSha256: string;
  resultHashSha256: string;
  engineContractVersion: 1;
  engineVersion: string;
  calculatedAt: string;
}
```

`GET .../schedule/result` requires a live session and `project.read` and returns
`{ revision, result, calculation }`. `revision` is the current project revision.
Both other fields are null when no completed run matches that revision, its
current canonical input hash, contract version, and the deployed bridge's declared
engine identity. An old run is retained as history but never displayed as current.
The GET does not perform a calculation. All responses are `Cache-Control: no-store`.

POST requires existing Origin, CSRF, session-binding and `schedule.run` checks.
Finalization independently rechecks the same live session, organization/project
permissions, revision and exact canonical input in the database transaction.
Revoked or expired sessions return 401, permission loss 403, changed input/revision
409, cancelled work 409, and invalid or oversized engine/stored output 503.
Corrupt persisted data is a fail-closed error, not a successful null result.
Engine identity/availability failures return 503 rather than using an old result.

## Immutable persistence and hashing

Migration `0004_schedule_calculations.sql` adds an append-only tenant-scoped table
with a composite project foreign key and tenant-bound audit-event foreign key.
Each row stores the exact canonical input, project revision, exact serialized
result, SHA-256 hashes, declared engine contract/build identity, timestamp and
corresponding audit ID. This input snapshot is immutable even as the live project
changes. UPDATE, DELETE and TRUNCATE are rejected. Project deletion is restricted
while calculation history exists; retention/deletion administration is outside
this increment.

Input hashing retains `serializeScheduleInputV1`'s canonical v1 representation.
Results use `serializeScheduleResultV1`: compact UTF-8 JSON, recursively sorted
object keys using code-point comparison, array order retained, no trailing newline.
Input and result are stored as text so PostgreSQL JSONB key reordering cannot
change the hashed bytes. Retrieval verifies exact input, both hashes, serialized
result representation, byte bounds and result shape against current activity IDs.
Unknown output properties are rejected at every object level before recursive
serialization, so opaque deeply nested extensions cannot bypass the v1 boundary.
Metadata is bounded scalar data and does not contain a duplicate result.

The Rust bridge owns all dates, float, controlling paths and violations. Its new
`--engine-info` reports contract version and a package version plus reproducible
FNV-1a source compatibility fingerprint. The fingerprint covers all three Rust
crates' sources/manifests, workspace manifest and lockfile. It is a declared
compatibility identity, **not a cryptographic source/binary attestation**. The
API obtains it through a bounded process handshake and supplies
`--engine-version <identity>` to the calculating process, which rejects a mismatch.
Deployments must still supply and protect a trusted immutable executable. Signed
artifacts, provenance, compiler/feature attestation and hardened execution remain
operational release gates.

## Commit, retry and cancellation boundary

Rust runs outside a database transaction. After it finishes, finalization locks
the session, organization membership, project and relevant project membership
in that order. SHARE locks serialize revocation/role changes; the project UPDATE
lock serializes edits and finalizers. Session expiry is checked using wall-clock
time after lock waits and again just before commit. An edit committed during Rust
work invalidates that result, including a changed input with an unchanged revision.

An immutable result and its `schedule.run` audit are inserted in one transaction.
A failure in either insertion rolls both back. Identical revision/input/engine
requests have one unique stored run and one audit, including separate API replicas.
A successful retry returns that same calculation ID/timestamp/result. If a
run is already available, an independently authorized, current-input-checked
reuse path returns it without launching Rust again. Two replicas can still both
calculate when neither sees a completed run; finalization safely deduplicates them.
If a new calculation differs for the same declared engine/input, finalization fails closed
with `schedule_result_conflict`; it does not rewrite the existing run or invent
another history entry. In-process concurrent runs retain the existing 409 admission
response. This increment does not add distributed engine admission or tenant quotas.

Disconnect/cancellation is checked after blocking finalization operations and
before transaction callback completion. It rolls back uncommitted audit/result
changes. Cancellation during PostgreSQL COMMIT is inherently best effort: an
already committed calculation can survive a lost response, and authorized GET
allows clients to restore it without blindly repeating POST.

Canonical input and serialized output are each bounded at 32 MiB in the repository
and database; process execution retains its existing input/output/deadline/admission
limits. Request bodies still have the existing 1 MiB API limit. The API does not
claim 100,000-activity browser acceptance or a production-ready persistence service.
