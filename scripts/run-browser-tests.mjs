import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createBrowserDatabase } from "./browser-test-database.mjs";
import { runBrowserTests } from "./browser-test-runner.mjs";

const requireApi = createRequire(new URL("../apps/api/package.json", import.meta.url));
const postgres = requireApi("postgres");
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run browser acceptance with pnpm test:browser.");
process.exitCode = await runBrowserTests({
  createFixture: () =>
    createBrowserDatabase(process.env.DATABASE_URL, (url) =>
      postgres(url, { max: 1, connect_timeout: 5, connection: { statement_timeout: 10_000 } }),
    ),
  startChild: (env) =>
    spawn(pnpm, ["exec", "playwright", "test", ...process.argv.slice(2)], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, ...env },
      stdio: "inherit",
    }),
});
