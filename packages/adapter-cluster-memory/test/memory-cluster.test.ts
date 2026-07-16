import { describe, expect, it } from "vitest";

import {
  verifyClusterProfile,
  verifyWakeupTransportProfile,
} from "@work-fabric/exchange-conformance";
import { MemoryClusterAdapter } from "../src/index.js";

describe("MemoryClusterAdapter", () => {
  it("satisfies the reusable cluster profile", async () => {
    await verifyClusterProfile((seed) => new MemoryClusterAdapter(seed));
  });

  it("satisfies the standalone Wakeup transport profile", async () => {
    await verifyWakeupTransportProfile(() => new MemoryClusterAdapter());
  });

  it("rejects invalid scans and wakeups", async () => {
    const adapter = new MemoryClusterAdapter();
    await expect(adapter.scanReady({
      tenant_id: "tenant-a",
      kinds: [],
      available_at_or_before: "2026-07-16T00:00:00.000Z",
      limit: 1,
    })).rejects.toThrow(/kinds/i);
    await expect(adapter.publish({
      wakeup_id: "wakeup-a",
      exchange_id: "exchange-a",
      tenant_id: "tenant-a",
      partition_id: "partition-a",
      kind: "outbox_wakeup",
      observed_position: 0,
      occurred_at: "2026-07-16T00:00:00.000Z",
    })).rejects.toThrow(/observed_position/i);
  });

  it("stops waiting when its signal is aborted", async () => {
    const adapter = new MemoryClusterAdapter();
    const controller = new AbortController();
    controller.abort(new Error("test stop"));
    await expect(adapter.next(controller.signal)).rejects.toThrow(/test stop/);
  });

  it("continues keyset pages in the declared work-kind order", async () => {
    const common = {
      tenant_id: "tenant-a",
      partition_id: "partition-a",
      observed_position: 1,
      available_at: "2026-07-16T00:00:00.000Z",
    } as const;
    const adapter = new MemoryClusterAdapter([
      { ...common, kind: "handoff_projection" },
      { ...common, kind: "outbox_wakeup" },
    ]);
    const first = await adapter.scanReady({
      tenant_id: "tenant-a",
      kinds: ["handoff_projection", "outbox_wakeup"],
      available_at_or_before: "2026-07-16T00:00:00.000Z",
      limit: 1,
    });
    expect(first.next_cursor).not.toBeNull();
    if (first.next_cursor === null) throw new Error("expected another page");
    const second = await adapter.scanReady({
      tenant_id: "tenant-a",
      kinds: ["handoff_projection", "outbox_wakeup"],
      available_at_or_before: "2026-07-16T00:00:00.000Z",
      cursor: first.next_cursor,
      limit: 1,
    });

    expect(first.items[0]?.kind).toBe("outbox_wakeup");
    expect(second.items[0]?.kind).toBe("handoff_projection");
  });
});
