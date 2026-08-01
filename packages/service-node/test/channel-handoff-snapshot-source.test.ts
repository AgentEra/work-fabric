import { describe, expect, it } from "vitest";

import { MemoryHandoffReadModelStore } from "@work-fabric/exchange-runtime";

import { StoreBackedChannelHandoffSnapshotSource } from "../src/channel-handoff-snapshot-source.js";

describe("StoreBackedChannelHandoffSnapshotSource", () => {
  it("returns an immutable canonical snapshot only at the requested version", async () => {
    const handoffs = new MemoryHandoffReadModelStore();
    await handoffs.putHandoff({
      tenant_id: "tenant-1",
      partition_id: "partition-1",
      handoff_id: "handoff-1",
      stream_version: 3,
      state: {
        handoff_id: "handoff-1",
        resource_version: 3,
        lifecycle_state: "result_returned",
        result: {
          summary: [{
            kind: "text",
            media_type: "text/plain",
            text: "Agent authored reply",
          }],
          artifacts: [],
          evidence: [],
          extensions: {},
        },
      },
      latest_status: null,
    });
    const source = new StoreBackedChannelHandoffSnapshotSource(
      "tenant-1",
      handoffs,
    );

    await expect(source.get({
      tenant_id: "tenant-1",
      handoff_id: "handoff-1",
      minimum_resource_version: 4,
    })).resolves.toEqual({ kind: "not_ready" });

    const ready = await source.get({
      tenant_id: "tenant-1",
      handoff_id: "handoff-1",
      minimum_resource_version: 3,
    });
    expect(ready).toMatchObject({
      kind: "ready",
      snapshot: {
        handoff_id: "handoff-1",
        resource_version: 3,
        lifecycle_state: "result_returned",
      },
    });
    if (ready.kind !== "ready") throw new Error("expected ready snapshot");
    (ready.snapshot as Record<string, unknown>).lifecycle_state = "mutated";
    await expect(handoffs.getHandoff("handoff-1")).resolves.toMatchObject({
      state: { lifecycle_state: "result_returned" },
    });
  });

  it("does not expose another Tenant or a missing Handoff", async () => {
    const source = new StoreBackedChannelHandoffSnapshotSource(
      "tenant-1",
      new MemoryHandoffReadModelStore(),
    );

    await expect(source.get({
      tenant_id: "tenant-other",
      handoff_id: "handoff-1",
      minimum_resource_version: 1,
    })).resolves.toEqual({ kind: "not_found" });
    await expect(source.get({
      tenant_id: "tenant-1",
      handoff_id: "handoff-missing",
      minimum_resource_version: 1,
    })).resolves.toEqual({ kind: "not_found" });
  });
});
