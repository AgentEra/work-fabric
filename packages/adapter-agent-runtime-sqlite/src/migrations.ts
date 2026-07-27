import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { SqliteSession } from "./sqlite-session.js";

export interface SqliteMigration { readonly id: string; readonly sql: string; }

export const AGENT_RUNTIME_SQLITE_MIGRATION: SqliteMigration = {
  id: "001_agent_runtime",
  sql: readFileSync(new URL("../migrations/001_agent_runtime.sql", import.meta.url), "utf8"),
};
export const AGENT_CAPABILITY_INVOCATION_SQLITE_MIGRATION: SqliteMigration = {
  id: "002_capability_invocations",
  sql: readFileSync(
    new URL("../migrations/002_capability_invocations.sql", import.meta.url),
    "utf8",
  ),
};
export const AGENT_RUNTIME_SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  AGENT_RUNTIME_SQLITE_MIGRATION,
  AGENT_CAPABILITY_INVOCATION_SQLITE_MIGRATION,
];

function checksum(sql: string): string { return createHash("sha256").update(sql).digest("hex"); }

export function migrateAgentRuntimeSqlite(session: SqliteSession, migrations: readonly SqliteMigration[] = AGENT_RUNTIME_SQLITE_MIGRATIONS): { readonly applied: number; readonly ordered_ids: readonly string[] } {
  const ordered = [...migrations].sort((a, b) => a.id.localeCompare(b.id));
  session.exec("CREATE TABLE IF NOT EXISTS agent_runtime_schema_migrations (migration_id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  let applied = 0;
  session.transaction(() => {
    const seen = new Set<string>();
    for (const migration of ordered) {
      if (!/^[0-9]{3}_[a-z0-9_]+$/.test(migration.id) || migration.sql.trim() === "") throw new TypeError("SQLite migration is invalid");
      if (seen.has(migration.id)) throw new Error(`duplicate migration ${migration.id}`);
      seen.add(migration.id);
    }
    const highestApplied = session.prepare("SELECT migration_id FROM agent_runtime_schema_migrations ORDER BY migration_id DESC LIMIT 1").get() as { migration_id: string } | undefined;
    for (const migration of ordered) {
      const digest = checksum(migration.sql);
      const existing = session.prepare("SELECT checksum FROM agent_runtime_schema_migrations WHERE migration_id = ?").get(migration.id) as { checksum: string } | undefined;
      if (existing !== undefined) {
        if (existing.checksum !== digest) throw new Error(`SQLite migration checksum mismatch: ${migration.id}`);
        continue;
      }
      if (highestApplied !== undefined && migration.id <= highestApplied.migration_id) {
        throw new Error(`SQLite migration out of order: ${migration.id}`);
      }
      session.exec(migration.sql);
      session.prepare("INSERT INTO agent_runtime_schema_migrations (migration_id, checksum, applied_at) VALUES (?, ?, ?)").run(migration.id, digest, new Date().toISOString());
      applied += 1;
    }
  }, "EXCLUSIVE");
  return { applied, ordered_ids: ordered.map((migration) => migration.id) };
}
