import type {
  CapabilityCandidate,
  CapabilityInvocationRequest,
  CapabilityInvocationResult,
} from "./capability-invocation.js";

export type CapabilityInvocationState =
  | "requested"
  | "offered"
  | "waiting"
  | "succeeded"
  | "rejected"
  | "failed"
  | "cancelled";

export interface CapabilityInvocationRecord {
  readonly tenant_id: string;
  readonly original_handoff_id: string;
  readonly invocation_id: string;
  readonly state: CapabilityInvocationState;
  readonly request_digest: `sha256:${string}`;
  readonly request: CapabilityInvocationRequest;
  readonly candidate: CapabilityCandidate | null;
  readonly auxiliary_handoff_id: string | null;
  readonly result: CapabilityInvocationResult | null;
  readonly attempt: number;
  readonly owner: string | null;
  readonly fencing_token: number;
  readonly lease_expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AgentCapabilityInvocationStore {
  createInvocationIfAbsent(input: {
    readonly tenant_id: string;
    readonly request: CapabilityInvocationRequest;
    readonly request_digest: `sha256:${string}`;
    readonly now: string;
  }): Promise<{
    readonly created: boolean;
    readonly record: CapabilityInvocationRecord;
  }>;
  claimInvocation(input: {
    readonly tenant_id: string;
    readonly original_handoff_id: string;
    readonly invocation_id: string;
    readonly owner: string;
    readonly now: string;
    readonly lease_seconds: number;
    readonly allowed_states: readonly CapabilityInvocationState[];
  }): Promise<CapabilityInvocationRecord | null>;
  transitionInvocation(input: {
    readonly tenant_id: string;
    readonly original_handoff_id: string;
    readonly invocation_id: string;
    readonly owner: string;
    readonly fencing_token: number;
    readonly expected_state: CapabilityInvocationState;
    readonly next_state: CapabilityInvocationState;
    readonly now: string;
    readonly candidate?: CapabilityCandidate;
    readonly auxiliary_handoff_id?: string;
    readonly result?: CapabilityInvocationResult;
  }): Promise<boolean>;
  getInvocation(
    tenantId: string,
    originalHandoffId: string,
    invocationId: string,
  ): Promise<CapabilityInvocationRecord | null>;
  listRecoverableInvocations(
    tenantId: string,
    now: string,
    limit: number,
  ): Promise<readonly CapabilityInvocationRecord[]>;
}
