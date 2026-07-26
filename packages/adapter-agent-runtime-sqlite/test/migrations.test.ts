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
        applied: 1,
        ordered_ids: ["001_agent_runtime"],
      });
      expect(migrateAgentRuntimeSqlite(session)).toEqual({
        applied: 0,
        ordered_ids: ["001_agent_runtime"],
      });
      expect(() => migrateAgentRuntimeSqlite(session, [{
        ...AGENT_RUNTIME_SQLITE_MIGRATION,
        sql: `${AGENT_RUNTIME_SQLITE_MIGRATION.sql}\n-- changed`,
      }])).toThrow("checksum mismatch");
    } finally {
      session.close();
    }
  });
});
