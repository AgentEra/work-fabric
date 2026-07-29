import { createHash } from "node:crypto";
import {
  ChannelRouteStoreError,
  type ChannelRouteStore,
} from "@work-fabric/channel-spi";
import type {
  ConnectorAcceptedReceipt,
  ConnectorAcceptedReceiptHandler,
  ConnectorCommandResult,
} from "@work-fabric/connector-spi";
import {
  DebugChannelStoreError,
  type DebugChannelStore,
} from "@work-fabric/debug-channel-spi";
import type {
  RuntimeSubscription,
  SubscriptionStore,
} from "@work-fabric/exchange-spi";

export interface DebugIntakeReceiptHandlerOptions {
  readonly plugin_instance_id: string;
  readonly routes: ChannelRouteStore;
  readonly subscriptions: SubscriptionStore;
  readonly diagnostics: DebugChannelStore;
  readonly max_delivery_attempts: number;
  readonly on_handoff_ready?: (handoffId: string) => void;
}

function bounded(value: unknown, field: string, maximum = 512): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function subscriptionId(
  tenantId: string,
  pluginInstanceId: string,
  handoffId: string,
): string {
  return `channel_${createHash("sha256")
    .update(tenantId)
    .update("\0")
    .update(pluginInstanceId)
    .update("\0")
    .update(handoffId)
    .digest("base64url")}`;
}

export class DebugIntakeReceiptHandler
implements ConnectorAcceptedReceiptHandler {
  readonly manifest = {
    profile: "connector.accepted-receipt.v1",
    adapter: "workfabric-debug-intake",
    capabilities: {
      route_before_subscription: true,
      submission_correlation: true,
      idempotent_replay: true,
    },
  } as const;

  constructor(private readonly options: DebugIntakeReceiptHandlerOptions) {}

  async record(
    input: ConnectorAcceptedReceipt,
  ): Promise<ConnectorCommandResult> {
    if (input.command.operation !== "handoff.offer") {
      return {
        kind: "accepted",
        receipt_id: input.accepted.receipt_id,
        event_ids: input.accepted.event_ids,
      };
    }
    const resource = input.accepted.resource;
    if (resource === undefined || resource.resource_type !== "handoff") {
      return {
        kind: "permanent_failure",
        error_code: "handoff_resource_missing",
      };
    }
    if (input.command.identity.endpoint_id === undefined) {
      return {
        kind: "permanent_failure",
        error_code: "initiator_endpoint_missing",
      };
    }
    try {
      const conversationId = bounded(
        input.claim.envelope.payload.conversation_id,
        "conversation_id",
      );
      const submissionId = bounded(
        input.claim.envelope.payload.submission_id,
        "submission_id",
        96,
      );
      if (input.claim.envelope.external_event_id !== submissionId) {
        return {
          kind: "permanent_failure",
          error_code: "invalid_debug_route",
        };
      }
      await this.options.routes.put({
        route: {
          tenant_id: input.tenant_id,
          plugin_instance_id: this.options.plugin_instance_id,
          handoff_id: resource.resource_id,
          external_conversation_id: conversationId,
          external_message_id: submissionId,
          version: 1,
          created_at: input.claim.accepted_at,
          updated_at: input.claim.accepted_at,
        },
        expected_version: 0,
      });
      await this.options.diagnostics.linkHandoff({
        tenant_id: input.tenant_id,
        plugin_instance_id: this.options.plugin_instance_id,
        submission_id: submissionId,
        handoff_id: resource.resource_id,
        updated_at: input.claim.updated_at,
      });
      const subscription: RuntimeSubscription = {
        subscription_id: subscriptionId(
          input.tenant_id,
          this.options.plugin_instance_id,
          resource.resource_id,
        ),
        tenant_id: input.tenant_id,
        owner: {
          actor_id: input.command.identity.actor_id,
          actor_type: input.command.identity.actor_type,
        },
        endpoint_id: input.command.identity.endpoint_id,
        filter: {
          event_types: ["workfabric.handoff.result_returned.v1"],
          actor_ids: [],
          endpoint_ids: [],
          thread_ids: [],
          handoff_ids: [resource.resource_id],
          work_reference_uris: [],
          capability_ids: [],
          lifecycle_states: [],
        },
        destination: {
          destination_id: `handoff:${resource.resource_id}`,
          binding: "collaboration-channel",
          configuration: {
            plugin_instance_id: this.options.plugin_instance_id,
            route_mode: "handoff",
          },
        },
        delivery_mode: "webhook",
        state: "active",
        max_attempts: this.options.max_delivery_attempts,
        created_at: input.claim.accepted_at,
        updated_at: input.claim.accepted_at,
      };
      await this.options.subscriptions.putSubscription(subscription);
      this.options.on_handoff_ready?.(resource.resource_id);
      return {
        kind: "accepted",
        receipt_id: `debug-channel-route:${resource.resource_id}`,
        event_ids: [],
      };
    } catch (error) {
      if (
        error instanceof DebugChannelStoreError
        && error.code === "submission_not_found"
      ) {
        return {
          kind: "permanent_failure",
          error_code: "debug_submission_missing",
        };
      }
      if (
        (error instanceof ChannelRouteStoreError
          && error.code === "route_conflict")
        || (error instanceof DebugChannelStoreError
          && (
            error.code === "handoff_conflict"
            || error.code === "idempotency_conflict"
          ))
        || error instanceof TypeError
        || error instanceof RangeError
      ) {
        return {
          kind: "permanent_failure",
          error_code: "invalid_debug_route",
        };
      }
      return {
        kind: "retryable_failure",
        error_code: "debug_route_unavailable",
      };
    }
  }
}
