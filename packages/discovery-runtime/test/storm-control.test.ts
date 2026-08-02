import { describe, expect, it } from "vitest";

import {
  DiscoveryQueryDeduplicator,
  DiscoveryNegativeQueryCache,
  consumeQueryBudget,
  discoveryBackoffDelay,
  discoveryQueryFingerprint,
} from "../src/index.js";

const budget = {
  deadline: "2026-08-01T00:01:00.000Z",
  remaining_hops: 2,
  remaining_fanout: 3,
  remaining_results: 5,
  remaining_bytes: 32_768,
};

describe("discovery storm controls", () => {
  it("consumes budgets monotonically and rejects deadline or exhaustion", () => {
    expect(consumeQueryBudget(budget, {
      now: "2026-08-01T00:00:00.000Z",
      hops: 1,
      fanout: 1,
      results: 2,
      bytes: 1_024,
    })).toEqual({
      ...budget,
      remaining_hops: 1,
      remaining_fanout: 2,
      remaining_results: 3,
      remaining_bytes: 31_744,
    });
    expect(() => consumeQueryBudget(budget, {
      now: budget.deadline,
      hops: 0, fanout: 0, results: 0, bytes: 0,
    })).toThrowError(expect.objectContaining({ code: "discovery_budget_exhausted" }));
    expect(() => consumeQueryBudget(budget, {
      now: "2026-08-01T00:00:00.000Z",
      hops: 3, fanout: 0, results: 0, bytes: 0,
    })).toThrowError(expect.objectContaining({ code: "discovery_budget_exhausted" }));
  });

  it("single-flights duplicates, caches bounded results, and rejects saturation", async () => {
    let now = "2026-08-01T00:00:00.000Z";
    let releases = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dedupe = new DiscoveryQueryDeduplicator<string>({
      clock: { now: () => now },
      max_entries: 2,
      max_in_flight: 1,
      max_cache_seconds: 60,
    });
    const work = () => dedupe.execute("source:q-1", "2026-08-01T00:00:30.000Z", async () => {
      releases += 1;
      await gate;
      return "response";
    });
    const first = work();
    const duplicate = work();
    await expect(dedupe.execute("source:q-2", "2026-08-01T00:00:30.000Z", async () => "other"))
      .rejects.toMatchObject({ code: "discovery_rate_limited" });
    release();
    await expect(Promise.all([first, duplicate])).resolves.toEqual(["response", "response"]);
    expect(releases).toBe(1);
    await expect(work()).resolves.toBe("response");
    expect(releases).toBe(1);
    now = "2026-08-01T00:00:31.000Z";
    await expect(work()).rejects.toMatchObject({ code: "discovery_budget_exhausted" });
  });

  it("computes bounded deterministic exponential backoff with jitter", () => {
    expect(discoveryBackoffDelay({ attempt: 0, min_ms: 1_000, max_ms: 30_000, random: 0 })).toBe(500);
    expect(discoveryBackoffDelay({ attempt: 3, min_ms: 1_000, max_ms: 30_000, random: 0.5 })).toBe(8_000);
    expect(discoveryBackoffDelay({ attempt: 20, min_ms: 1_000, max_ms: 30_000, random: 1 })).toBe(30_000);
  });

  it("uses a canonical fingerprint for a negative cache no longer than 60 seconds", () => {
    let now = "2026-08-01T00:00:00.000Z";
    const cache = new DiscoveryNegativeQueryCache({
      clock: { now: () => now }, max_entries: 2, ttl_seconds: 60,
    });
    const left = discoveryQueryFingerprint({ capability_id: "software.implementation", limit: 5 });
    const right = discoveryQueryFingerprint({ limit: 5, capability_id: "software.implementation" });
    expect(left).toBe(right);
    cache.put(left, "2026-08-01T00:02:00.000Z");
    expect(cache.has(right)).toBe(true);
    now = "2026-08-01T00:01:00.000Z";
    expect(cache.has(right)).toBe(false);
  });
});
