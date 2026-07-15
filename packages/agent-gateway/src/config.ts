import type {
  EndpointSessionOpenInput,
  SubscriptionDocument,
} from "@work-fabric/sdk-typescript";

import { AgentGatewayError } from "./errors.js";

export interface AgentGatewayConfig {
  readonly endpoint_id: string;
  readonly subscription: SubscriptionDocument;
  readonly open_session: EndpointSessionOpenInput;
  readonly inbox_refresh_ms: number;
  readonly max_active_partitions: number;
  readonly incoming_queue_capacity: number;
  readonly heartbeat_retry_count: number;
  readonly heartbeat_backoff_ms: number;
  readonly graceful_close_timeout_ms: number;
}

export interface NormalizedAgentGatewayConfig extends AgentGatewayConfig {
  readonly subscription: Readonly<SubscriptionDocument>;
  readonly open_session: Readonly<EndpointSessionOpenInput>;
}

function positive(value: number, field: string, maximum: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new AgentGatewayError("invalid_config", `${field} is outside its bound`);
  }
}

function nonNegative(value: number, field: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new AgentGatewayError("invalid_config", `${field} is outside its bound`);
  }
}

function emptyFilter(subscription: SubscriptionDocument): boolean {
  return Object.values(subscription.filter).every(
    (values) => Array.isArray(values) && values.length === 0,
  );
}

export function normalizeAgentGatewayConfig(
  input: AgentGatewayConfig,
): NormalizedAgentGatewayConfig {
  if (
    input.endpoint_id.length === 0 ||
    input.endpoint_id.length > 128 ||
    input.subscription.endpoint_id !== input.endpoint_id ||
    input.subscription.owner.actor_type !== "agent" ||
    input.subscription.delivery.mode !== "sse" ||
    input.subscription.state !== "active" ||
    !emptyFilter(input.subscription)
  ) {
    throw new AgentGatewayError(
      "invalid_config",
      "Gateway Subscription must be an active empty-filter Agent SSE Subscription for the Endpoint",
    );
  }
  positive(input.inbox_refresh_ms, "inbox_refresh_ms", 300_000);
  positive(input.max_active_partitions, "max_active_partitions", 128);
  positive(input.incoming_queue_capacity, "incoming_queue_capacity", 1_024);
  nonNegative(input.heartbeat_retry_count, "heartbeat_retry_count", 5);
  positive(input.heartbeat_backoff_ms, "heartbeat_backoff_ms", 30_000);
  positive(input.graceful_close_timeout_ms, "graceful_close_timeout_ms", 60_000);
  return Object.freeze({
    ...structuredClone(input),
    subscription: Object.freeze(structuredClone(input.subscription)),
    open_session: Object.freeze(structuredClone(input.open_session)),
  });
}
