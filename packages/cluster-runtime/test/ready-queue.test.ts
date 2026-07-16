import { describe, expect, it } from "vitest";

import type { PartitionWorkItem } from "@work-fabric/cluster-spi";
import { TenantFairReadyQueue } from "../src/index.js";

function item(
  tenantId: string,
  partitionId: string,
  observedPosition: number,
  availableAt = "2026-07-16T00:00:00.000Z",
): PartitionWorkItem {
  return {
    tenant_id: tenantId,
    partition_id: partitionId,
    kind: "outbox_wakeup",
    observed_position: observedPosition,
    available_at: availableAt,
  };
}

describe("TenantFairReadyQueue", () => {
  it("coalesces identities and serves tenants round-robin", () => {
    const queue = new TenantFairReadyQueue(4);
    queue.offer(item("tenant-a", "p1", 1));
    queue.offer(item("tenant-a", "p1", 9));
    queue.offer(item("tenant-a", "p2", 2));
    queue.offer(item("tenant-b", "p3", 3));

    expect(queue.size).toBe(3);
    expect([
      queue.take()?.tenant_id,
      queue.take()?.tenant_id,
      queue.take()?.tenant_id,
    ]).toEqual(["tenant-a", "tenant-b", "tenant-a"]);
  });

  it("drops new identities at capacity without dropping newer coalesced state", () => {
    const queue = new TenantFairReadyQueue(1);
    expect(queue.offer(item("tenant-a", "p1", 1))).toBe("queued");
    expect(queue.offer(item(
      "tenant-a",
      "p1",
      2,
      "2026-07-16T00:00:01.000Z",
    ))).toBe("coalesced");
    expect(queue.offer(item("tenant-b", "p2", 1))).toBe("dropped");
    expect(queue.take()).toMatchObject({
      observed_position: 2,
      available_at: "2026-07-16T00:00:01.000Z",
    });
    expect(queue.dropped).toBe(1);
  });

  it("clones values, rejects invalid capacity and can be cleared", () => {
    expect(() => new TenantFairReadyQueue(0)).toThrow(/capacity/i);
    const queue = new TenantFairReadyQueue(2);
    const offered = item("tenant-a", "p1", 1) as PartitionWorkItem & {
      partition_id: string;
    };
    queue.offer(offered);
    offered.partition_id = "caller-mutated";
    expect(queue.take()?.partition_id).toBe("p1");
    queue.offer(item("tenant-a", "p1", 1));
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.take()).toBeNull();
  });
});
