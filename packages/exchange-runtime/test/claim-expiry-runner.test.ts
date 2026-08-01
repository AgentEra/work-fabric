import { describe, expect, it } from "vitest";

import { MemoryEndpointInboxStore } from "@work-fabric/adapter-endpoint-memory";

import { ClaimLeaseExpiryRunner } from "../src/index.js";

function claimed(
  handoffId: string,
  expiresAt: string,
  fencingToken: number,
) {
  return {
    tenant_id: "tenant_01",
    partition_id: `partition_${handoffId}`,
    handoff_id: handoffId,
    resource_version: fencingToken + 1,
    lifecycle_state: "claimed",
    capability_ids: ["software.implementation"],
    active_claim: {
      claim_id: `claim_${handoffId}`,
      fencing_token: fencingToken,
      expires_at: expiresAt,
    },
    last_event_id: `event_${handoffId}`,
    observed_position: fencingToken + 1,
    visible_actor_ids: [],
    visible_endpoint_ids: [],
    active: true,
  };
}

describe("ClaimLeaseExpiryRunner", () => {
  it("scans due claims with bounded deterministic pagination and preserves fencing inputs", async () => {
    const inbox = new MemoryEndpointInboxStore();
    await inbox.upsertRoutingFact(
      claimed("handoff_02", "2026-07-27T00:00:00Z", 2),
    );
    await inbox.upsertRoutingFact(
      claimed("handoff_01", "2026-07-27T00:00:00Z", 1),
    );
    await inbox.upsertRoutingFact(
      claimed("handoff_future", "2026-07-27T00:01:00Z", 3),
    );
    const attempts: string[] = [];
    const runner = new ClaimLeaseExpiryRunner({
      tenant_id: "tenant_01",
      inbox,
      clock: { now: () => "2026-07-27T00:00:30Z" },
      poll_interval_ms: 1_000,
      page_limit: 1,
      max_pages_per_run: 10,
      async expire(claim) {
        attempts.push(
          `${claim.handoff_id}:${claim.claim_id}:${claim.fencing_token}`,
        );
        return claim.handoff_id === "handoff_01" ? "expired" : "stale";
      },
    });

    await expect(runner.runOnce()).resolves.toEqual({
      inspected: 2,
      expired: 1,
      stale: 1,
      retry: 0,
    });
    expect(attempts).toEqual([
      "handoff_01:claim_handoff_01:1",
      "handoff_02:claim_handoff_02:2",
    ]);
  });

  it("isolates a failed expiry attempt so peer claims still progress", async () => {
    const inbox = new MemoryEndpointInboxStore();
    await inbox.upsertRoutingFact(
      claimed("handoff_01", "2026-07-27T00:00:00Z", 1),
    );
    await inbox.upsertRoutingFact(
      claimed("handoff_02", "2026-07-27T00:00:00Z", 2),
    );
    const attempts: string[] = [];
    const runner = new ClaimLeaseExpiryRunner({
      tenant_id: "tenant_01",
      inbox,
      clock: { now: () => "2026-07-27T00:00:30Z" },
      poll_interval_ms: 1_000,
      page_limit: 10,
      max_pages_per_run: 1,
      async expire(claim) {
        attempts.push(claim.handoff_id);
        if (claim.handoff_id === "handoff_01") throw new Error("transient");
        return "expired";
      },
    });

    await expect(runner.runOnce()).resolves.toEqual({
      inspected: 2,
      expired: 1,
      stale: 0,
      retry: 1,
    });
    expect(attempts).toEqual(["handoff_01", "handoff_02"]);
  });
});
