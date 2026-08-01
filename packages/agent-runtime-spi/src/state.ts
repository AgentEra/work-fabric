import type { RuntimeDriverResult } from "./driver.js";

export type RuntimeRunState =
  | "received"
  | "accepted"
  | "running"
  | "result_ready"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RuntimeDeliveryRecord {
  readonly tenant_id: string;
  readonly delivery_id: string;
  readonly handoff_id: string;
  readonly partition_id: string;
  readonly event_id: string;
  readonly received_at: string;
  readonly acknowledged_at: string | null;
}

export interface RuntimeRunRecord {
  readonly tenant_id: string;
  readonly handoff_id: string;
  readonly state: RuntimeRunState;
  readonly attempt: number;
  readonly owner: string | null;
  readonly fencing_token: number;
  readonly lease_expires_at: string | null;
  readonly last_progress_sequence: number;
  readonly result_digest: string | null;
  readonly result: RuntimeDriverResult | null;
  readonly failure_code: string | null;
  readonly updated_at: string;
}

export interface RuntimeCommandRecord {
  readonly tenant_id: string;
  readonly handoff_id: string;
  readonly command: "accept" | "decline" | "status" | "result";
  readonly idempotency_key: string;
  readonly resource_version: number;
  readonly recorded_at: string;
}

export interface AgentRuntimeStateStore {
  recordDelivery(input: RuntimeDeliveryRecord): Promise<{
    readonly created: boolean;
    readonly record: RuntimeDeliveryRecord;
  }>;
  markDeliveryAcknowledged(
    tenantId: string,
    deliveryId: string,
    acknowledgedAt: string,
  ): Promise<boolean>;
  createRunIfAbsent(
    tenantId: string,
    handoffId: string,
    now: string,
  ): Promise<{ readonly created: boolean; readonly run: RuntimeRunRecord }>;
  claimRun(input: {
    readonly tenant_id: string;
    readonly handoff_id: string;
    readonly owner: string;
    readonly now: string;
    readonly lease_seconds: number;
    readonly allowed_states: readonly RuntimeRunState[];
  }): Promise<RuntimeRunRecord | null>;
  /** Every mutation after claimRun must match owner and a monotonic fencing token. */
  renewRun(
    tenantId: string,
    handoffId: string,
    owner: string,
    fencingToken: number,
    now: string,
    leaseSeconds: number,
  ): Promise<boolean>;
  /** Every mutation after claimRun must match owner and a monotonic fencing token. */
  transitionRun(input: {
    readonly tenant_id: string;
    readonly handoff_id: string;
    readonly owner: string;
    readonly fencing_token: number;
    readonly expected_state: RuntimeRunState;
    readonly next_state: RuntimeRunState;
    readonly now: string;
    readonly result_digest?: string;
    readonly result?: RuntimeDriverResult;
    readonly failure_code?: string;
  }): Promise<boolean>;
  /** Every mutation after claimRun must match owner and a monotonic fencing token. */
  checkpointProgress(input: {
    readonly tenant_id: string;
    readonly handoff_id: string;
    readonly owner: string;
    readonly fencing_token: number;
    readonly sequence: number;
    readonly now: string;
  }): Promise<boolean>;
  recordCommand(input: RuntimeCommandRecord): Promise<{
    readonly created: boolean;
    readonly record: RuntimeCommandRecord;
  }>;
  listCommands(
    tenantId: string,
    handoffId: string,
  ): Promise<readonly RuntimeCommandRecord[]>;
  getRun(tenantId: string, handoffId: string): Promise<RuntimeRunRecord | null>;
  listRecoverable(
    tenantId: string,
    now: string,
    limit: number,
  ): Promise<readonly RuntimeRunRecord[]>;
  close(): Promise<void>;
}
