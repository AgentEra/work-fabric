import { describe, expect, it } from "vitest";

import type { PostgresClient, PostgresQueryResult, TenantSession } from "@work-fabric/adapter-postgres-common";
import { PostgresRuntimeState } from "../src/index.js";

class FakeClient implements PostgresClient {
  readonly calls: string[] = [];
  responses: Array<PostgresQueryResult<Record<string, unknown>>> = [];
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, _values?: readonly unknown[]): Promise<PostgresQueryResult<Row>> {
    this.calls.push(text);
    return (this.responses.shift() ?? { rows: [], rowCount: 0 }) as PostgresQueryResult<Row>;
  }
  release(): void {}
}

class Session implements TenantSession {
  readonly tenant_id = "tenant_01";
  constructor(readonly client: FakeClient) {}
  withTransaction<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> { return operation(this.client); }
}

describe("PostgresRuntimeState", () => {
  it("enforces checkpoint CAS and tenant binding", async () => {
    const client = new FakeClient();
    client.responses = [{ rows: [{ position: "3" }], rowCount: 1 }, { rows: [], rowCount: 1 }];
    const state = new PostgresRuntimeState(() => new Session(client), "tenant_01");
    await expect(state.loadProjectionCheckpoint("projector", "partition")).resolves.toBe(3);
    await expect(state.advanceProjectionCheckpoint("projector", "partition", 3, 4)).resolves.toBe(true);
    await expect(state.listActiveSubscriptions("other_tenant")).rejects.toThrow("tenant context mismatch");
  });

  it("maps and clones outbox claims", async () => {
    const event = { event_id: "event_01", event_type: "test", schema_version: "1.0", exchange_id: "exchange", request_message_id: "message", idempotency_key: "key", thread_id: "thread", handoff_id: "handoff", actor_id: "actor", endpoint_id: "endpoint", visibility: "public", visible_actor_ids: [], visible_endpoint_ids: [], occurred_at: "2026-07-15T00:00:00.000Z", domain_data: { state: "new" }, protocol_data: { state: "new" }, tenant_id: "tenant_01", partition_id: "partition_01", partition_position: 1, stream_id: "stream", stream_version: 1, commit_id: "commit", commit_ordinal: 0 };
    const client = new FakeClient();
    client.responses = [{ rows: [{ outbox_id: "outbox", tenant_id: "tenant_01", partition_id: "partition_01", position: 1, event, attempt: 0, next_attempt_at: null, lease_owner: null, lease_expires_at: null, fencing_token: 0 }], rowCount: 1 }, { rows: [], rowCount: 1 }];
    const state = new PostgresRuntimeState(() => new Session(client), "tenant_01");
    const rows = await state.claim({ owner: "worker", now: "2026-07-15T00:00:00.000Z", lease_seconds: 10, limit: 1, tenant_id: "tenant_01", partition_id: "partition_01" });
    expect(rows[0]?.fencing_token).toBe(1);
    (rows[0]?.event.domain_data as { state: string }).state = "mutated";
    expect(event.domain_data.state).toBe("new");
  });

  it("uses owner and fencing CAS for worker leases", async () => {
    const client = new FakeClient();
    client.responses = [{ rows: [{ lease_key: "worker", owner: "owner", fencing_token: 2, expires_at: "2026-07-15T00:00:10.000Z" }], rowCount: 1 }, { rows: [], rowCount: 0 }];
    const state = new PostgresRuntimeState(() => new Session(client), "tenant_01");
    await expect(state.acquire("worker", "owner", "2026-07-15T00:00:00.000Z", 10)).resolves.toMatchObject({ fencing_token: 2 });
    await expect(state.release("worker", "owner", 2)).resolves.toBe(false);
  });
});
