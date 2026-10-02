import { buildApp } from "./app.js";
import { createDatabase } from "./db/client.js";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.PORT ?? "4000", 10);

const database = createDatabase();
const app = buildApp({ database });

async function shutdown(): Promise<void> {
  await app.close();
  await database.end({ timeout: 5 });
}

process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.error(error);
  await database.end({ timeout: 5 });
  process.exitCode = 1;
}
