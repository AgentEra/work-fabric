import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SqliteFeishuProviderStore } from "../src/index.js";

describe("SqliteFeishuProviderStore", () => {
  it("recovers durable execution outcomes and resource ownership after restart", async () => {
    const directory = await mkdtemp("/tmp/work-fabric-feishu-provider-");
    const location = join(directory, "provider.db");
    try {
      const first = new SqliteFeishuProviderStore({
        location,
        busy_timeout_ms: 5_000,
      });
      await first.begin({
        tenant_id: "tenant-1",
        idempotency_key: "create-1",
        capability_id: "feishu.document.create",
        input_digest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        created_at: "2026-07-27T10:00:00.000Z",
      });
      await first.putOwnership({
        tenant_id: "tenant-1",
        document_token: "doc-1",
        citizen_id: "feishu-document-actions",
        endpoint_id: "endpoint-feishu-provider",
        original_handoff_id: "handoff-1",
        initiating_actor_id: "actor-human-1",
        create_idempotency_key: "create-1",
        created_at: "2026-07-27T10:00:00.000Z",
        last_known_revision: "1",
        deleted_at: null,
      });
      await first.complete("tenant-1", "create-1", {
        outcome: "succeeded",
        data: {
          document_token: "doc-1",
          title: "项目需求",
          revision: "1",
          url: "https://feishu.example/doc-1",
        },
        artifacts: [],
      }, "2026-07-27T10:00:01.000Z");
      await first.close();

      const second = new SqliteFeishuProviderStore({
        location,
        busy_timeout_ms: 5_000,
      });
      const replay = await second.begin({
        tenant_id: "tenant-1",
        idempotency_key: "create-1",
        capability_id: "feishu.document.create",
        input_digest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        created_at: "2026-07-27T10:00:02.000Z",
      });
      expect(replay).toMatchObject({
        created: false,
        record: {
          outcome: {
            outcome: "succeeded",
            data: { document_token: "doc-1" },
          },
        },
      });
      expect(await second.getOwnership("tenant-1", "doc-1")).toMatchObject({
        last_known_revision: "1",
        deleted_at: null,
      });
      await second.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enforces tenant isolation and input digest idempotency", async () => {
    const store = new SqliteFeishuProviderStore({
      location: ":memory:",
      busy_timeout_ms: 5_000,
    });
    await store.begin({
      tenant_id: "tenant-1",
      idempotency_key: "same-key",
      capability_id: "feishu.document.create",
      input_digest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      created_at: "2026-07-27T10:00:00.000Z",
    });
    await expect(store.begin({
      tenant_id: "tenant-1",
      idempotency_key: "same-key",
      capability_id: "feishu.document.create",
      input_digest:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      created_at: "2026-07-27T10:00:00.000Z",
    })).rejects.toThrow(/idempotency conflict/i);
    await expect(store.begin({
      tenant_id: "tenant-2",
      idempotency_key: "same-key",
      capability_id: "feishu.document.create",
      input_digest:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      created_at: "2026-07-27T10:00:00.000Z",
    })).resolves.toMatchObject({ created: true });
    await store.close();
  });
});
