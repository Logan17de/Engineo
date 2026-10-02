import { createDatabase } from "./client.js";
import { migrateDatabase } from "./migrate.js";

const database = createDatabase();

try {
  await migrateDatabase(database);
  console.log("Engineo database migrations applied.");
} finally {
  await database.end();
}
