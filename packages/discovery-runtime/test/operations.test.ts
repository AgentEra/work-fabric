import { describe, expect, it } from "vitest";

import { MemoryDiscoveryPeerBindingStore, MemoryDiscoveryStore } from "@work-fabric/adapter-discovery-memory";
import { DISCOVERY_PROFILE, type DiscoveryRecord } from "@work-fabric/discovery-spi";

import { DiscoveryOperationsService } from "../src/index.js";

const scope = { tenant_id: "tenant-secret", tenant_view_id: "view-secret" };
function record(id: string, expires_at: string): DiscoveryRecord {
  return {
    profile: DISCOVERY_PROFILE, record_id: id, record_kind: "capability_route",
    origin_exchange_id: "exchange-secret", revision: 1, issued_at: "2026-08-01T00:00:00.000Z",
    expires_at, visibility: "public", audiences: [], transitive: false, max_hops: 0,
    payload: { capability_id: "capability-secret", versions: ["1"], input_media_types: [], output_media_types: [], input_schema_refs: [], output_schema_refs: [], interaction_modes: [], binding_types: [], security_schemes: [], availability: "available", detail_uri: "https://secret.example.test" },
    payload_digest: "a".repeat(64), key_id: "key-secret", signature: "A".repeat(86),
  };
}

describe("DiscoveryOperationsService", () => {
  it("returns bounded anonymous aggregates without discovery facts or identifiers", async () => {
    const store = new MemoryDiscoveryStore({ max_records_per_origin: 10, tombstone_retention_seconds: 330 });
    await store.apply({ ...scope, source_peer_id: null, value: record("fresh", "2026-08-01T00:01:00.000Z") });
    await store.apply({ ...scope, source_peer_id: null, value: record("expired", "2026-08-01T00:00:01.000Z") });
    await store.apply({ ...scope, source_peer_id: null, value: {
      profile: DISCOVERY_PROFILE, record_id: "withdrawn", origin_exchange_id: "exchange-secret",
      revision: 2, withdrawn_at: "2026-08-01T00:00:10.000Z", retain_until: "2026-08-01T00:05:40.000Z",
      key_id: "key-secret", signature: "B".repeat(86),
    } });
    const peers = new MemoryDiscoveryPeerBindingStore();
    for (const [index, state] of ["active", "disabled", "active"] .entries()) {
      await peers.put({ binding: {
        ...scope, peer_id: `peer-secret-${index}`, exchange_id: `exchange-secret-${index}`,
        state: state as "active" | "disabled", allow_import: true, allow_export: index !== 1,
        allow_query: true, allow_transit: false, max_page_size: 10, max_response_bytes: 65_536, version: 1,
      }, expected_version: null });
    }
    const service = new DiscoveryOperationsService({
      store, peers, clock: { now: () => "2026-08-01T00:00:30.000Z" }, max_peer_samples: 2,
      counters: { snapshot: () => ({ coalesced_updates: 7, prevented_forwards: 11, sync_failures: 2, query_rejections: 3 }) },
    });
    const snapshot = await service.snapshot(scope);

    expect(snapshot).toMatchObject({
      health: "healthy",
      records: { fresh: 1, expired: 1, withdrawn: 1, conflicts: 0, capacity: 10 },
      peers: { total: 3, active: 2, disabled: 1, samples_truncated: true },
      counters: { coalesced_updates: 7, prevented_forwards: 11, sync_failures: 2, query_rejections: 3 },
    });
    expect(snapshot.peers.samples).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|signature|payload|uri|capability_id|tenant_id|peer_id|exchange_id|actor_id|endpoint_id/i);
  });

  it("reports an unhealthy dependency summary instead of leaking store errors", async () => {
    const service = new DiscoveryOperationsService({
      store: { status: async () => { throw new Error("postgres://credential@secret-host"); } } as never,
      peers: { list: async () => { throw new Error("peer-secret"); } } as never,
      clock: { now: () => "2026-08-01T00:00:30.000Z" },
      max_peer_samples: 2,
    });
    const snapshot = await service.snapshot(scope);
    expect(snapshot).toMatchObject({ health: "unhealthy", dependency_failures: 2 });
    expect(JSON.stringify(snapshot)).not.toMatch(/postgres|credential|secret-host|peer-secret/);
  });
});
