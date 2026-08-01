import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { NetworkCitizenSqliteSession } from "./sqlite-session.js";

const migration = {
  id: "001_network_citizens",
  sql: readFileSync(
    new URL("../migrations/001_network_citizens.sql", import.meta.url),
    "utf8",
  ),
};

export function migrateNetworkCitizenSqlite(
  session: NetworkCitizenSqliteSession,
): void {
  session.exec(`
    CREATE TABLE IF NOT EXISTS work_fabric_network_citizen_migrations (
      migration_id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  session.transaction(() => {
    const digest = createHash("sha256").update(migration.sql).digest("hex");
    const existing = session
      .prepare(
        "SELECT checksum FROM work_fabric_network_citizen_migrations WHERE migration_id = ?",
      )
      .get(migration.id) as { checksum: string } | undefined;
    if (existing !== undefined) {
      if (existing.checksum !== digest) {
        throw new Error(
          `SQLite migration checksum mismatch: ${migration.id}`,
        );
      }
      return;
    }
    session.exec(migration.sql);
    session
      .prepare(
        "INSERT INTO work_fabric_network_citizen_migrations (migration_id, checksum, applied_at) VALUES (?, ?, ?)",
      )
      .run(migration.id, digest, new Date().toISOString());
  });
}
