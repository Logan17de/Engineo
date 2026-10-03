import type { Database, DatabaseExecutor } from "../apps/api/src/db/client.js";

export interface BrowserDatabaseEnvironment extends NodeJS.ProcessEnv {
  DATABASE_URL: string;
  ENGINEO_BROWSER_TEST_RUN_ID: string;
  ENGINEO_BROWSER_TEST_SERVER_ID: string;
}

export function assertSerialBrowserScenario(workers: number, baseURL: string | undefined): void;
export function browserDatabaseSource(databaseUrl: string | undefined): URL;
export function browserDatabaseEnvironment(env: NodeJS.ProcessEnv): {
  url: string;
  runId: string;
  serverIdentity: { address: string; port: number };
};
export function assertBrowserDatabase(db: DatabaseExecutor, env: NodeJS.ProcessEnv): Promise<void>;
export function resetBrowserLoginQuota(db: Database, env: NodeJS.ProcessEnv): Promise<void>;
export function createBrowserDatabase(
  sourceUrl: string | undefined,
  connect: (url: string) => Database,
): Promise<{ env: BrowserDatabaseEnvironment; dispose: () => Promise<void> }>;
