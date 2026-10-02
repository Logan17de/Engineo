export interface DatabaseConfig {
  url: string;
  maxConnections: number;
  idleTimeoutSeconds: number;
  connectTimeoutSeconds: number;
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function databaseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required");
  }

  return {
    url,
    maxConnections: positiveInteger("DB_MAX_CONNECTIONS", env.DB_MAX_CONNECTIONS, 10),
    idleTimeoutSeconds: positiveInteger("DB_IDLE_TIMEOUT_SECONDS", env.DB_IDLE_TIMEOUT_SECONDS, 20),
    connectTimeoutSeconds: positiveInteger(
      "DB_CONNECT_TIMEOUT_SECONDS",
      env.DB_CONNECT_TIMEOUT_SECONDS,
      10,
    ),
  };
}
