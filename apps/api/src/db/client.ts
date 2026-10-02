import postgres from "postgres";
import { type DatabaseConfig, databaseConfigFromEnv } from "./config.js";

export type Database = ReturnType<typeof postgres>;

export function createDatabase(
  config: DatabaseConfig = databaseConfigFromEnv(),
): Database {
  return postgres(config.url, {
    max: config.maxConnections,
    idle_timeout: config.idleTimeoutSeconds,
    connect_timeout: config.connectTimeoutSeconds,
    prepare: true,
    transform: {
      undefined: null,
    },
  });
}
