# Engineo Development

## Prerequisites

- Node.js 24+
- pnpm 12.8+
- Rust 1.99 with `rustfmt` and `clippy`
- Git

The repository pins the Rust toolchain in `rust-toolchain.toml` and declares the pnpm version in the root `package.json`.

## Install

```bash
pnpm install --frozen-lockfile
```

Rust workspace dependencies are resolved by Cargo when Rust commands run.

## Run the Planner

Start the web application and API together:

```bash
pnpm dev
```

Defaults:
- web: http://localhost:3000
- API: http://localhost:4000
- API health: http://localhost:4000/health

Set `DATABASE_URL` to a disposable development PostgreSQL database, run
`pnpm --filter @engineo/api db:migrate`, and build the deterministic bridge:

```bash
cargo build --release --locked -p engineo-scheduling --bin engineo-schedule
export ENGINEO_SCHEDULER_BIN="$PWD/target/release/engineo-schedule"
```

The Planner uses same-origin `/api` forwarding to `ENGINEO_API_ORIGIN` (default
`http://127.0.0.1:4000`). Set `APP_ORIGIN=http://localhost:3000` and
`COOKIE_SECURE=false` for this local HTTP development origin. Production API
configuration requires HTTPS and secure cookies. Sign-in requires a provisioned
account; identity administration is still an open acceptance item. Browser tests
create unique accounts only in their disposable test database.

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
pnpm test:browser
```

Browser acceptance uses the production builds and real PostgreSQL/Rust bridge.
Run `pnpm build` and `pnpm exec playwright install --with-deps chromium` first,
and provide a disposable loopback `DATABASE_URL` and `ENGINEO_SCHEDULER_BIN`.
Playwright starts its own servers on ports 3100/4000. A system Chromium can be
selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. See the
[browser execution record](verification/2026-10-02-planner-browser.md) for
coverage and current limits. Generated traces/reports are ignored artifacts.

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
