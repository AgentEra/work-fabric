import { describe, expect, it } from "vitest";

import { MemoryDiscrepancyStore } from "../src/index.js";

function discrepancy(id: string, observedAt: string) {
  return {
    discrepancy_id: id,
    tenant_id: "tenant-1",
    connector_id: "connector-1",
    external_object_id: `external-${id}`,
    resource_id: "handoff-1",
    expected_state: "accepted",
    expected_version: 2,
    observed_state: "declined",
    observed_at: observedAt,
    metadata: { source: "receipt" },
    status: "open" as const,
    version: 1,
    acknowledged_at: null,
    acknowledged_by: null,
    acknowledgement_reason: null,
  };
}

describe("MemoryDiscrepancyStore", () => {
  it("is immutable on first write and returns cloned tenant-scoped records", async () => {
    const store = new MemoryDiscrepancyStore({ cursor_secret: "discrepancy-secret" });
    const input = discrepancy("discrepancy-1", "2026-07-16T01:00:00.000Z");
    await store.put(input);
    await store.put(structuredClone(input));
    await expect(store.put({ ...input, observed_state: "closed" })).rejects.toThrow(/conflict/i);

    const loaded = await store.get("tenant-1", "discrepancy-1");
    expect(loaded).toEqual(input);
    if (loaded !== null) (loaded.metadata as { source: string }).source = "mutated";
    expect((await store.get("tenant-1", "discrepancy-1"))?.metadata).toEqual({ source: "receipt" });
    await expect(store.get("tenant-2", "discrepancy-1")).resolves.toBeNull();
  });

  it("paginates deterministically with filter-bound opaque cursors", async () => {
    const store = new MemoryDiscrepancyStore({ cursor_secret: "discrepancy-secret" });
    await store.put(discrepancy("discrepancy-1", "2026-07-16T01:00:00.000Z"));
    await store.put(discrepancy("discrepancy-2", "2026-07-16T02:00:00.000Z"));
    const first = await store.list({
      tenant_id: "tenant-1", connector_id: "connector-1", statuses: ["open"], limit: 1,
    });
    expect(first.items.map((item) => item.discrepancy_id)).toEqual(["discrepancy-2"]);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await store.list({
      tenant_id: "tenant-1", connector_id: "connector-1", statuses: ["open"],
      cursor: first.next_cursor as string, limit: 1,
    });
    expect(second.items.map((item) => item.discrepancy_id)).toEqual(["discrepancy-1"]);
    await expect(store.list({
      tenant_id: "tenant-1", connector_id: "other", statuses: ["open"],
      cursor: first.next_cursor as string, limit: 1,
    })).rejects.toThrow(/cursor/i);
  });

  it("acknowledges with optimistic versioning and idempotent replay", async () => {
    const store = new MemoryDiscrepancyStore();
    await store.put(discrepancy("discrepancy-1", "2026-07-16T01:00:00.000Z"));
    const command = {
      tenant_id: "tenant-1",
      discrepancy_id: "discrepancy-1",
      expected_version: 1,
      acknowledged_at: "2026-07-16T03:00:00.000Z",
      acknowledged_by: "principal-1",
      reason: "reviewed",
    };
    const accepted = await store.acknowledge(command);
    expect(accepted).toMatchObject({
      kind: "acknowledged",
      discrepancy: { status: "acknowledged", version: 2 },
    });
    await expect(store.acknowledge(command)).resolves.toMatchObject({ kind: "replayed" });
    await expect(store.acknowledge({ ...command, reason: "changed" })).resolves.toEqual({
      kind: "conflict",
      current_version: 2,
    });
    await expect(store.acknowledge({ ...command, discrepancy_id: "missing" })).resolves.toEqual({
      kind: "not_found",
    });
  });
});
