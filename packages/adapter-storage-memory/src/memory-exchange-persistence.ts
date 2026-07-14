import type {
  AtomicCommitRequest,
  AtomicCommitResult,
  CapabilityManifest,
  CommandRecord,
  DeadLetterRecord,
  DeliveryAttempt,
  DeliveryStateStore,
  EventRecord,
  ExchangePersistence,
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
  private readonly attempts = new Map<number, DeliveryAttempt>();
  private readonly deadLetters = new Map<number, DeadLetterRecord>();
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
    assertNonNegativeInteger(clonedFailure.position, "failure position");
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
    return this.deliveryPositions.get(compoundKey(subscriptionId, partitionId)) ?? 0;
  }

  async recordDeliveryAttempt(attempt: DeliveryAttempt): Promise<void> {
    this.attempts.set(this.attempts.size, clone(attempt));
  }

  async advanceDeliveryPosition(
    subscriptionId: string,
    partitionId: string,
    expectedPosition: number,
    newPosition: number,
  ): Promise<boolean> {
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
    this.deadLetters.set(this.deadLetters.size, clone(record));
  }

  getDeliveryAttempts(): readonly DeliveryAttempt[] {
    return clone([...this.attempts.values()]);
  }

  getDeadLetters(): readonly DeadLetterRecord[] {
    return clone([...this.deadLetters.values()]);
  }
}
