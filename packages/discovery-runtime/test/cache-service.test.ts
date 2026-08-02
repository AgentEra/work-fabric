import { describe, expect, it } from "vitest";

import {
  MemoryDiscoveryPeerBindingStore,
  MemoryDiscoveryStore,
} from "@work-fabric/adapter-discovery-memory";
import type { DiscoverySigner, DiscoveryTrustResolver } from "@work-fabric/discovery-spi";

import {
  DiscoveryCacheService,
  DiscoveryRecordCodec,
} from "../src/index.js";

const signature = "A".repeat(86);
const clock = { now: () => "2026-08-01T00:00:30.000Z" };
const signer: DiscoverySigner = { key_id: "key-1", async sign() { return signature; } };
const trust: DiscoveryTrustResolver = { async verify(input) { return input.signature === signature; } };
const scope = { tenant_id: "tenant-a", tenant_view_id: "view-a" };

async function harness() {
  const store = new MemoryDiscoveryStore({
    max_records_per_origin: 10,
    tombstone_retention_seconds: 300,
  });
  const peers = new MemoryDiscoveryPeerBindingStore();
  await peers.put({
    expected_version: null,
    binding: {
      ...scope,
      peer_id: "peer-source",
      exchange_id: "exchange-source",
      state: "active",
      allow_import: true,
      allow_export: true,
      allow_query: true,
      allow_transit: false,
      max_page_size: 100,
      max_response_bytes: 65_536,
      version: 1,
    },
  });
  const source = new DiscoveryRecordCodec({
    local_exchange_id: "exchange-source", signer, trust, clock,
  });
  const targetCodec = new DiscoveryRecordCodec({
    local_exchange_id: "exchange-target", signer, trust, clock,
  });
  const service = new DiscoveryCacheService({
    local_exchange_id: "exchange-target",
    codec: targetCodec,
    store,
    peers,
    clock,
  });
  const bytes = await source.sign({
    record_id: "exchange:source",
    record_kind: "exchange",
    origin_exchange_id: "exchange-source",
    revision: 1,
    issued_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-08-01T00:01:00.000Z",
    visibility: "peer",
    audiences: ["exchange-target"],
    transitive: false,
    max_hops: 0,
    payload: {
      exchange_id: "exchange-source",
      display_name: "Source",
      discovery_profiles: ["workfabric.discovery.v1"],
      federation_profiles: [],
      bindings: [],
      security_schemes: ["ed25519"],
    },
  });
  return { store, peers, service, bytes };
}

describe("DiscoveryCacheService", () => {
  it("verifies before applying and preserves idempotent revisions", async () => {
    const { store, service, bytes } = await harness();
    await expect(service.accept({
      ...scope,
      source_peer_id: "peer-source",
      audience_exchange_id: "exchange-target",
      bytes,
    })).resolves.toMatchObject({ outcome: "applied" });
    await expect(service.accept({
      ...scope,
      source_peer_id: "peer-source",
      audience_exchange_id: "exchange-target",
      bytes,
    })).resolves.toMatchObject({ outcome: "duplicate" });

    const tampered = Uint8Array.from(bytes);
    tampered[tampered.length - 2] = (tampered[tampered.length - 2] ?? 0) ^ 1;
    await expect(service.accept({
      ...scope,
      source_peer_id: "peer-source",
      audience_exchange_id: "exchange-target",
      bytes: tampered,
    })).rejects.toMatchObject({ code: expect.stringMatching(/^discovery_/) });
    await expect(store.status({ ...scope, now: clock.now() })).resolves.toMatchObject({ live: 1 });
  });

  it("rejects unknown Peers and non-transitive relays", async () => {
    const { service, bytes } = await harness();
    await expect(service.accept({
      ...scope,
      source_peer_id: "peer-unknown",
      audience_exchange_id: "exchange-target",
      bytes,
    })).rejects.toMatchObject({ code: "discovery_wrong_audience" });
  });

  it("applies a higher-revision local tombstone and blocks resurrection", async () => {
    const { store, service, bytes } = await harness();
    await service.accept({
      ...scope,
      source_peer_id: "peer-source",
      audience_exchange_id: "exchange-target",
      bytes,
    });
    await expect(service.withdrawLocal({
      ...scope,
      tombstone: {
        profile: "workfabric.discovery.v1",
        record_id: "exchange:source",
        origin_exchange_id: "exchange-source",
        revision: 2,
        withdrawn_at: "2026-08-01T00:00:31.000Z",
        retain_until: "2026-08-01T00:05:31.000Z",
        key_id: "key-1",
        signature,
      },
    })).resolves.toMatchObject({ outcome: "applied" });
    await expect(store.get({
      ...scope,
      origin_exchange_id: "exchange-source",
      record_id: "exchange:source",
      now: "2026-08-01T00:00:32.000Z",
    })).resolves.toBeNull();
    await expect(service.accept({
      ...scope,
      source_peer_id: "peer-source",
      audience_exchange_id: "exchange-target",
      bytes,
    })).resolves.toMatchObject({ outcome: "stale" });
  });
});
