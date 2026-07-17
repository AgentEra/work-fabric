import { createHash } from "node:crypto";
import { ChannelRouteStoreError, type ChannelRouteStore } from "@work-fabric/channel-spi";
import type { ConnectorAcceptedReceipt, ConnectorAcceptedReceiptHandler, ConnectorCommandResult } from "@work-fabric/connector-spi";
import type { RuntimeSubscription, SubscriptionStore } from "@work-fabric/exchange-spi";

export interface FeishuIntakeReceiptHandlerOptions {
  readonly plugin_instance_id: string;
  readonly routes: ChannelRouteStore;
  readonly subscriptions: SubscriptionStore;
  readonly actor_type_for: (actorId: string) => "human" | "agent" | "system";
  readonly max_delivery_attempts: number;
  readonly on_handoff_ready?: (handoffId: string) => void;
}
const string = (value: unknown): string => { if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new TypeError("route field invalid"); return value; };
const subscriptionId = (tenant: string, plugin: string, handoff: string) => `channel_${createHash("sha256").update(tenant).update("\0").update(plugin).update("\0").update(handoff).digest("base64url")}`;

export class FeishuIntakeReceiptHandler implements ConnectorAcceptedReceiptHandler {
  readonly manifest = { profile: "connector.accepted-receipt.v1", adapter: "feishu-intake", capabilities: { route_before_subscription: true, idempotent_replay: true } } as const;
  constructor(private readonly options: FeishuIntakeReceiptHandlerOptions) {}
  async record(input: ConnectorAcceptedReceipt): Promise<ConnectorCommandResult> {
    if (input.command.operation !== "handoff.offer") return { kind: "accepted", receipt_id: input.accepted.receipt_id, event_ids: input.accepted.event_ids };
    const resource = input.accepted.resource;
    if (resource === undefined || resource.resource_type !== "handoff") return { kind: "permanent_failure", error_code: "handoff_resource_missing" };
    if (input.command.identity.endpoint_id === undefined) return { kind: "permanent_failure", error_code: "initiator_endpoint_missing" };
    try {
      const chatId = string(input.claim.envelope.payload.chat_id);
      const messageId = string(input.claim.envelope.payload.message_id);
      await this.options.routes.put({ route: {
        tenant_id: input.tenant_id, plugin_instance_id: this.options.plugin_instance_id,
        handoff_id: resource.resource_id, external_conversation_id: chatId,
        external_message_id: messageId, version: 1,
        created_at: input.claim.accepted_at, updated_at: input.claim.accepted_at,
      }, expected_version: 0 });
      const subscription: RuntimeSubscription = {
        subscription_id: subscriptionId(input.tenant_id, this.options.plugin_instance_id, resource.resource_id),
        tenant_id: input.tenant_id,
        owner: { actor_id: input.command.identity.actor_id, actor_type: this.options.actor_type_for(input.command.identity.actor_id) },
        endpoint_id: input.command.identity.endpoint_id,
        filter: { event_types: [], actor_ids: [], endpoint_ids: [], thread_ids: [], handoff_ids: [resource.resource_id], work_reference_uris: [], capability_ids: [], lifecycle_states: [] },
        destination: { destination_id: `handoff:${resource.resource_id}`, binding: "collaboration-channel", configuration: { plugin_instance_id: this.options.plugin_instance_id, route_mode: "handoff" } },
        delivery_mode: "webhook", state: "active", max_attempts: this.options.max_delivery_attempts,
        created_at: input.claim.accepted_at, updated_at: input.claim.accepted_at,
      };
      await this.options.subscriptions.putSubscription(subscription);
      this.options.on_handoff_ready?.(resource.resource_id);
      return { kind: "accepted", receipt_id: `channel-route:${resource.resource_id}`, event_ids: [] };
    } catch (error) {
      return error instanceof ChannelRouteStoreError && error.code === "route_conflict" || error instanceof TypeError || error instanceof RangeError
        ? { kind: "permanent_failure", error_code: "invalid_channel_route" }
        : { kind: "retryable_failure", error_code: "channel_route_unavailable" };
    }
  }
}
