import type { ConnectorIngressState } from "@work-fabric/connector-spi";
import type { PendingDeliveryOutcome } from "@work-fabric/exchange-spi";

export interface OperationalPage<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
}

export interface ProjectionOperationalStatus {
  readonly tenant_id: string;
  readonly projector_id: string;
  readonly partition_id: string;
  readonly checkpoint_position: number;
  readonly journal_position: number;
  readonly lag: number;
  readonly state: "current" | "lagging";
}

export interface ProjectionFailureView {
  readonly projector_id: string;
  readonly partition_id: string;
  readonly event_id: string;
  readonly position: number;
  readonly reason_code: "projection_failed";
  readonly recorded_at: string;
}

export interface ProjectionFailureOperationalQuery {
  readonly projector_id: string;
  readonly partition_id: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface ActiveDeliveryView {
  readonly delivery_id: string;
  readonly from_position: number;
  readonly to_position: number;
  readonly attempt: number;
  readonly delivered_at: string;
  readonly visibility_expires_at: string;
  readonly outcome: PendingDeliveryOutcome;
}

export interface DeliveryOperationalState {
  readonly tenant_id: string;
  readonly subscription_id: string;
  readonly partition_id: string;
  readonly position: number;
  readonly active_delivery: ActiveDeliveryView | null;
}

export interface DeliveryAttemptView {
  readonly subscription_id: string;
  readonly partition_id: string;
  readonly event_id: string;
  readonly attempt: number;
  readonly attempted_at: string;
  readonly outcome: "accepted" | "retryable_failure" | "permanent_failure";
  readonly next_attempt_at: string | null;
}

export interface DeliveryAttemptOperationalQuery {
  readonly subscription_id: string;
  readonly event_id: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface DeadLetterView {
  readonly subscription_id: string;
  readonly partition_id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly partition_position: number;
  readonly handoff_id: string;
  readonly thread_id: string;
  readonly attempts: number;
  readonly reason_code: "delivery_dead_letter";
  readonly recorded_at: string;
}

export interface DeadLetterOperationalQuery {
  readonly subscription_id: string;
  readonly event_id?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface ConnectorIngressOperationalView {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly ingress_id: string;
  readonly source_system: string;
  readonly external_event_id: string;
  readonly event_type: string;
  readonly state: ConnectorIngressState;
  readonly attempt: number;
  readonly available_at: string;
  readonly accepted_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly last_error_code: string | null;
  readonly last_requeued_at: string | null;
}

export interface ConnectorIngressOperationalQuery {
  readonly connector_id: string;
  readonly states?: readonly ConnectorIngressState[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface ConnectorDiscrepancyView {
  readonly discrepancy_id: string;
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly external_object_id: string;
  readonly resource_id: string | null;
  readonly expected_state: string | null;
  readonly expected_version: number | null;
  readonly observed_state: string;
  readonly observed_at: string;
  readonly status: "open" | "acknowledged";
  readonly version: number;
  readonly acknowledged_at: string | null;
  readonly acknowledged_by: string | null;
}

export interface ConnectorDiscrepancyOperationalQuery {
  readonly connector_id?: string;
  readonly statuses?: readonly ConnectorDiscrepancyView["status"][];
  readonly cursor?: string;
  readonly limit: number;
}

export interface PartitionJournalPositionSource {
  load(tenantId: string, partitionId: string): Promise<number | null>;
}
