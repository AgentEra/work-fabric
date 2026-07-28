import type { JsonObject } from "@work-fabric/exchange-spi";

export interface ConversationContextRequest {
  readonly tenant_id: string;
  readonly provider_family: string;
  readonly external_tenant_id: string;
  readonly conversation_id: string;
  readonly trigger_message_id: string;
  readonly thread_id?: string;
  readonly root_message_id?: string;
  readonly triggered_at: string;
  readonly represented_actor_id: string;
  readonly recipient_actor_id: string;
  readonly recipient_endpoint_id: string;
  readonly delegation_id: string;
  readonly delegation_scopes: readonly string[];
  readonly delegation_expires_at: string;
  readonly policy: {
    readonly lookback_seconds: number;
    readonly maximum_messages: number;
    readonly maximum_bytes: number;
  };
}

export type ConversationContextMaterialization =
  | {
      readonly kind: "materialized";
      readonly bundle: JsonObject;
    }
  | {
      readonly kind: "temporarily_unavailable";
      readonly code: string;
      readonly retry_after?: string;
    }
  | {
      readonly kind: "permanently_unavailable";
      readonly code: string;
    };

/**
 * Provider-neutral port consumed by collaboration Channels. Implementations
 * own content access, decoding, bounding and provenance.
 */
export interface ConversationContextMaterializer {
  materialize(
    request: ConversationContextRequest,
    signal: AbortSignal,
  ): Promise<ConversationContextMaterialization>;
}
