import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteSession } from "@work-fabric/adapter-storage-sqlite";
import { runDebugChannelStoreContract } from "../../debug-channel-spi/test/store-contract.js";
import {
  SqliteDebugChannelStore,
  migrateDebugChannelSqlite,
} from "../src/index.js";

describe("SqliteDebugChannelStore", () => {
  runDebugChannelStoreContract({
    async create() {
      const directory = await mkdtemp(join(tmpdir(), "work-fabric-debug-store-"));
      const session = new SqliteSession({ location: join(directory, "debug.db") });
      migrateDebugChannelSqlite(session);
      return {
        store: new SqliteDebugChannelStore(session),
        async close() {
          session.close();
          await rm(directory, { recursive: true, force: true });
        },
      };
    },
  });

  it("survives reopening the same SQLite database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-debug-restart-"));
    const location = join(directory, "debug.db");
    try {
      const first = new SqliteSession({ location });
      migrateDebugChannelSqlite(first);
      const store = new SqliteDebugChannelStore(first);
      await store.createSubmission({
        submission: {
          tenant_id: "tenant-local",
          plugin_instance_id: "debug-local",
          submission_id: "submission-restart",
          conversation_id: "conversation-restart",
          idempotency_key: "message-restart",
          request_digest: "c".repeat(64),
          created_at: "2026-07-29T09:00:00.000Z",
          updated_at: "2026-07-29T09:00:00.000Z",
          expires_at: "2026-08-12T09:00:00.000Z",
        },
      });
      first.close();

      const second = new SqliteSession({ location });
      expect(migrateDebugChannelSqlite(second).applied).toBe(0);
      const loaded = await new SqliteDebugChannelStore(second).getSubmission({
        tenant_id: "tenant-local",
        plugin_instance_id: "debug-local",
        submission_id: "submission-restart",
      });
      expect(loaded?.idempotency_key).toBe("message-restart");
      second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
