# ADR-0001: Separate Rust project-controls engine from product application

- Status: Accepted for initial implementation
- Date: 2026-10-02

## Context

Engineo needs two different optimization profiles:

1. rapid product iteration for web workflows, collaboration, permissions, and integrations;
2. highly trustworthy and performant project-controls calculations that may later run server-side, locally, or through WASM.

Combining all product logic and scheduling mathematics into one web application would make the trust core harder to isolate, benchmark, test, and reuse.

## Decision

Use:
- TypeScript + React/Next.js for the web product;
- a modular TypeScript application API initially;
- Rust for the deterministic project-controls engine;
- PostgreSQL for authoritative application persistence;
- a versioned serialization boundary between application and engine.

The Rust engine will be a pure domain library. It will not query the product database or invoke AI.

## Consequences

Positive:
- scheduling engine can be exhaustively tested in isolation;
- predictable performance for large graphs;
- path to native/server/WASM execution;
- product code can iterate without destabilizing calculation internals.

Costs:
- two primary languages;
- explicit cross-language contracts;
- build/release tooling must cover both ecosystems.

## Revisit conditions

Revisit if the cross-language boundary materially slows delivery, WASM/native portability proves unnecessary, or measured performance shows a simpler implementation would meet the quality bar without sacrificing isolation.
