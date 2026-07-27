import { createPgPool, runMigrations, TENANT_CONTEXT_MIGRATION, type MigrationSource, type PostgresPool } from "@work-fabric/adapter-postgres-common";
import { CHANNEL_ROUTES_MIGRATION, CLAIM_POOL_INDEX_MIGRATION, CLUSTER_RUNTIME_MIGRATION, CONNECTOR_INGRESS_HARDENING_MIGRATION, CONNECTOR_INGRESS_MIGRATION, ENDPOINT_BOUNDARY_MIGRATION, ENDPOINT_INBOX_PROJECTION_MIGRATION, EXCHANGE_AUTHORITY_MIGRATION, OPERABILITY_MIGRATION, RUNTIME_STATE_HARDENING_MIGRATION, RUNTIME_STATE_MIGRATION } from "@work-fabric/adapter-storage-postgres";
import { CONTEXT_MIGRATION } from "@work-fabric/adapter-context-postgres";
import { POSTGRES_ADMISSION_MIGRATION } from "@work-fabric/adapter-admission-postgres";

export const POSTGRES_MIGRATIONS: readonly MigrationSource[] = [
  TENANT_CONTEXT_MIGRATION,
  EXCHANGE_AUTHORITY_MIGRATION,
  RUNTIME_STATE_MIGRATION,
  RUNTIME_STATE_HARDENING_MIGRATION,
  CONTEXT_MIGRATION,
  ENDPOINT_BOUNDARY_MIGRATION,
  CONNECTOR_INGRESS_MIGRATION,
  CONNECTOR_INGRESS_HARDENING_MIGRATION,
  OPERABILITY_MIGRATION,
  CLUSTER_RUNTIME_MIGRATION,
  CHANNEL_ROUTES_MIGRATION,
  ENDPOINT_INBOX_PROJECTION_MIGRATION,
  CLAIM_POOL_INDEX_MIGRATION,
  POSTGRES_ADMISSION_MIGRATION,
];

export interface PostgresMigrateOptions { readonly connection_string: string; readonly dry_run?: boolean; readonly pool?: PostgresPool; }

export function orderedMigrations(sources: readonly MigrationSource[] = POSTGRES_MIGRATIONS): readonly MigrationSource[] {
  return [...sources].sort((left, right) => { const leftNumber = Number(/^\d+/.exec(left.id)?.[0] ?? -1); const rightNumber = Number(/^\d+/.exec(right.id)?.[0] ?? -1); return leftNumber - rightNumber || left.id.localeCompare(right.id); });
}

export async function migratePostgres(options: PostgresMigrateOptions): Promise<{ readonly migrations: number; readonly ordered_ids: readonly string[] }> {
  if (typeof options.connection_string !== "string" || options.connection_string.trim().length === 0) throw new TypeError("connection_string must be non-empty");
  const ordered = orderedMigrations();
  if (options.dry_run) return { migrations: 0, ordered_ids: ordered.map((source) => source.id) };
  const pool = options.pool ?? createPgPool(options.connection_string);
  try { const client = await pool.connect(); try { const migrations = await runMigrations(client, ordered); return { migrations, ordered_ids: ordered.map((source) => source.id) }; } finally { client.release(); } } finally { if (options.pool === undefined) await pool.end(); }
}

function cliArgs(argv: readonly string[]): { connection: string | undefined; dryRun: boolean } { const connectionIndex = argv.indexOf("--connection-string"); return { connection: connectionIndex >= 0 ? argv[connectionIndex + 1] : process.env.PG_TEST_URL, dryRun: argv.includes("--dry-run") }; }

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = cliArgs(process.argv.slice(2));
  if (args.connection === undefined) throw new Error("provide --connection-string or PG_TEST_URL");
  migratePostgres({ connection_string: args.connection, dry_run: args.dryRun }).then((result) => { process.stdout.write(`${args.dryRun ? "planned" : "applied"} ${result.migrations} migrations\n`); }).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
