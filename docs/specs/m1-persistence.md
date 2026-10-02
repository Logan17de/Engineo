# M1 Persistence Architecture

## Purpose

Engineo's application database stores collaborative product state. It is deliberately separate from the deterministic Rust scheduling engine.

The application flow is:

```text
PostgreSQL
   |
tenant-scoped repository
   |
versioned Engineo schedule contract
   |
Rust scheduling engine
```

The Rust engine never opens a database connection.

## Tenant boundary

Every tenant-owned project child row stores `organization_id` in addition to `project_id`.

Composite foreign keys such as:

```sql
FOREIGN KEY (organization_id, project_id, calendar_id)
  REFERENCES calendars(organization_id, project_id, id)
```

mean an activity cannot reference a calendar belonging to another organization even if application authorization contains a bug.

Application repositories still require an explicit `TenantContext`; database structure is a second defense layer, not a replacement for authorization.

## Core tables

- `organizations`
- `users`
- `organization_memberships`
- `projects`
- `calendars`
- `wbs_nodes`
- `activities`
- `relationships`
- `project_schedule_settings`
- `audit_events`

## Audit history

`audit_events` is append-only. Database triggers reject UPDATE and DELETE.

The initial table is intentionally generic so later API, security, import/export, schedule, and AI actions can share one event stream.

## Migrations

Migrations are plain SQL under `apps/api/migrations/`.

The migration runner:
- applies files in lexical order;
- records SHA-256 checksums;
- refuses to continue if an already-applied migration file changes;
- applies each migration transactionally.

Applied migration files are immutable. Schema changes require a new migration.

## Canonical schedule reconstruction

`ProjectRepository.scheduleSnapshot` reads a project through tenant-scoped queries and rebuilds `EngineProjectInputV1`.

Calculated dates are not stored as authoritative schedule inputs in M1. A schedule run reconstructs the versioned input contract and invokes the deterministic engine.

## CI

GitHub Actions starts a disposable PostgreSQL service for TypeScript/API tests.

Integration tests verify:
- migrations are idempotent;
- a complete schedule can be reconstructed;
- a different tenant cannot read the project through the repository;
- cross-tenant composite references fail at the database layer;
- audit events cannot be updated or deleted.

## Configuration

Only non-secret names/defaults are committed in `.env.example`.

Production `DATABASE_URL` and related credentials must come from the deployment secret store. They must never be placed in repository files, logs, project exports, or AI context.
