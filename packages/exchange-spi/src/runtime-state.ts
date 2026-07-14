import type { EventRecord } from "./events.js";

export interface ProjectionCheckpointStore {
  /** Returns a non-negative safe integer; zero is the initial checkpoint. */
  loadProjectionCheckpoint(
    projectorId: string,
    partitionId: string,
  ): Promise<number>;
  advanceProjectionCheckpoint(
    projectorId: string,
    partitionId: string,
    /** Non-negative safe integer; zero is valid. */
    expectedPosition: number,
    /** Non-negative safe integer; zero is valid. */
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
  /** Positive safe integer Partition Position of the failed Event. */
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
  readonly next_attempt_at: string | null;
}

export interface DeadLetterRecord {
  readonly subscription_id: string;
  readonly event: EventRecord;
  readonly attempts: number;
  readonly reason: string;
  readonly recorded_at: string;
}

export type PendingDeliveryOutcome =
  | "pending"
  | "acknowledged"
  | "retry"
  | "rejected"
  | "expired";

export interface PendingDeliveryRecord {
  readonly delivery_id: string;
  readonly subscription_id: string;
  readonly partition_id: string;
  /** Non-negative safe integer acknowledged position before this Delivery. */
  readonly from_position: number;
  /** Positive safe integer final Event position in this Delivery. */
  readonly to_position: number;
  readonly next_cursor: string;
  readonly events: readonly EventRecord[];
  /** Positive safe integer attempt for this position. */
  readonly attempt: number;
  readonly delivered_at: string;
  readonly visibility_expires_at: string;
  readonly outcome: PendingDeliveryOutcome;
}

export type DeliveryClaimResult =
  | { readonly kind: "claimed"; readonly delivery: PendingDeliveryRecord }
  | { readonly kind: "conflict"; readonly delivery: PendingDeliveryRecord };

export type DeliverySettlementResult =
  | {
      readonly kind: "completed" | "replayed" | "conflict";
      readonly delivery: PendingDeliveryRecord;
    }
  | {
      readonly kind: "position_conflict";
      readonly delivery: PendingDeliveryRecord;
      readonly current_position: number;
    };

export interface DeliverySettlement {
  readonly outcome: "acknowledged" | "retry" | "rejected" | "expired";
  readonly settled_at: string;
  readonly reason: string | null;
}

export interface DeliveryStateStore {
  loadDeliveryPosition(
    subscriptionId: string,
    partitionId: string,
  ): Promise<number>;
  recordDeliveryAttempt(attempt: DeliveryAttempt): Promise<void>;
  listDeliveryAttempts(
    subscriptionId: string,
    eventId: string,
  ): Promise<readonly DeliveryAttempt[]>;
  advanceDeliveryPosition(
    subscriptionId: string,
    partitionId: string,
    expectedPosition: number,
    newPosition: number,
  ): Promise<boolean>;
  putDeadLetter(record: DeadLetterRecord): Promise<void>;
  listDeadLetters(
    subscriptionId: string,
    eventId?: string,
  ): Promise<readonly DeadLetterRecord[]>;
  getActiveDelivery(
    subscriptionId: string,
    partitionId: string,
  ): Promise<PendingDeliveryRecord | null>;
  claimPendingDelivery(
    delivery: PendingDeliveryRecord,
    expectedActiveDeliveryId: string | null,
  ): Promise<DeliveryClaimResult>;
  getDelivery(deliveryId: string): Promise<PendingDeliveryRecord | null>;
  settleDelivery(
    deliveryId: string,
    expectedOutcome: "pending",
    settlement: DeliverySettlement,
  ): Promise<DeliverySettlementResult>;
}
