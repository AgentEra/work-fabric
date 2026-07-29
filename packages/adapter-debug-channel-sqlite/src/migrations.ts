import { readFileSync } from "node:fs";
import {
  migrateSqlite,
  type SqliteMigration,
  type SqliteSession,
} from "@work-fabric/adapter-storage-sqlite";

export const SQLITE_DEBUG_CHANNEL_MIGRATION: SqliteMigration = {
  id: "001_debug_channel",
  sql: readFileSync(
    new URL("../migrations/001_debug_channel.sql", import.meta.url),
    "utf8",
  ),
};

export function migrateDebugChannelSqlite(session: SqliteSession): {
  readonly applied: number;
  readonly ordered_ids: readonly string[];
} {
  return migrateSqlite(session, [SQLITE_DEBUG_CHANNEL_MIGRATION]);
}
