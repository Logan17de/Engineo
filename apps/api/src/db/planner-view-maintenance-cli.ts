import { PlannerViewRepository } from "../repositories/planner-view-repository.js";
import { createDatabase } from "./client.js";

// One finite indexed batch using an already-authorized deployment identity.
// This command does not install a cron, change grants, or provision credentials.
const db = createDatabase();
try {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, ...(await new PlannerViewRepository(db).maintain()) })}\n`,
  );
} catch {
  process.stderr.write("Private view maintenance failed. No bounds were bypassed.\n");
  process.exitCode = 1;
} finally {
  await db.end({ timeout: 5 });
}
