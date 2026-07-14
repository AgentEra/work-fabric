import { isDeepStrictEqual } from "node:util";

import type {
  AtomicCommitRequest,
  AtomicCommitResult,
  CapabilityManifest,
  CommandRecord,
  DeadLetterRecord,
  DeliveryClaimResult,
  DeliveryAttempt,
  DeliverySettlement,
  DeliverySettlementResult,
  DeliveryStateStore,
  EventRecord,
  ExchangePersistence,
  PendingDeliveryRecord,
  ProjectionFailureRecord,
  ProjectionFailureStore,
  ProjectionCheckpointStore,
  SnapshotRecord,
  StreamAppend,
  StreamVersionCheck,
} from "@work-fabric/exchange-spi";

const manifest: CapabilityManifest = {
  profile: "exchange.persistence.v1",
  adapter: "memory",
  capabilities: {
    expected_stream_version: true,
    ordered_streams: true,
    atomic_multi_stream_append: true,
    transactional_idempotency: true,
    partitioned_journal: true,
    immutable_events: true,
    active_delivery_cas: true,
    atomic_delivery_settlement: true,
    idempotent_dead_letters: true,
    snapshots: true,
    batch_read: true,
    tenant_isolation: true,
  },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compoundKey(first: string, second: string): string {
  return JSON.stringify([first, second]);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

function assertOpaqueId(value: string, label: string): void {
  assertNonEmpty(value, label);
  if (value.length > 128) {
    throw new Error(`${label} must not exceed 128 characters`);
  }
}

function assertTimestamp(value: string, label: string): void {
  assertNonEmpty(value, label);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(
      value,
    );
  const parsed = Date.parse(value);
  if (match === null || Number.isNaN(parsed)) {
    throw new Error(`${label} must be a strict UTC ISO timestamp`);
  }
  const date = new Date(parsed);
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() + 1 !== Number(match[2]) ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5]) ||
    date.getUTCSeconds() !== Number(match[6])
  ) {
    throw new Error(`${label} must be a strict UTC ISO timestamp`);
  }
}

function equalValue(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class MemoryExchangePersistence
  implements
    ExchangePersistence,
    ProjectionCheckpointStore,
    ProjectionFailureStore,
    DeliveryStateStore
{
  private readonly streams = new Map<string, EventRecord[]>();
  private readonly partitions = new Map<string, EventRecord[]>();
  private readonly commands = new Map<string, CommandRecord>();
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private readonly projectionCheckpoints = new Map<string, number>();
  private readonly projectionFailures = new Map<
    string,
    ProjectionFailureRecord
  >();
  private readonly deliveryPositions = new Map<string, number>();
  private readonly attempts = new Map<string, DeliveryAttempt>();
  private readonly deadLetters = new Map<string, DeadLetterRecord>();
  private readonly deliveries = new Map<string, PendingDeliveryRecord>();
  private readonly activeDeliveries = new Map<string, string>();
  private readonly eventIds = new Set<string>();

  private commitTail: Promise<void> = Promise.resolve();

  get manifest(): CapabilityManifest {
    return clone(manifest);
  }

  private async withCommitLock<T>(
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const result = this.commitTail.then(operation, operation);
    this.commitTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async readStream(
    streamId: string,
    fromVersion = 0,
  ): Promise<readonly EventRecord[]> {
    assertNonNegativeInteger(fromVersion, "fromVersion");
    const records = this.streams.get(streamId) ?? [];
    return clone(
      records.filter((record) => record.stream_version >= fromVersion),
    );
  }

  async readPartition(
    partitionId: string,
    afterPosition: number,
    limit: number,
  ): Promise<readonly EventRecord[]> {
    assertNonNegativeInteger(afterPosition, "afterPosition");
    assertPositiveInteger(limit, "limit");
    const records = this.partitions.get(partitionId) ?? [];
    return clone(
      records
        .filter((record) => record.partition_position > afterPosition)
        .slice(0, limit),
    );
  }

  async findCommand(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<CommandRecord | null> {
    const command = this.commands.get(compoundKey(tenantId, idempotencyKey));
    return command === undefined ? null : clone(command);
  }

  async commitAtomically(
    request: AtomicCommitRequest,
  ): Promise<AtomicCommitResult> {
    const clonedRequest = clone(request);
    const result = await this.withCommitLock(() =>
      this.commitWithinLock(clonedRequest),
    );
    return clone(result);
  }

  private commitWithinLock(request: AtomicCommitRequest): AtomicCommitResult {
    if (request.outcome.operation_status === "temporarily_unavailable") {
      throw new Error("temporarily_unavailable outcomes cannot be persisted");
    }

    const commandKey = compoundKey(request.tenant_id, request.idempotency_key);
    const existingCommand = this.commands.get(commandKey);
    if (existingCommand !== undefined) {
      if (existingCommand.payload_digest === request.payload_digest) {
        return { kind: "replayed", outcome: clone(existingCommand.outcome) };
      }
      return { kind: "idempotency_key_reused" };
    }

    this.validateCommitShape(request.appends, request.version_checks);

    for (const condition of [
      ...request.version_checks,
      ...request.appends,
    ]) {
      const existingRecords = this.streams.get(condition.stream_id);
      const assignedPartition = existingRecords?.[0]?.partition_id;
      if (
        assignedPartition !== undefined &&
        assignedPartition !== request.partition_id
      ) {
        throw new Error(
          `stream ${condition.stream_id} is assigned to partition ${assignedPartition}`,
        );
      }
    }

    const currentVersions = new Map<string, number>();
    let hasVersionConflict = false;
    for (const condition of [
      ...request.version_checks,
      ...request.appends,
    ]) {
      const currentVersion = this.streams.get(condition.stream_id)?.length ?? 0;
      currentVersions.set(condition.stream_id, currentVersion);
      if (currentVersion !== condition.expected_version) {
        hasVersionConflict = true;
      }
    }
    if (hasVersionConflict) {
      return {
        kind: "version_conflict",
        current_versions: Object.fromEntries(currentVersions),
      };
    }

    const partitionRecords = [
      ...(this.partitions.get(request.partition_id) ?? []),
    ];
    const stagedStreams = new Map<string, EventRecord[]>();
    const committedEvents: EventRecord[] = [];
    let commitOrdinal = 0;
    let partitionPosition = partitionRecords.length + 1;

    for (const append of request.appends) {
      const streamRecords = [...(this.streams.get(append.stream_id) ?? [])];
      let streamVersion = streamRecords.length + 1;
      for (const proposed of append.events) {
        const record: EventRecord = {
          ...clone(proposed),
          tenant_id: request.tenant_id,
          partition_id: request.partition_id,
          partition_position: partitionPosition,
          stream_id: append.stream_id,
          stream_version: streamVersion,
          commit_id: request.commit_id,
          commit_ordinal: commitOrdinal,
        };
        streamRecords.push(record);
        partitionRecords.push(record);
        committedEvents.push(record);
        streamVersion += 1;
        partitionPosition += 1;
        commitOrdinal += 1;
      }
      stagedStreams.set(append.stream_id, streamRecords);
    }

    for (const [streamId, records] of stagedStreams) {
      this.streams.set(streamId, records);
    }
    this.partitions.set(request.partition_id, partitionRecords);
    for (const event of committedEvents) {
      this.eventIds.add(event.event_id);
    }
    this.commands.set(commandKey, {
      tenant_id: request.tenant_id,
      idempotency_key: request.idempotency_key,
      payload_digest: request.payload_digest,
      first_request_message_id: request.request_message_id,
      outcome: clone(request.outcome),
    });

    return { kind: "committed", events: clone(committedEvents) };
  }

  private validateCommitShape(
    appends: readonly StreamAppend[],
    versionChecks: readonly StreamVersionCheck[],
  ): void {
    const streamIds = new Set<string>();
    const eventIds = new Set<string>();
    for (const append of appends) {
      assertNonNegativeInteger(append.expected_version, "expected version");
      if (streamIds.has(append.stream_id)) {
        throw new Error(`duplicate stream ID: ${append.stream_id}`);
      }
      streamIds.add(append.stream_id);
      if (append.events.length === 0) {
        throw new Error(`stream append ${append.stream_id} must contain an event`);
      }
      for (const event of append.events) {
        if (eventIds.has(event.event_id) || this.eventIds.has(event.event_id)) {
          throw new Error(`duplicate event ID: ${event.event_id}`);
        }
        eventIds.add(event.event_id);
      }
    }

    const checkedStreamIds = new Set<string>();
    for (const check of versionChecks) {
      assertNonNegativeInteger(
        check.expected_version,
        "version check expected version",
      );
      if (checkedStreamIds.has(check.stream_id)) {
        throw new Error(`duplicate stream version check: ${check.stream_id}`);
      }
      if (streamIds.has(check.stream_id)) {
        throw new Error(
          `stream version check overlaps stream append: ${check.stream_id}`,
        );
      }
      checkedStreamIds.add(check.stream_id);
    }
  }

  async loadSnapshot(streamId: string): Promise<SnapshotRecord | null> {
    const snapshot = this.snapshots.get(streamId);
    return snapshot === undefined ? null : clone(snapshot);
  }

  async saveSnapshot(snapshot: SnapshotRecord): Promise<void> {
    const clonedSnapshot = clone(snapshot);
    assertNonNegativeInteger(clonedSnapshot.stream_version, "snapshot version");
    this.snapshots.set(clonedSnapshot.stream_id, clonedSnapshot);
  }

  async deleteSnapshot(streamId: string): Promise<void> {
    this.snapshots.delete(streamId);
  }

  async loadProjectionCheckpoint(
    projectorId: string,
    partitionId: string,
  ): Promise<number> {
    return this.projectionCheckpoints.get(compoundKey(projectorId, partitionId)) ?? 0;
  }

  async advanceProjectionCheckpoint(
    projectorId: string,
    partitionId: string,
    expectedPosition: number,
    newPosition: number,
  ): Promise<boolean> {
    assertNonNegativeInteger(expectedPosition, "expected position");
    assertNonNegativeInteger(newPosition, "new position");
    const key = compoundKey(projectorId, partitionId);
    const currentPosition = this.projectionCheckpoints.get(key) ?? 0;
    if (currentPosition !== expectedPosition || newPosition < currentPosition) {
      return false;
    }
    this.projectionCheckpoints.set(key, newPosition);
    return true;
  }

  async resetProjectionCheckpoint(
    projectorId: string,
    partitionId: string,
  ): Promise<void> {
    this.projectionCheckpoints.delete(compoundKey(projectorId, partitionId));
  }

  async putProjectionFailure(
    failure: ProjectionFailureRecord,
  ): Promise<void> {
    const clonedFailure = clone(failure);
    assertPositiveInteger(clonedFailure.position, "failure position");
    assertNonEmpty(clonedFailure.projector_id, "projector_id");
    assertNonEmpty(clonedFailure.partition_id, "partition_id");
    assertNonEmpty(clonedFailure.event_id, "event_id");
    assertNonEmpty(clonedFailure.reason, "reason");
    assertNonEmpty(clonedFailure.recorded_at, "recorded_at");
    if (clonedFailure.reason.length > 512) {
      throw new Error("reason must not exceed 512 characters");
    }
    const key = JSON.stringify([
      clonedFailure.projector_id,
      clonedFailure.partition_id,
      clonedFailure.event_id,
      clonedFailure.position,
    ]);
    if (!this.projectionFailures.has(key)) {
      this.projectionFailures.set(key, clonedFailure);
    }
  }

  async listProjectionFailures(
    projectorId: string,
    partitionId: string,
  ): Promise<readonly ProjectionFailureRecord[]> {
    assertNonEmpty(projectorId, "projector_id");
    assertNonEmpty(partitionId, "partition_id");
    return clone(
      [...this.projectionFailures.values()]
        .filter(
          (failure) =>
            failure.projector_id === projectorId &&
            failure.partition_id === partitionId,
        )
        .sort(
          (left, right) =>
            left.position - right.position ||
            compareCodePoints(left.event_id, right.event_id),
        ),
    );
  }

  async loadDeliveryPosition(
    subscriptionId: string,
    partitionId: string,
  ): Promise<number> {
    assertOpaqueId(subscriptionId, "subscription_id");
    assertOpaqueId(partitionId, "partition_id");
    return this.deliveryPositions.get(compoundKey(subscriptionId, partitionId)) ?? 0;
  }

  async recordDeliveryAttempt(attempt: DeliveryAttempt): Promise<void> {
    const candidate = clone(attempt);
    this.validateDeliveryAttempt(candidate);
    const key = JSON.stringify([
      candidate.subscription_id,
      candidate.event_id,
      candidate.attempt,
    ]);
    const existing = this.attempts.get(key);
    if (existing !== undefined && !equalValue(existing, candidate)) {
      throw new Error("contradictory Delivery Attempt replay");
    }
    if (existing === undefined) this.attempts.set(key, candidate);
  }

  async listDeliveryAttempts(
    subscriptionId: string,
    eventId: string,
  ): Promise<readonly DeliveryAttempt[]> {
    assertOpaqueId(subscriptionId, "subscription_id");
    assertOpaqueId(eventId, "event_id");
    return clone(
      [...this.attempts.values()]
        .filter(
          (attempt) =>
            attempt.subscription_id === subscriptionId &&
            attempt.event_id === eventId,
        )
        .sort(
          (left, right) =>
            left.attempt - right.attempt ||
            compareCodePoints(left.attempted_at, right.attempted_at),
        ),
    );
  }

  async advanceDeliveryPosition(
    subscriptionId: string,
    partitionId: string,
    expectedPosition: number,
    newPosition: number,
  ): Promise<boolean> {
    assertOpaqueId(subscriptionId, "subscription_id");
    assertOpaqueId(partitionId, "partition_id");
    assertNonNegativeInteger(expectedPosition, "expected position");
    assertNonNegativeInteger(newPosition, "new position");
    const key = compoundKey(subscriptionId, partitionId);
    const currentPosition = this.deliveryPositions.get(key) ?? 0;
    if (currentPosition !== expectedPosition || newPosition < currentPosition) {
      return false;
    }
    this.deliveryPositions.set(key, newPosition);
    return true;
  }

  async putDeadLetter(record: DeadLetterRecord): Promise<void> {
    const candidate = clone(record);
    this.validateDeadLetter(candidate);
    const key = compoundKey(candidate.subscription_id, candidate.event.event_id);
    if (!this.deadLetters.has(key)) this.deadLetters.set(key, candidate);
  }

  async listDeadLetters(
    subscriptionId: string,
    eventId?: string,
  ): Promise<readonly DeadLetterRecord[]> {
    assertOpaqueId(subscriptionId, "subscription_id");
    if (eventId !== undefined) assertOpaqueId(eventId, "event_id");
    return clone(
      [...this.deadLetters.values()]
        .filter(
          (record) =>
            record.subscription_id === subscriptionId &&
            (eventId === undefined || record.event.event_id === eventId),
        )
        .sort(
          (left, right) =>
            compareCodePoints(
              left.event.partition_id,
              right.event.partition_id,
            ) ||
            left.event.partition_position - right.event.partition_position ||
            compareCodePoints(left.event.event_id, right.event.event_id),
        ),
    );
  }

  async getActiveDelivery(
    subscriptionId: string,
    partitionId: string,
  ): Promise<PendingDeliveryRecord | null> {
    assertOpaqueId(subscriptionId, "subscription_id");
    assertOpaqueId(partitionId, "partition_id");
    const deliveryId = this.activeDeliveries.get(
      compoundKey(subscriptionId, partitionId),
    );
    if (deliveryId === undefined) return null;
    const delivery = this.deliveries.get(deliveryId);
    if (delivery === undefined) {
      throw new Error("active Delivery points to a missing record");
    }
    return clone(delivery);
  }

  async claimPendingDelivery(
    delivery: PendingDeliveryRecord,
    expectedActiveDeliveryId: string | null,
  ): Promise<DeliveryClaimResult> {
    const candidate = clone(delivery);
    this.validatePendingDelivery(candidate);
    if (candidate.outcome !== "pending") {
      throw new Error("claimed Delivery outcome must be pending");
    }
    if (expectedActiveDeliveryId !== null) {
      assertOpaqueId(expectedActiveDeliveryId, "expected active delivery_id");
    }

    return this.withCommitLock(() => {
      const activeKey = compoundKey(
        candidate.subscription_id,
        candidate.partition_id,
      );
      const activeId = this.activeDeliveries.get(activeKey);
      const active =
        activeId === undefined ? undefined : this.deliveries.get(activeId);
      if (activeId !== undefined && active === undefined) {
        throw new Error("active Delivery points to a missing record");
      }

      const existingById = this.deliveries.get(candidate.delivery_id);
      if (existingById !== undefined) {
        if (!equalValue(existingById, candidate)) {
          throw new Error("contradictory Delivery ID replay");
        }
        if (activeId === candidate.delivery_id) {
          return { kind: "claimed", delivery: clone(existingById) };
        }
        return {
          kind: "conflict",
          delivery: clone(active ?? existingById),
        };
      }

      if (expectedActiveDeliveryId === null) {
        if (active !== undefined) {
          return { kind: "conflict", delivery: clone(active) };
        }
      } else {
        if (
          active === undefined ||
          active.delivery_id !== expectedActiveDeliveryId ||
          (active.outcome !== "retry" && active.outcome !== "expired")
        ) {
          const conflict =
            active ?? this.deliveries.get(expectedActiveDeliveryId);
          if (conflict === undefined) {
            throw new Error("expected active Delivery does not exist");
          }
          return { kind: "conflict", delivery: clone(conflict) };
        }
        if (
          candidate.subscription_id !== active.subscription_id ||
          candidate.partition_id !== active.partition_id ||
          candidate.from_position !== active.from_position ||
          candidate.to_position !== active.to_position ||
          !isDeepStrictEqual(
            candidate.events.map((event) => event.event_id),
            active.events.map((event) => event.event_id),
          ) ||
          candidate.attempt !== active.attempt + 1
        ) {
          throw new Error("replacement Delivery violates active identity");
        }
      }

      this.deliveries.set(candidate.delivery_id, candidate);
      this.activeDeliveries.set(activeKey, candidate.delivery_id);
      return { kind: "claimed", delivery: clone(candidate) };
    });
  }

  async getDelivery(
    deliveryId: string,
  ): Promise<PendingDeliveryRecord | null> {
    assertOpaqueId(deliveryId, "delivery_id");
    const delivery = this.deliveries.get(deliveryId);
    return delivery === undefined ? null : clone(delivery);
  }

  async settleDelivery(
    deliveryId: string,
    expectedOutcome: "pending",
    settlement: DeliverySettlement,
  ): Promise<DeliverySettlementResult> {
    assertOpaqueId(deliveryId, "delivery_id");
    if (expectedOutcome !== "pending") {
      throw new Error("expected Delivery outcome must be pending");
    }
    this.validateSettlement(settlement);

    return this.withCommitLock(() => {
      const stored = this.deliveries.get(deliveryId);
      if (stored === undefined) throw new Error("Delivery not found");
      if (stored.outcome !== expectedOutcome) {
        return {
          kind: stored.outcome === settlement.outcome ? "replayed" : "conflict",
          delivery: clone(stored),
        };
      }

      const positionKey = compoundKey(
        stored.subscription_id,
        stored.partition_id,
      );
      const currentPosition = this.deliveryPositions.get(positionKey) ?? 0;
      if (
        (settlement.outcome === "acknowledged" ||
          settlement.outcome === "rejected") &&
        currentPosition !== stored.from_position
      ) {
        return {
          kind: "position_conflict",
          delivery: clone(stored),
          current_position: currentPosition,
        };
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
          this.validateDeadLetter(deadLetter);
          const key = compoundKey(stored.subscription_id, event.event_id);
          if (!this.deadLetters.has(key)) {
            this.deadLetters.set(key, clone(deadLetter));
          }
        }
      }

      if (
        settlement.outcome === "acknowledged" ||
        settlement.outcome === "rejected"
      ) {
        this.deliveryPositions.set(positionKey, stored.to_position);
      }
      const completed: PendingDeliveryRecord = {
        ...stored,
        outcome: settlement.outcome,
      };
      this.deliveries.set(deliveryId, completed);
      if (
        settlement.outcome === "acknowledged" ||
        settlement.outcome === "rejected"
      ) {
        if (this.activeDeliveries.get(positionKey) === deliveryId) {
          this.activeDeliveries.delete(positionKey);
        }
      }
      return { kind: "completed", delivery: clone(completed) };
    });
  }

  getDeliveryAttempts(): readonly DeliveryAttempt[] {
    return clone(
      [...this.attempts.values()].sort(
        (left, right) =>
          compareCodePoints(left.subscription_id, right.subscription_id) ||
          compareCodePoints(left.event_id, right.event_id) ||
          left.attempt - right.attempt ||
          compareCodePoints(left.attempted_at, right.attempted_at),
      ),
    );
  }

  getDeadLetters(): readonly DeadLetterRecord[] {
    return clone(
      [...this.deadLetters.values()].sort(
        (left, right) =>
          compareCodePoints(left.subscription_id, right.subscription_id) ||
          compareCodePoints(left.event.partition_id, right.event.partition_id) ||
          left.event.partition_position - right.event.partition_position ||
          compareCodePoints(left.event.event_id, right.event.event_id),
      ),
    );
  }

  private validateDeliveryAttempt(attempt: DeliveryAttempt): void {
    assertOpaqueId(attempt.subscription_id, "attempt subscription_id");
    assertOpaqueId(attempt.partition_id, "attempt partition_id");
    assertOpaqueId(attempt.event_id, "attempt event_id");
    assertPositiveInteger(attempt.attempt, "attempt");
    assertTimestamp(attempt.attempted_at, "attempted_at");
    if (
      attempt.outcome !== "accepted" &&
      attempt.outcome !== "retryable_failure" &&
      attempt.outcome !== "permanent_failure"
    ) {
      throw new Error("attempt outcome is invalid");
    }
    if (attempt.next_attempt_at !== null) {
      assertTimestamp(attempt.next_attempt_at, "next_attempt_at");
      if (Date.parse(attempt.next_attempt_at) <= Date.parse(attempt.attempted_at)) {
        throw new Error("next_attempt_at must be after attempted_at");
      }
    }
    if (attempt.detail !== null && typeof attempt.detail !== "string") {
      throw new Error("attempt detail must be a string or null");
    }
  }

  private validateDeadLetter(record: DeadLetterRecord): void {
    assertOpaqueId(record.subscription_id, "dead-letter subscription_id");
    assertOpaqueId(record.event.event_id, "dead-letter event_id");
    assertOpaqueId(record.event.partition_id, "dead-letter partition_id");
    assertPositiveInteger(
      record.event.partition_position,
      "dead-letter event position",
    );
    assertPositiveInteger(record.attempts, "dead-letter attempts");
    assertNonEmpty(record.reason, "dead-letter reason");
    if (record.reason.length > 512) {
      throw new Error("dead-letter reason must not exceed 512 characters");
    }
    assertTimestamp(record.recorded_at, "dead-letter recorded_at");
  }

  private validatePendingDelivery(delivery: PendingDeliveryRecord): void {
    assertOpaqueId(delivery.delivery_id, "delivery_id");
    assertOpaqueId(delivery.subscription_id, "delivery subscription_id");
    assertOpaqueId(delivery.partition_id, "delivery partition_id");
    assertNonNegativeInteger(delivery.from_position, "delivery from_position");
    assertPositiveInteger(delivery.to_position, "delivery to_position");
    if (delivery.to_position <= delivery.from_position) {
      throw new Error("delivery to_position must be after from_position");
    }
    assertNonEmpty(delivery.next_cursor, "delivery next_cursor");
    if (delivery.next_cursor.length > 2048) {
      throw new Error("delivery next_cursor must not exceed 2048 characters");
    }
    assertPositiveInteger(delivery.attempt, "delivery attempt");
    assertTimestamp(delivery.delivered_at, "delivery delivered_at");
    assertTimestamp(
      delivery.visibility_expires_at,
      "delivery visibility_expires_at",
    );
    if (
      Date.parse(delivery.visibility_expires_at) <=
      Date.parse(delivery.delivered_at)
    ) {
      throw new Error("delivery visibility expiry must be after delivery time");
    }
    if (delivery.events.length === 0) {
      throw new Error("delivery must contain at least one Event");
    }
    let previousPosition = delivery.from_position;
    for (const event of delivery.events) {
      assertOpaqueId(event.event_id, "delivery event_id");
      assertPositiveInteger(event.partition_position, "delivery event position");
      if (event.partition_id !== delivery.partition_id) {
        throw new Error("delivery Event partition mismatch");
      }
      if (event.partition_position <= previousPosition) {
        throw new Error("delivery Events must be ordered after from_position");
      }
      previousPosition = event.partition_position;
    }
    if (previousPosition !== delivery.to_position) {
      throw new Error("delivery to_position must equal its final Event position");
    }
  }

  private validateSettlement(settlement: DeliverySettlement): void {
    if (
      settlement.outcome !== "acknowledged" &&
      settlement.outcome !== "retry" &&
      settlement.outcome !== "rejected" &&
      settlement.outcome !== "expired"
    ) {
      throw new Error("settlement outcome is invalid");
    }
    assertTimestamp(settlement.settled_at, "settlement settled_at");
    if (
      settlement.reason !== null &&
      (typeof settlement.reason !== "string" || settlement.reason.length === 0)
    ) {
      throw new Error("settlement reason must be a non-empty string or null");
    }
    if (settlement.reason !== null && settlement.reason.length > 512) {
      throw new Error("settlement reason must not exceed 512 characters");
    }
  }
}
