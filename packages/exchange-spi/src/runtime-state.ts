import type { EventRecord } from "./events.js";

export interface ProjectionCheckpointStore {
  loadProjectionCheckpoint(
    projectorId: string,
    partitionId: string,
  ): Promise<number>;
  advanceProjectionCheckpoint(
    projectorId: string,
    partitionId: string,
    expectedPosition: number,
    newPosition: number,
  ): Promise<boolean>;
  resetProjectionCheckpoint(
    projectorId: string,
    partitionId: string,
  ): Promise<void>;
}

export interface ProjectionFailureRecord {
  readonly projector_id: string;
  readonly partition_id: string;
  readonly event_id: string;
  readonly position: number;
  readonly reason: string;
  readonly recorded_at: string;
}

export interface ProjectionFailureStore {
  putProjectionFailure(failure: ProjectionFailureRecord): Promise<void>;
  listProjectionFailures(
    projectorId: string,
    partitionId: string,
  ): Promise<readonly ProjectionFailureRecord[]>;
}

export interface DeliveryAttempt {
  readonly subscription_id: string;
  readonly partition_id: string;
  readonly event_id: string;
  readonly attempt: number;
  readonly attempted_at: string;
  readonly outcome: "accepted" | "retryable_failure" | "permanent_failure";
  readonly detail: string | null;
}

export interface DeadLetterRecord {
  readonly subscription_id: string;
  readonly event: EventRecord;
  readonly attempts: number;
  readonly reason: string;
  readonly recorded_at: string;
}

export interface DeliveryStateStore {
  loadDeliveryPosition(
    subscriptionId: string,
    partitionId: string,
  ): Promise<number>;
  recordDeliveryAttempt(attempt: DeliveryAttempt): Promise<void>;
  advanceDeliveryPosition(
    subscriptionId: string,
    partitionId: string,
    expectedPosition: number,
    newPosition: number,
  ): Promise<boolean>;
  putDeadLetter(record: DeadLetterRecord): Promise<void>;
}
