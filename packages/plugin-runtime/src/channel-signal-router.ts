import {
  SIGNAL_REQUIRED_CAPABILITIES,
  type ProtocolEvent,
  type SignalAdapter,
  type SignalDeliveryResult,
  type SignalDestination,
} from "@work-fabric/exchange-spi";

import { PluginRuntimeError } from "./errors.js";

export class ChannelSignalRouter implements SignalAdapter {
  readonly manifest = {
    profile: "exchange.signal.v1",
    adapter: "collaboration-channel-router",
    capabilities: Object.fromEntries(
      SIGNAL_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
    ),
  } as const;

  private readonly adapters = new Map<string, SignalAdapter>();

  register(instanceId: string, adapter: SignalAdapter): void {
    if (instanceId.length === 0 || instanceId.length > 128) {
      throw new PluginRuntimeError("invalid_plugin_instance");
    }
    if (this.adapters.has(instanceId)) {
      throw new PluginRuntimeError("duplicate_plugin_instance");
    }
    this.adapters.set(instanceId, adapter);
  }

  unregister(instanceId: string): void {
    this.adapters.delete(instanceId);
  }

  async deliver(
    event: ProtocolEvent,
    destination: SignalDestination,
  ): Promise<SignalDeliveryResult> {
    if (
      destination.binding !== "collaboration-channel" ||
      typeof destination.configuration.plugin_instance_id !== "string" ||
      typeof destination.configuration.route_mode !== "string"
    ) {
      return { kind: "permanent_failure", detail: "invalid_channel_destination" };
    }
    const adapter = this.adapters.get(destination.configuration.plugin_instance_id);
    if (adapter === undefined) {
      return { kind: "retryable_failure", detail: "plugin_instance_unavailable" };
    }
    try {
      return await adapter.deliver(structuredClone(event), structuredClone(destination));
    } catch {
      return { kind: "retryable_failure", detail: "plugin_instance_failure" };
    }
  }
}
