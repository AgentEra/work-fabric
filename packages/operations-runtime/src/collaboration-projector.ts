import type { Clock } from "@work-fabric/exchange-core";
import type {
  EventJournal,
  EventRecord,
  HandoffReadModelStore,
  ProjectionCheckpointStore,
  ProjectionFailureStore,
} from "@work-fabric/exchange-spi";
import {
  observeSemanticSafely,
  type CollaborationViewStore,
  type PartitionJournalPositionSource,
  type SemanticObservation,
  type SemanticTelemetryObserver,
} from "@work-fabric/operations-spi";
import {
  relationshipsFromModel,
  responsibilityFromModel,
  timelineFromRecord,
} from "./collaboration-codec.js";

export const COLLABORATION_PROJECTOR_ID =
  "workfabric.collaboration.visibility.v1";

export type CollaborationProjectionResult =
  | { readonly kind: "idle"; readonly position: number }
  | {
      readonly kind: "advanced";
      readonly position: number;
      readonly processed: number;
    }
  | {
      readonly kind: "waiting";
      readonly position: number;
      readonly handoff_id: string;
      readonly required_stream_version: number;
    }
  | {
      readonly kind: "blocked";
      readonly position: number;
      readonly event_id: string;
      readonly reason: string;
    };

function nonNegative(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}

function positive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

function safeReason(stage: string, error: unknown): string {
  void error;
  return `${stage}: adapter operation failed`;
}

export class CollaborationProjector {
  constructor(
    private readonly journal: EventJournal,
    private readonly checkpoints: ProjectionCheckpointStore,
    private readonly failures: ProjectionFailureStore,
    private readonly handoffs: HandoffReadModelStore,
    private readonly views: CollaborationViewStore,
    private readonly clock: Clock,
    private readonly telemetry?: SemanticTelemetryObserver,
    private readonly journalPosition?: PartitionJournalPositionSource,
  ) {}

  async runPartition(
    partitionId: string,
    limit: number,
  ): Promise<CollaborationProjectionResult> {
    const startedAt = performance.now();
    const result = await this.runPartitionInternal(partitionId, limit);
    const outcome: SemanticObservation["outcome"] =
      result.kind === "blocked"
        ? "failed"
        : result.kind === "waiting"
          ? "retryable"
          : "succeeded";
    observeSemanticSafely(this.telemetry, {
      operation: "projection_batch",
      outcome,
      category: "projector",
      duration_ms: Math.max(0, performance.now() - startedAt),
      count: result.kind === "advanced" ? Math.max(1, result.processed) : 1,
    });
    return result;
  }

  private async runPartitionInternal(
    partitionId: string,
    limit: number,
  ): Promise<CollaborationProjectionResult> {
    positive(limit, "limit");
    let position = await this.checkpoints.loadProjectionCheckpoint(
      COLLABORATION_PROJECTOR_ID,
      partitionId,
    );
    nonNegative(position, "checkpoint position");
    const records = await this.journal.readPartition(partitionId, position, limit);
    if (records.length === 0) return { kind: "idle", position };
    let observedLag = records.length;
    if (this.journalPosition !== undefined) {
      try {
        const journalPosition = await this.journalPosition.load(
          records[0]!.tenant_id,
          partitionId,
        );
        if (journalPosition !== null && journalPosition > position) {
          observedLag = journalPosition - position;
        }
      } catch {
        // Telemetry enrichment cannot block projection progress.
      }
    }
    observeSemanticSafely(this.telemetry, {
      operation: "projection_lag",
      outcome: "succeeded",
      category: "projector",
      duration_ms: 0,
      count: observedLag,
    });
    let processed = 0;
    for (const record of records) {
      if (record.partition_position !== position + 1) {
        return this.block(
          partitionId,
          position,
          record,
          `partition position gap: expected ${position + 1}, received ${record.partition_position}`,
        );
      }
      const model = await this.handoffs.getHandoff(record.handoff_id);
      if (model === null || model.stream_version < record.stream_version) {
        return {
          kind: "waiting",
          position,
          handoff_id: record.handoff_id,
          required_stream_version: record.stream_version,
        };
      }
      if (
        model.tenant_id !== record.tenant_id ||
        model.partition_id !== record.partition_id ||
        model.handoff_id !== record.handoff_id
      ) {
        return this.block(
          partitionId,
          position,
          record,
          "model identity: Handoff projection does not match Journal record",
        );
      }
      try {
        const responsibility = responsibilityFromModel(model);
        const timeline = timelineFromRecord(record);
        const relationships = relationshipsFromModel(model);
        await this.views.putResponsibility(responsibility);
        await this.views.putTimeline(timeline);
        await this.views.replaceHandoffRelationships(
          model.tenant_id,
          model.partition_id,
          model.handoff_id,
          model.stream_version,
          relationships,
        );
      } catch (error) {
        return this.block(
          partitionId,
          position,
          record,
          safeReason("view write", error),
        );
      }
      let advanced: boolean;
      try {
        advanced = await this.checkpoints.advanceProjectionCheckpoint(
          COLLABORATION_PROJECTOR_ID,
          partitionId,
          position,
          record.partition_position,
        );
      } catch (error) {
        return this.block(
          partitionId,
          position,
          record,
          safeReason("checkpoint advance", error),
        );
      }
      if (!advanced) {
        return this.block(
          partitionId,
          position,
          record,
          "checkpoint advance: compare-and-advance returned false",
        );
      }
      position = record.partition_position;
      processed += 1;
    }
    return { kind: "advanced", position, processed };
  }

  async rebuildPartition(
    tenantId: string,
    partitionId: string,
    batchSize: number,
  ): Promise<number> {
    positive(batchSize, "batchSize");
    await this.views.clearPartition(tenantId, partitionId);
    await this.checkpoints.resetProjectionCheckpoint(
      COLLABORATION_PROJECTOR_ID,
      partitionId,
    );
    let position = 0;
    for (;;) {
      const result = await this.runPartition(partitionId, batchSize);
      if (result.kind === "idle") return result.position;
      if (result.kind === "advanced") {
        position = result.position;
        continue;
      }
      throw new Error(
        result.kind === "waiting"
          ? `collaboration rebuild is waiting for Handoff ${result.handoff_id}`
          : `collaboration rebuild blocked at ${result.event_id}: ${result.reason}`,
      );
    }
  }

  private async block(
    partitionId: string,
    position: number,
    record: EventRecord,
    reason: string,
  ): Promise<CollaborationProjectionResult> {
    await this.failures.putProjectionFailure({
      projector_id: COLLABORATION_PROJECTOR_ID,
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
