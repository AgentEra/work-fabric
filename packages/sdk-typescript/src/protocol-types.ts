import type { JsonObject, ProtocolEvent } from "@work-fabric/exchange-spi";
import type { EventDeliveryDocument } from "@work-fabric/exchange-runtime";

export type {
  CommandEnvelope,
  OperationResult,
} from "@work-fabric/exchange-core";
export type {
  EventDeliveryDocument as EventDelivery,
  PullResult,
  AckResult,
} from "@work-fabric/exchange-runtime";
export type {
  DeliveryAttempt,
  ProjectionFailureRecord,
  RuntimeSubscription,
  HandoffReadModel,
  JsonObject,
  ProtocolEvent,
} from "@work-fabric/exchange-spi";

export interface SubscriptionDocument {
  readonly subscription_id: string;
  readonly owner: {
    readonly actor_id: string;
    readonly actor_type: "human" | "agent" | "system";
  };
  readonly endpoint_id: string;
  readonly filter: {
    readonly event_types: readonly string[];
    readonly actor_ids: readonly string[];
    readonly endpoint_ids: readonly string[];
    readonly thread_ids: readonly string[];
    readonly handoff_ids: readonly string[];
    readonly work_reference_uris: readonly string[];
    readonly capability_ids: readonly string[];
    readonly lifecycle_states: readonly string[];
  };
  readonly delivery: {
    readonly mode: "cursor_pull" | "sse" | "webhook";
  };
  readonly state: "active" | "suspended" | "closed";
  readonly cursor: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly extensions?: JsonObject;
}

export interface DeliveryAck {
  readonly delivery_id: string;
  readonly subscription_id: string;
  readonly outcome: "acknowledged" | "retry" | "rejected";
  readonly acknowledged_at: string;
  readonly last_event_id?: string;
  readonly cursor?: string;
  readonly details?: JsonObject;
  readonly extensions?: JsonObject;
}

export interface SseDeliveryFrame {
  readonly id: string;
  readonly event: "workfabric.delivery";
  readonly data: EventDeliveryDocument;
}
