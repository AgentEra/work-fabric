import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DISCOVERY_PROFILE, type DiscoveryRecord } from "@work-fabric/discovery-spi";
import { verifyDiscoveryStoreProfile } from "@work-fabric/exchange-conformance";

import {
  createSqliteDiscoveryPeerBindingStore,
  createSqliteDiscoveryStore,
  migrateSqlite,
  SqliteSession,
} from "../src/index.js";

const tenantId = "tenant-profile";
const tenantViewId = "view-profile";
const scope = { tenant_id: tenantId, tenant_view_id: tenantViewId };

function record(): DiscoveryRecord {
  return {
    profile: DISCOVERY_PROFILE,
    record_id: "restart-record",
    record_kind: "exchange",
    origin_exchange_id: "exchange-origin",
    revision: 1,
    issued_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-08-01T00:01:00.000Z",
    visibility: "public",
    audiences: [],
    transitive: false,
    max_hops: 0,
    payload: {
      exchange_id: "exchange-origin",
      display_name: "Origin",
      discovery_profiles: [DISCOVERY_PROFILE],
      federation_profiles: [],
      bindings: [],
      security_schemes: ["ed25519"],
    },
    payload_digest: "a".repeat(64),
    key_id: "key-a",
    signature: "A".repeat(86),
  };
}

describe("SQLite discovery adapters", () => {
  it("passes the discovery profile and restores records and Peer CAS state after restart", async () => {
    const location = join(mkdtempSync(join(tmpdir(), "wf-discovery-")), "wf.db");
    const first = new SqliteSession({ location });
    migrateSqlite(first);
    const store = createSqliteDiscoveryStore(first, tenantId, tenantViewId, {
      max_records_per_origin: 100,
      tombstone_retention_seconds: 330,
    });
    await verifyDiscoveryStoreProfile(() => store);
    await store.apply({ ...scope, source_peer_id: null, value: record() });
    const peers = createSqliteDiscoveryPeerBindingStore(first, tenantId, tenantViewId);
    const initialPeer = {
      ...scope,
      peer_id: "peer-a",
      exchange_id: "exchange-a",
      state: "active" as const,
      allow_import: true,
      allow_export: true,
      allow_query: true,
      allow_transit: false,
      max_page_size: 100,
      max_response_bytes: 65_536,
      version: 1,
    };
    await peers.put({ binding: initialPeer, expected_version: null });
    await peers.put({ binding: { ...initialPeer, allow_transit: true, version: 2 }, expected_version: 1 });
    first.close();

    const second = new SqliteSession({ location });
    migrateSqlite(second);
    const restored = createSqliteDiscoveryStore(second, tenantId, tenantViewId, {
      max_records_per_origin: 100,
      tombstone_retention_seconds: 330,
    });
    await expect(restored.get({
      ...scope,
      origin_exchange_id: "exchange-origin",
      record_id: "restart-record",
      now: "2026-08-01T00:00:30.000Z",
    })).resolves.toMatchObject({ record_id: "restart-record" });
    await expect(createSqliteDiscoveryPeerBindingStore(second, tenantId, tenantViewId).get(scope, "peer-a"))
      .resolves.toMatchObject({ version: 2, allow_transit: true });
    expect(restored.manifest.capabilities).toMatchObject({
      local_file_durability: true,
      single_process_writer: true,
      clustered_claims: false,
    });
    second.close();
  });

  it("rejects cross-tenant and cross-view mutations before persisting an operation", async () => {
    const session = new SqliteSession({ location: ":memory:" });
    migrateSqlite(session);
    const store = createSqliteDiscoveryStore(session, tenantId, tenantViewId, {
      max_records_per_origin: 10,
      tombstone_retention_seconds: 330,
    });
    const count = () => (session.prepare(`
      SELECT COUNT(*) AS count FROM work_fabric_local_store_operations
      WHERE tenant_id=? AND store_kind=?
    `).get(tenantId, `discovery-records:${tenantViewId}`) as { count: number }).count;
    const before = count();

    await expect(store.apply({ ...scope, tenant_id: "tenant-other", source_peer_id: null, value: record() }))
      .rejects.toThrow("tenant context mismatch");
    await expect(store.apply({ ...scope, tenant_view_id: "view-other", source_peer_id: null, value: record() }))
      .rejects.toThrow("tenant view context mismatch");
    expect(count()).toBe(before);
    session.close();
  });
});
