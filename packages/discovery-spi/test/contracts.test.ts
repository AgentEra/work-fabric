import { describe, expect, it } from "vitest";

import {
  DISCOVERY_AUTHORITY_ACTIONS,
  DISCOVERY_MAX_MESSAGE_BYTES,
  DISCOVERY_PROFILE,
  DISCOVERY_REQUIRED_STORE_CAPABILITIES,
  type DiscoveryQueryBudget,
  type DiscoveryUnsignedRecord,
} from "../src/index.js";

describe("discovery SPI", () => {
  it("defines the bounded participation profile consumed by gateways", () => {
    expect(DISCOVERY_PROFILE).toBe("workfabric.discovery.v1");
    expect(DISCOVERY_MAX_MESSAGE_BYTES).toBe(65_536);
    expect(DISCOVERY_AUTHORITY_ACTIONS).toEqual([
      "workfabric.discovery.query.v1",
      "workfabric.discovery.resolve.v1",
      "workfabric.discovery.peer.read.v1",
      "workfabric.discovery.peer.manage.v1",
      "workfabric.discovery.sync.v1",
      "workfabric.discovery.export.v1",
    ]);
    expect(DISCOVERY_REQUIRED_STORE_CAPABILITIES).toContain(
      "conflicting_replay_rejection",
    );
  });

  it("keeps internal scope and query budgets out of exported records", () => {
    const budget: DiscoveryQueryBudget = {
      deadline: "2026-08-01T00:00:10.000Z",
      remaining_hops: 2,
      remaining_fanout: 4,
      remaining_results: 20,
      remaining_bytes: 32_768,
    };
    const record: DiscoveryUnsignedRecord = {
      profile: DISCOVERY_PROFILE,
      record_id: "exchange:alpha",
      record_kind: "exchange",
      origin_exchange_id: "exchange-alpha",
      revision: 1,
      issued_at: "2026-08-01T00:00:00.000Z",
      expires_at: "2026-08-01T00:01:00.000Z",
      visibility: "public",
      audiences: [],
      transitive: false,
      max_hops: 0,
      payload: {
        exchange_id: "exchange-alpha",
        display_name: "Alpha",
        discovery_profiles: [DISCOVERY_PROFILE],
        federation_profiles: ["workfabric.federation.v1"],
        bindings: [],
        security_schemes: ["ed25519"],
      },
      payload_digest: "a".repeat(64),
      key_id: "key-1",
    };

    expect(budget.remaining_bytes).toBe(32_768);
    expect(record).not.toHaveProperty("tenant_id");
    expect(record).not.toHaveProperty("tenant_view_id");
    expect(record).not.toHaveProperty("heartbeat_sequence");
    expect(record).not.toHaveProperty("fencing_token");
  });
});
