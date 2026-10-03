import { ConfigurationRepository } from "../repositories/configuration-repository.js";
import { createDatabase } from "./client.js";

// One bounded batch per invocation. An operator can schedule the command using
// the already-authorized deployment database identity; it provisions no access.
const db = createDatabase();
try {
  const removedArtifacts = await new ConfigurationRepository(db).maintainArtifacts();
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, removedArtifacts, batchLimit: 64 })}\n`,
  );
} catch {
  process.stderr.write("Configuration artifact maintenance failed. No bounds were bypassed.\n");
  process.exitCode = 1;
} finally {
  await db.end({ timeout: 5 });
}
