import { describe, expect, it } from "vitest";
import { migratePostgres, orderedMigrations } from "./postgres-migrate.js";
import { runPostgresSmoke } from "./postgres-smoke.js";

describe("PostgreSQL tooling", () => {
  it("orders migrations numerically and supports dry-run without opening a pool", async () => {
    expect(orderedMigrations([{ id: "10_later", sql: "SELECT 1" }, { id: "2_early", sql: "SELECT 1" }]).map((migration) => migration.id)).toEqual(["2_early", "10_later"]);
    await expect(migratePostgres({ connection_string: "postgres://secret", dry_run: true })).resolves.toMatchObject({ migrations: 0 });
  });

  it("rejects missing connection strings before any external call", async () => {
    await expect(migratePostgres({ connection_string: "" })).rejects.toThrow("connection_string");
    await expect(runPostgresSmoke({ connection_string: "", tenant_id: "tenant", verify_rls: false })).rejects.toThrow("connection_string");
  });
});
