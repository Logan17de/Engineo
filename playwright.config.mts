import { defineConfig } from "@playwright/test";
import { browserDatabaseEnvironment } from "./scripts/browser-test-database.mjs";

const { url: databaseUrl } = browserDatabaseEnvironment(process.env);
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "test-results",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 960 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: [
    {
      command: "pnpm --filter @engineo/api start",
      url: "http://127.0.0.1:4000/health",
      reuseExistingServer: false,
      env: {
        DATABASE_URL: databaseUrl,
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        PORT: "4000",
        APP_ORIGIN: "http://127.0.0.1:3100",
        COOKIE_SECURE: "false",
      },
    },
    {
      command: "pnpm --filter @engineo/web start --hostname 127.0.0.1 --port 3100",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
