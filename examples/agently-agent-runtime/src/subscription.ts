import type { AgentGatewayConfig } from "@work-fabric/agent-gateway";
import type { EndpointRegistration, SubscriptionDocument } from "@work-fabric/sdk-typescript";

import { DAILY_ASSISTANT_CAPABILITIES, DAILY_ASSISTANT_CAPABILITY_IDS } from "./capabilities.js";

export function dailyAssistantGatewayConfig(input: {
  readonly actorId: string;
  readonly endpointId: string;
  readonly subscriptionId: string;
  readonly queueCapacity: number;
}): AgentGatewayConfig {
  const now = new Date().toISOString();
  const subscription: SubscriptionDocument = {
    subscription_id: input.subscriptionId,
    owner: { actor_id: input.actorId, actor_type: "agent" }, endpoint_id: input.endpointId,
    filter: { event_types: [], actor_ids: [], endpoint_ids: [], thread_ids: [], handoff_ids: [], work_reference_uris: [], capability_ids: [], lifecycle_states: [] },
    delivery: { mode: "sse" }, state: "active", cursor: null, created_at: now, updated_at: now,
  };
  return {
    endpoint_id: input.endpointId, subscription,
    open_session: { client_session_id: `daily-assistant-${process.pid}`, protocol_version: "1", capabilities: DAILY_ASSISTANT_CAPABILITIES, availability: "available", requested_lease_seconds: 60, expected_registration_version: 1 },
    inbox_refresh_ms: 5_000, max_active_partitions: 8, incoming_queue_capacity: input.queueCapacity,
    heartbeat_retry_count: 2, heartbeat_backoff_ms: 250, graceful_close_timeout_ms: 10_000,
  };
}

export function dailyAssistantEndpointRegistration(): EndpointRegistration {
  return {
    endpoint_id: "endpoint-intake-agent", actor: { actor_id: "actor-intake-agent", actor_type: "agent" },
    endpoint_type: "agent", display_name: "Daily Assistant", protocol_versions: ["1"], bindings: [],
    allowed_capability_ids: DAILY_ASSISTANT_CAPABILITY_IDS,
    limits: { max_inline_content_bytes: 262_144, max_concurrent_handoffs: 2 }, administrative_state: "active", registration_version: 1,
  };
}
