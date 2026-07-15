import { afterEach, describe, expect, it } from "vitest";
import { createPgPool, createTenantSession, runMigrations, TENANT_CONTEXT_MIGRATION, type PostgresPool, type TenantSession } from "@work-fabric/adapter-postgres-common";
import { CONTEXT_MIGRATION, PostgresContextRepository } from "../src/index.js";

const connectionString = process.env.PG_TEST_URL;
const live = connectionString !== undefined && connectionString.trim().length > 0;
let pool: PostgresPool | undefined;
afterEach(async () => { if (pool !== undefined) await pool.end(); pool = undefined; });

describe("PostgreSQL context integration", () => {
  it.skipIf(!live)("isolates tenant context metadata with RLS", async () => {
    if (connectionString === undefined) return;
    pool = createPgPool(connectionString);
    const schema = `wf_context_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const setup = await pool.connect(); await setup.query(`CREATE SCHEMA "${schema}"`); await setup.query(`SET search_path TO "${schema}"`); await runMigrations(setup, [TENANT_CONTEXT_MIGRATION, CONTEXT_MIGRATION]); setup.release();
    const sessionFactory = (tenantId: string): TenantSession => { const base = createTenantSession(pool as PostgresPool, tenantId); return { tenant_id: base.tenant_id, withTransaction: (operation) => base.withTransaction(async (client) => { await client.query(`SET LOCAL search_path TO "${schema}"`); return operation(client); }) }; };
    const repository = new PostgresContextRepository(sessionFactory);
    await repository.putBundle("tenant_context", { context_id: "context_01", version: 1, digest: null, visibility_scope: { actor_ids: ["actor_01"], endpoint_ids: [] } });
    await expect(repository.checkAvailability({ tenant_id: "other_tenant", actor_id: "actor_01", endpoint_id: "endpoint_01", reference: { context_id: "context_01", version: 1, digest: null } })).resolves.toMatchObject({ kind: "unavailable" });
    const cleanup = await pool.connect(); await cleanup.query(`SET search_path TO "${schema}"`); await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); cleanup.release();
  });
});
