import type { PostgresClient } from "./postgres-client.js";

export interface MigrationSource {
  readonly id: string;
  readonly sql: string;
}

export const TENANT_CONTEXT_MIGRATION: MigrationSource = {
  id: "001_tenant_context",
  sql: `
CREATE OR REPLACE FUNCTION work_fabric_current_tenant()
RETURNS text
LANGUAGE sql
STABLE
AS $$ SELECT nullif(current_setting('app.tenant_id', true), '') $$;

CREATE TABLE IF NOT EXISTS work_fabric_tenant_probe (
  tenant_id text NOT NULL,
  probe_id text NOT NULL,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, probe_id)
);

ALTER TABLE work_fabric_tenant_probe ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_fabric_tenant_probe_isolation ON work_fabric_tenant_probe;
CREATE POLICY work_fabric_tenant_probe_isolation ON work_fabric_tenant_probe
  USING (tenant_id = work_fabric_current_tenant())
  WITH CHECK (tenant_id = work_fabric_current_tenant());
`,
};

const MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS work_fabric_schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
)
`;

function numericMigrationId(id: string): number {
  const match = /^(\d+)(?:_|$)/.exec(id);
  if (match === null) throw new TypeError(`migration id must start with digits: ${id}`);
  return Number(match[1]);
}

export async function runMigrations(
  client: PostgresClient,
  sources: readonly MigrationSource[],
): Promise<number> {
  const ids = new Set<string>();
  for (const source of sources) {
    if (typeof source.id !== "string" || source.id.trim().length === 0) {
      throw new TypeError("migration id must be non-empty");
    }
    if (ids.has(source.id)) throw new Error(`duplicate migration id: ${source.id}`);
    ids.add(source.id);
    numericMigrationId(source.id);
    if (typeof source.sql !== "string" || source.sql.trim().length === 0) {
      throw new TypeError(`migration SQL must be non-empty: ${source.id}`);
    }
  }

  const ordered = [...sources].sort((left, right) => {
    const numeric = numericMigrationId(left.id) - numericMigrationId(right.id);
    return numeric !== 0 ? numeric : left.id.localeCompare(right.id);
  });
  await client.query(MIGRATION_TABLE_SQL);
  let applied = 0;
  for (const source of ordered) {
    const result = await client.query<{ id: string }>(
      "SELECT id FROM work_fabric_schema_migrations WHERE id = $1",
      [source.id],
    );
    if (result.rows.length > 0) continue;
    await client.query(source.sql);
    await client.query(
      "INSERT INTO work_fabric_schema_migrations (id) VALUES ($1)",
      [source.id],
    );
    applied += 1;
  }
  return applied;
}
