import { afterEach, describe, expect, it } from "vitest";

import {
  createPgPool,
  createTenantSession,
  runMigrations,
  TENANT_CONTEXT_MIGRATION,
  type PostgresClient,
  type PostgresPool,
  type PostgresQueryResult,
  type TenantSession,
} from "@work-fabric/adapter-postgres-common";
import { DISCOVERY_PROFILE, type DiscoveryRecord } from "@work-fabric/discovery-spi";
import { verifyDiscoveryStoreProfile } from "@work-fabric/exchange-conformance";

import {
  DISCOVERY_MIGRATION,
  PostgresDiscoveryPeerBindingStore,
  PostgresDiscoveryStore,
} from "../src/index.js";

class Client implements PostgresClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  readonly responses: Array<PostgresQueryResult<Record<string, unknown>>> = [];
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ text, ...(values === undefined ? {} : { values }) });
    return (this.responses.shift() ?? { rows: [], rowCount: 1 }) as PostgresQueryResult<Row>;
  }
  release(): void {}
}

class Session implements TenantSession {
  readonly tenant_id = "tenant-a";
  constructor(readonly client: Client) {}
  withTransaction<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
    return operation(this.client);
  }
}

const scope = { tenant_id: "tenant-a", tenant_view_id: "view-a" };
const connectionString = process.env.WORK_FABRIC_TEST_POSTGRES_URL ?? process.env.PG_TEST_URL;
const live = connectionString !== undefined && connectionString.trim().length > 0;
let pool: PostgresPool | undefined;

afterEach(async () => {
  await pool?.end();
  pool = undefined;
});
function record(): DiscoveryRecord {
  return {
    profile: DISCOVERY_PROFILE,
    record_id: "route-a",
    record_kind: "exchange",
    origin_exchange_id: "exchange-a",
    revision: 1,
    issued_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-08-01T00:01:00.000Z",
    visibility: "public", audiences: [], transitive: false, max_hops: 0,
    payload: {
      exchange_id: "exchange-a", display_name: "A", discovery_profiles: [DISCOVERY_PROFILE],
      federation_profiles: [], bindings: [], security_schemes: ["ed25519"],
    },
    payload_digest: "a".repeat(64), key_id: "key-a", signature: "A".repeat(86),
  };
}

describe("PostgreSQL discovery persistence", () => {
  it("defines tenant/view/origin keys, retained changes, indexes, and forced RLS", () => {
    expect(DISCOVERY_MIGRATION.id).toBe("010_discovery");
    for (const table of ["work_fabric_discovery_records", "work_fabric_discovery_changes", "work_fabric_discovery_peers"]) {
      expect(DISCOVERY_MIGRATION.sql).toContain(table);
    }
    expect(DISCOVERY_MIGRATION.sql).toMatch(/PRIMARY KEY \(tenant_id, tenant_view_id, origin_exchange_id, record_id\)/);
    expect(DISCOVERY_MIGRATION.sql.match(/FORCE ROW LEVEL SECURITY/g)?.length).toBeGreaterThanOrEqual(3);
    expect(DISCOVERY_MIGRATION.sql).toContain("tenant_id = work_fabric_current_tenant()");
    expect(DISCOVERY_MIGRATION.sql).toContain("work_fabric_discovery_changes_cursor_idx");
  });

  it("locks a record revision, writes the record and change atomically, and guards tenant views", async () => {
    const client = new Client();
    client.responses.push(
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
      { rows: [{ change_sequence: "7" }], rowCount: 1 },
    );
    const store = new PostgresDiscoveryStore(() => new Session(client), "tenant-a", "view-a", {
      max_records_per_origin: 100,
    });
    await expect(store.apply({ ...scope, source_peer_id: "peer-a", value: record() }))
      .resolves.toEqual({ outcome: "applied", sequence: 7 });
    expect(client.calls[0]?.text).toContain("FOR UPDATE");
    expect(client.calls[0]?.values?.slice(0, 4)).toEqual(["tenant-a", "view-a", "exchange-a", "route-a"]);
    expect(client.calls.some((call) => call.text.includes("work_fabric_discovery_changes"))).toBe(true);
    const before = client.calls.length;
    await expect(store.apply({ ...scope, tenant_view_id: "view-other", source_peer_id: null, value: record() }))
      .rejects.toThrow("tenant view context mismatch");
    expect(client.calls).toHaveLength(before);
  });

  it("uses versioned PeerBinding CAS and immutable exchange bindings", async () => {
    const client = new Client();
    client.responses.push({ rows: [], rowCount: 0 }, { rows: [], rowCount: 1 });
    const peers = new PostgresDiscoveryPeerBindingStore(() => new Session(client), "tenant-a", "view-a");
    const binding = {
      ...scope, peer_id: "peer-a", exchange_id: "exchange-a", state: "active" as const,
      allow_import: true, allow_export: true, allow_query: true, allow_transit: false,
      max_page_size: 100, max_response_bytes: 65_536, version: 1,
    };
    await expect(peers.put({ binding, expected_version: null })).resolves.toEqual(binding);
    expect(client.calls[0]?.text).toContain("FOR UPDATE");
    expect(client.calls.some((call) => call.text.includes("INSERT INTO work_fabric_discovery_peers"))).toBe(true);
  });

  it.skipIf(!live)("passes the shared discovery profile against live PostgreSQL with RLS", async () => {
    if (connectionString === undefined) return;
    pool = createPgPool(connectionString);
    const schema = `wf_discovery_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const setup = await pool.connect();
    await setup.query(`CREATE SCHEMA "${schema}"`);
    await setup.query(`SET search_path TO "${schema}"`);
    await runMigrations(setup, [TENANT_CONTEXT_MIGRATION, DISCOVERY_MIGRATION]);
    setup.release();
    const sessions = () => {
      const base = createTenantSession(pool as PostgresPool, "tenant-profile");
      return {
        tenant_id: "tenant-profile",
        withTransaction: <T>(operation: (client: PostgresClient) => Promise<T>) =>
          base.withTransaction(async (client) => {
            await client.query(`SET LOCAL search_path TO "${schema}"`);
            return operation(client);
          }),
      };
    };
    try {
      await verifyDiscoveryStoreProfile(() => new PostgresDiscoveryStore(
        sessions, "tenant-profile", "view-profile", { max_records_per_origin: 100 },
      ));
    } finally {
      const cleanup = await pool.connect();
      await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
      cleanup.release();
    }
  });
});
