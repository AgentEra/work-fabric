import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";
import {
  createPgPool,
  createTenantSession,
  runMigrations,
  TENANT_CONTEXT_MIGRATION,
  type PostgresPool,
} from "@work-fabric/adapter-postgres-common";
import type { AtomicCommitRequest } from "@work-fabric/exchange-spi";
import type { TenantSession } from "@work-fabric/adapter-postgres-common";
import { PostgresExchangePersistence } from "../src/index.js";

const connectionString = process.env.PG_TEST_URL;
const live = connectionString !== undefined && connectionString.trim().length > 0;
let pool: PostgresPool | undefined;

const makeRequest = (tenantId: string, suffix: string): AtomicCommitRequest => ({
  tenant_id: tenantId,
  partition_id: `partition_${suffix}`,
  commit_id: `commit_${suffix}`,
  idempotency_key: `key_${suffix}`,
  payload_digest: `digest_${suffix}`,
  request_message_id: `message_${suffix}`,
  outcome: { operation_status: "accepted", resource: { suffix }, receipt: null, error: null },
  version_checks: [],
  appends: [{
    stream_id: `stream_${suffix}`,
    expected_version: 0,
    events: [{
      event_id: `event_${suffix}`,
      event_type: "workfabric.integration.v1",
      schema_version: "1.0",
      exchange_id: `exchange_${suffix}`,
      request_message_id: `message_${suffix}`,
      idempotency_key: `key_${suffix}`,
      thread_id: `thread_${suffix}`,
      handoff_id: `handoff_${suffix}`,
      actor_id: "actor",
      endpoint_id: "endpoint",
      visibility: "tenant",
      visible_actor_ids: [],
      visible_endpoint_ids: [],
      occurred_at: "2026-07-15T00:00:00.123456789Z",
      domain_data: { suffix },
      protocol_data: { suffix },
    }],
  }],
});

afterEach(async () => {
  if (pool !== undefined) await pool.end();
  pool = undefined;
});

describe("PostgreSQL exchange integration", () => {
  it.skipIf(!live)("commits one same-key command and isolates tenants", async () => {
    if (connectionString === undefined) return;
    pool = createPgPool(connectionString);
    const schema = `wf_exchange_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const client = await pool.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const exchangeSql = await readFile(new URL("../migrations/002_exchange_authority.sql", import.meta.url), "utf8");
    await runMigrations(client, [TENANT_CONTEXT_MIGRATION, { id: "002_exchange_authority", sql: exchangeSql }]);
    client.release();

    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const tenant = `tenant_${suffix}`;
    const sessionFactory = (tenantId: string): TenantSession => {
      const base = createTenantSession(pool as PostgresPool, tenantId);
      return {
        tenant_id: base.tenant_id,
        withTransaction: (operation) => base.withTransaction(async (session) => {
          await session.query(`SET LOCAL search_path TO "${schema}"`);
          return operation(session);
        }),
      };
    };
    const persistence = new PostgresExchangePersistence(sessionFactory, tenant);
    const request = makeRequest(tenant, suffix);
    try {
      const [first, second] = await Promise.all([
        persistence.commitAtomically(request),
        persistence.commitAtomically(request),
      ]);
      expect([first.kind, second.kind].sort()).toEqual(["committed", "replayed"]);
      const other = new PostgresExchangePersistence(sessionFactory, `other_${suffix}`);
      const streamId = request.appends[0]?.stream_id;
      if (streamId === undefined) throw new Error("missing integration stream");
      await expect(other.readStream(streamId)).resolves.toEqual([]);
    } finally {
      const cleanup = await pool.connect();
      await cleanup.query(`SET search_path TO "${schema}"`);
      await cleanup.query("DROP TABLE IF EXISTS work_fabric_outbox, work_fabric_events, work_fabric_commands, work_fabric_snapshots, work_fabric_tenant_probe CASCADE");
      await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
      cleanup.release();
    }
  });
});
