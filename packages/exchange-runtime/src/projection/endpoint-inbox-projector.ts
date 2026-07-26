import type {
  EndpointInboxRoutingFact,
  EndpointInboxStore,
  EventJournal,
  EventRecord,
  JsonObject,
  ProjectionCheckpointStore,
  ProjectionFailureStore,
} from "@work-fabric/exchange-spi";
import type { Clock } from "@work-fabric/exchange-core";
import type { RuntimeOwnershipFence } from "../runtime-ownership-fence.js";

export const ENDPOINT_INBOX_PROJECTOR_ID = "workfabric.endpoint-inbox.v1";

export type EndpointInboxProjectionRunResult =
  | { readonly kind: "idle"; readonly position: number }
  | { readonly kind: "advanced"; readonly position: number; readonly processed: number }
  | { readonly kind: "blocked"; readonly position: number; readonly event_id: string; readonly reason: string };

const HANDOFF_EVENT = /^workfabric\.handoff\.[a-z][a-z0-9_]*\.v1$/;
const TERMINAL_STATES = new Set([
  "closed",
  "declined",
  "expired",
  "cancelled",
  "transferred",
]);

function object(value: unknown, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonObject;
}

function lifecycle(record: EventRecord): {
  readonly state: string;
  readonly resourceVersion: number;
} {
  const protocol = object(record.protocol_data, "protocol_data");
  const resourceVersion = protocol.resource_version;
  const change = object(protocol.change, "protocol_data.change");
  const state = change.to_state;
  if (
    !Number.isSafeInteger(resourceVersion) ||
    Number(resourceVersion) <= 0 ||
    resourceVersion !== record.stream_version
  ) {
    throw new TypeError("protocol resource_version is inconsistent");
  }
  if (typeof state !== "string" || state.length === 0 || state.length > 64) {
    throw new TypeError("protocol lifecycle state is invalid");
  }
  return { state, resourceVersion: Number(resourceVersion) };
}

function assertRecord(record: EventRecord): void {
  for (const [field, value] of [
    ["tenant_id", record.tenant_id],
    ["partition_id", record.partition_id],
    ["handoff_id", record.handoff_id],
    ["event_id", record.event_id],
  ] as const) {
    if (value.length === 0) throw new TypeError(`${field} must not be empty`);
  }
  if (
    !Number.isSafeInteger(record.partition_position) ||
    record.partition_position <= 0 ||
    !Number.isSafeInteger(record.stream_version) ||
    record.stream_version <= 0
  ) {
    throw new TypeError("Journal positions must be positive safe integers");
  }
}

export class EndpointInboxProjector {
  constructor(
    private readonly store: EndpointInboxStore,
    private readonly journal?: EventJournal,
    private readonly checkpoints?: ProjectionCheckpointStore,
    private readonly failures?: ProjectionFailureStore,
    private readonly clock?: Clock,
  ) {}

  async apply(record: EventRecord): Promise<void> {
    if (!HANDOFF_EVENT.test(record.event_type)) return;
    assertRecord(record);
    const state = lifecycle(record);
    const fact: EndpointInboxRoutingFact = {
      tenant_id: record.tenant_id,
      partition_id: record.partition_id,
      handoff_id: record.handoff_id,
      resource_version: state.resourceVersion,
      lifecycle_state: state.state,
      last_event_id: record.event_id,
      observed_position: record.partition_position,
      visible_actor_ids: [...record.visible_actor_ids],
      visible_endpoint_ids: [...record.visible_endpoint_ids],
      active: !TERMINAL_STATES.has(state.state),
    };
    await this.store.upsertRoutingFact(fact);
  }

  async rebuild(
    tenantId: string,
    records: Iterable<EventRecord> | AsyncIterable<EventRecord>,
  ): Promise<void> {
    if (tenantId.length === 0) throw new TypeError("tenantId must not be empty");
    await this.store.clearTenantProjection(tenantId);
    for await (const record of records) {
      if (record.tenant_id !== tenantId) {
        throw new TypeError("rebuild record Tenant does not match");
      }
      await this.apply(record);
    }
  }

  async runPartition(
    partitionId: string,
    limit: number,
    fence?: RuntimeOwnershipFence,
  ): Promise<EndpointInboxProjectionRunResult> {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("limit must be a positive safe integer");
    const runtime = this.runtime();
    let position = await runtime.checkpoints.loadProjectionCheckpoint(ENDPOINT_INBOX_PROJECTOR_ID, partitionId);
    if (!Number.isSafeInteger(position) || position < 0) throw new RangeError("loaded checkpoint position must be a non-negative safe integer");
    const records = await runtime.journal.readPartition(partitionId, position, limit);
    if (records.length === 0) return { kind: "idle", position };

    let processed = 0;
    for (const record of records) {
      if (record.partition_id !== partitionId || record.partition_position !== position + 1) {
        return this.block(partitionId, position, record, "journal record does not continue the endpoint inbox projection", fence);
      }
      try {
        await fence?.assertOwnership();
        await this.apply(record);
        await fence?.assertOwnership();
        const advanced = await runtime.checkpoints.advanceProjectionCheckpoint(
          ENDPOINT_INBOX_PROJECTOR_ID,
          partitionId,
          position,
          record.partition_position,
        );
        if (!advanced) return this.block(partitionId, position, record, "endpoint inbox checkpoint compare-and-advance returned false", fence);
      } catch (error) {
        return this.block(partitionId, position, record, error instanceof Error ? error.message : "endpoint inbox projection failed", fence);
      }
      position = record.partition_position;
      processed += 1;
    }
    return { kind: "advanced", position, processed };
  }

  async rebuildPartition(tenantId: string, partitionId: string, batchSize: number): Promise<void> {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) throw new RangeError("batchSize must be a positive safe integer");
    const runtime = this.runtime();
    await this.store.clearPartitionProjection(tenantId, partitionId);
    await runtime.checkpoints.resetProjectionCheckpoint(ENDPOINT_INBOX_PROJECTOR_ID, partitionId);
    let previousPosition = -1;
    for (;;) {
      const result = await this.runPartition(partitionId, batchSize);
      if (result.kind === "idle") return;
      if (result.kind === "blocked") throw new Error(`Endpoint inbox rebuild blocked at event ${result.event_id}: ${result.reason}`);
      if (result.position <= previousPosition) throw new Error("Endpoint inbox rebuild made no progress");
      previousPosition = result.position;
    }
  }

  private runtime(): {
    readonly journal: EventJournal;
    readonly checkpoints: ProjectionCheckpointStore;
    readonly failures: ProjectionFailureStore;
    readonly clock: Clock;
  } {
    if (this.journal === undefined || this.checkpoints === undefined || this.failures === undefined || this.clock === undefined) {
      throw new Error("Endpoint inbox partition projection dependencies are required");
    }
    return { journal: this.journal, checkpoints: this.checkpoints, failures: this.failures, clock: this.clock };
  }

  private async block(
    partitionId: string,
    position: number,
    record: EventRecord,
    reason: string,
    fence?: RuntimeOwnershipFence,
  ): Promise<EndpointInboxProjectionRunResult> {
    const runtime = this.runtime();
    await fence?.assertOwnership();
    await runtime.failures.putProjectionFailure({
      projector_id: ENDPOINT_INBOX_PROJECTOR_ID,
      partition_id: partitionId,
      event_id: record.event_id,
      position: record.partition_position,
      reason: reason.slice(0, 512),
      recorded_at: runtime.clock.now(),
    });
    return { kind: "blocked", position, event_id: record.event_id, reason };
  }
}
