import type { ExchangeAdapter } from "./capabilities.js";
import type { EventRecord } from "./events.js";
import type { SignalDestination } from "./signal.js";

export const SUBSCRIPTION_REQUIRED_CAPABILITIES = [
  "tenant_isolation",
  "state_filtering",
  "immutable_reads",
] as const;

export const SUBSCRIPTION_DELIVERY_REQUIRED_CAPABILITIES = [
  "tenant_isolation",
  "audience_enforcement",
  "default_deny",
] as const;

export interface SubscriptionFilter {
  readonly event_types: readonly string[];
  readonly actor_ids: readonly string[];
  readonly endpoint_ids: readonly string[];
  readonly thread_ids: readonly string[];
  readonly handoff_ids: readonly string[];
  readonly work_reference_uris: readonly string[];
  readonly capability_ids: readonly string[];
  readonly lifecycle_states: readonly string[];
}

export interface RuntimeSubscription {
  readonly subscription_id: string;
  readonly tenant_id: string;
  readonly owner: {
    readonly actor_id: string;
    readonly actor_type: "human" | "agent" | "system";
  };
  readonly endpoint_id: string;
  readonly filter: SubscriptionFilter;
  readonly destination: SignalDestination;
  readonly delivery_mode: "cursor_pull" | "sse" | "webhook" | string;
  readonly state: "active" | "suspended" | "closed";
  readonly max_attempts: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SubscriptionStore extends ExchangeAdapter {
  getSubscription(subscriptionId: string): Promise<RuntimeSubscription | null>;
  listActiveSubscriptions(
    tenantId: string,
  ): Promise<readonly RuntimeSubscription[]>;
  putSubscription(subscription: RuntimeSubscription): Promise<void>;
}

export type SubscriptionDeliveryDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string };

export interface SubscriptionDeliveryPolicy extends ExchangeAdapter {
  authorizeDelivery(
    subscription: RuntimeSubscription,
    event: EventRecord,
  ): Promise<SubscriptionDeliveryDecision>;
}
