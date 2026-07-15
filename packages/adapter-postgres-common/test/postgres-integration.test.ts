import { afterEach, describe, expect, it } from "vitest";

import {
  createPgPool,
  createTenantSession,
  runMigrations,
  TENANT_CONTEXT_MIGRATION,
  type PostgresClient,
  type PostgresPool,
} from "../src/index.js";

const connectionString = process.env.PG_TEST_URL;
const live = connectionString !== undefined && connectionString.trim().length > 0;
let pool: PostgresPool | undefined;

afterEach(async () => {
  if (pool !== undefined) await pool.end();
  pool = undefined;
});

describe("PostgreSQL tenant RLS integration", () => {
  it.skipIf(!live)("isolates reads and writes between tenant sessions", async () => {
    if (connectionString === undefined) return;
    pool = createPgPool(connectionString);
    const schema = `wf_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const client = await pool.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await runMigrations(client, [TENANT_CONTEXT_MIGRATION]);
    client.release();

    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const probeId = `integration_${suffix}`;
    const tenantA = createTenantSession(pool, `tenant_a_${suffix}`);
    const tenantB = createTenantSession(pool, `tenant_b_${suffix}`);
    const useSchema = async (session: PostgresClient) => {
      await session.query(`SET LOCAL search_path TO "${schema}"`);
    };
    try {
      await tenantA.withTransaction(async (session) => {
        await useSchema(session);
        await session.query(
          "INSERT INTO work_fabric_tenant_probe (tenant_id, probe_id, value) VALUES ($1, $2, $3::jsonb)",
          [tenantA.tenant_id, probeId, JSON.stringify({ owner: "a" })],
        );
      });
      const before = await tenantB.withTransaction((session) =>
        useSchema(session).then(() =>
          session.query("SELECT tenant_id FROM work_fabric_tenant_probe WHERE probe_id = $1", [probeId]),
        ),
      );
      expect(before.rows).toEqual([]);
      await expect(
        tenantB.withTransaction(async (session) => {
          await useSchema(session);
          await session.query(
            "INSERT INTO work_fabric_tenant_probe (tenant_id, probe_id, value) VALUES ($1, $2, $3::jsonb)",
            [tenantA.tenant_id, `${probeId}_cross_write`, JSON.stringify({ owner: "b" })],
          );
        }),
      ).rejects.toThrow();
      await tenantB.withTransaction(async (session) => {
        await useSchema(session);
        await session.query(
          "INSERT INTO work_fabric_tenant_probe (tenant_id, probe_id, value) VALUES ($1, $2, $3::jsonb)",
          [tenantB.tenant_id, probeId, JSON.stringify({ owner: "b" })],
        );
      });
      const ownRows = await tenantA.withTransaction((session) =>
        useSchema(session).then(() =>
          session.query<{ tenant_id: string }>(
            "SELECT tenant_id FROM work_fabric_tenant_probe WHERE probe_id = $1 ORDER BY tenant_id",
            [probeId],
          ),
        ),
      );
      expect(ownRows.rows).toEqual([{ tenant_id: tenantA.tenant_id }]);
    } finally {
      await tenantA.withTransaction((session) =>
        useSchema(session).then(() =>
          session.query("DELETE FROM work_fabric_tenant_probe WHERE probe_id LIKE $1", [`${probeId}%`]),
        ),
      );
      await tenantB.withTransaction((session) =>
        useSchema(session).then(() =>
          session.query("DELETE FROM work_fabric_tenant_probe WHERE probe_id LIKE $1", [`${probeId}%`]),
        ),
      );
      const cleanup = await pool.connect();
      await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
      cleanup.release();
    }
  });
});
