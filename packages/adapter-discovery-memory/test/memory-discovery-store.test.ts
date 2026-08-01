import { describe, expect, it } from "vitest";

import {
  MemoryDiscoveryPeerBindingStore,
  MemoryDiscoveryStore,
} from "../src/index.js";

describe("Memory discovery adapters", () => {
  it("enforces optimistic Peer binding versions", async () => {
    const store = new MemoryDiscoveryPeerBindingStore();
    const first = {
      tenant_id: "tenant-a",
      tenant_view_id: "view-a",
      peer_id: "peer-b",
      exchange_id: "exchange-b",
      state: "active" as const,
      allow_import: true,
      allow_export: true,
      allow_query: true,
      allow_transit: false,
      max_page_size: 100,
      max_response_bytes: 65_536,
      version: 1,
    };
    await expect(store.put({ binding: first, expected_version: null })).resolves.toEqual(first);
    await expect(store.put({
      binding: { ...first, version: 2, allow_query: false },
      expected_version: 9,
    })).rejects.toThrow("discovery_peer_version_conflict");
    await expect(store.list({ tenant_id: "tenant-other", tenant_view_id: "view-a" }))
      .resolves.toEqual([]);
  });

  it("reports a bounded capability manifest", () => {
    const store = new MemoryDiscoveryStore({
      max_records_per_origin: 2,
      tombstone_retention_seconds: 60,
    });
    expect(store.manifest.profile).toBe("workfabric.discovery-store.v1");
    expect(store.manifest.capabilities.bounded_capacity).toBe(true);
  });
});
