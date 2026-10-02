import postgres from "postgres";
import { type DatabaseConfig, databaseConfigFromEnv } from "./config.js";

export type Database = ReturnType<typeof postgres>;
export type DatabaseExecutor = Database | postgres.TransactionSql;

export function createDatabase(config: DatabaseConfig = databaseConfigFromEnv()): Database {
  return postgres(config.url, {
    max: config.maxConnections,
    idle_timeout: config.idleTimeoutSeconds,
    connect_timeout: config.connectTimeoutSeconds,
    prepare: true,
    connection: {
      statement_timeout: 30_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 30_000,
    },
    transform: {
      undefined: null,
    },
  });
}
