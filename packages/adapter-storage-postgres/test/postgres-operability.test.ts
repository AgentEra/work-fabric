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
  verifyOperationsStoreProfile,
  verifyTenantScopedProjectionProfile,
} from "@work-fabric/exchange-conformance";

import {
  OPERABILITY_MIGRATION,
  PostgresAuditStore,
  PostgresCollaborationViewStore,
  PostgresHandoffReadModelStore,
} from "../src/index.js";

const connectionString = process.env.PG_TEST_URL;
const live = connectionString !== undefined && connectionString.trim().length > 0;
let pool: PostgresPool | undefined;

class FakeClient implements PostgresClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] | undefined }> = [];
  responses: Array<PostgresQueryResult<Record<string, unknown>>> = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, values });
    return (this.responses.shift() ?? { rows: [], rowCount: 0 }) as PostgresQueryResult<Row>;
  }

  release(): void {}
}

class FakeSession implements TenantSession {
  constructor(
    readonly tenant_id: string,
    private readonly client: FakeClient,
  ) {}

  withTransaction<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
    return operation(this.client);
  }
}

afterEach(async () => {
  if (pool !== undefined) await pool.end();
  pool = undefined;
});

describe("PostgreSQL operability persistence", () => {
  it("defines indexed tenant-isolated view and append-only audit tables", () => {
    expect(OPERABILITY_MIGRATION.id).toBe("007_operability");
    for (const table of [
      "work_fabric_handoff_read_models",
      "work_fabric_responsibility_views",
      "work_fabric_timeline_entries",
      "work_fabric_relationship_views",
      "work_fabric_relationship_versions",
      "work_fabric_operation_audit",
    ]) {
      expect(OPERABILITY_MIGRATION.sql).toContain(table);
      expect(OPERABILITY_MIGRATION.sql).toContain(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
      );
    }
    expect(OPERABILITY_MIGRATION.sql).toMatch(/updated_at timestamptz/i);
    expect(OPERABILITY_MIGRATION.sql).toMatch(/occurred_at timestamptz/i);
    expect(OPERABILITY_MIGRATION.sql).toMatch(/responsibility_views_query_idx/i);
    expect(OPERABILITY_MIGRATION.sql).toMatch(/timeline_entries_query_idx/i);
    expect(OPERABILITY_MIGRATION.sql).toMatch(/relationship_views_thread_idx/i);
    expect(OPERABILITY_MIGRATION.sql).toMatch(/operation_audit_query_idx/i);
  });

  it("uses indexed thread filters and bounded skip-locked audit pruning", async () => {
    const client = new FakeClient();
    client.responses.push({ rows: [], rowCount: 0 });
    client.responses.push({ rows: [], rowCount: 7 });
    const factory = (tenant: string) => new FakeSession(tenant, client);
    const collaboration = new PostgresCollaborationViewStore(
      factory,
      "tenant-1",
      { cursor_secret: "postgres-operability-test-secret" },
    );
    const audit = new PostgresAuditStore(factory, "tenant-1", {
      cursor_secret: "postgres-operability-test-secret",
    });

    await expect(collaboration.listRelationships({
      tenant_id: "tenant-1",
      partition_id: "partition-1",
      thread_id: "thread-1",
      limit: 10,
    })).resolves.toEqual({ items: [], next_cursor: null });
    await expect(
      audit.pruneBefore("tenant-1", "2026-07-16T00:00:00.000Z", 10),
    ).resolves.toBe(7);

    expect(client.calls[0]?.sql).toContain("thread_id=$3");
    expect(client.calls[0]?.values).toEqual([
      "tenant-1", "partition-1", "thread-1", 11,
    ]);
    expect(client.calls[1]?.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(client.calls[1]?.values).toEqual([
      "tenant-1", "2026-07-16T00:00:00.000Z", 10,
    ]);
  });

  it("binds every store to one tenant and returns cloned payloads", async () => {
    const client = new FakeClient();
    const payload = {
      tenant_id: "tenant-1",
      partition_id: "partition-1",
      handoff_id: "handoff-1",
      stream_version: 1,
      state: { handoff_id: "handoff-1", resource_version: 1 },
      latest_status: null,
    };
    client.responses.push({ rows: [{ payload }], rowCount: 1 });
    const factory = (tenant: string) => new FakeSession(tenant, client);
    const handoffs = new PostgresHandoffReadModelStore(factory, "tenant-1");
    const collaboration = new PostgresCollaborationViewStore(
      factory,
      "tenant-1",
      { cursor_secret: "postgres-operability-test-secret" },
    );
    const audit = new PostgresAuditStore(factory, "tenant-1", {
      cursor_secret: "postgres-operability-test-secret",
    });

    const loaded = await handoffs.getHandoff("handoff-1");
    expect(loaded).toEqual(payload);
    if (loaded !== null) (loaded.state as { handoff_id: string }).handoff_id = "mutated";
    expect(payload.state.handoff_id).toBe("handoff-1");
    expect(collaboration.manifest.profile).toBe("workfabric.collaboration-view.v1");
    expect(audit.manifest.profile).toBe("workfabric.operation-audit.v1");
    expect(() => new PostgresAuditStore(factory, "", { cursor_secret: "secret" })).toThrow(/tenant/i);
    expect(client.calls[0]).toMatchObject({ values: ["tenant-1", "handoff-1"] });
  });

  it.skipIf(!live)("passes projection and operations conformance with RLS", async () => {
    if (connectionString === undefined) return;
    pool = createPgPool(connectionString);
    const schema = `wf_operability_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const setup = await pool.connect();
    await setup.query(`CREATE SCHEMA "${schema}"`);
    await setup.query(`SET search_path TO "${schema}"`);
    await runMigrations(setup, [TENANT_CONTEXT_MIGRATION, OPERABILITY_MIGRATION]);
    setup.release();
    const sessionFactory = (tenantId: string): TenantSession => {
      const base = createTenantSession(pool as PostgresPool, tenantId);
      return {
        tenant_id: tenantId,
        withTransaction: (operation) => base.withTransaction(async (client) => {
          await client.query(`SET LOCAL search_path TO "${schema}"`);
          return operation(client);
        }),
      };
    };
    try {
      await verifyTenantScopedProjectionProfile(
        (tenantId) => new PostgresHandoffReadModelStore(sessionFactory, tenantId),
      );
      await verifyOperationsStoreProfile(() => ({
        collaboration: new PostgresCollaborationViewStore(
          sessionFactory,
          "tenant-profile",
          { cursor_secret: "postgres-live-profile-secret" },
        ),
        audit: new PostgresAuditStore(sessionFactory, "tenant-profile", {
          cursor_secret: "postgres-live-profile-secret",
        }),
      }));
      const other = new PostgresHandoffReadModelStore(sessionFactory, "other-tenant");
      await expect(other.getHandoff("handoff-1")).resolves.toBeNull();
    } finally {
      const cleanup = await pool.connect();
      await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
      cleanup.release();
    }
  });
});
