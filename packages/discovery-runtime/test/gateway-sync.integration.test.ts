import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  MemoryDiscoveryPeerBindingStore,
  MemoryDiscoveryStore,
} from "@work-fabric/adapter-discovery-memory";
import {
  NodeEd25519DiscoverySigner,
  NodeEd25519DiscoveryTrustResolver,
} from "@work-fabric/adapter-discovery-node-crypto";
import type { DiscoveryExportPolicy, DiscoveryPeerBinding } from "@work-fabric/discovery-spi";

import {
  DiscoveryCacheService,
  DiscoveryGateway,
  DiscoveryMessageCodec,
  DiscoveryRecordCodec,
} from "../src/index.js";

const scope = { tenant_id: "tenant-a", tenant_view_id: "view-a" };
const time = { now: () => "2026-08-01T00:00:30.000Z" };

function binding(peer_id: string, exchange_id: string): DiscoveryPeerBinding {
  return {
    ...scope,
    peer_id,
    exchange_id,
    state: "active",
    allow_import: true,
    allow_export: true,
    allow_query: true,
    allow_transit: false,
    max_page_size: 10,
    max_response_bytes: 65_536,
    version: 1,
  };
}

describe("DiscoveryGateway direct sync", () => {
  it("syncs signed changes and tombstones with replay-safe requests and cursors", async () => {
    const keyA = generateKeyPairSync("ed25519");
    const keyB = generateKeyPairSync("ed25519");
    const signerA = new NodeEd25519DiscoverySigner("key-a", keyA.privateKey);
    const signerB = new NodeEd25519DiscoverySigner("key-b", keyB.privateKey);
    const trustA = new NodeEd25519DiscoveryTrustResolver([
      { origin_exchange_id: "exchange-b", audience_exchange_id: "exchange-a", key_id: "key-b", public_key: keyB.publicKey },
      { origin_exchange_id: "exchange-a", audience_exchange_id: "exchange-a", key_id: "key-a", public_key: keyA.publicKey },
    ]);
    const trustB = new NodeEd25519DiscoveryTrustResolver([{
      origin_exchange_id: "exchange-a", audience_exchange_id: "exchange-b", key_id: "key-a", public_key: keyA.publicKey,
    }]);
    const recordsA = new MemoryDiscoveryStore({ max_records_per_origin: 20, tombstone_retention_seconds: 300 });
    const recordsB = new MemoryDiscoveryStore({ max_records_per_origin: 20, tombstone_retention_seconds: 300 });
    const peersA = new MemoryDiscoveryPeerBindingStore();
    const peersB = new MemoryDiscoveryPeerBindingStore();
    await peersA.put({ binding: binding("peer-b", "exchange-b"), expected_version: null });
    await peersB.put({ binding: binding("peer-a", "exchange-a"), expected_version: null });
    const recordCodecA = new DiscoveryRecordCodec({ local_exchange_id: "exchange-a", signer: signerA, trust: trustA, clock: time });
    const recordCodecB = new DiscoveryRecordCodec({ local_exchange_id: "exchange-b", signer: signerB, trust: trustB, clock: time });
    for (const [recordId, revision] of [["route-allowed", 1], ["route-revoked", 3]] as const) {
      const bytes = await recordCodecA.sign({
        record_id: recordId,
        record_kind: "capability_route",
        origin_exchange_id: "exchange-a",
        revision,
        issued_at: "2026-08-01T00:00:00.000Z",
        expires_at: "2026-08-01T00:01:00.000Z",
        visibility: "public",
        audiences: [],
        transitive: false,
        max_hops: 0,
        payload: {
          capability_id: recordId,
          versions: ["1.0.0"], input_media_types: [], output_media_types: [], input_schema_refs: [], output_schema_refs: [],
          interaction_modes: ["asynchronous"], binding_types: ["http_sse"], security_schemes: ["oauth2"], availability: "available",
        },
      });
      const record = await recordCodecA.verify(bytes, { audience: "exchange-a" });
      await recordsA.apply({ ...scope, source_peer_id: null, value: record });
    }
    const exportPolicy: DiscoveryExportPolicy = {
      async exportRecord({ record }) { return record.record_id === "route-revoked" ? null : record; },
    };
    const messageCodecA = new DiscoveryMessageCodec({ local_exchange_id: "exchange-a", signer: signerA, trust: trustA, clock: time });
    const messageCodecB = new DiscoveryMessageCodec({ local_exchange_id: "exchange-b", signer: signerB, trust: trustB, clock: time });
    let nextA = 0;
    let nextB = 0;
    const gatewayA = new DiscoveryGateway({
      ...scope,
      local_exchange_id: "exchange-a",
      message_codec: messageCodecA,
      record_codec: recordCodecA,
      cache: new DiscoveryCacheService({ local_exchange_id: "exchange-a", codec: recordCodecA, store: recordsA, peers: peersA, clock: time }),
      store: recordsA,
      peers: peersA,
      export_policy: exportPolicy,
      clock: time,
      id_generator: { nextId: () => `a-${++nextA}` },
    });
    const gatewayB = new DiscoveryGateway({
      ...scope,
      local_exchange_id: "exchange-b",
      message_codec: messageCodecB,
      record_codec: recordCodecB,
      cache: new DiscoveryCacheService({ local_exchange_id: "exchange-b", codec: recordCodecB, store: recordsB, peers: peersB, clock: time }),
      store: recordsB,
      peers: peersB,
      export_policy: { async exportRecord({ record }) { return record; } },
      clock: time,
      id_generator: { nextId: () => `b-${++nextB}` },
    });

    const prepared = await gatewayB.prepareSync({ peer_id: "peer-a" });
    const firstResponse = await gatewayA.receiveSync(prepared.bytes);
    const replayResponse = await gatewayA.receiveSync(prepared.bytes);
    expect(replayResponse).toEqual(firstResponse);

    const conflictingReplay = await messageCodecB.sign({
      message_id: prepared.message_id,
      message_type: "sync_request",
      target_exchange_id: "exchange-a",
      issued_at: time.now(),
      expires_at: "2026-08-01T00:00:50.000Z",
      payload: { limit: 1 },
    });
    await expect(gatewayA.receiveSync(conflictingReplay))
      .rejects.toMatchObject({ code: "discovery_record_conflict" });

    const wrongCorrelation = await messageCodecA.sign({
      message_id: "forged-response",
      message_type: "sync_response",
      target_exchange_id: "exchange-b",
      issued_at: time.now(),
      expires_at: "2026-08-01T00:00:50.000Z",
      payload: {
        request_message_id: prepared.message_id,
        request_digest: "0".repeat(64),
        items: [],
        etag: 'W/"2"',
        complete: true,
      },
    });
    await expect(gatewayB.deliverSync(prepared, { exchange: async () => wrongCorrelation }))
      .rejects.toMatchObject({ code: "discovery_record_conflict" });

    const unboundGatewayA = new DiscoveryGateway({
      ...scope,
      local_exchange_id: "exchange-a",
      message_codec: messageCodecA,
      record_codec: recordCodecA,
      cache: new DiscoveryCacheService({
        local_exchange_id: "exchange-a", codec: recordCodecA, store: recordsA,
        peers: new MemoryDiscoveryPeerBindingStore(), clock: time,
      }),
      store: recordsA,
      peers: new MemoryDiscoveryPeerBindingStore(),
      export_policy: exportPolicy,
      clock: time,
      id_generator: { nextId: () => "unbound-response" },
    });
    await expect(unboundGatewayA.receiveSync(prepared.bytes))
      .rejects.toMatchObject({ code: "discovery_wrong_audience" });

    const transport = { exchange: (request: Uint8Array) => gatewayA.receiveSync(request) };
    const result = await gatewayB.deliverSync(prepared, transport);
    expect(result).toMatchObject({ outcome: "applied", applied: 2, complete: true });
    if (result.outcome !== "applied") throw new Error("expected applied sync");
    expect(result.next_cursor).toBeTypeOf("string");
    await expect(recordsB.status({ ...scope, now: time.now() })).resolves.toMatchObject({ live: 1, withdrawn: 1 });

    const after = await gatewayB.prepareSync({ peer_id: "peer-a", cursor: result.next_cursor!, etag: result.etag });
    await expect(gatewayB.deliverSync(after, transport)).resolves.toMatchObject({ outcome: "applied", applied: 0, complete: true });
    await expect(gatewayB.deliverSync(after, { exchange: async () => "retryable_failure" as const }))
      .resolves.toEqual({ outcome: "retryable_failure" });
  });
});
