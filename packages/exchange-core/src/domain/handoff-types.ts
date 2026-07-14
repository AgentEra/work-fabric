import type { ContextReference, JsonObject } from "@work-fabric/exchange-spi";

export type ActorType = "human" | "agent" | "system";

export interface ActorRef {
  readonly actor_id: string;
  readonly actor_type: ActorType;
}

export type HandoffTarget =
  | { readonly actor_id: string }
  | { readonly endpoint_id: string }
  | { readonly capability_requirement: JsonObject };

export interface AcceptanceCriterion {
  readonly criterion_id: string;
  readonly description: string;
  readonly required: boolean;
  readonly result_schema_ref: string | null;
  readonly required_evidence_types: readonly string[];
  readonly extensions?: JsonObject;
}

export interface AuthorityScope {
  readonly delegation_id: string;
  readonly scopes: readonly string[];
  readonly resource_refs: readonly string[];
  readonly expires_at: string;
  readonly may_redelegate: boolean;
  readonly extensions?: JsonObject;
}

export type HandoffLifecycleState =
  | "offered"
  | "accepted"
  | "result_returned"
  | "verified"
  | "rework_requested"
  | "closed"
  | "declined"
  | "expired"
  | "cancelled"
  | "transferred";

export interface HandoffPackage {
  readonly work_reference: JsonObject;
  readonly target: HandoffTarget;
  readonly intent: readonly JsonObject[];
  readonly context: ContextReference | null;
  readonly authority_scope: AuthorityScope;
  readonly acceptance_criteria: readonly AcceptanceCriterion[];
  readonly verifier: ActorRef;
  readonly priority: "low" | "normal" | "high" | "critical";
  readonly accept_by: string;
  readonly result_due_at: string;
}

export interface HandoffState {
  readonly handoff_id: string;
  readonly thread_id: string;
  readonly resource_version: number;
  readonly lifecycle_state: HandoffLifecycleState;
  readonly initiator: ActorRef;
  readonly recipient: ActorRef | null;
  readonly verifier: ActorRef;
  readonly current_responsible_actor: ActorRef | null;
  readonly package: HandoffPackage;
  readonly result: JsonObject | null;
  readonly parent_handoff_id: string | null;
  readonly child_handoff_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}
