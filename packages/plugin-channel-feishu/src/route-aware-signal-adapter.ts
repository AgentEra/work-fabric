import type {
  ChannelHandoffSnapshotSource,
  ChannelRouteStore,
} from "@work-fabric/channel-spi";
import { SIGNAL_REQUIRED_CAPABILITIES, type ProtocolEvent, type SignalAdapter, type SignalDeliveryResult, type SignalDestination } from "@work-fabric/exchange-spi";

export interface FeishuStaticChannel { readonly receive_id_type: "chat_id" | "open_id" | "user_id" | "union_id" | "email"; readonly receive_id: string; readonly render_mode?: "text" | "card"; }
export interface FeishuRouteAwareSignalAdapterOptions {
  readonly tenant_id: string; readonly plugin_instance_id: string; readonly connector_id: string;
  readonly external_tenant_id: string; readonly credential_ref: string; readonly render_mode: "text" | "card";
  readonly actor_id: string; readonly endpoint_id?: string; readonly routes: ChannelRouteStore;
  readonly handoff_snapshots: ChannelHandoffSnapshotSource;
  readonly static_channels: Readonly<Record<string, FeishuStaticChannel>>;
  readonly delegate: SignalAdapter;
}

export class FeishuRouteAwareSignalAdapter implements SignalAdapter {
  readonly manifest = { profile: "exchange.signal.v1", adapter: "feishu-channel-route", capabilities: Object.fromEntries(SIGNAL_REQUIRED_CAPABILITIES.map((item) => [item, true])) } as const;
  constructor(private readonly options: FeishuRouteAwareSignalAdapterOptions) {}
  async deliver(event: ProtocolEvent, destination: SignalDestination): Promise<SignalDeliveryResult> {
    const config = destination.configuration;
    if (destination.binding !== "collaboration-channel" || config.plugin_instance_id !== this.options.plugin_instance_id || (config.route_mode !== "handoff" && config.route_mode !== "static")) return { kind: "permanent_failure", detail: "invalid_feishu_plugin_destination" };
    if (event.wftenant !== undefined && event.wftenant !== this.options.tenant_id) return { kind: "permanent_failure", detail: "tenant_mismatch" };
    if (
      config.route_mode === "handoff" &&
      event.type !== "workfabric.handoff.result_returned.v1"
    ) return { kind: "accepted" };
    let receive: FeishuStaticChannel;
    if (config.route_mode === "handoff") {
      const handoffId = event.wfhandoff ?? event.subject;
      const route = await this.options.routes.get({ tenant_id: this.options.tenant_id, plugin_instance_id: this.options.plugin_instance_id, handoff_id: handoffId });
      if (route === null) return { kind: "retryable_failure", detail: "channel_route_missing" };
      receive = { receive_id_type: "chat_id", receive_id: route.external_conversation_id };
    } else {
      if (typeof config.channel_ref !== "string") return { kind: "permanent_failure", detail: "static_channel_missing" };
      const channel = this.options.static_channels[config.channel_ref];
      if (channel === undefined) return { kind: "permanent_failure", detail: "static_channel_missing" };
      receive = channel;
    }
    let deliveredEvent = structuredClone(event);
    if (event.type === "workfabric.handoff.result_returned.v1") {
      if (!Number.isSafeInteger(event.wfsequence) || event.wfsequence < 1) {
        return { kind: "permanent_failure", detail: "invalid_result_event" };
      }
      const snapshot = await this.options.handoff_snapshots.get({
        tenant_id: this.options.tenant_id,
        handoff_id: event.wfhandoff ?? event.subject,
        minimum_resource_version: event.wfsequence,
      });
      if (snapshot.kind === "not_ready") {
        return {
          kind: "retryable_failure",
          detail: "handoff_snapshot_not_ready",
        };
      }
      if (snapshot.kind === "not_found") {
        return {
          kind: "permanent_failure",
          detail: "handoff_snapshot_not_found",
        };
      }
      deliveredEvent = {
        ...deliveredEvent,
        data: { ...deliveredEvent.data, snapshot: snapshot.snapshot },
      };
    }
    return this.options.delegate.deliver(deliveredEvent, {
      destination_id: destination.destination_id,
      binding: "feishu",
      configuration: {
        credential_ref: this.options.credential_ref,
        connector_id: this.options.connector_id,
        external_tenant_id: this.options.external_tenant_id,
        actor_id: this.options.actor_id,
        actor_type: "agent",
        ...(this.options.endpoint_id === undefined ? {} : { endpoint_id: this.options.endpoint_id }),
        receive_id_type: receive.receive_id_type,
        receive_id: receive.receive_id,
        render_mode: receive.render_mode ?? this.options.render_mode,
        action_ttl_seconds: 900,
      },
    });
  }
}
