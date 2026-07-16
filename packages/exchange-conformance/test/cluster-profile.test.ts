import { describe, expect, it } from "vitest";

import type {
  PartitionWakeup,
  PartitionWakeupConsumer,
  PartitionWakeupPublisher,
  PartitionWorkCatalog,
  PartitionWorkItem,
} from "@work-fabric/cluster-spi";
import {
  DEFAULT_CLUSTER_PROFILE_FIXTURES,
  verifyClusterProfile,
} from "../src/cluster-profile.js";

const manifest = {
  profile: "workfabric.cluster.v1" as const,
  adapter: "inline-test",
  capabilities: {
    tenant_isolation: true,
    tenant_scoped_keyset_scan: true,
    bounded_pages: true,
    stable_work_ordering: true,
    duplicate_wakeup_tolerance: true,
    lost_wakeup_poll_recovery: true,
    deep_clone: true,
  },
};

function inlineAdapter(seed: readonly PartitionWorkItem[]) {
  const work = structuredClone(seed);
  const pending: PartitionWakeup[] = [];
  const catalog: PartitionWorkCatalog &
    PartitionWakeupPublisher & PartitionWakeupConsumer = {
    manifest,
    async scanReady(input) {
      const offset = input.cursor === undefined
        ? 0
        : Number(Buffer.from(input.cursor, "base64url").toString("utf8"));
      const values = work
        .filter((item) =>
          item.tenant_id === input.tenant_id &&
          input.kinds.includes(item.kind) &&
          item.available_at <= input.available_at_or_before
        )
        .sort((left, right) =>
          left.available_at.localeCompare(right.available_at) ||
          left.partition_id.localeCompare(right.partition_id) ||
          left.kind.localeCompare(right.kind)
        );
      const items = values.slice(offset, offset + input.limit);
      return {
        items: structuredClone(items),
        next_cursor: offset + items.length < values.length
          ? Buffer.from(String(offset + items.length)).toString("base64url")
          : null,
      };
    },
    async publish(wakeup) {
      pending.push(structuredClone(wakeup));
      return "accepted";
    },
    async next(signal) {
      if (signal.aborted) throw signal.reason;
      const wakeup = pending.shift();
      if (wakeup === undefined) return null;
      let settled = false;
      return {
        wakeup: structuredClone(wakeup),
        async acknowledge() {
          if (settled) throw new Error("already settled");
          settled = true;
        },
        async retry() {
          if (settled) throw new Error("already settled");
          settled = true;
          pending.unshift(structuredClone(wakeup));
        },
      };
    },
  };
  return catalog;
}

describe("cluster conformance profile", () => {
  it("verifies tenant-keyset catalog and duplicate/loss-tolerant wakeups", async () => {
    await expect(verifyClusterProfile(inlineAdapter)).resolves.toBeUndefined();
  });

  it("uses bounded, non-sensitive fixtures", () => {
    expect(DEFAULT_CLUSTER_PROFILE_FIXTURES.ready_items).toHaveLength(3);
    expect(JSON.stringify(DEFAULT_CLUSTER_PROFILE_FIXTURES)).not.toMatch(
      /password|secret|token|content|result/i,
    );
  });
});
