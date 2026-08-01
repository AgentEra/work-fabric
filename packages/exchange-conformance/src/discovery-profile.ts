import assert from "node:assert/strict";

import {
  DISCOVERY_PROFILE,
  type DiscoveryRecord,
  type DiscoveryStore,
  type DiscoveryTombstone,
} from "@work-fabric/discovery-spi";

export type DiscoveryStoreFactory = () => DiscoveryStore;

const scope = { tenant_id: "tenant-profile", tenant_view_id: "view-profile" };
const now = "2026-08-01T00:00:30.000Z";

function record(recordId: string, revision = 1, expiresAt = "2026-08-01T00:01:00.000Z"): DiscoveryRecord {
  return {
    profile: DISCOVERY_PROFILE,
    record_id: recordId,
    record_kind: "exchange",
    origin_exchange_id: "exchange-origin",
    revision,
    issued_at: "2026-08-01T00:00:00.000Z",
    expires_at: expiresAt,
    visibility: "public",
    audiences: [],
    transitive: false,
    max_hops: 0,
    payload: {
      exchange_id: "exchange-origin",
      display_name: `Origin ${recordId}`,
      discovery_profiles: [DISCOVERY_PROFILE],
      federation_profiles: ["workfabric.federation.v1"],
      bindings: [],
      security_schemes: ["ed25519"],
    },
    payload_digest: `${revision}`.padStart(64, "0"),
    key_id: "key-profile",
    signature: "A".repeat(86),
  };
}

async function rejects(operation: Promise<unknown>, message: string): Promise<void> {
  try { await operation; } catch { return; }
  assert.fail(message);
}

async function isolated(operation: Promise<DiscoveryRecord | null>, message: string): Promise<void> {
  let value: DiscoveryRecord | null | undefined;
  let rejected = false;
  try { value = await operation; } catch { rejected = true; }
  assert.ok(rejected || value === null, message);
}

export async function verifyDiscoveryStoreProfile(factory: DiscoveryStoreFactory): Promise<void> {
  const store = factory();
  assert.equal(store.manifest.profile, "workfabric.discovery-store.v1");

  const original = record("record-a");
  assert.equal((await store.apply({ ...scope, source_peer_id: "peer-a", value: original })).outcome, "applied");
  (original.payload as { display_name: string }).display_name = "mutated";
  const stored = await store.get({ ...scope, origin_exchange_id: "exchange-origin", record_id: "record-a", now });
  assert.ok(stored?.record_kind === "exchange");
  assert.equal(stored.payload.display_name, "Origin record-a");
  await isolated(store.get({ tenant_id: "tenant-other", tenant_view_id: scope.tenant_view_id, origin_exchange_id: "exchange-origin", record_id: "record-a", now }), "cross-tenant reads must be absent or rejected");
  await isolated(store.get({ tenant_id: scope.tenant_id, tenant_view_id: "view-other", origin_exchange_id: "exchange-origin", record_id: "record-a", now }), "cross-view reads must be absent or rejected");

  const same = record("record-a");
  assert.equal((await store.apply({ ...scope, source_peer_id: "peer-a", value: same })).outcome, "duplicate");
  await rejects(store.apply({ ...scope, source_peer_id: "peer-a", value: { ...same, signature: "B".repeat(86) } }), "same revision with different bytes must conflict");
  assert.equal((await store.apply({ ...scope, source_peer_id: "peer-a", value: { ...same, revision: 0 } })).outcome, "stale");

  await store.apply({ ...scope, source_peer_id: "peer-a", value: record("record-a", 2) });
  await store.apply({ ...scope, source_peer_id: "peer-a", value: record("record-b") });
  const first = await store.query({ ...scope, now, limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.next_cursor !== undefined);
  const second = await store.query({ ...scope, now, limit: 1, cursor: first.next_cursor });
  assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0]?.record_id, first.items[0]?.record_id);
  await rejects(store.query({ ...scope, tenant_id: "tenant-other", now, limit: 1, cursor: first.next_cursor }), "cursor must bind tenant and query");

  const tombstone: DiscoveryTombstone = {
    profile: DISCOVERY_PROFILE,
    record_id: "record-a",
    origin_exchange_id: "exchange-origin",
    revision: 3,
    withdrawn_at: "2026-08-01T00:00:31.000Z",
    retain_until: "2026-08-01T00:05:31.000Z",
    key_id: "key-profile",
    signature: "C".repeat(86),
  };
  await store.apply({ ...scope, source_peer_id: "peer-a", value: tombstone });
  assert.equal(await store.get({ ...scope, origin_exchange_id: "exchange-origin", record_id: "record-a", now: "2026-08-01T00:00:32.000Z" }), null);
  assert.equal((await store.apply({ ...scope, source_peer_id: "peer-a", value: record("record-a", 2) })).outcome, "stale");

  await store.apply({ ...scope, source_peer_id: "peer-a", value: record("expired", 1, "2026-08-01T00:00:01.000Z") });
  assert.equal((await store.query({ ...scope, now, limit: 10 })).items.some((item) => item.record_id === "expired"), false);
  assert.ok((await store.changes({ ...scope, peer_id: "peer-b", limit: 20 })).items.some((item) => item.record_id === "record-a"));
  assert.ok((await store.status({ ...scope, now })).withdrawn >= 1);
}
