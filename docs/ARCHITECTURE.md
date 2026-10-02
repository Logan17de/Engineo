# Engineo Architecture

## Architecture goals

Engineo should be correct before clever, modular before sprawling, and capable of scaling from one project to enterprise portfolios.

The most important boundary is between **deterministic project-controls computation** and **probabilistic AI assistance**.

## Proposed stack

### Web application
- TypeScript
- React / Next.js
- virtualized grid for large activity tables
- Canvas/WebGL where useful for dense Gantt and network visualization

### Core scheduling engine
- Rust
- pure domain library with no UI or database dependency
- deterministic input -> output contract
- property-based and golden-fixture tests
- optional WASM build later for offline/local calculation

Rust gives the trust core strong typing, predictable performance, memory safety, and a path to native/server/WASM execution.

### Application API
Begin with a modular TypeScript service layer for product velocity. The scheduling engine is invoked through a narrow versioned boundary. Service extraction can happen later without changing domain contracts.

### Persistence
- PostgreSQL as system of record
- object storage for attachments/imports/exports
- Redis only where caching, rate limiting, presence, or jobs justify it

### Background work
A durable job queue handles imports, exports, large recalculations, reports, portfolio rollups, simulations, and AI workflows.

## Logical architecture

```text
Browser / future desktop shell
          |
          v
    Application API
      |    |    |
      |    |    +--> Collaboration / notifications
      |    +-------> Import-export adapters
      +-----------> Project Controls Engine
                         |
                         +--> Calendar arithmetic
                         +--> CPM / paths / float
                         +--> Progress semantics
                         +--> Resource analysis
                         +--> Leveling
                         +--> Cost / EVM
                         +--> Scenario engine

Application API --> PostgreSQL
Application API --> Object storage
Workers         --> Durable queue

AI Orchestrator
   |
   +--> read project tools
   +--> scenario tools
   +--> deterministic validation
   +--> proposed changes
             |
             v
        human approval
```

## Domain boundaries

- **Identity & organizations** — organizations, workspaces, users, teams, roles, permissions.
- **Project structure** — programs, projects, WBS nodes, activities, milestones, codes, custom fields.
- **Scheduling** — relationships, calendars, constraints, data date, progress, options, calculated dates, paths.
- **Resources** — resources, roles, crews, availability, rates, assignments, capacity.
- **Cost & performance** — cost accounts, budgets, actuals, remaining cost, expenses, time-phased values, earned value.
- **Baselines & scenarios** — immutable baseline snapshots and isolated what-if scenarios.
- **Collaboration** — comments, mentions, approvals, notifications, presence, proposals.
- **Audit** — append-only material change events with actor, timestamp, source, before/after, correlation ID.
- **Interoperability** — adapters for XER/XML/CSV/spreadsheets and future APIs. External formats never become the canonical model.

## Scheduling engine contract

The engine receives a normalized scheduling model and options, validates them, and returns:
- calculated activity dates;
- float values;
- project finish;
- critical/controlling-path information;
- diagnostics;
- calculation trace metadata.

The engine must never query the product database directly.

## Large schedule strategy

Target: 100,000+ activities with dense relationships.

Design rules:
- compact IDs/graph structures on hot paths;
- immutable calculation input snapshots;
- incremental recalculation only after full recalculation is proven correct;
- no ORM hydration in calculation paths;
- virtualized UI and timeline rendering;
- background calculation for very large changes;
- cache derived views, never authoritative state.

## AI safety boundary

AI gets structured tools such as `query_activities`, `explain_date`, `trace_path`, `run_schedule`, `create_scenario`, and `evaluate_scenario`.

The LLM never calculates authoritative dates itself. It requests deterministic computation and explains returned facts.

## Future offline strategy

A desktop shell can combine the web UI with a local store and WASM/native scheduling engine after synchronization semantics are stable.

## Architecture decisions

Material decisions belong in `docs/adr/` before implementation becomes expensive to reverse.
