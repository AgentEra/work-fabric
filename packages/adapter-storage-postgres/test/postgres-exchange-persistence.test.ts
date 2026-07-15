import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  type AtomicCommitRequest,
  type EventRecord,
} from "@work-fabric/exchange-spi";
import type {
  PostgresClient,
  PostgresQueryResult,
  TenantSession,
} from "@work-fabric/adapter-postgres-common";
import { PostgresExchangePersistence } from "../src/index.js";

const proposed = (id = "event_01") => ({
  event_id: id,
  event_type: "workfabric.test.v1",
  schema_version: "1.0" as const,
  exchange_id: "exchange_01",
  request_message_id: "message_01",
  idempotency_key: "key_01",
  thread_id: "thread_01",
  handoff_id: "handoff_01",
  actor_id: "actor_01",
  endpoint_id: "endpoint_01",
  visibility: "public" as const,
  visible_actor_ids: [],
  visible_endpoint_ids: [],
  occurred_at: "2026-07-15T00:00:00.123456789Z",
  domain_data: { state: "offered" },
  protocol_data: { state: "offered" },
});

const request = (overrides: Partial<AtomicCommitRequest> = {}): AtomicCommitRequest => ({
  tenant_id: "tenant_01",
  partition_id: "partition_01",
  commit_id: "commit_01",
  idempotency_key: "command_01",
  payload_digest: "digest_01",
  request_message_id: "message_01",
  outcome: { operation_status: "accepted", resource: { state: "ok" }, receipt: null, error: null },
  version_checks: [],
  appends: [{ stream_id: "stream_01", expected_version: 0, events: [proposed()] }],
  ...overrides,
});

class FakeClient implements PostgresClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  responses: Array<PostgresQueryResult<Record<string, unknown>>> = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push(values === undefined ? { text } : { text, values });
    return (this.responses.shift() ?? { rows: [], rowCount: 0 }) as PostgresQueryResult<Row>;
  }

  release(): void {}
}

class RecordingSession implements TenantSession {
  readonly tenant_id = "tenant_01";
  readonly markers: string[] = [];
  constructor(readonly client: FakeClient) {}

  async withTransaction<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
    this.markers.push("BEGIN");
    const result = await operation(this.client);
    this.markers.push("COMMIT");
    return result;
  }
}

function persistence(session: RecordingSession): PostgresExchangePersistence {
  return new PostgresExchangePersistence(() => session, "tenant_01");
}

describe("PostgresExchangePersistence", () => {
  it("defines tenant RLS for every authoritative table", async () => {
    const sql = await readFile(new URL("../migrations/002_exchange_authority.sql", import.meta.url), "utf8");
    for (const table of ["work_fabric_events", "work_fabric_commands", "work_fabric_snapshots", "work_fabric_outbox"]) {
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`CREATE POLICY ${table}_tenant_isolation`);
    }
  });

  it("writes event, outbox, and command in one transaction before commit", async () => {
    const client = new FakeClient();
    client.responses = [
      { rows: [], rowCount: 0 },
      { rows: [{ current_version: 0 }], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ];
    const session = new RecordingSession(client);
    const result = await persistence(session).commitAtomically(request());
    expect(result.kind).toBe("committed");
    const eventIndex = client.calls.findIndex(({ text }) => text.startsWith("INSERT INTO work_fabric_events"));
    const outboxIndex = client.calls.findIndex(({ text }) => text.startsWith("INSERT INTO work_fabric_outbox"));
    const commandIndex = client.calls.findIndex(({ text }) => text.startsWith("INSERT INTO work_fabric_commands"));
    expect(eventIndex).toBeGreaterThanOrEqual(0);
    expect(outboxIndex).toBeGreaterThan(eventIndex);
    expect(commandIndex).toBeGreaterThan(outboxIndex);
    expect(session.markers).toEqual(["BEGIN", "COMMIT"]);
  });

  it("replays the same idempotency digest and rejects changed digests", async () => {
    const client = new FakeClient();
    client.responses = [{
      rows: [{
        tenant_id: "tenant_01",
        idempotency_key: "command_01",
        payload_digest: "digest_01",
        first_request_message_id: "message_01",
        outcome: request().outcome,
      }],
      rowCount: 1,
    }];
    const session = new RecordingSession(client);
    await expect(persistence(session).commitAtomically(request())).resolves.toEqual({
      kind: "replayed",
      outcome: request().outcome,
    });
    client.responses = [{ rows: [{
      tenant_id: "tenant_01", idempotency_key: "command_01", payload_digest: "digest_01", first_request_message_id: "message_01", outcome: request().outcome,
    }], rowCount: 1 }];
    await expect(persistence(session).commitAtomically(request({ payload_digest: "other" }))).resolves.toEqual({ kind: "idempotency_key_reused" });
  });

  it("returns exact version conflicts without event/outbox writes", async () => {
    const client = new FakeClient();
    client.responses = [
      { rows: [], rowCount: 0 },
      { rows: [{ current_version: 4 }], rowCount: 1 },
    ];
    const result = await persistence(new RecordingSession(client)).commitAtomically(request());
    expect(result).toEqual({ kind: "version_conflict", current_versions: { stream_01: 4 } });
    expect(client.calls.some(({ text }) => text.startsWith("INSERT INTO"))).toBe(false);
  });

  it("rejects temporarily unavailable outcomes before opening a transaction", async () => {
    const session = new RecordingSession(new FakeClient());
    await expect(persistence(session).commitAtomically(request({
      outcome: { operation_status: "temporarily_unavailable", resource: null, receipt: null, error: { code: "busy" } },
    }))).rejects.toThrow();
    expect(session.markers).toEqual([]);
  });

  it("maps immutable event rows and snapshot JSON", async () => {
    const event: EventRecord = {
      ...proposed(), tenant_id: "tenant_01", partition_id: "partition_01", partition_position: 1,
      stream_id: "stream_01", stream_version: 1, commit_id: "commit_01", commit_ordinal: 0,
    };
    const client = new FakeClient();
    client.responses = [{ rows: [event] as unknown as Record<string, unknown>[], rowCount: 1 }];
    const session = new RecordingSession(client);
    const rows = await persistence(session).readStream("stream_01");
    expect(rows).toEqual([event]);
    (rows[0] as unknown as { domain_data: { state: string } }).domain_data.state = "mutated";
    expect(event.domain_data.state).toBe("offered");
  });

  it("round-trips and deletes tenant snapshots", async () => {
    const snapshot = { stream_id: "stream_01", stream_version: 1, schema_version: "1.0", state: { state: "ok" } };
    const client = new FakeClient();
    const session = new RecordingSession(client);
    await persistence(session).saveSnapshot(snapshot);
    client.responses = [{ rows: [snapshot], rowCount: 1 }];
    await expect(persistence(session).loadSnapshot("stream_01")).resolves.toEqual(snapshot);
    await persistence(session).deleteSnapshot("stream_01");
    expect(client.calls.some(({ text }) => text.startsWith("DELETE FROM work_fabric_snapshots"))).toBe(true);
  });
});
