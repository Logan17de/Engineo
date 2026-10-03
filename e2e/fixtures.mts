import { test as base } from "@playwright/test";
import { createDatabase } from "../apps/api/src/db/client.js";
import {
  assertSerialBrowserScenario,
  browserDatabaseEnvironment,
  resetBrowserLoginQuota,
} from "../scripts/browser-test-database.mjs";

export const test = base.extend<{ isolatedLoginQuota: undefined }>({
  isolatedLoginQuota: [
    async ({ baseURL }, use, testInfo) => {
      assertSerialBrowserScenario(testInfo.config.workers, baseURL);
      const { url } = browserDatabaseEnvironment(process.env);
      const db = createDatabase({
        url,
        maxConnections: 1,
        idleTimeoutSeconds: 5,
        connectTimeoutSeconds: 5,
      });
      try {
        await resetBrowserLoginQuota(db, process.env);
        await use(undefined);
      } finally {
        await db.end({ timeout: 5 });
      }
    },
    { auto: true },
  ],
});
