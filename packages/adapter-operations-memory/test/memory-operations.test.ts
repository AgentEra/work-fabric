import { describe, expect, it } from "vitest";

import {
  MemoryAuditStore,
  MemoryCollaborationViewStore,
} from "../src/index.js";

describe("Memory operations adapters", () => {
  it("publish separate collaboration and audit profiles", () => {
    expect(new MemoryCollaborationViewStore().manifest.profile).toBe(
      "workfabric.collaboration-view.v1",
    );
    expect(new MemoryAuditStore().manifest.profile).toBe(
      "workfabric.operation-audit.v1",
    );
  });

  it("rejects credential-shaped or excessively deep projection JSON", async () => {
    const store = new MemoryCollaborationViewStore();
    const base = {
      tenant_id: "tenant-1",
      partition_id: "partition-1",
      thread_id: "thread-1",
      handoff_id: "handoff-1",
      stream_version: 1,
      lifecycle_state: "offered" as const,
      initiator: { actor_id: "actor-1", actor_type: "human" as const },
      recipient: { actor_id: "actor-2", actor_type: "human" as const },
      current_responsible_actor: {
        actor_id: "actor-1",
        actor_type: "human" as const,
      },
      verifier: { actor_id: "actor-3", actor_type: "human" as const },
      target_binding: null,
      priority: "normal" as const,
      accept_by: "2026-07-17T00:00:00.000Z",
      result_due_at: "2026-07-18T00:00:00.000Z",
      latest_status: null,
      parent_handoff_id: null,
      child_handoff_id: null,
      created_at: "2026-07-16T00:00:00.000Z",
      updated_at: "2026-07-16T00:00:00.000Z",
    };
    await expect(
      store.putResponsibility({
        ...base,
        work_reference: { uri: "urn:work:1", access_token: "secret" },
      }),
    ).rejects.toThrow(/credential|unsafe/i);

    let nested: Record<string, unknown> = { value: "leaf" };
    for (let depth = 0; depth < 20; depth += 1) nested = { nested };
    await expect(
      store.putResponsibility({
        ...base,
        work_reference: nested as never,
      }),
    ).rejects.toThrow(/depth/i);
  });
});
