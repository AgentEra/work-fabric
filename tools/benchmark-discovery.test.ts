import { describe, expect, it } from "vitest";

import { runDiscoveryBenchmark } from "./benchmark-discovery.js";

describe("Participation Discovery storm benchmark", () => {
  it("keeps announcement, query, sync, cycle and pruning work bounded", async () => {
    const report = await runDiscoveryBenchmark({ query_samples: 20, sync_samples: 5 });

    expect(report.heartbeat_churn).toEqual({
      local_heartbeats: 10_000,
      peer_updates: 0,
    });
    expect(report.coalescing.input_changes).toBe(1_000);
    expect(report.coalescing.refresh_turns).toBe(1);
    expect(report.coalescing.peer_updates).toBeLessThanOrEqual(1);
    expect(report.local_query.samples).toBe(20);
    expect(report.local_query.p50_ms).toBeGreaterThanOrEqual(0);
    expect(report.local_query.p95_ms).toBeGreaterThanOrEqual(report.local_query.p50_ms);
    expect(report.direct_sync.samples).toBe(5);
    expect(report.direct_sync.p50_ms).toBeGreaterThanOrEqual(0);
    expect(report.direct_sync.p95_ms).toBeGreaterThanOrEqual(report.direct_sync.p50_ms);
    expect(report.direct_sync.total_bytes).toBeGreaterThan(0);
    expect(report.cycle.processed_by_exchange).toEqual({
      exchange_a: 1,
      exchange_b: 1,
      exchange_c: 1,
    });
    expect(report.cycle.max_processes_per_exchange).toBe(1);
    expect(report.pruning.retained_before_prune).toBeLessThanOrEqual(32);
    expect(report.pruning.retained_after_prune).toBe(0);
    expect(report.pruning.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("rejects unbounded or empty sample requests", async () => {
    await expect(runDiscoveryBenchmark({ query_samples: 0, sync_samples: 1 })).rejects.toThrow();
    await expect(runDiscoveryBenchmark({ query_samples: 1, sync_samples: 0 })).rejects.toThrow();
    await expect(runDiscoveryBenchmark({ query_samples: 10_001, sync_samples: 1 })).rejects.toThrow();
  });
});
