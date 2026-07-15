import { describe, expect, it } from "vitest";

import { runMigrations, type MigrationSource, type PostgresClient } from "../src/index.js";
import { TENANT_CONTEXT_MIGRATION } from "../src/migrations.js";

class MigrationClient implements PostgresClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  readonly applied = new Set<string>();

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: readonly Row[]; rowCount: number }> {
    this.calls.push(values === undefined ? { text } : { text, values });
    if (text.startsWith("SELECT id FROM work_fabric_schema_migrations")) {
      const id = String(values?.[0]);
      return {
        rows: (this.applied.has(id) ? [{ id }] : []) as unknown as Row[],
        rowCount: this.applied.has(id) ? 1 : 0,
      };
    }
    if (text.startsWith("INSERT INTO work_fabric_schema_migrations")) {
      this.applied.add(String(values?.[0]));
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {}
}

const source = (id: string, sql: string): MigrationSource => ({ id, sql });

describe("migration runner", () => {
  it("orders numeric migration IDs and records applied sources", async () => {
    const client = new MigrationClient();
    const applied = await runMigrations(client, [
      source("10_later", "CREATE TABLE later_probe (id integer);"),
      source("2_middle", "CREATE TABLE middle_probe (id integer);"),
      source("001_first", "CREATE TABLE first_probe (id integer);"),
    ]);

    expect(applied).toBe(3);
    const migrationSql = client.calls
      .map(({ text }) => text)
      .filter((text) => text.startsWith("CREATE TABLE"));
    expect(migrationSql).toEqual([
      "CREATE TABLE first_probe (id integer);",
      "CREATE TABLE middle_probe (id integer);",
      "CREATE TABLE later_probe (id integer);",
    ]);
    expect(client.applied).toEqual(new Set(["001_first", "2_middle", "10_later"]));
  });

  it("skips already applied sources and rejects duplicate IDs", async () => {
    const client = new MigrationClient();
    client.applied.add("001_first");
    await expect(runMigrations(client, [source("001_first", "CREATE TABLE should_not_run;")])).resolves.toBe(0);
    expect(client.calls.some(({ text }) => text.includes("should_not_run"))).toBe(false);
    await expect(
      runMigrations(client, [source("001_first", "a"), source("001_first", "b")]),
    ).rejects.toThrow("duplicate migration id");
  });

  it("ships a static tenant-context and fail-closed RLS migration", () => {
    expect(TENANT_CONTEXT_MIGRATION.id).toBe("001_tenant_context");
    expect(TENANT_CONTEXT_MIGRATION.sql).toContain("current_setting('app.tenant_id', true)");
    expect(TENANT_CONTEXT_MIGRATION.sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(TENANT_CONTEXT_MIGRATION.sql).toContain("FORCE ROW LEVEL SECURITY");
    expect(TENANT_CONTEXT_MIGRATION.sql).toContain("CREATE POLICY");
    expect(TENANT_CONTEXT_MIGRATION.sql).toContain(
      "nullif(current_setting('app.tenant_id', true), '')",
    );
    expect(TENANT_CONTEXT_MIGRATION.sql).toContain(
      "USING (tenant_id = work_fabric_current_tenant())",
    );
    expect(TENANT_CONTEXT_MIGRATION.sql).toContain(
      "WITH CHECK (tenant_id = work_fabric_current_tenant())",
    );
  });
});
