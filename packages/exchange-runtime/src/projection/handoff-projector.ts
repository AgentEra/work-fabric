import {
  evolveHandoff,
  handoffEventFromJson,
  handoffStateFromJson,
  handoffStateToJson,
  type Clock,
  type HandoffEvent,
  type HandoffState,
} from "@work-fabric/exchange-core";
import type {
  EventJournal,
  EventRecord,
  HandoffReadModel,
  HandoffReadModelStore,
  ProjectionCheckpointStore,
  ProjectionFailureStore,
} from "@work-fabric/exchange-spi";
import type { RuntimeOwnershipFence } from "../runtime-ownership-fence.js";

export const HANDOFF_PROJECTOR_ID = "workfabric.handoff.read-model.v1";

export type ProjectionRunResult =
  | { readonly kind: "idle"; readonly position: number }
  | {
      readonly kind: "advanced";
      readonly position: number;
      readonly processed: number;
    }
  | {
      readonly kind: "blocked";
      readonly position: number;
      readonly event_id: string;
      readonly reason: string;
    };

type FailureStage =
  | "journal read"
  | "model read"
  | "decode"
  | "stream version gap"
  | "partition position gap"
  | "model write"
  | "checkpoint advance";

function failureReason(stage: FailureStage, error: unknown): string {
  let detail = "unknown failure";
  if (error instanceof Error) {
    detail = error.message.replace(/[\r\n\t]+/g, " ").trim();
  } else if (typeof error === "string") {
    detail = error.replace(/[\r\n\t]+/g, " ").trim();
  } else if (error !== null) {
    detail = `non-Error ${typeof error}`;
  }
  return `${stage}: ${detail}`.slice(0, 512);
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function requireNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
}

function requireTrustedCursorMetadata(record: EventRecord): void {
  requireNonEmptyString(record.event_id, "Journal record event_id");
  requirePositiveInteger(
    record.partition_position,
    "Journal record partition_position",
  );
}

function requireRecordIdentity(
  record: EventRecord,
  partitionId: string,
  event: HandoffEvent,
): void {
  requireNonEmptyString(record.tenant_id, "record tenant_id");
  requireNonEmptyString(record.partition_id, "record partition_id");
  requireNonEmptyString(record.stream_id, "record stream_id");
  requireNonEmptyString(record.handoff_id, "record handoff_id");
  requireNonEmptyString(record.event_type, "record event_type");
  requireNonEmptyString(record.occurred_at, "record occurred_at");
  requirePositiveInteger(record.stream_version, "record stream_version");
  if (record.partition_id !== partitionId) {
    throw new Error("record partition_id does not match the requested Partition");
  }
  if (record.schema_version !== "1.0") {
    throw new Error("record schema_version is not supported");
  }
  if (record.stream_id !== record.handoff_id) {
    throw new Error("record stream_id does not match handoff_id");
  }
  if (
    event.handoff_id !== record.handoff_id ||
    event.event_type !== record.event_type ||
    event.occurred_at !== record.occurred_at
  ) {
    throw new Error("domain Event does not match Journal metadata");
  }
}

function decodeExistingState(
  model: HandoffReadModel,
  record: EventRecord,
): HandoffState {
  if (
    model.tenant_id !== record.tenant_id ||
    model.partition_id !== record.partition_id ||
    model.handoff_id !== record.handoff_id
  ) {
    throw new Error("stored Handoff model identity does not match Journal record");
  }
  const state = handoffStateFromJson(model.state);
  if (
    state.handoff_id !== model.handoff_id ||
    state.resource_version !== model.stream_version
  ) {
    throw new Error("stored Handoff state identity or version is inconsistent");
  }
  return state;
}

export class HandoffProjector {
  constructor(
    private readonly journal: EventJournal,
    private readonly checkpoints: ProjectionCheckpointStore,
    private readonly failures: ProjectionFailureStore,
    private readonly models: HandoffReadModelStore,
    private readonly clock: Clock,
  ) {}

  async runPartition(
    partitionId: string,
    limit: number,
    fence?: RuntimeOwnershipFence,
  ): Promise<ProjectionRunResult> {
    requirePositiveInteger(limit, "limit");
    let position = await this.checkpoints.loadProjectionCheckpoint(
      HANDOFF_PROJECTOR_ID,
      partitionId,
    );
    requireNonNegativeInteger(position, "loaded checkpoint position");
    let records: readonly EventRecord[];
    try {
      records = await this.journal.readPartition(partitionId, position, limit);
    } catch (error) {
      throw new Error(failureReason("journal read", error));
    }
    if (records.length === 0) return { kind: "idle", position };

    let processed = 0;
    for (const record of records) {
      requireTrustedCursorMetadata(record);
      if (record.partition_position !== position + 1) {
        return this.block(
          partitionId,
          position,
          record,
          failureReason(
            "partition position gap",
            new Error(`expected ${position + 1}, received ${record.partition_position}`),
          ),
          fence,
        );
      }

      let model: HandoffReadModel | null;
      try {
        model = await this.models.getHandoff(record.handoff_id);
      } catch (error) {
        return this.block(
          partitionId,
          position,
          record,
          failureReason("model read", error),
          fence,
        );
      }

      let event: HandoffEvent;
      let state: HandoffState | null = null;
      try {
        event = handoffEventFromJson(record.domain_data);
        requireRecordIdentity(record, partitionId, event);
        if (model !== null) state = decodeExistingState(model, record);
      } catch (error) {
        return this.block(
          partitionId,
          position,
          record,
          failureReason("decode", error),
          fence,
        );
      }

      if (model === null || model.stream_version < record.stream_version) {
        const expectedVersion = model === null ? 1 : model.stream_version + 1;
        if (record.stream_version !== expectedVersion) {
          return this.block(
            partitionId,
            position,
            record,
            failureReason(
              "stream version gap",
              new Error(
                `expected ${expectedVersion}, received ${record.stream_version}`,
              ),
            ),
            fence,
          );
        }

        let evolved: HandoffState;
        try {
          evolved = evolveHandoff(state, event, record.stream_version);
        } catch (error) {
          return this.block(
            partitionId,
            position,
            record,
            failureReason("decode", error),
            fence,
          );
        }
        const nextModel: HandoffReadModel = {
          tenant_id: record.tenant_id,
          partition_id: record.partition_id,
          handoff_id: record.handoff_id,
          stream_version: record.stream_version,
          state: handoffStateToJson(evolved),
          latest_status:
            event.event_type === "workfabric.handoff.status_reported.v1"
              ? event.status
              : (model?.latest_status ?? null),
        };
        await fence?.assertOwnership();
        try {
          await this.models.putHandoff(nextModel);
        } catch (error) {
          return this.block(
            partitionId,
            position,
            record,
            failureReason("model write", error),
            fence,
          );
        }
      }

      let advanced: boolean;
      await fence?.assertOwnership();
      try {
        advanced = await this.checkpoints.advanceProjectionCheckpoint(
          HANDOFF_PROJECTOR_ID,
          partitionId,
          position,
          record.partition_position,
        );
      } catch (error) {
        return this.block(
          partitionId,
          position,
          record,
          failureReason("checkpoint advance", error),
          fence,
        );
      }
      if (!advanced) {
        return this.block(
          partitionId,
          position,
          record,
          failureReason(
            "checkpoint advance",
            new Error("compare-and-advance returned false"),
          ),
          fence,
        );
      }
      position = record.partition_position;
      processed += 1;
    }

    return { kind: "advanced", position, processed };
  }

  async rebuildPartition(partitionId: string, batchSize: number): Promise<void> {
    requirePositiveInteger(batchSize, "batchSize");
    await this.models.clearPartition(partitionId);
    await this.checkpoints.resetProjectionCheckpoint(
      HANDOFF_PROJECTOR_ID,
      partitionId,
    );

    let previousPosition = -1;
    for (;;) {
      const result = await this.runPartition(partitionId, batchSize);
      if (result.kind === "idle") return;
      if (result.kind === "blocked") {
        throw new Error(
          `Projection rebuild blocked at event ${result.event_id}: ${result.reason}`,
        );
      }
      if (result.processed <= 0 || result.position <= previousPosition) {
        throw new Error("Projection rebuild made no progress");
      }
      previousPosition = result.position;
    }
  }

  private async block(
    partitionId: string,
    position: number,
    record: EventRecord,
    reason: string,
    fence?: RuntimeOwnershipFence,
  ): Promise<ProjectionRunResult> {
    await fence?.assertOwnership();
    await this.failures.putProjectionFailure({
      projector_id: HANDOFF_PROJECTOR_ID,
      partition_id: partitionId,
      event_id: record.event_id,
      position: record.partition_position,
      reason,
      recorded_at: this.clock.now(),
    });
    return {
      kind: "blocked",
      position,
      event_id: record.event_id,
      reason,
    };
  }
}
