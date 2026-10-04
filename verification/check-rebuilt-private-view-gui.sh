#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TOOLS="$ROOT/verification/tooling/node_modules"
if [[ ! -f "$TOOLS/typescript/bin/tsc" ]]; then
  printf '%s\n' 'Install only the pinned verification tools first: npm ci --prefix verification/tooling --ignore-scripts --no-audit --no-fund'
  exit 1
fi
if [[ ! -e node_modules && ! -L node_modules ]]; then
  ln -s verification/tooling/node_modules node_modules
fi
mkdir -p "$TOOLS/@engineo" verification/evidence
if [[ ! -e "$TOOLS/@engineo/contracts" && ! -L "$TOOLS/@engineo/contracts" ]]; then
  ln -s "$ROOT/packages/contracts" "$TOOLS/@engineo/contracts"
fi
GUARD="$ROOT/verification/no-runtime-io.mjs"
node --import "$GUARD" "$TOOLS/typescript/bin/tsc" -p packages/contracts/tsconfig.build.json
node --import "$GUARD" "$TOOLS/typescript/bin/tsc" -p packages/contracts/tsconfig.json
node --import "$GUARD" "$TOOLS/typescript/bin/tsc" -p apps/web/tsconfig.json
node --import "$GUARD" "$TOOLS/@biomejs/biome/bin/biome" format apps/web packages/contracts/src/index.ts packages/contracts/src/planner-view-operations.ts verification/no-runtime-io.mjs verification/tsconfig.gui-build.json verification/tooling/package.json
node --import "$GUARD" "$TOOLS/@biomejs/biome/bin/biome" lint apps/web packages/contracts/src/index.ts packages/contracts/src/planner-view-operations.ts verification/no-runtime-io.mjs
TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import "$GUARD" --import "$TOOLS/tsx/dist/loader.mjs" --test apps/web/app/planner/*.test.ts apps/web/app/planner/*.test.tsx
node --import "$GUARD" "$TOOLS/typescript/bin/tsc" -p verification/tsconfig.gui-build.json
node --import "$GUARD" "$TOOLS/esbuild/bin/esbuild" apps/web/app/planner/Planner.tsx --bundle --platform=browser --format=esm --outfile=verification/gui-build/planner-browser.js
printf '%s\n' 'Client-only static and mocked checks passed. API, database, HTTP, browser and Next.js runtime acceptance were not run.'
