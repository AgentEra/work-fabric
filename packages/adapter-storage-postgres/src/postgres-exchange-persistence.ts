import { readFileSync } from "node:fs";
import {
  PERSISTENCE_REQUIRED_CAPABILITIES,
  type AtomicCommitRequest,
  type AtomicCommitResult,
  type CapabilityManifest,
  type CommandRecord,
  type EventRecord,
  type ExchangePersistence,
  type SnapshotRecord,
  type StreamAppend,
  type SnapshotRepository,
} from "@work-fabric/exchange-spi";
import {
  assertCapabilities,
  parseUtcTimestamp,
} from "@work-fabric/exchange-spi";
import type { PostgresClient, TenantSession } from "@work-fabric/adapter-postgres-common";

export const EXCHANGE_AUTHORITY_MIGRATION = {
  id: "002_exchange_authority",
  sql: readFileSync(new URL("../migrations/002_exchange_authority.sql", import.meta.url), "utf8"),
} as const;

const manifest: CapabilityManifest = {
  profile: "exchange.persistence.v1",
  adapter: "postgres",
  capabilities: {
    ...Object.fromEntries(PERSISTENCE_REQUIRED_CAPABILITIES.map((capability) => [capability, true])),
    snapshots: true,
    batch_read: true,
    tenant_isolation: true,
  },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function positiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function nonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function identity(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function jsonValue<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return clone(value as T);
}

function eventFromRow(row: Record<string, unknown>): EventRecord {
  const event = {
    event_id: String(row.event_id),
    event_type: String(row.event_type),
    schema_version: row.schema_version as "1.0",
    exchange_id: String(row.exchange_id),
    request_message_id: String(row.request_message_id),
    idempotency_key: String(row.idempotency_key),
    ...(row.correlation_id === null || row.correlation_id === undefined ? {} : { correlation_id: String(row.correlation_id) }),
    ...(row.causation_id === null || row.causation_id === undefined ? {} : { causation_id: String(row.causation_id) }),
    thread_id: String(row.thread_id),
    handoff_id: String(row.handoff_id),
    actor_id: String(row.actor_id),
    endpoint_id: String(row.endpoint_id),
    visibility: row.visibility as EventRecord["visibility"],
    visible_actor_ids: jsonValue<readonly string[]>(row.visible_actor_ids),
    visible_endpoint_ids: jsonValue<readonly string[]>(row.visible_endpoint_ids),
    occurred_at: String(row.occurred_at),
    domain_data: jsonValue<EventRecord["domain_data"]>(row.domain_data),
    protocol_data: jsonValue<EventRecord["protocol_data"]>(row.protocol_data),
    tenant_id: String(row.tenant_id),
    partition_id: String(row.partition_id),
    partition_position: Number(row.partition_position),
    stream_id: String(row.stream_id),
    stream_version: Number(row.stream_version),
    commit_id: String(row.commit_id),
    commit_ordinal: Number(row.commit_ordinal),
  } satisfies EventRecord;
  parseUtcTimestamp(event.occurred_at, "event.occurred_at");
  positiveInteger(event.partition_position, "partition_position");
  positiveInteger(event.stream_version, "stream_version");
  nonNegativeInteger(event.commit_ordinal, "commit_ordinal");
  return clone(event);
}

function commandFromRow(row: Record<string, unknown>): CommandRecord {
  return {
    tenant_id: String(row.tenant_id),
    idempotency_key: String(row.idempotency_key),
    payload_digest: String(row.payload_digest),
    first_request_message_id: String(row.first_request_message_id),
    outcome: jsonValue(row.outcome),
  };
}

function validateRequest(request: AtomicCommitRequest): void {
  identity(request.tenant_id, "tenant_id");
  identity(request.partition_id, "partition_id");
  identity(request.commit_id, "commit_id");
  identity(request.idempotency_key, "idempotency_key");
  identity(request.payload_digest, "payload_digest");
  identity(request.request_message_id, "request_message_id");
  if (request.outcome.operation_status === "temporarily_unavailable") {
    throw new Error("temporarily_unavailable outcomes cannot be persisted");
  }
  const streams = new Set<string>();
  const events = new Set<string>();
  for (const append of request.appends) {
    identity(append.stream_id, "stream_id");
    nonNegativeInteger(append.expected_version, "expected_version");
    if (streams.has(append.stream_id)) throw new Error(`duplicate stream ID: ${append.stream_id}`);
    streams.add(append.stream_id);
    if (append.events.length === 0) throw new Error(`stream append ${append.stream_id} must contain an event`);
    for (const event of append.events) {
      identity(event.event_id, "event_id");
      parseUtcTimestamp(event.occurred_at, "occurred_at");
      if (events.has(event.event_id)) throw new Error(`duplicate event ID: ${event.event_id}`);
      events.add(event.event_id);
    }
  }
  const checked = new Set<string>();
  for (const check of request.version_checks) {
    identity(check.stream_id, "stream_id");
    nonNegativeInteger(check.expected_version, "expected_version");
    if (checked.has(check.stream_id) || streams.has(check.stream_id)) {
      throw new Error(`duplicate or overlapping stream version check: ${check.stream_id}`);
    }
    checked.add(check.stream_id);
  }
}

async function currentVersion(client: PostgresClient, tenantId: string, streamId: string): Promise<number> {
  const result = await client.query<{ current_version: number | string | null }>(
    "SELECT COALESCE(MAX(stream_version), 0) AS current_version FROM work_fabric_events WHERE tenant_id = $1 AND stream_id = $2",
    [tenantId, streamId],
  );
  return Number(result.rows[0]?.current_version ?? 0);
}

export class PostgresExchangePersistence implements ExchangePersistence, SnapshotRepository {
  readonly manifest = clone(manifest);
  private tenantContext: string | undefined;

  constructor(
    private readonly sessionFactory: (tenantId: string) => TenantSession,
    snapshotTenantId?: string,
  ) {
    assertCapabilities(this.manifest, PERSISTENCE_REQUIRED_CAPABILITIES);
    if (snapshotTenantId !== undefined) {
      identity(snapshotTenantId, "tenantId");
      this.tenantContext = snapshotTenantId;
    }
  }

  private readTenant(): string {
    if (this.tenantContext === undefined) {
      throw new Error("tenant context is required before journal or snapshot reads");
    }
    return this.tenantContext;
  }

  async commitAtomically(request: AtomicCommitRequest): Promise<AtomicCommitResult> {
    validateRequest(request);
    if (this.tenantContext === undefined) this.tenantContext = request.tenant_id;
    if (this.tenantContext !== request.tenant_id) {
      throw new Error("a persistence instance cannot be used across tenant contexts");
    }
    const result = await this.sessionFactory(request.tenant_id).withTransaction(async (client) => {
      // Serialize same-key commands even when the command row does not yet
      // exist; a row-level FOR UPDATE cannot lock a missing key.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
        [request.tenant_id, `command:${request.idempotency_key}`],
      );
      const existing = await client.query<Record<string, unknown>>(
        "SELECT tenant_id, idempotency_key, payload_digest, first_request_message_id, outcome FROM work_fabric_commands WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE",
        [request.tenant_id, request.idempotency_key],
      );
      const command = existing.rows[0];
      if (command !== undefined) {
        const record = commandFromRow(command);
        return record.payload_digest === request.payload_digest
          ? ({ kind: "replayed", outcome: clone(record.outcome) } satisfies AtomicCommitResult)
          : ({ kind: "idempotency_key_reused" } satisfies AtomicCommitResult);
      }

      const checks = new Map<string, number>();
      const streamIds = [...new Set([
        ...request.version_checks.map((check) => check.stream_id),
        ...request.appends.map((append) => append.stream_id),
      ])].sort();
      for (const streamId of streamIds) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
          [request.tenant_id, `stream:${streamId}`],
        );
        checks.set(streamId, await currentVersion(client, request.tenant_id, streamId));
      }
      const conflicts = [...request.version_checks, ...request.appends].filter(
        (check) => checks.get(check.stream_id) !== check.expected_version,
      );
      if (conflicts.length > 0) {
        return {
          kind: "version_conflict",
          current_versions: Object.fromEntries(checks),
        } satisfies AtomicCommitResult;
      }

      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
        [request.tenant_id, `partition:${request.partition_id}`],
      );

      const partition = await client.query<{ current_position: number | string | null }>(
        "SELECT partition_position AS current_position FROM work_fabric_events WHERE tenant_id = $1 AND partition_id = $2 ORDER BY partition_position DESC LIMIT 1 FOR UPDATE",
        [request.tenant_id, request.partition_id],
      );
      let partitionPosition = Number(partition.rows[0]?.current_position ?? 0) + 1;
      let ordinal = 0;
      const committed: EventRecord[] = [];
      for (const append of request.appends) {
        let streamVersion = (checks.get(append.stream_id) ?? 0) + 1;
        for (const proposed of append.events) {
          const event: EventRecord = {
            ...clone(proposed),
            tenant_id: request.tenant_id,
            partition_id: request.partition_id,
            partition_position: partitionPosition,
            stream_id: append.stream_id,
            stream_version: streamVersion,
            commit_id: request.commit_id,
            commit_ordinal: ordinal,
          };
          await client.query(
            "INSERT INTO work_fabric_events (tenant_id, event_id, event_type, schema_version, exchange_id, request_message_id, idempotency_key, correlation_id, causation_id, thread_id, handoff_id, actor_id, endpoint_id, visibility, visible_actor_ids, visible_endpoint_ids, occurred_at, domain_data, protocol_data, partition_id, partition_position, stream_id, stream_version, commit_id, commit_ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18::jsonb,$19::jsonb,$20,$21,$22,$23,$24,$25)",
            [event.tenant_id, event.event_id, event.event_type, event.schema_version, event.exchange_id, event.request_message_id, event.idempotency_key, event.correlation_id ?? null, event.causation_id ?? null, event.thread_id, event.handoff_id, event.actor_id, event.endpoint_id, event.visibility, JSON.stringify(event.visible_actor_ids), JSON.stringify(event.visible_endpoint_ids), event.occurred_at, JSON.stringify(event.domain_data), JSON.stringify(event.protocol_data), event.partition_id, event.partition_position, event.stream_id, event.stream_version, event.commit_id, event.commit_ordinal],
          );
          await client.query(
            "INSERT INTO work_fabric_outbox (tenant_id, outbox_id, partition_id, position, event) VALUES ($1,$2,$3,$4,$5::jsonb)",
            [event.tenant_id, event.event_id, event.partition_id, event.partition_position, JSON.stringify(event)],
          );
          committed.push(event);
          partitionPosition += 1;
          streamVersion += 1;
          ordinal += 1;
        }
      }
      await client.query(
        "INSERT INTO work_fabric_commands (tenant_id, idempotency_key, payload_digest, first_request_message_id, outcome) VALUES ($1,$2,$3,$4,$5::jsonb)",
        [request.tenant_id, request.idempotency_key, request.payload_digest, request.request_message_id, JSON.stringify(request.outcome)],
      );
      return { kind: "committed", events: clone(committed) } satisfies AtomicCommitResult;
    });
    return clone(result);
  }

  async readStream(streamId: string, fromVersion = 0): Promise<readonly EventRecord[]> {
    identity(streamId, "streamId");
    nonNegativeInteger(fromVersion, "fromVersion");
    const tenantId = this.readTenant();
    return this.sessionFactory(tenantId).withTransaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        "SELECT * FROM work_fabric_events WHERE tenant_id = $1 AND stream_id = $2 AND stream_version >= $3 ORDER BY stream_version",
        [tenantId, streamId, fromVersion],
      );
      return result.rows.map(eventFromRow);
    });
  }

  async readPartition(partitionId: string, afterPosition = 0, limit = 100): Promise<readonly EventRecord[]> {
    identity(partitionId, "partitionId");
    nonNegativeInteger(afterPosition, "afterPosition");
    positiveInteger(limit, "limit");
    const tenantId = this.readTenant();
    return this.sessionFactory(tenantId).withTransaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        "SELECT * FROM work_fabric_events WHERE tenant_id = $1 AND partition_id = $2 AND partition_position > $3 ORDER BY partition_position LIMIT $4",
        [tenantId, partitionId, afterPosition, limit],
      );
      return result.rows.map(eventFromRow);
    });
  }

  async findCommand(tenantId: string, idempotencyKey: string): Promise<CommandRecord | null> {
    identity(tenantId, "tenantId");
    identity(idempotencyKey, "idempotencyKey");
    return this.sessionFactory(tenantId).withTransaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        "SELECT tenant_id, idempotency_key, payload_digest, first_request_message_id, outcome FROM work_fabric_commands WHERE tenant_id = $1 AND idempotency_key = $2",
        [tenantId, idempotencyKey],
      );
      return result.rows[0] === undefined ? null : clone(commandFromRow(result.rows[0]));
    });
  }

  async loadSnapshot(streamId: string): Promise<SnapshotRecord | null> {
    identity(streamId, "streamId");
    const tenantId = this.readTenant();
    return this.sessionFactory(tenantId).withTransaction(async (client) => {
      const result = await client.query<Record<string, unknown>>(
        "SELECT stream_id, stream_version, schema_version, state FROM work_fabric_snapshots WHERE tenant_id = $1 AND stream_id = $2",
        [tenantId, streamId],
      );
      const row = result.rows[0];
      return row === undefined ? null : clone({
        stream_id: String(row.stream_id),
        stream_version: Number(row.stream_version),
        schema_version: String(row.schema_version),
        state: jsonValue(row.state),
      });
    });
  }

  async saveSnapshot(snapshot: SnapshotRecord): Promise<void> {
    identity(snapshot.stream_id, "stream_id");
    nonNegativeInteger(snapshot.stream_version, "stream_version");
    identity(snapshot.schema_version, "schema_version");
    const tenantId = this.readTenant();
    await this.sessionFactory(tenantId).withTransaction(async (client) => {
      await client.query(
        "INSERT INTO work_fabric_snapshots (tenant_id, stream_id, stream_version, schema_version, state) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (tenant_id, stream_id) DO UPDATE SET stream_version = EXCLUDED.stream_version, schema_version = EXCLUDED.schema_version, state = EXCLUDED.state",
        [tenantId, snapshot.stream_id, snapshot.stream_version, snapshot.schema_version, JSON.stringify(snapshot.state)],
      );
    });
  }

  async deleteSnapshot(streamId: string): Promise<void> {
    identity(streamId, "streamId");
    const tenantId = this.readTenant();
    await this.sessionFactory(tenantId).withTransaction(async (client) => {
      await client.query("DELETE FROM work_fabric_snapshots WHERE tenant_id = $1 AND stream_id = $2", [tenantId, streamId]);
    });
  }
}
