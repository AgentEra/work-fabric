import { describe, expect, it } from "vitest";

import {
  CLUSTER_REQUIRED_CAPABILITIES,
  PARTITION_WORK_KINDS,
  validateClusterLimits,
} from "../src/index.js";

const validLimits = {
  max_concurrent_turns: 4,
  max_ready_items: 100,
  catalog_page_size: 25,
  turn_item_limit: 100,
  lease_seconds: 30,
  drain_timeout_seconds: 30,
  poll_interval_ms: 1_000,
  max_tenants_per_host: 10,
} as const;

describe("cluster contracts", () => {
  it("keeps work kinds mechanical and closed", () => {
    expect(PARTITION_WORK_KINDS).toEqual([
      "outbox_wakeup",
      "handoff_projection",
      "collaboration_projection",
      "signal_delivery",
    ]);
    expect(JSON.stringify(PARTITION_WORK_KINDS)).not.toMatch(
      /agent|workflow|priority|execute|rank/i,
    );
    expect(CLUSTER_REQUIRED_CAPABILITIES).toContain(
      "tenant_scoped_keyset_scan",
    );
  });

  it("accepts the documented bounded host limits", () => {
    expect(validateClusterLimits(validLimits)).toEqual(validLimits);
  });

  it.each([
    ["max_concurrent_turns", 0],
    ["max_concurrent_turns", 1_025],
    ["max_ready_items", 3],
    ["max_ready_items", 100_001],
    ["catalog_page_size", 1_001],
    ["turn_item_limit", 10_001],
    ["lease_seconds", 9],
    ["lease_seconds", 301],
    ["drain_timeout_seconds", 301],
    ["poll_interval_ms", 99],
    ["poll_interval_ms", 60_001],
    ["max_tenants_per_host", 10_001],
  ] as const)("rejects an invalid %s bound", (field, value) => {
    expect(() => validateClusterLimits({ ...validLimits, [field]: value }))
      .toThrow(field);
  });
});
