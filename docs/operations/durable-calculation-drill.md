# Durable calculation migration, backup and restore drill

These are release gates, not evidence of an executed production deployment.
All data-changing rehearsal steps target an owned disposable database. Production
credentials, backup identities/storage, scheduled automation and deployment
require the owner's separate decision.

## Current blocker and status

The saved cloud runtime has PostgreSQL 18.4 and the native server/init/management
tools, but lacks `pg_dump` and `pg_restore`. A read-only download of the official
PostgreSQL client package index from `apt.postgresql.org` failed with
`Tunnel connection failed: 403 Forbidden`. No new credentials, repository setting
or alternate execution environment were used. The restore and rollback drill
below is **never run**. An approved PostgreSQL 18 client source is needed first.

## Migration and application rollback

Record the application commit, locked dependencies, Rust binary digest and SQL
checksums before the rehearsal. Run the migration CLI against a populated owned
copy, then run it again: immutable checksums and markers must remain unchanged.
Migration 0004 is additive: a result table, tenant/project foreign key, size/shape
constraints, current-revision index and append-only trigger. No existing project
input is rewritten or backfilled.

Exercise a completed run, restart and verify the same ID, revision, canonical
input/result hashes and audit. Verify a viewer reads it, a foreign tenant cannot,
and a new edit hides its dates. These application/API behaviors have local test
evidence; the complete operational migration/rollback rehearsal still needs a
record on the final release candidate.

For application rollback, run the previous reviewed application/binary against
the rehearsal database with the additive table retained. Verify login, authorized
input reads/edits/export and later re-upgrade result reads. Do not delete result
history or checksum markers to force rollback. A schema defect needs a reviewed
forward migration, or a tested restore of the pre-migration copy before any
accepted production writes. Record any incompatible client/schema behavior.

Concurrent migrator safety, deliberate failed-migration rollback and this
previous-binary/re-upgrade drill remain pending operational checks.

## Backup and empty-database restore

PostgreSQL documents that [`pg_dump` makes a consistent logical export](https://www.postgresql.org/docs/18/app-pgdump.html)
and its custom format is restored with `pg_restore`. Provision the approved
backup/restore identities and credential files through the selected secret store;
do not commit passwords or copy production credentials into the rehearsal.

Use the PostgreSQL 18 tools against the owned database, with `PGHOST`, `PGPORT`,
`PGUSER`, `PGDATABASE` and `PGPASSFILE` supplied by the operator. Choose an
approved artifact path in `ENGINEO_BACKUP_FILE`; measure duration and save a
digest alongside the run manifest:

```bash
pg_dump --format=custom --file="$ENGINEO_BACKUP_FILE"
sha256sum "$ENGINEO_BACKUP_FILE"
pg_restore --list "$ENGINEO_BACKUP_FILE"
```

Create a new empty rehearsal database and set its name in `PGDATABASE`.
Restore using its approved identity. Keep source roles/ownership available for
this drill so ACLs are tested as well as data:

```bash
pg_restore --exit-on-error --single-transaction \
  --dbname="$PGDATABASE" "$ENGINEO_BACKUP_FILE"
```

Start the exact candidate API/Rust binary against that restored database. Compare
the source/destination migration checksums, project revision and canonical input
hashes, all schedule-run IDs/byte hashes, audit attribution/counts, memberships
and permissions. Calculate one unchanged fixture and compare its deterministic
result. Repeat the invalid/revoked/viewer/foreign-tenant cases; restoring data
must not weaken authorization or append-only enforcement.

Record dump/restore/start/verification durations, archive bytes and the newest
restored committed event. Declare measured RTO and observed data loss for this
rehearsal. Production RPO/RTO, encryption at rest/in transit, automated retention,
WAL/PITR strategy, restore monitoring and an independent restore cadence remain
open; one logical dump does not establish those controls.
