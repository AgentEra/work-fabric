import { describe, expect, it, vi } from "vitest";

import type {
  ClusterHostLimits,
  PartitionWakeupConsumer,
  PartitionWorkCatalog,
  PartitionWorkItem,
  WakeupDelivery,
} from "@work-fabric/cluster-spi";
import type { SemanticObservation } from "@work-fabric/operations-spi";
import {
  ClusterHost,
  type ClusterPartitionRunner,
} from "../src/index.js";

const validLimits: ClusterHostLimits = {
  max_concurrent_turns: 2,
  max_ready_items: 4,
  catalog_page_size: 4,
  turn_item_limit: 10,
  lease_seconds: 30,
  drain_timeout_seconds: 2,
  poll_interval_ms: 1_000,
  max_tenants_per_host: 4,
};

function item(tenant: string, partition: string, position = 1): PartitionWorkItem {
  return {
    tenant_id: tenant,
    partition_id: partition,
    kind: "outbox_wakeup",
    observed_position: position,
    available_at: "2026-07-16T00:00:00.000Z",
  };
}

function catalog(values: readonly PartitionWorkItem[]): PartitionWorkCatalog {
  return {
    manifest: {
      profile: "workfabric.cluster.v1",
      adapter: "host-test",
      capabilities: {},
    },
    async scanReady(input) {
      return {
        items: structuredClone(values.filter((value) =>
          value.tenant_id === input.tenant_id
        ).slice(0, input.limit)),
        next_cursor: null,
      };
    },
  };
}

function deferredRunner() {
  const releases: Array<() => void> = [];
  let started = 0;
  const runner: ClusterPartitionRunner = {
    async run() {
      started += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      return {
        kind: "ran",
        fencing_token: started,
        outcome: { outcome: "advanced", processed: 1 },
      };
    },
  };
  return {
    runner,
    get started() { return started; },
    completeAll() {
      for (const release of releases.splice(0)) release();
    },
  };
}

describe("ClusterHost", () => {
  it("bounds concurrency and drains without starting queued work", async () => {
    const turns = deferredRunner();
    const host = new ClusterHost({
      catalog: catalog([
        item("tenant-a", "p1"),
        item("tenant-a", "p2"),
        item("tenant-a", "p3"),
      ]),
      tenant_ids: ["tenant-a"],
      worker: turns.runner,
      clock: { now: () => "2026-07-16T00:00:00.000Z" },
    }, validLimits);

    await host.pollOnce();
    await host.pump();
    expect(turns.started).toBe(2);
    const draining = host.drain();
    turns.completeAll();
    await expect(draining).resolves.toMatchObject({
      state: "stopped",
      queue_depth: 0,
    });
    expect(turns.started).toBe(2);
  });

  it("recovers a lost wakeup through authoritative catalog polling", async () => {
    const run = vi.fn<ClusterPartitionRunner["run"]>(async () => ({
      kind: "ran",
      fencing_token: 1,
      outcome: { outcome: "advanced", processed: 1 },
    }));
    const host = new ClusterHost({
      catalog: catalog([item("tenant-a", "p1")]),
      tenant_ids: ["tenant-a"],
      worker: { run },
      clock: { now: () => "2026-07-16T00:00:00.000Z" },
    }, validLimits);

    await host.pollOnce();
    await host.pump();
    await Promise.resolve();

    expect(run).toHaveBeenCalledTimes(1);
    expect(host.snapshot().completed_turns).toBe(1);
  });

  it("settles one duplicate hint after coalescing it", async () => {
    const acknowledge = vi.fn(async () => {});
    const delivery: WakeupDelivery = {
      wakeup: {
        wakeup_id: "wakeup-a",
        exchange_id: "exchange-a",
        tenant_id: "tenant-a",
        partition_id: "p1",
        kind: "outbox_wakeup",
        observed_position: 2,
        occurred_at: "2026-07-16T00:00:00.000Z",
      },
      acknowledge,
      retry: vi.fn(async () => {}),
    };
    let next = delivery as WakeupDelivery | null;
    const consumer: PartitionWakeupConsumer = {
      manifest: {
        profile: "workfabric.cluster.v1",
        adapter: "host-test",
        capabilities: {},
      },
      async next() {
        const value = next;
        next = null;
        return value;
      },
    };
    const host = new ClusterHost({
      catalog: catalog([item("tenant-a", "p1")]),
      wakeup_consumer: consumer,
      tenant_ids: ["tenant-a"],
      worker: {
        run: vi.fn<ClusterPartitionRunner["run"]>(async () => ({
          kind: "lease_unavailable",
        })),
      },
      clock: { now: () => "2026-07-16T00:00:00.000Z" },
    }, validLimits);
    await host.pollOnce();

    await expect(host.ingestOnce()).resolves.toBe("coalesced");
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(host.snapshot().queue_depth).toBe(1);
  });

  it("does not run overlapping catalog polls", async () => {
    let release = () => {};
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const scanReady = vi.fn(async () => {
      await barrier;
      return { items: [], next_cursor: null };
    });
    const host = new ClusterHost({
      catalog: {
        manifest: {
          profile: "workfabric.cluster.v1",
          adapter: "host-test",
          capabilities: {},
        },
        scanReady,
      },
      tenant_ids: ["tenant-a"],
      worker: {
        run: vi.fn<ClusterPartitionRunner["run"]>(async () => ({
          kind: "lease_unavailable",
        })),
      },
      clock: { now: () => "2026-07-16T00:00:00.000Z" },
    }, validLimits);

    const first = host.pollOnce();
    await Promise.resolve();
    await expect(host.pollOnce()).resolves.toBe("already_polling");
    release();
    await first;
    expect(scanReady).toHaveBeenCalledOnce();
  });

  it("emits only fixed cluster semantics", async () => {
    const values: SemanticObservation[] = [];
    const host = new ClusterHost({
      catalog: catalog([]),
      tenant_ids: ["tenant-a"],
      worker: {
        run: vi.fn<ClusterPartitionRunner["run"]>(async () => ({
          kind: "lease_unavailable",
        })),
      },
      clock: { now: () => "2026-07-16T00:00:00.000Z" },
      telemetry: { observe: (value) => values.push(value) },
    }, validLimits);
    await host.pollOnce();
    await host.drain();

    expect(values.map((value) => value.operation)).toEqual([
      "cluster_catalog_scan",
      "cluster_drain",
    ]);
    for (const value of values) {
      expect(value.category).toBe("cluster");
      expect(Object.keys(value).sort()).toEqual([
        "category", "count", "duration_ms", "operation", "outcome",
      ]);
    }
  });
});
