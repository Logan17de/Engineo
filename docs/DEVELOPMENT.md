# Engineo Development

## Prerequisites

- Node.js 24+
- pnpm 12.8+
- Rust 1.99 with `rustfmt` and `clippy`
- Git

The repository pins the Rust toolchain in `rust-toolchain.toml` and declares the pnpm version in the root `package.json`.

## Install

```bash
pnpm install
```

Rust workspace dependencies are resolved by Cargo when Rust commands run.

## Run the product shells

Start the web application and API together:

```bash
pnpm dev
```

Defaults:
- web: http://localhost:3000
- API: http://localhost:4000
- API health: http://localhost:4000/health

These are foundation shells, not the planner UI.

## Run all checks

```bash
pnpm check
```

That command runs the TypeScript/web/API checks followed by Rust formatting, Clippy, and tests.

Individual commands:

```bash
pnpm check:ts
pnpm check:rust
pnpm lint
pnpm format:check
pnpm test:ts
cargo test --workspace
```

## Formatting

Apply formatting:

```bash
pnpm format
```

Biome owns JavaScript/TypeScript/JSON/CSS formatting. Rustfmt owns Rust formatting.

## Repository map

```text
apps/
  web/                 Next.js product UI
  api/                 application API

packages/
  contracts/           versioned TypeScript boundary contracts

crates/
  project-model/       canonical scheduling domain primitives
  calendar/            working-time/calendar primitives
  scheduling/          deterministic scheduling engine

fixtures/
  contracts/           cross-boundary contract fixtures

docs/
  adr/                 architecture decision records
```

## Core rule

Do not put authoritative schedule mathematics in the web app, API handlers, or AI prompts.

The deterministic Rust engine owns calculated schedule behavior. Product layers send normalized inputs to it and consume explicit outputs.

## Contract changes

The engine/application boundary is versioned.

When changing it:
1. update the canonical model intentionally;
2. update the TypeScript contract;
3. add/update a fixture under `fixtures/contracts/`;
4. update Rust-side parsing once serialization is introduced;
5. preserve old versions when compatibility requires it.

Issue #9 owns the full M0 domain contract design.

## Security

- Dependency audits run in CI.
- Dependabot checks JavaScript, Rust, and GitHub Actions dependencies weekly.
- Do not commit secrets or local `.env` files.
- The repository currently has no production credentials or infrastructure.

## Pull requests

Calculation changes should include tests that demonstrate the behavior and its edge cases. Bugs in scheduling semantics should become permanent regression fixtures.
