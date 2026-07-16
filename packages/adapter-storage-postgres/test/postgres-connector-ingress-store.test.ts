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
import {
  CONNECTOR_INGRESS_REQUIRED_CAPABILITIES,
} from "@work-fabric/connector-spi";
import { verifyConnectorIngressProfile } from "@work-fabric/exchange-conformance";
import { assertCapabilities } from "@work-fabric/exchange-spi";

import {
  CONNECTOR_INGRESS_MIGRATION,
  CONNECTOR_INGRESS_HARDENING_MIGRATION,
  PostgresConnectorIngressStore,
} from "../src/index.js";

class FakeClient implements PostgresClient {
  readonly calls: string[] = [];
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    _values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push(text);
    return { rows: [], rowCount: 0 };
  }
  release(): void {}
}

class FakeSession implements TenantSession {
  readonly tenant_id = "tenant_01";
  readonly client = new FakeClient();
  withTransaction<T>(
    operation: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    return operation(this.client);
  }
}

const connectionString = process.env.PG_TEST_URL;
const live = connectionString !== undefined && connectionString.trim().length > 0;
let pool: PostgresPool | undefined;

afterEach(async () => {
  await pool?.end();
  pool = undefined;
});

describe("PostgreSQL Connector ingress store", () => {
  it("publishes the generic profile and an isolated migration", async () => {
    const session = new FakeSession();
    const store = new PostgresConnectorIngressStore(
      () => session,
      "tenant_01",
    );
    assertCapabilities(
      store.manifest,
      CONNECTOR_INGRESS_REQUIRED_CAPABILITIES,
    );
    expect(store.manifest.profile).toBe("connector.ingress.v1");
    expect(CONNECTOR_INGRESS_MIGRATION.id).toBe("005_connector_ingress");
    expect(CONNECTOR_INGRESS_MIGRATION.sql).toContain(
      "work_fabric_connector_ingress",
    );
    expect(CONNECTOR_INGRESS_MIGRATION.sql).toContain(
      "FORCE ROW LEVEL SECURITY",
    );
    expect(CONNECTOR_INGRESS_MIGRATION.sql).toContain(
      "UNIQUE (tenant_id, connector_id, source_system, dedupe_key)",
    );
    await expect(store.claim({
      tenant_id: "tenant_01",
      connector_id: "connector_01",
      worker_id: "worker_01",
      now: "2026-07-15T00:00:00Z",
      lease_seconds: 30,
      limit: 10,
    })).resolves.toEqual([]);
    expect(session.client.calls.join("\n")).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("uses indexed temporal columns and exposes bounded tenant-scoped retention pruning", async () => {
    const session = new FakeSession();
    const store = new PostgresConnectorIngressStore(
      () => session,
      "tenant_01",
      {
        completed_retention_seconds: 604_800,
        dead_letter_retention_seconds: 2_592_000,
      },
    );
    expect(CONNECTOR_INGRESS_HARDENING_MIGRATION.sql).toMatch(/TYPE timestamptz/i);
    expect(CONNECTOR_INGRESS_HARDENING_MIGRATION.sql).toContain(
      "work_fabric_connector_ingress_claim_idx",
    );
    await expect(store.pruneExpired({
      tenant_id: "tenant_01",
      connector_id: "connector_01",
      now: "2026-07-16T00:00:00Z",
      limit: 100,
    })).resolves.toBe(0);
    const sql = session.client.calls.join("\n");
    expect(sql).toContain("retention_expires_at <= $3");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).not.toContain("::timestamptz");
  });

  it.skipIf(!live)("satisfies the shared profile with RLS", async () => {
    if (connectionString === undefined) return;
    pool = createPgPool(connectionString);
    const schema = `wf_connector_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const setup = await pool.connect();
    await setup.query(`CREATE SCHEMA "${schema}"`);
    await setup.query(`SET search_path TO "${schema}"`);
    await runMigrations(setup, [
      TENANT_CONTEXT_MIGRATION,
      CONNECTOR_INGRESS_MIGRATION,
      CONNECTOR_INGRESS_HARDENING_MIGRATION,
    ]);
    setup.release();

    const sessionFactory = (tenantId: string): TenantSession => {
      const base = createTenantSession(pool as PostgresPool, tenantId);
      return {
        tenant_id: tenantId,
        withTransaction: (operation) =>
          base.withTransaction(async (client) => {
            await client.query(`SET LOCAL search_path TO "${schema}"`);
            return operation(client);
          }),
      };
    };

    try {
      await verifyConnectorIngressProfile(
        () => new PostgresConnectorIngressStore(
          sessionFactory,
          "tenant_profile_01",
        ),
      );
      const other = new PostgresConnectorIngressStore(
        sessionFactory,
        "tenant_other",
      );
      await expect(other.list({
        tenant_id: "tenant_other",
        connector_id: "connector_profile_01",
        limit: 10,
      })).resolves.toEqual({ items: [] });
    } finally {
      const cleanup = await pool.connect();
      await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
      cleanup.release();
    }
  });
});
