import { isDeepStrictEqual } from "node:util";

import {
  PERSISTENCE_REQUIRED_CAPABILITIES,
  compareUtcTimestamps,
  parseUtcTimestamp,
  type AtomicCommitRequest,
  type AtomicCommitResult,
  type CapabilityManifest,
  type CommandRecord,
  type DeadLetterRecord,
  type DeliveryAttempt,
  type DeliveryClaimResult,
  type DeliverySettlement,
  type DeliverySettlementResult,
  type DeliveryStateStore,
  type EventRecord,
  type ExchangePersistence,
  type PendingDeliveryRecord,
  type ProjectionCheckpointStore,
  type ProjectionFailureRecord,
  type ProjectionFailureStore,
  type SnapshotRecord,
} from "@work-fabric/exchange-spi";
import type { BoundedOperationalHistoryStore } from "@work-fabric/operations-spi";

import type { SqliteSession } from "./sqlite-session.js";

const manifest: CapabilityManifest = {
  profile: "exchange.persistence.v1",
  adapter: "sqlite",
  capabilities: {
    ...Object.fromEntries(
      PERSISTENCE_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
    ),
    snapshots: true,
    batch_read: true,
    tenant_isolation: true,
    local_file_durability: true,
    single_process_writer: true,
    clustered_claims: false,
  },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function identity(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
}

function nonNegative(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function positive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function scanLimit(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 1_001) {
    throw new RangeError("scan limit must be between 1 and 1001");
  }
}

function timestamp(value: string, label: string): void {
  parseUtcTimestamp(value, label);
}

function boundedReason(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new TypeError(`${label} must contain 1 to 512 characters`);
  }
}

function cursor(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new TypeError(`${label} must contain 1 to 2048 characters`);
  }
}

function parseJson<T>(value: unknown): T {
  if (typeof value !== "string") throw new Error("SQLite JSON column is invalid");
  return JSON.parse(value) as T;
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
  const appended = new Set<string>();
  const checked = new Set<string>();
  const eventIds = new Set<string>();
  for (const append of request.appends) {
    identity(append.stream_id, "stream_id");
    nonNegative(append.expected_version, "expected_version");
    if (appended.has(append.stream_id)) throw new Error("duplicate stream append");
    if (append.events.length === 0) throw new Error("stream append requires events");
    appended.add(append.stream_id);
    for (const event of append.events) {
      identity(event.event_id, "event_id");
      identity(event.handoff_id, "handoff_id");
      identity(event.thread_id, "thread_id");
      timestamp(event.occurred_at, "occurred_at");
      if (eventIds.has(event.event_id)) throw new Error("duplicate event ID");
      eventIds.add(event.event_id);
    }
  }
  for (const check of request.version_checks) {
    identity(check.stream_id, "version check stream_id");
    nonNegative(check.expected_version, "version check expected_version");
    if (checked.has(check.stream_id)) throw new Error("duplicate stream version check");
    if (appended.has(check.stream_id)) {
      throw new Error("stream version check overlaps stream append");
    }
    checked.add(check.stream_id);
  }
}

function validateEvent(event: EventRecord): void {
  identity(event.event_id, "event_id");
  identity(event.tenant_id, "event tenant_id");
  identity(event.partition_id, "event partition_id");
  positive(event.partition_position, "event partition_position");
  positive(event.stream_version, "event stream_version");
  nonNegative(event.commit_ordinal, "event commit_ordinal");
  timestamp(event.occurred_at, "event occurred_at");
}

function validateAttempt(attempt: DeliveryAttempt): void {
  identity(attempt.subscription_id, "attempt subscription_id");
  identity(attempt.partition_id, "attempt partition_id");
  identity(attempt.event_id, "attempt event_id");
  positive(attempt.attempt, "attempt");
  timestamp(attempt.attempted_at, "attempted_at");
  if (![
    "accepted",
    "retryable_failure",
    "permanent_failure",
  ].includes(attempt.outcome)) throw new TypeError("attempt outcome is invalid");
  if (attempt.outcome === "accepted") {
    if (attempt.detail !== null || attempt.next_attempt_at !== null) {
      throw new TypeError("accepted attempt cannot contain failure detail");
    }
    return;
  }
  boundedReason(attempt.detail, "attempt detail");
  if (attempt.outcome === "permanent_failure" && attempt.next_attempt_at !== null) {
    throw new TypeError("permanent failure cannot be retried");
  }
  if (attempt.next_attempt_at !== null) {
    timestamp(attempt.next_attempt_at, "next_attempt_at");
    if (compareUtcTimestamps(attempt.next_attempt_at, attempt.attempted_at) <= 0) {
      throw new RangeError("next_attempt_at must be after attempted_at");
    }
  }
}

function validateDeadLetter(record: DeadLetterRecord): void {
  identity(record.subscription_id, "dead-letter subscription_id");
  validateEvent(record.event);
  positive(record.attempts, "dead-letter attempts");
  boundedReason(record.reason, "dead-letter reason");
  timestamp(record.recorded_at, "dead-letter recorded_at");
}

function validateDelivery(delivery: PendingDeliveryRecord): void {
  identity(delivery.delivery_id, "delivery_id");
  identity(delivery.subscription_id, "delivery subscription_id");
  identity(delivery.partition_id, "delivery partition_id");
  nonNegative(delivery.from_position, "delivery from_position");
  positive(delivery.to_position, "delivery to_position");
  if (delivery.to_position <= delivery.from_position) {
    throw new RangeError("delivery to_position must be after from_position");
  }
  cursor(delivery.next_cursor, "delivery next_cursor");
  positive(delivery.attempt, "delivery attempt");
  timestamp(delivery.delivered_at, "delivery delivered_at");
  timestamp(delivery.visibility_expires_at, "delivery visibility_expires_at");
  if (compareUtcTimestamps(delivery.visibility_expires_at, delivery.delivered_at) <= 0) {
    throw new RangeError("delivery visibility expiry must be after delivery time");
  }
  if (!["pending", "retry", "rejected", "expired", "acknowledged"].includes(
    delivery.outcome,
  )) throw new TypeError("delivery outcome is invalid");
  if (delivery.events.length === 0) throw new TypeError("delivery requires events");
  let position = delivery.from_position;
  for (const event of delivery.events) {
    validateEvent(event);
    if (event.partition_id !== delivery.partition_id || event.partition_position <= position) {
      throw new Error("delivery events must be ordered within one partition");
    }
    position = event.partition_position;
  }
  if (position !== delivery.to_position) {
    throw new Error("delivery to_position must equal final event position");
  }
}

function validateSettlement(settlement: DeliverySettlement): void {
  if (!["acknowledged", "retry", "rejected", "expired"].includes(settlement.outcome)) {
    throw new TypeError("settlement outcome is invalid");
  }
  timestamp(settlement.settled_at, "settled_at");
  if (settlement.reason !== null) boundedReason(settlement.reason, "settlement reason");
}

function sameDeliveryIdentity(
  candidate: PendingDeliveryRecord,
  active: PendingDeliveryRecord,
): boolean {
  return candidate.subscription_id === active.subscription_id &&
    candidate.partition_id === active.partition_id &&
    candidate.from_position === active.from_position &&
    candidate.to_position === active.to_position &&
    isDeepStrictEqual(
      candidate.events.map((event) => event.event_id),
      active.events.map((event) => event.event_id),
    );
}

export class SqliteExchangePersistence
  implements
    ExchangePersistence,
    ProjectionCheckpointStore,
    ProjectionFailureStore,
    DeliveryStateStore,
    BoundedOperationalHistoryStore
{
  readonly manifest = clone(manifest);

  constructor(
    private readonly session: SqliteSession,
    private readonly tenantId: string,
  ) {
    identity(tenantId, "tenantId");
  }

  private assertTenant(tenantId: string): void {
    identity(tenantId, "tenantId");
    if (tenantId !== this.tenantId) throw new Error("tenant context mismatch");
  }

  async commitAtomically(request: AtomicCommitRequest): Promise<AtomicCommitResult> {
    validateRequest(request);
    this.assertTenant(request.tenant_id);
    const result = this.session.transaction<AtomicCommitResult>(() => {
      const command = this.session.prepare(
        "SELECT payload_digest, outcome FROM work_fabric_commands WHERE tenant_id = ? AND idempotency_key = ?",
      ).get(this.tenantId, request.idempotency_key) as
        | { payload_digest: string; outcome: string }
        | undefined;
      if (command !== undefined) {
        return command.payload_digest === request.payload_digest
          ? { kind: "replayed", outcome: clone(parseJson(command.outcome)) }
          : { kind: "idempotency_key_reused" };
      }

      const currentVersions = new Map<string, number>();
      const streamIds = [...new Set([
        ...request.version_checks.map((check) => check.stream_id),
        ...request.appends.map((append) => append.stream_id),
      ])].sort();
      const versionStatement = this.session.prepare(
        "SELECT COALESCE(MAX(stream_version), 0) AS version FROM work_fabric_events WHERE tenant_id = ? AND stream_id = ?",
      );
      const partitionStatement = this.session.prepare(
        "SELECT partition_id FROM work_fabric_events WHERE tenant_id = ? AND stream_id = ? LIMIT 1",
      );
      for (const streamId of streamIds) {
        const row = versionStatement.get(this.tenantId, streamId) as { version: number };
        currentVersions.set(streamId, Number(row.version));
        if ((currentVersions.get(streamId) ?? 0) > 0) {
          const partition = partitionStatement.get(this.tenantId, streamId) as {
            partition_id: string;
          };
          if (partition.partition_id !== request.partition_id) {
            throw new Error("stream partition is immutable");
          }
        }
      }
      const conflicts = [...request.version_checks, ...request.appends].some(
        (check) => currentVersions.get(check.stream_id) !== check.expected_version,
      );
      if (conflicts) {
        return {
          kind: "version_conflict",
          current_versions: Object.fromEntries(currentVersions),
        };
      }

      const partitionRow = this.session.prepare(
        "SELECT COALESCE(MAX(partition_position), 0) AS position FROM work_fabric_events WHERE tenant_id = ? AND partition_id = ?",
      ).get(this.tenantId, request.partition_id) as { position: number };
      let partitionPosition = Number(partitionRow.position) + 1;
      let ordinal = 0;
      const committed: EventRecord[] = [];
      const insertEvent = this.session.prepare(
        "INSERT INTO work_fabric_events (tenant_id,event_id,partition_id,partition_position,stream_id,stream_version,payload) VALUES (?,?,?,?,?,?,?)",
      );
      const insertOutbox = this.session.prepare(
        "INSERT INTO work_fabric_outbox (tenant_id,outbox_id,partition_id,position,event) VALUES (?,?,?,?,?)",
      );
      for (const append of request.appends) {
        let streamVersion = (currentVersions.get(append.stream_id) ?? 0) + 1;
        for (const proposed of append.events) {
          const event: EventRecord = {
            ...clone(proposed),
            tenant_id: this.tenantId,
            partition_id: request.partition_id,
            partition_position: partitionPosition,
            stream_id: append.stream_id,
            stream_version: streamVersion,
            commit_id: request.commit_id,
            commit_ordinal: ordinal,
          };
          validateEvent(event);
          const payload = JSON.stringify(event);
          insertEvent.run(
            this.tenantId,
            event.event_id,
            event.partition_id,
            event.partition_position,
            event.stream_id,
            event.stream_version,
            payload,
          );
          insertOutbox.run(
            this.tenantId,
            event.event_id,
            event.partition_id,
            event.partition_position,
            payload,
          );
          committed.push(event);
          partitionPosition += 1;
          streamVersion += 1;
          ordinal += 1;
        }
      }
      this.session.prepare(
        "INSERT INTO work_fabric_commands (tenant_id,idempotency_key,payload_digest,first_request_message_id,outcome) VALUES (?,?,?,?,?)",
      ).run(
        this.tenantId,
        request.idempotency_key,
        request.payload_digest,
        request.request_message_id,
        JSON.stringify(request.outcome),
      );
      return { kind: "committed", events: clone(committed) };
    });
    return clone(result);
  }

  async readStream(streamId: string, fromVersion = 0): Promise<readonly EventRecord[]> {
    identity(streamId, "streamId");
    nonNegative(fromVersion, "fromVersion");
    return this.session.prepare(
      "SELECT payload FROM work_fabric_events WHERE tenant_id = ? AND stream_id = ? AND stream_version >= ? ORDER BY stream_version",
    ).all(this.tenantId, streamId, fromVersion).map((row) =>
      clone(parseJson<EventRecord>((row as { payload: string }).payload))
    );
  }

  async readPartition(
    partitionId: string,
    afterPosition = 0,
    limit = 100,
  ): Promise<readonly EventRecord[]> {
    identity(partitionId, "partitionId");
    nonNegative(afterPosition, "afterPosition");
    positive(limit, "limit");
    return this.session.prepare(
      "SELECT payload FROM work_fabric_events WHERE tenant_id = ? AND partition_id = ? AND partition_position > ? ORDER BY partition_position LIMIT ?",
    ).all(this.tenantId, partitionId, afterPosition, limit).map((row) =>
      clone(parseJson<EventRecord>((row as { payload: string }).payload))
    );
  }

  async findCommand(tenantId: string, idempotencyKey: string): Promise<CommandRecord | null> {
    this.assertTenant(tenantId);
    identity(idempotencyKey, "idempotencyKey");
    const row = this.session.prepare(
      "SELECT payload_digest,first_request_message_id,outcome FROM work_fabric_commands WHERE tenant_id = ? AND idempotency_key = ?",
    ).get(this.tenantId, idempotencyKey) as Record<string, unknown> | undefined;
    return row === undefined ? null : {
      tenant_id: this.tenantId,
      idempotency_key: idempotencyKey,
      payload_digest: String(row.payload_digest),
      first_request_message_id: String(row.first_request_message_id),
      outcome: clone(parseJson(String(row.outcome))),
    };
  }

  async loadSnapshot(streamId: string): Promise<SnapshotRecord | null> {
    identity(streamId, "streamId");
    const row = this.session.prepare(
      "SELECT stream_version,schema_version,state FROM work_fabric_snapshots WHERE tenant_id = ? AND stream_id = ?",
    ).get(this.tenantId, streamId) as Record<string, unknown> | undefined;
    return row === undefined ? null : {
      stream_id: streamId,
      stream_version: Number(row.stream_version),
      schema_version: String(row.schema_version),
      state: clone(parseJson(String(row.state))),
    };
  }

  async saveSnapshot(snapshot: SnapshotRecord): Promise<void> {
    identity(snapshot.stream_id, "snapshot stream_id");
    nonNegative(snapshot.stream_version, "snapshot stream_version");
    identity(snapshot.schema_version, "snapshot schema_version");
    this.session.prepare(`
      INSERT INTO work_fabric_snapshots
        (tenant_id,stream_id,stream_version,schema_version,state)
      VALUES (?,?,?,?,?)
      ON CONFLICT (tenant_id,stream_id) DO UPDATE SET
        stream_version=excluded.stream_version,
        schema_version=excluded.schema_version,
        state=excluded.state
    `).run(
      this.tenantId,
      snapshot.stream_id,
      snapshot.stream_version,
      snapshot.schema_version,
      JSON.stringify(clone(snapshot.state)),
    );
  }

  async deleteSnapshot(streamId: string): Promise<void> {
    identity(streamId, "streamId");
    this.session.prepare(
      "DELETE FROM work_fabric_snapshots WHERE tenant_id = ? AND stream_id = ?",
    ).run(this.tenantId, streamId);
  }

  async loadProjectionCheckpoint(projectorId: string, partitionId: string): Promise<number> {
    identity(projectorId, "projectorId");
    identity(partitionId, "partitionId");
    const row = this.session.prepare(
      "SELECT position FROM work_fabric_projection_checkpoints WHERE tenant_id=? AND projector_id=? AND partition_id=?",
    ).get(this.tenantId, projectorId, partitionId) as { position: number } | undefined;
    return Number(row?.position ?? 0);
  }

  async advanceProjectionCheckpoint(
    projectorId: string,
    partitionId: string,
    expectedPosition: number,
    newPosition: number,
  ): Promise<boolean> {
    identity(projectorId, "projectorId");
    identity(partitionId, "partitionId");
    nonNegative(expectedPosition, "expectedPosition");
    nonNegative(newPosition, "newPosition");
    return this.session.transaction(() => {
      const current = this.session.prepare(
        "SELECT position FROM work_fabric_projection_checkpoints WHERE tenant_id=? AND projector_id=? AND partition_id=?",
      ).get(this.tenantId, projectorId, partitionId) as { position: number } | undefined;
      const position = Number(current?.position ?? 0);
      if (position !== expectedPosition || newPosition < position) return false;
      this.session.prepare(`
        INSERT INTO work_fabric_projection_checkpoints
          (tenant_id,projector_id,partition_id,position) VALUES (?,?,?,?)
        ON CONFLICT (tenant_id,projector_id,partition_id)
          DO UPDATE SET position=excluded.position
      `).run(this.tenantId, projectorId, partitionId, newPosition);
      return true;
    });
  }

  async resetProjectionCheckpoint(projectorId: string, partitionId: string): Promise<void> {
    identity(projectorId, "projectorId");
    identity(partitionId, "partitionId");
    this.session.prepare(
      "DELETE FROM work_fabric_projection_checkpoints WHERE tenant_id=? AND projector_id=? AND partition_id=?",
    ).run(this.tenantId, projectorId, partitionId);
  }

  async putProjectionFailure(failure: ProjectionFailureRecord): Promise<void> {
    identity(failure.projector_id, "projector_id");
    identity(failure.partition_id, "partition_id");
    identity(failure.event_id, "event_id");
    positive(failure.position, "failure position");
    boundedReason(failure.reason, "failure reason");
    timestamp(failure.recorded_at, "failure recorded_at");
    this.session.prepare(`
      INSERT OR IGNORE INTO work_fabric_projection_failures
        (tenant_id,projector_id,partition_id,event_id,position,payload)
      VALUES (?,?,?,?,?,?)
    `).run(
      this.tenantId,
      failure.projector_id,
      failure.partition_id,
      failure.event_id,
      failure.position,
      JSON.stringify(clone(failure)),
    );
  }

  async listProjectionFailures(
    projectorId: string,
    partitionId: string,
  ): Promise<readonly ProjectionFailureRecord[]> {
    identity(projectorId, "projectorId");
    identity(partitionId, "partitionId");
    return this.session.prepare(`
      SELECT payload FROM work_fabric_projection_failures
      WHERE tenant_id=? AND projector_id=? AND partition_id=?
      ORDER BY position,event_id
    `).all(this.tenantId, projectorId, partitionId).map((row) =>
      clone(parseJson<ProjectionFailureRecord>((row as { payload: string }).payload))
    );
  }

  async scanProjectionFailures(
    input: Parameters<BoundedOperationalHistoryStore["scanProjectionFailures"]>[0],
  ): Promise<readonly ProjectionFailureRecord[]> {
    this.assertTenant(input.tenant_id);
    identity(input.projector_id, "projector_id");
    identity(input.partition_id, "partition_id");
    scanLimit(input.limit);
    if (input.after !== null) {
      nonNegative(input.after.position, "after.position");
      identity(input.after.event_id, "after.event_id");
    }
    const after = input.after;
    const rows = after === null
      ? this.session.prepare(`
          SELECT payload FROM work_fabric_projection_failures
          WHERE tenant_id=? AND projector_id=? AND partition_id=?
          ORDER BY position,event_id LIMIT ?
        `).all(this.tenantId, input.projector_id, input.partition_id, input.limit)
      : this.session.prepare(`
          SELECT payload FROM work_fabric_projection_failures
          WHERE tenant_id=? AND projector_id=? AND partition_id=?
            AND (position>? OR (position=? AND event_id>?))
          ORDER BY position,event_id LIMIT ?
        `).all(
          this.tenantId,
          input.projector_id,
          input.partition_id,
          after.position,
          after.position,
          after.event_id,
          input.limit,
        );
    return rows.map((row) =>
      clone(parseJson<ProjectionFailureRecord>((row as { payload: string }).payload))
    );
  }

  async loadDeliveryPosition(subscriptionId: string, partitionId: string): Promise<number> {
    identity(subscriptionId, "subscriptionId");
    identity(partitionId, "partitionId");
    const row = this.session.prepare(
      "SELECT position FROM work_fabric_delivery_positions WHERE tenant_id=? AND subscription_id=? AND partition_id=?",
    ).get(this.tenantId, subscriptionId, partitionId) as { position: number } | undefined;
    return Number(row?.position ?? 0);
  }

  async recordDeliveryAttempt(attempt: DeliveryAttempt): Promise<void> {
    validateAttempt(attempt);
    const existing = this.session.prepare(`
      SELECT payload FROM work_fabric_delivery_attempts
      WHERE tenant_id=? AND subscription_id=? AND event_id=? AND attempt=?
    `).get(
      this.tenantId,
      attempt.subscription_id,
      attempt.event_id,
      attempt.attempt,
    ) as { payload: string } | undefined;
    if (existing !== undefined) {
      if (!isDeepStrictEqual(parseJson(existing.payload), attempt)) {
        throw new Error("contradictory Delivery Attempt replay");
      }
      return;
    }
    this.session.prepare(`
      INSERT INTO work_fabric_delivery_attempts
        (tenant_id,subscription_id,event_id,attempt,payload) VALUES (?,?,?,?,?)
    `).run(
      this.tenantId,
      attempt.subscription_id,
      attempt.event_id,
      attempt.attempt,
      JSON.stringify(clone(attempt)),
    );
  }

  async listDeliveryAttempts(
    subscriptionId: string,
    eventId: string,
  ): Promise<readonly DeliveryAttempt[]> {
    identity(subscriptionId, "subscriptionId");
    identity(eventId, "eventId");
    return this.session.prepare(`
      SELECT payload FROM work_fabric_delivery_attempts
      WHERE tenant_id=? AND subscription_id=? AND event_id=? ORDER BY attempt
    `).all(this.tenantId, subscriptionId, eventId).map((row) =>
      clone(parseJson<DeliveryAttempt>((row as { payload: string }).payload))
    );
  }

  async scanDeliveryAttempts(
    input: Parameters<BoundedOperationalHistoryStore["scanDeliveryAttempts"]>[0],
  ): Promise<readonly DeliveryAttempt[]> {
    this.assertTenant(input.tenant_id);
    identity(input.subscription_id, "subscription_id");
    identity(input.event_id, "event_id");
    scanLimit(input.limit);
    if (input.after !== null) {
      positive(input.after.attempt, "after.attempt");
      timestamp(input.after.attempted_at, "after.attempted_at");
    }
    const after = input.after;
    const rows = after === null
      ? this.session.prepare(`
          SELECT payload FROM work_fabric_delivery_attempts
          WHERE tenant_id=? AND subscription_id=? AND event_id=?
          ORDER BY attempt LIMIT ?
        `).all(this.tenantId, input.subscription_id, input.event_id, input.limit)
      : this.session.prepare(`
          SELECT payload FROM work_fabric_delivery_attempts
          WHERE tenant_id=? AND subscription_id=? AND event_id=?
            AND (attempt>? OR
              (attempt=? AND json_extract(payload,'$.attempted_at')>?))
          ORDER BY attempt,json_extract(payload,'$.attempted_at') LIMIT ?
        `).all(
          this.tenantId,
          input.subscription_id,
          input.event_id,
          after.attempt,
          after.attempt,
          after.attempted_at,
          input.limit,
        );
    return rows.map((row) =>
      clone(parseJson<DeliveryAttempt>((row as { payload: string }).payload))
    );
  }

  async advanceDeliveryPosition(
    subscriptionId: string,
    partitionId: string,
    expectedPosition: number,
    newPosition: number,
  ): Promise<boolean> {
    identity(subscriptionId, "subscriptionId");
    identity(partitionId, "partitionId");
    nonNegative(expectedPosition, "expectedPosition");
    nonNegative(newPosition, "newPosition");
    return this.session.transaction(() => {
      const current = this.session.prepare(
        "SELECT position FROM work_fabric_delivery_positions WHERE tenant_id=? AND subscription_id=? AND partition_id=?",
      ).get(this.tenantId, subscriptionId, partitionId) as { position: number } | undefined;
      const position = Number(current?.position ?? 0);
      if (position !== expectedPosition || newPosition < position) return false;
      this.session.prepare(`
        INSERT INTO work_fabric_delivery_positions
          (tenant_id,subscription_id,partition_id,position) VALUES (?,?,?,?)
        ON CONFLICT (tenant_id,subscription_id,partition_id)
          DO UPDATE SET position=excluded.position
      `).run(this.tenantId, subscriptionId, partitionId, newPosition);
      return true;
    });
  }

  async putDeadLetter(record: DeadLetterRecord): Promise<void> {
    validateDeadLetter(record);
    this.session.prepare(`
      INSERT OR IGNORE INTO work_fabric_dead_letters
        (tenant_id,subscription_id,event_id,partition_id,partition_position,payload,recorded_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      this.tenantId,
      record.subscription_id,
      record.event.event_id,
      record.event.partition_id,
      record.event.partition_position,
      JSON.stringify(clone(record)),
      record.recorded_at,
    );
  }

  async listDeadLetters(
    subscriptionId: string,
    eventId?: string,
  ): Promise<readonly DeadLetterRecord[]> {
    identity(subscriptionId, "subscriptionId");
    if (eventId !== undefined) identity(eventId, "eventId");
    const rows = eventId === undefined
      ? this.session.prepare(`
          SELECT payload FROM work_fabric_dead_letters
          WHERE tenant_id=? AND subscription_id=?
          ORDER BY partition_id,partition_position,event_id
        `).all(this.tenantId, subscriptionId)
      : this.session.prepare(`
          SELECT payload FROM work_fabric_dead_letters
          WHERE tenant_id=? AND subscription_id=? AND event_id=?
          ORDER BY partition_id,partition_position,event_id
        `).all(this.tenantId, subscriptionId, eventId);
    return rows.map((row) =>
      clone(parseJson<DeadLetterRecord>((row as { payload: string }).payload))
    );
  }

  async scanDeadLetters(
    input: Parameters<BoundedOperationalHistoryStore["scanDeadLetters"]>[0],
  ): Promise<readonly DeadLetterRecord[]> {
    this.assertTenant(input.tenant_id);
    identity(input.subscription_id, "subscription_id");
    if (input.event_id !== undefined) identity(input.event_id, "event_id");
    scanLimit(input.limit);
    if (input.after !== null) {
      timestamp(input.after.recorded_at, "after.recorded_at");
      identity(input.after.event_id, "after.event_id");
    }
    const rows = this.session.prepare(`
      SELECT payload FROM work_fabric_dead_letters
      WHERE tenant_id=? AND subscription_id=?
        AND (? IS NULL OR event_id=?)
        AND (? IS NULL OR recorded_at<? OR (recorded_at=? AND event_id>?))
      ORDER BY recorded_at DESC,event_id ASC LIMIT ?
    `).all(
      this.tenantId,
      input.subscription_id,
      input.event_id ?? null,
      input.event_id ?? null,
      input.after?.recorded_at ?? null,
      input.after?.recorded_at ?? null,
      input.after?.recorded_at ?? null,
      input.after?.event_id ?? null,
      input.limit,
    );
    return rows.map((row) =>
      clone(parseJson<DeadLetterRecord>((row as { payload: string }).payload))
    );
  }

  async getActiveDelivery(
    subscriptionId: string,
    partitionId: string,
  ): Promise<PendingDeliveryRecord | null> {
    identity(subscriptionId, "subscriptionId");
    identity(partitionId, "partitionId");
    const row = this.session.prepare(`
      SELECT d.payload FROM work_fabric_delivery_active a
      JOIN work_fabric_deliveries d
        ON d.tenant_id=a.tenant_id AND d.delivery_id=a.delivery_id
      WHERE a.tenant_id=? AND a.subscription_id=? AND a.partition_id=?
    `).get(this.tenantId, subscriptionId, partitionId) as { payload: string } | undefined;
    return row === undefined ? null : clone(parseJson(row.payload));
  }

  async claimPendingDelivery(
    delivery: PendingDeliveryRecord,
    expectedActiveDeliveryId: string | null,
  ): Promise<DeliveryClaimResult> {
    validateDelivery(delivery);
    if (delivery.outcome !== "pending") throw new TypeError("claimed delivery must be pending");
    if (expectedActiveDeliveryId !== null) identity(expectedActiveDeliveryId, "expected delivery");
    return clone(this.session.transaction<DeliveryClaimResult>(() => {
      const byId = this.getDeliverySync(delivery.delivery_id);
      const active = this.getActiveDeliverySync(delivery.subscription_id, delivery.partition_id);
      if (byId !== null) {
        if (!isDeepStrictEqual(byId, delivery)) {
          throw new Error("contradictory Delivery ID replay");
        }
        return active?.delivery_id === delivery.delivery_id
          ? { kind: "claimed", delivery: byId }
          : { kind: "conflict", delivery: active ?? byId };
      }
      if (expectedActiveDeliveryId === null) {
        if (active !== null) return { kind: "conflict", delivery: active };
      } else {
        if (
          active === null ||
          active.delivery_id !== expectedActiveDeliveryId ||
          (active.outcome !== "retry" && active.outcome !== "expired")
        ) {
          const conflict = active ?? this.getDeliverySync(expectedActiveDeliveryId);
          if (conflict === null) throw new Error("expected active Delivery does not exist");
          return { kind: "conflict", delivery: conflict };
        }
        if (!sameDeliveryIdentity(delivery, active) || delivery.attempt !== active.attempt + 1) {
          throw new Error("replacement Delivery violates active identity");
        }
      }
      this.session.prepare(
        "INSERT INTO work_fabric_deliveries (tenant_id,delivery_id,subscription_id,partition_id,payload) VALUES (?,?,?,?,?)",
      ).run(
        this.tenantId,
        delivery.delivery_id,
        delivery.subscription_id,
        delivery.partition_id,
        JSON.stringify(clone(delivery)),
      );
      this.session.prepare(`
        INSERT INTO work_fabric_delivery_active
          (tenant_id,subscription_id,partition_id,delivery_id) VALUES (?,?,?,?)
        ON CONFLICT (tenant_id,subscription_id,partition_id)
          DO UPDATE SET delivery_id=excluded.delivery_id
      `).run(
        this.tenantId,
        delivery.subscription_id,
        delivery.partition_id,
        delivery.delivery_id,
      );
      return { kind: "claimed", delivery };
    }));
  }

  async getDelivery(deliveryId: string): Promise<PendingDeliveryRecord | null> {
    identity(deliveryId, "deliveryId");
    return clone(this.getDeliverySync(deliveryId));
  }

  async settleDelivery(
    deliveryId: string,
    expectedOutcome: "pending",
    settlement: DeliverySettlement,
  ): Promise<DeliverySettlementResult> {
    identity(deliveryId, "deliveryId");
    if (expectedOutcome !== "pending") throw new TypeError("expected outcome must be pending");
    validateSettlement(settlement);
    return clone(this.session.transaction<DeliverySettlementResult>(() => {
      const stored = this.getDeliverySync(deliveryId);
      if (stored === null) throw new Error("Delivery not found");
      if (stored.outcome !== expectedOutcome) {
        return {
          kind: stored.outcome === settlement.outcome ? "replayed" : "conflict",
          delivery: stored,
        };
      }
      const currentPosition = this.loadDeliveryPositionSync(
        stored.subscription_id,
        stored.partition_id,
      );
      if (
        (settlement.outcome === "acknowledged" || settlement.outcome === "rejected") &&
        currentPosition !== stored.from_position
      ) {
        return { kind: "position_conflict", delivery: stored, current_position: currentPosition };
      }
      if (settlement.outcome === "rejected") {
        for (const event of stored.events) {
          const deadLetter: DeadLetterRecord = {
            subscription_id: stored.subscription_id,
            event,
            attempts: stored.attempt,
            reason: settlement.reason ?? "delivery_rejected",
            recorded_at: settlement.settled_at,
          };
          validateDeadLetter(deadLetter);
          this.session.prepare(`
            INSERT OR IGNORE INTO work_fabric_dead_letters
              (tenant_id,subscription_id,event_id,partition_id,partition_position,payload,recorded_at)
            VALUES (?,?,?,?,?,?,?)
          `).run(
            this.tenantId,
            deadLetter.subscription_id,
            event.event_id,
            event.partition_id,
            event.partition_position,
            JSON.stringify(deadLetter),
            deadLetter.recorded_at,
          );
        }
      }
      if (settlement.outcome === "acknowledged" || settlement.outcome === "rejected") {
        this.session.prepare(`
          INSERT INTO work_fabric_delivery_positions
            (tenant_id,subscription_id,partition_id,position) VALUES (?,?,?,?)
          ON CONFLICT (tenant_id,subscription_id,partition_id)
            DO UPDATE SET position=excluded.position
        `).run(
          this.tenantId,
          stored.subscription_id,
          stored.partition_id,
          stored.to_position,
        );
        this.session.prepare(`
          DELETE FROM work_fabric_delivery_active
          WHERE tenant_id=? AND subscription_id=? AND partition_id=? AND delivery_id=?
        `).run(
          this.tenantId,
          stored.subscription_id,
          stored.partition_id,
          deliveryId,
        );
      }
      const completed = { ...stored, outcome: settlement.outcome };
      this.session.prepare(
        "UPDATE work_fabric_deliveries SET payload=? WHERE tenant_id=? AND delivery_id=?",
      ).run(JSON.stringify(completed), this.tenantId, deliveryId);
      return { kind: "completed", delivery: completed };
    }));
  }

  private getDeliverySync(deliveryId: string): PendingDeliveryRecord | null {
    const row = this.session.prepare(
      "SELECT payload FROM work_fabric_deliveries WHERE tenant_id=? AND delivery_id=?",
    ).get(this.tenantId, deliveryId) as { payload: string } | undefined;
    return row === undefined ? null : parseJson(row.payload);
  }

  private getActiveDeliverySync(
    subscriptionId: string,
    partitionId: string,
  ): PendingDeliveryRecord | null {
    const row = this.session.prepare(`
      SELECT d.payload FROM work_fabric_delivery_active a
      JOIN work_fabric_deliveries d
        ON d.tenant_id=a.tenant_id AND d.delivery_id=a.delivery_id
      WHERE a.tenant_id=? AND a.subscription_id=? AND a.partition_id=?
    `).get(this.tenantId, subscriptionId, partitionId) as { payload: string } | undefined;
    return row === undefined ? null : parseJson(row.payload);
  }

  private loadDeliveryPositionSync(subscriptionId: string, partitionId: string): number {
    const row = this.session.prepare(
      "SELECT position FROM work_fabric_delivery_positions WHERE tenant_id=? AND subscription_id=? AND partition_id=?",
    ).get(this.tenantId, subscriptionId, partitionId) as { position: number } | undefined;
    return Number(row?.position ?? 0);
  }
}
