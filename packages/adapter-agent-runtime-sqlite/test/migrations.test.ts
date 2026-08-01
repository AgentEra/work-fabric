import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  AGENT_RUNTIME_SQLITE_MIGRATION,
  SqliteSession,
  migrateAgentRuntimeSqlite,
} from "../src/index.js";

describe("agent runtime SQLite migrations", () => {
  it("applies migrations in deterministic order and rejects changed checksums", () => {
    const database = new DatabaseSync(":memory:");
    const session = new SqliteSession({ database });
    try {
      expect(migrateAgentRuntimeSqlite(session)).toEqual({
        applied: 3,
        ordered_ids: [
          "001_agent_runtime",
          "002_capability_invocations",
          "003_private_state",
        ],
      });
      expect(migrateAgentRuntimeSqlite(session)).toEqual({
        applied: 0,
        ordered_ids: [
          "001_agent_runtime",
          "002_capability_invocations",
          "003_private_state",
        ],
      });
      expect(() => migrateAgentRuntimeSqlite(session, [{
        ...AGENT_RUNTIME_SQLITE_MIGRATION,
        sql: `${AGENT_RUNTIME_SQLITE_MIGRATION.sql}\n-- changed`,
      }])).toThrow("checksum mismatch");
    } finally {
      session.close();
    }
  });

  it("rejects an unseen lower migration after a higher migration was applied", () => {
    const database = new DatabaseSync(":memory:");
    const session = new SqliteSession({ database });
    const laterMigration = { id: "002_agent_runtime_later", sql: "CREATE TABLE agent_runtime_later (id TEXT PRIMARY KEY);" };
    try {
      expect(migrateAgentRuntimeSqlite(session, [laterMigration])).toMatchObject({ applied: 1 });
      expect(() => migrateAgentRuntimeSqlite(session, [AGENT_RUNTIME_SQLITE_MIGRATION, laterMigration])).toThrow("out of order");
    } finally {
      session.close();
    }
  });
});
