import { describe, expect, it } from "vitest";

import {
  createPgPool,
  createTenantSession,
  type PostgresClient,
  type PostgresQueryResult,
  type TenantSession,
} from "@work-fabric/adapter-postgres-common";
import { PARTITION_WORK_KINDS } from "@work-fabric/cluster-spi";
import { migratePostgres } from "../../../tools/postgres-migrate.js";
import {
  CLUSTER_RUNTIME_MIGRATION,
  PostgresPartitionWorkCatalog,
  PostgresRuntimeState,
} from "../src/index.js";

interface Call {
  readonly sql: string;
  readonly values: readonly unknown[] | undefined;
}

class FakeClient implements PostgresClient {
  readonly calls: Call[] = [];
  responses: Array<PostgresQueryResult<Record<string, unknown>>> = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, values });
    return (this.responses.shift() ?? { rows: [], rowCount: 0 }) as
      PostgresQueryResult<Row>;
  }

  release(): void {}
}

class Session implements TenantSession {
  constructor(
    readonly tenant_id: string,
    private readonly client: FakeClient,
  ) {}

  withTransaction<T>(
    operation: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    return operation(this.client);
  }
}

const secret = "cursor-secret-at-least-32-characters-long";

describe("PostgresPartitionWorkCatalog", () => {
  it("pushes tenant, due time, stable keyset and limit into indexed SQL", async () => {
    const client = new FakeClient();
    client.responses.push({
      rows: [
        {
          tenant_id: "tenant-1",
          partition_id: "partition-a",
          kind: "outbox_wakeup",
          observed_position: "4",
          available_at: new Date("2026-07-15T23:59:00.000Z"),
        },
        {
          tenant_id: "tenant-1",
          partition_id: "partition-b",
          kind: "handoff_projection",
          observed_position: "7",
          available_at: new Date("2026-07-15T23:59:30.000Z"),
        },
      ],
      rowCount: 2,
    });
    const catalog = new PostgresPartitionWorkCatalog(
      (tenantId) => new Session(tenantId, client),
      secret,
    );
    const first = await catalog.scanReady({
      tenant_id: "tenant-1",
      kinds: ["outbox_wakeup", "handoff_projection"],
      available_at_or_before: "2026-07-16T00:00:00.000Z",
      limit: 1,
    });

    expect(first.items).toEqual([{
      tenant_id: "tenant-1",
      partition_id: "partition-a",
      kind: "outbox_wakeup",
      observed_position: 4,
      available_at: "2026-07-15T23:59:00.000Z",
    }]);
    expect(first.next_cursor).toBeTypeOf("string");
    const call = client.calls[0];
    expect(call?.sql).toMatch(/work_fabric_partition_readiness/);
    expect(call?.sql).toMatch(/tenant_id\s*=\s*\$1/);
    expect(call?.sql).toMatch(/available_at\s*<=\s*\$3/);
    expect(call?.sql).toMatch(/ORDER BY[\s\S]*available_at[\s\S]*partition_id/i);
    expect(call?.sql).toMatch(/LIMIT\s+\$7/i);
    expect(call?.values).toEqual([
      "tenant-1",
      ["outbox_wakeup", "handoff_projection"],
      "2026-07-16T00:00:00.000Z",
      null,
      null,
      null,
      2,
    ]);
    expect(JSON.stringify(client.calls)).not.toContain(secret);

    client.responses.push({ rows: [], rowCount: 0 });
    await catalog.scanReady({
      tenant_id: "tenant-1",
      kinds: ["handoff_projection", "outbox_wakeup"],
      available_at_or_before: "2026-07-16T00:00:00.000Z",
      cursor: first.next_cursor ?? "missing",
      limit: 1,
    });
    expect(client.calls[1]?.values).toEqual([
      "tenant-1",
      ["outbox_wakeup", "handoff_projection"],
      "2026-07-16T00:00:00.000Z",
      "2026-07-15T23:59:00.000Z",
      "partition-a",
      0,
      2,
    ]);
  });

  it("rejects tampered/filter-crossed cursors before SQL", async () => {
    const client = new FakeClient();
    client.responses.push({
      rows: [
        {
          tenant_id: "tenant-1",
          partition_id: "partition-a",
          kind: "outbox_wakeup",
          observed_position: 1,
          available_at: "2026-07-15T23:59:00.000Z",
        },
        {
          tenant_id: "tenant-1",
          partition_id: "partition-b",
          kind: "outbox_wakeup",
          observed_position: 2,
          available_at: "2026-07-15T23:59:01.000Z",
        },
      ],
      rowCount: 2,
    });
    const catalog = new PostgresPartitionWorkCatalog(
      (tenantId) => new Session(tenantId, client),
      secret,
    );
    const page = await catalog.scanReady({
      tenant_id: "tenant-1",
      kinds: ["outbox_wakeup"],
      available_at_or_before: "2026-07-16T00:00:00.000Z",
      limit: 1,
    });
    const cursor = page.next_cursor ?? "";
    const calls = client.calls.length;

    await expect(catalog.scanReady({
      tenant_id: "tenant-1",
      kinds: ["outbox_wakeup"],
      available_at_or_before: "2026-07-16T00:00:00.000Z",
      cursor: `${cursor}x`,
      limit: 1,
    })).rejects.toThrow(/cursor/i);
    await expect(catalog.scanReady({
      tenant_id: "tenant-2",
      kinds: ["outbox_wakeup"],
      available_at_or_before: "2026-07-16T00:00:00.000Z",
      cursor,
      limit: 1,
    })).rejects.toThrow(/context/i);
    expect(client.calls).toHaveLength(calls);
  });

  it("declares derived RLS readiness without replacing authority", () => {
    expect(CLUSTER_RUNTIME_MIGRATION.id).toBe("008_cluster_runtime");
    expect(CLUSTER_RUNTIME_MIGRATION.sql).toMatch(
      /CREATE TABLE IF NOT EXISTS work_fabric_partition_readiness/,
    );
    expect(CLUSTER_RUNTIME_MIGRATION.sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(CLUSTER_RUNTIME_MIGRATION.sql).toMatch(/CREATE TRIGGER/);
    expect(CLUSTER_RUNTIME_MIGRATION.sql).not.toMatch(
      /DROP TABLE|ALTER TABLE work_fabric_events DROP|TRUNCATE/i,
    );
    for (const kind of PARTITION_WORK_KINDS) {
      expect(CLUSTER_RUNTIME_MIGRATION.sql).toContain(`'${kind}'`);
    }
  });
});

const connectionString = process.env.PG_TEST_URL;
const live = connectionString !== undefined && connectionString.length > 0;

describe("PostgreSQL cluster lease integration", () => {
  it.skipIf(!live)("isolates tenants and fences a race before expiry takeover", async () => {
    if (!connectionString) return;
    const pool = createPgPool(connectionString);
    const tenantA = `cluster-a-${Date.now()}`;
    const tenantB = `cluster-b-${Date.now()}`;
    try {
      await migratePostgres({ connection_string: connectionString, pool });
      const factory = (tenantId: string) => createTenantSession(pool, tenantId);
      const first = new PostgresRuntimeState(factory, tenantA);
      const second = new PostgresRuntimeState(factory, tenantA);
      const [left, right] = await Promise.all([
        first.acquire("partition:outbox_wakeup:p1", "owner-a", "2026-07-16T00:00:00.000Z", 30),
        second.acquire("partition:outbox_wakeup:p1", "owner-b", "2026-07-16T00:00:00.000Z", 30),
      ]);
      const winner = left ?? right;
      expect([left, right].filter((value) => value !== null)).toHaveLength(1);
      expect(winner).not.toBeNull();

      const hidden = await factory(tenantB).withTransaction((client) =>
        client.query("SELECT lease_key FROM work_fabric_worker_leases WHERE lease_key=$1", [
          "partition:outbox_wakeup:p1",
        ])
      );
      expect(hidden.rows).toEqual([]);

      const replacement = await second.acquire(
        "partition:outbox_wakeup:p1",
        "owner-c",
        "2026-07-16T00:00:31.000Z",
        30,
      );
      expect(replacement?.fencing_token).toBeGreaterThan(
        winner?.fencing_token ?? 0,
      );
    } finally {
      for (const tenantId of [tenantA, tenantB]) {
        await createTenantSession(pool, tenantId).withTransaction((client) =>
          client.query("DELETE FROM work_fabric_worker_leases").then(() => undefined)
        ).catch(() => undefined);
      }
      await pool.end();
    }
  });
});
