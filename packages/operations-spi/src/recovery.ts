import type { ExchangeAdapter } from "@work-fabric/exchange-spi";

export type RecoveryKind =
  | "connector_requeue"
  | "delivery_replay"
  | "projection_rebuild"
  | "discrepancy_acknowledge";

export type RecoveryTarget =
  | {
      readonly kind: "connector_requeue";
      readonly connector_id: string;
      readonly ingress_id: string;
      readonly available_at: string;
    }
  | {
      readonly kind: "delivery_replay";
      readonly subscription_id: string;
      readonly partition_id: string;
      readonly event_id: string;
    }
  | {
      readonly kind: "projection_rebuild";
      readonly projector_id: string;
      readonly partition_id: string;
    }
  | {
      readonly kind: "discrepancy_acknowledge";
      readonly discrepancy_id: string;
    };

export type RecoveryState = "pending" | "processing" | "completed" | "failed";

export interface RecoveryRequestRecord {
  readonly tenant_id: string;
  readonly recovery_id: string;
  readonly idempotency_key: string;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly target: RecoveryTarget;
  readonly expected_version: number;
  readonly reason: string;
  readonly state: RecoveryState;
  readonly version: number;
  readonly attempt: number;
  readonly outcome_code: string | null;
  readonly completed_at: string | null;
}

export interface SubmitRecoveryRequest {
  readonly tenant_id: string;
  readonly recovery_id: string;
  readonly idempotency_key: string;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly target: RecoveryTarget;
  readonly expected_version: number;
  readonly reason: string;
}

export type SubmitRecoveryResult =
  | { readonly kind: "accepted" | "replayed"; readonly recovery: RecoveryRequestRecord }
  | { readonly kind: "conflict"; readonly recovery_id: string };

export interface ClaimRecoveryRequests {
  readonly tenant_id: string;
  readonly worker_id: string;
  readonly now: string;
  readonly lease_seconds: number;
  readonly limit: number;
}

export interface RecoveryRequestClaim extends RecoveryRequestRecord {
  readonly state: "processing";
  readonly claim_owner: string;
  readonly claim_token: string;
  readonly fencing_token: number;
  readonly lease_expires_at: string;
}

export interface CompleteRecoveryRequest {
  readonly tenant_id: string;
  readonly recovery_id: string;
  readonly claim_token: string;
  readonly fencing_token: number;
  readonly completed_at: string;
  readonly outcome_code: string;
}

export interface RecoveryRequestStore extends ExchangeAdapter {
  submit(input: SubmitRecoveryRequest): Promise<SubmitRecoveryResult>;
  get(tenantId: string, recoveryId: string): Promise<RecoveryRequestRecord | null>;
  claim(input: ClaimRecoveryRequests): Promise<readonly RecoveryRequestClaim[]>;
  complete(input: CompleteRecoveryRequest): Promise<RecoveryRequestRecord>;
  fail(input: CompleteRecoveryRequest): Promise<RecoveryRequestRecord>;
}

export class RecoveryStoreError extends Error {
  constructor(
    readonly code: "not_found" | "claim_lost" | "invalid_state",
    message: string,
  ) {
    super(message);
  }
}
