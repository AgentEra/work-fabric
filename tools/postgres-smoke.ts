import { createPgPool, createTenantSession, type PostgresPool } from "@work-fabric/adapter-postgres-common";
import { migratePostgres } from "./postgres-migrate.js";

export interface PostgresSmokeOptions { readonly connection_string: string; readonly tenant_id: string; readonly verify_rls: boolean; readonly pool?: PostgresPool; }

export async function runPostgresSmoke(options: PostgresSmokeOptions): Promise<{ readonly migrations: number; readonly profiles: readonly string[] }> {
  if (typeof options.connection_string !== "string" || options.connection_string.trim().length === 0) throw new TypeError("connection_string must be non-empty");
  if (typeof options.tenant_id !== "string" || options.tenant_id.trim().length === 0) throw new TypeError("tenant_id must be non-empty");
  const pool = options.pool ?? createPgPool(options.connection_string);
  try {
    const migration = await migratePostgres({ connection_string: options.connection_string, pool });
    if (options.verify_rls) {
      const owner = createTenantSession(pool, options.tenant_id);
      const probeId = "postgres-smoke";
      try {
        await owner.withTransaction((client) => client.query("INSERT INTO work_fabric_tenant_probe (tenant_id,probe_id,value) VALUES ($1,$2,$3::jsonb) ON CONFLICT (tenant_id,probe_id) DO UPDATE SET value=EXCLUDED.value", [options.tenant_id, probeId, JSON.stringify({ ok: true })]).then(() => undefined));
        const other = createTenantSession(pool, `${options.tenant_id}-other`);
        const visible = await other.withTransaction((client) => client.query("SELECT probe_id FROM work_fabric_tenant_probe WHERE probe_id=$1", [probeId]));
        if (visible.rows.length !== 0) throw new Error("tenant RLS smoke check failed");
      } finally {
        await owner.withTransaction((client) => client.query("DELETE FROM work_fabric_tenant_probe WHERE tenant_id=$1 AND probe_id=$2", [options.tenant_id, probeId]).then(() => undefined));
      }
    }
    return { migrations: migration.migrations, profiles: ["exchange.durability.v1", "exchange.projection.v1", "exchange.subscription.v1", "exchange.persistence.v1", "exchange.context.v1", "connector.ingress.v1", "workfabric.collaboration-view.v1", "workfabric.operation-audit.v1", "workfabric.recovery-request.v1", "workfabric.connector-discrepancy.v1"] };
  } finally { if (options.pool === undefined) await pool.end(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const connection = process.env.PG_TEST_URL;
  if (connection === undefined) throw new Error("provide PG_TEST_URL");
  runPostgresSmoke({ connection_string: connection, tenant_id: "postgres-smoke", verify_rls: true }).then((result) => process.stdout.write(`smoke passed; ${result.migrations} migrations\n`)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
