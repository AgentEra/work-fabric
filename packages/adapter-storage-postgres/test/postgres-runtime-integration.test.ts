import { afterEach, describe, expect, it } from "vitest";
import {
  createPgPool,
  createTenantSession,
  runMigrations,
  TENANT_CONTEXT_MIGRATION,
  type PostgresPool,
  type TenantSession,
} from "@work-fabric/adapter-postgres-common";
import { EXCHANGE_AUTHORITY_MIGRATION, PostgresRuntimeState, RUNTIME_STATE_HARDENING_MIGRATION, RUNTIME_STATE_MIGRATION } from "../src/index.js";
import type { EventRecord } from "@work-fabric/exchange-spi";

const connectionString = process.env.PG_TEST_URL;
const live = connectionString !== undefined && connectionString.trim().length > 0;
let pool: PostgresPool | undefined;

afterEach(async () => { if (pool !== undefined) await pool.end(); pool = undefined; });

describe("PostgreSQL runtime-state integration", () => {
  it.skipIf(!live)("enforces tenant isolation and atomic delivery settlement", async () => {
    if (connectionString === undefined) return;
    pool = createPgPool(connectionString);
    const schema = `wf_runtime_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const setup = await pool.connect();
    await setup.query(`CREATE SCHEMA "${schema}"`);
    await setup.query(`SET search_path TO "${schema}"`);
    await runMigrations(setup, [TENANT_CONTEXT_MIGRATION, EXCHANGE_AUTHORITY_MIGRATION, RUNTIME_STATE_MIGRATION, RUNTIME_STATE_HARDENING_MIGRATION]);
    setup.release();
    const sessionFactory = (tenantId: string): TenantSession => {
      const base = createTenantSession(pool as PostgresPool, tenantId);
      return { tenant_id: base.tenant_id, withTransaction: (operation) => base.withTransaction(async (client) => { await client.query(`SET LOCAL search_path TO "${schema}"`); return operation(client); }) };
    };
    const event: EventRecord = { event_id: "event_runtime", event_type: "workfabric.runtime.v1", schema_version: "1.0", tenant_id: "tenant_runtime", exchange_id: "exchange_runtime", request_message_id: "message_runtime", idempotency_key: "key_runtime", thread_id: "thread_runtime", handoff_id: "handoff_runtime", actor_id: "actor_runtime", endpoint_id: "endpoint_runtime", visibility: "tenant", visible_actor_ids: [], visible_endpoint_ids: [], occurred_at: "2026-07-15T00:00:00.000000001Z", domain_data: {}, protocol_data: {}, partition_id: "partition_runtime", partition_position: 1, stream_id: "stream_runtime", stream_version: 1, commit_id: "commit_runtime", commit_ordinal: 0 };
    const delivery = { delivery_id: "delivery_runtime", subscription_id: "subscription_runtime", partition_id: "partition_runtime", from_position: 0, to_position: 1, next_cursor: "cursor", events: [event], attempt: 1, delivered_at: "2026-07-15T00:00:00.000000001Z", visibility_expires_at: "2026-07-15T00:01:00.000000001Z", outcome: "pending" as const };
    try {
      const state = new PostgresRuntimeState(sessionFactory, "tenant_runtime");
      await expect(state.claimPendingDelivery(delivery, null)).resolves.toMatchObject({ kind: "claimed" });
      await expect(state.settleDelivery(delivery.delivery_id, "pending", { outcome: "rejected", settled_at: "2026-07-15T00:02:00.000000001Z", reason: "integration" })).resolves.toMatchObject({ kind: "completed" });
      await expect(state.getActiveDelivery(delivery.subscription_id, delivery.partition_id)).resolves.toBeNull();
      const other = new PostgresRuntimeState(sessionFactory, "tenant_other");
      await expect(other.getDelivery(delivery.delivery_id)).resolves.toBeNull();
    } finally {
      const cleanup = await pool.connect();
      await cleanup.query(`SET search_path TO "${schema}"`);
      await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
      cleanup.release();
    }
  });
});
