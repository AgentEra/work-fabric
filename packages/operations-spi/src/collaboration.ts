import type {
  ExchangeAdapter,
  JsonObject,
} from "@work-fabric/exchange-spi";

export const OPERATIONS_STORE_REQUIRED_CAPABILITIES = [
  "tenant_isolation",
  "monotonic_projection",
  "partition_reset",
  "deterministic_cursor_pagination",
  "immutable_reads",
  "append_only_audit",
] as const;

export type ParticipantType = "human" | "agent" | "system";

export interface ParticipantRef {
  readonly actor_id: string;
  readonly actor_type: ParticipantType;
}

export interface SafeTargetBinding {
  readonly actor: ParticipantRef | null;
  readonly endpoint_id: string | null;
  readonly resolved_at: string;
}

export type ResponsibilityLifecycleState =
  | "target_resolution_pending"
  | "target_unavailable"
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

export interface ResponsibilityView {
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly thread_id: string;
  readonly handoff_id: string;
  readonly stream_version: number;
  readonly lifecycle_state: ResponsibilityLifecycleState;
  readonly initiator: ParticipantRef;
  readonly recipient: ParticipantRef | null;
  readonly current_responsible_actor: ParticipantRef | null;
  readonly verifier: ParticipantRef;
  readonly target_binding: SafeTargetBinding | null;
  readonly work_reference: JsonObject;
  readonly priority: "low" | "normal" | "high" | "critical";
  readonly accept_by: string;
  readonly result_due_at: string;
  readonly latest_status: JsonObject | null;
  readonly parent_handoff_id: string | null;
  readonly child_handoff_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TimelineEntry {
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly partition_position: number;
  readonly handoff_id: string;
  readonly thread_id: string;
  readonly stream_version: number;
  readonly event_id: string;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly subject: string;
  readonly source: ParticipantRef | null;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly change: JsonObject;
}

export type RelationshipKind =
  | "thread_membership"
  | "parent_child"
  | "responsibility"
  | "target";

export interface RelationshipView {
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly relationship_id: string;
  readonly relationship_kind: RelationshipKind;
  readonly source_id: string;
  readonly target_id: string;
  readonly handoff_id: string;
  readonly stream_version: number;
  readonly observed_at: string;
}

export interface ProjectionFreshness {
  readonly projector_id: string;
  readonly partition_id: string;
  readonly projected_position: number;
  readonly journal_position: number;
  readonly observed_at: string;
}

export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly next_cursor: string | null;
  readonly freshness: ProjectionFreshness;
}

export interface ResponsibilityQuery {
  readonly tenant_id: string;
  readonly partition_id?: string;
  readonly thread_id?: string;
  readonly responsible_actor_id?: string;
  readonly lifecycle_states?: readonly ResponsibilityLifecycleState[];
  readonly priorities?: readonly ResponsibilityView["priority"][];
  readonly due_before?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface TimelineQuery {
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly handoff_id?: string;
  readonly thread_id?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface RelationshipQuery {
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly handoff_id?: string;
  readonly thread_id?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface CollaborationViewStore extends ExchangeAdapter {
  putResponsibility(view: ResponsibilityView): Promise<void>;
  putTimeline(entry: TimelineEntry): Promise<void>;
  putRelationship(view: RelationshipView): Promise<void>;
  getResponsibility(
    tenantId: string,
    handoffId: string,
  ): Promise<ResponsibilityView | null>;
  listResponsibilities(
    query: ResponsibilityQuery,
  ): Promise<CursorPage<ResponsibilityView>>;
  listTimeline(query: TimelineQuery): Promise<CursorPage<TimelineEntry>>;
  listRelationships(
    query: RelationshipQuery,
  ): Promise<CursorPage<RelationshipView>>;
  clearPartition(tenantId: string, partitionId: string): Promise<void>;
}
