import type { Database, DatabaseExecutor } from "../apps/api/src/db/client.js";

export function assertSerialBrowserScenario(workers: number, baseURL: string | undefined): void;
export function browserDatabaseSource(databaseUrl: string | undefined): URL;
export function browserDatabaseEnvironment(env: NodeJS.ProcessEnv): { url: string; runId: string };
export function assertBrowserDatabase(db: DatabaseExecutor, env: NodeJS.ProcessEnv): Promise<void>;
export function resetBrowserLoginQuota(db: Database, env: NodeJS.ProcessEnv): Promise<void>;
export function createBrowserDatabase(
  sourceUrl: string | undefined,
  connect: (url: string) => Database,
): Promise<{ env: NodeJS.ProcessEnv; dispose: () => Promise<void> }>;
