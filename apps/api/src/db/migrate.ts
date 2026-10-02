import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Database } from "./client.js";

const defaultMigrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

interface AppliedMigration {
  name: string;
  checksum_sha256: string;
}

export async function migrateDatabase(
  db: Database,
  migrationsDirectory: string = defaultMigrationsDirectory,
): Promise<void> {
  await db`
    CREATE TABLE IF NOT EXISTS engineo_schema_migrations (
      name text PRIMARY KEY,
      checksum_sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const names = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right, "en"));

  for (const name of names) {
    const sql = await readFile(new URL(name, `file://${migrationsDirectory}/`), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = await db<AppliedMigration[]>`
      SELECT name, checksum_sha256
      FROM engineo_schema_migrations
      WHERE name = ${name}
    `;

    if (existing.length > 0) {
      if (existing[0]?.checksum_sha256 !== checksum) {
        throw new Error(`Migration checksum changed after application: ${name}`);
      }
      continue;
    }

    await db.begin(async (transaction) => {
      await transaction.unsafe(sql);
      await transaction`
        INSERT INTO engineo_schema_migrations (name, checksum_sha256)
        VALUES (${name}, ${checksum})
      `;
    });
  }
}
