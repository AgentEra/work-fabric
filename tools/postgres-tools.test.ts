import { describe, expect, it } from "vitest";
import { createPgPool, createTenantSession } from "@work-fabric/adapter-postgres-common";
import { migratePostgres, orderedMigrations } from "./postgres-migrate.js";
import { runPostgresSmoke } from "./postgres-smoke.js";

const connectionString = process.env.PG_TEST_URL;
const live = connectionString !== undefined && connectionString.trim().length > 0;

describe("PostgreSQL tooling", () => {
  it("orders migrations numerically and supports dry-run without opening a pool", async () => {
    expect(orderedMigrations([{ id: "10_later", sql: "SELECT 1" }, { id: "2_early", sql: "SELECT 1" }]).map((migration) => migration.id)).toEqual(["2_early", "10_later"]);
    await expect(migratePostgres({ connection_string: "postgres://secret", dry_run: true })).resolves.toMatchObject({ migrations: 0 });
  });

  it("rejects missing connection strings before any external call", async () => {
    await expect(migratePostgres({ connection_string: "" })).rejects.toThrow("connection_string");
    await expect(runPostgresSmoke({ connection_string: "", tenant_id: "tenant", verify_rls: false })).rejects.toThrow("connection_string");
  });

  it.skipIf(!live)("can repeat the tenant RLS smoke check without retaining probe rows", async () => {
    if (connectionString === undefined) return;
    const tenantId = `postgres_tools_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    await expect(runPostgresSmoke({ connection_string: connectionString, tenant_id: tenantId, verify_rls: true })).resolves.toBeDefined();
    const pool = createPgPool(connectionString);
    try {
      const retained = await createTenantSession(pool, tenantId).withTransaction((client) => client.query("SELECT probe_id FROM work_fabric_tenant_probe WHERE probe_id=$1", ["postgres-smoke"]));
      expect(retained.rows).toEqual([]);
    } finally {
      await pool.end();
    }
    await expect(runPostgresSmoke({ connection_string: connectionString, tenant_id: tenantId, verify_rls: true })).resolves.toBeDefined();
  });
});
