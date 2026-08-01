import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MemoryDiscoveryPeerBindingStore,
  MemoryDiscoveryStore,
} from "@work-fabric/adapter-discovery-memory";
import type {
  DiscoveryPeerBinding,
  DiscoverySigner,
  DiscoveryTrustResolver,
} from "@work-fabric/discovery-spi";

import {
  DiscoveryCacheService,
  DiscoveryGateway,
  DiscoveryMessageCodec,
  DiscoveryRecordCodec,
} from "../src/index.js";

const scope = { tenant_id: "tenant-a", tenant_view_id: "view-a" };
const clock = { now: () => "2026-08-01T00:00:00.000Z" };
const signer: DiscoverySigner = {
  key_id: "test-key",
  async sign(canonical) { return createHash("sha512").update(canonical).digest("base64url"); },
};
const trust: DiscoveryTrustResolver = {
  async verify(input) {
    return createHash("sha512").update(input.canonical).digest("base64url") === input.signature;
  },
};

function peer(peer_id: string, exchange_id: string): DiscoveryPeerBinding {
  return {
    ...scope, peer_id, exchange_id, state: "active",
    allow_import: true, allow_export: true, allow_query: true, allow_transit: true,
    max_page_size: 10, max_response_bytes: 65_536, version: 1,
  };
}

describe("DiscoveryGateway bounded transitive query", () => {
  it("terminates a cycle, single-flights duplicates, and reduces every budget", async () => {
    const ids = new Map<string, number>();
    const stores = new Map<string, MemoryDiscoveryStore>();
    const peerStores = new Map<string, MemoryDiscoveryPeerBindingStore>();
    const gateways = new Map<string, DiscoveryGateway>();
    const calls = new Map<string, number>();
    const links: Record<string, readonly [string, string][]> = {
      "exchange-a": [["peer-b", "exchange-b"]],
      "exchange-b": [["peer-a", "exchange-a"], ["peer-c", "exchange-c"]],
      "exchange-c": [["peer-b", "exchange-b"], ["peer-a", "exchange-a"]],
    };

    for (const exchangeId of Object.keys(links)) {
      const store = new MemoryDiscoveryStore({ max_records_per_origin: 20, tombstone_retention_seconds: 300 });
      const peers = new MemoryDiscoveryPeerBindingStore();
      stores.set(exchangeId, store);
      peerStores.set(exchangeId, peers);
      for (const [peerId, remote] of links[exchangeId]!) {
        await peers.put({ binding: peer(peerId, remote), expected_version: null });
      }
      if (exchangeId !== "exchange-a") {
        const codec = new DiscoveryRecordCodec({ local_exchange_id: exchangeId, signer, trust, clock });
        const bytes = await codec.sign({
          record_id: `route:${exchangeId}`,
          record_kind: "capability_route",
          origin_exchange_id: exchangeId,
          revision: 1,
          issued_at: clock.now(),
          expires_at: "2026-08-01T00:01:00.000Z",
          visibility: "public",
          audiences: [],
          transitive: true,
          max_hops: 2,
          payload: {
            capability_id: "software.implementation", versions: ["1.0.0"],
            input_media_types: ["application/json"], output_media_types: ["application/json"],
            input_schema_refs: [], output_schema_refs: [], interaction_modes: ["asynchronous"],
            binding_types: ["http_sse"], security_schemes: ["oauth2"], availability: "available",
          },
        });
        await store.apply({ ...scope, source_peer_id: null, value: JSON.parse(new TextDecoder().decode(bytes)) });
      }
    }

    for (const exchangeId of Object.keys(links)) {
      const store = stores.get(exchangeId)!;
      const peers = peerStores.get(exchangeId)!;
      const recordCodec = new DiscoveryRecordCodec({ local_exchange_id: exchangeId, signer, trust, clock });
      const gateway = new DiscoveryGateway({
        ...scope,
        local_exchange_id: exchangeId,
        message_codec: new DiscoveryMessageCodec({ local_exchange_id: exchangeId, signer, trust, clock }),
        record_codec: recordCodec,
        cache: new DiscoveryCacheService({ local_exchange_id: exchangeId, codec: recordCodec, store, peers, clock }),
        store,
        peers,
        export_policy: { async exportRecord({ record }) { return record; } },
        clock,
        id_generator: { nextId(kind) {
          const next = (ids.get(exchangeId) ?? 0) + 1;
          ids.set(exchangeId, next);
          return `${exchangeId}:${kind}:${next}`;
        } },
        query_transport: (binding) => ({
          exchange: async (request) => {
            calls.set(binding.exchange_id, (calls.get(binding.exchange_id) ?? 0) + 1);
            return gateways.get(binding.exchange_id)!.receiveQuery(request);
          },
        }),
        query_max_in_flight: 4,
        query_max_entries: 100,
      });
      gateways.set(exchangeId, gateway);
    }

    const prepared = await gateways.get("exchange-a")!.prepareQuery({
      peer_id: "peer-b",
      query_id: "query-cycle",
      query: { record_kinds: ["capability_route"], capability_id: "software.implementation", limit: 5 },
      budget: {
        deadline: "2026-08-01T00:00:30.000Z",
        remaining_hops: 2,
        remaining_fanout: 3,
        remaining_results: 5,
        remaining_bytes: 32_768,
      },
    });
    const gatewayB = gateways.get("exchange-b")!;
    const [first, duplicate] = await Promise.all([
      gatewayB.receiveQuery(prepared.bytes),
      gatewayB.receiveQuery(prepared.bytes),
    ]);
    expect(duplicate).toEqual(first);
    expect(calls.get("exchange-c")).toBe(1);
    expect(calls.get("exchange-a") ?? 0).toBe(0);

    const result = await gateways.get("exchange-a")!.deliverQuery(prepared, {
      exchange: async () => first,
    });
    expect(result.items.map((item) => item.origin_exchange_id)).toEqual(["exchange-b", "exchange-c"]);
    expect(result.coverage).toBe("partial");
    expect(result.budget.remaining_hops).toBeLessThan(2);
    expect(result.budget.remaining_fanout).toBeLessThan(3);
    expect(result.budget.remaining_results).toBe(3);
    expect(result.budget.remaining_bytes).toBeLessThan(32_768);

    const peerA = (await peerStores.get("exchange-b")!.get(scope, "peer-a"))!;
    await peerStores.get("exchange-b")!.put({
      binding: { ...peerA, max_response_bytes: first.byteLength - 1, version: 2 },
      expected_version: 1,
    });
    const bounded = await gateways.get("exchange-a")!.prepareQuery({
      peer_id: "peer-b",
      query_id: "query-bounded-response",
      query: { record_kinds: ["capability_route"], capability_id: "software.implementation", limit: 5 },
      budget: {
        deadline: "2026-08-01T00:00:30.000Z",
        remaining_hops: 2, remaining_fanout: 3, remaining_results: 5, remaining_bytes: 32_768,
      },
    });
    const boundedBytes = await gatewayB.receiveQuery(bounded.bytes);
    const boundedResult = await gateways.get("exchange-a")!.deliverQuery(bounded, { exchange: async () => boundedBytes });
    expect(boundedResult.items).toHaveLength(1);
    expect(boundedResult.warnings).toContain("discovery_response_truncated");

    const peerARestricted = (await peerStores.get("exchange-b")!.get(scope, "peer-a"))!;
    await peerStores.get("exchange-b")!.put({
      binding: { ...peerARestricted, allow_transit: false, max_response_bytes: 65_536, version: 3 },
      expected_version: 2,
    });
    const callsBeforeRestrictedQuery = calls.get("exchange-c") ?? 0;
    const restricted = await gateways.get("exchange-a")!.prepareQuery({
      peer_id: "peer-b",
      query_id: "query-no-transit",
      query: { record_kinds: ["capability_route"], capability_id: "software.implementation", limit: 5 },
      budget: {
        deadline: "2026-08-01T00:00:30.000Z",
        remaining_hops: 2, remaining_fanout: 3, remaining_results: 5, remaining_bytes: 32_768,
      },
    });
    const restrictedBytes = await gatewayB.receiveQuery(restricted.bytes);
    const restrictedResult = await gateways.get("exchange-a")!.deliverQuery(restricted, { exchange: async () => restrictedBytes });
    expect(calls.get("exchange-c") ?? 0).toBe(callsBeforeRestrictedQuery);
    expect(restrictedResult.items.map((item) => item.origin_exchange_id)).toEqual(["exchange-b"]);
  });
});
