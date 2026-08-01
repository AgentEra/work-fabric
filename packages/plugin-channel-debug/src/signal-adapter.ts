import { createHash } from "node:crypto";
import type {
  ChannelHandoffSnapshotSource,
  ChannelRouteStore,
} from "@work-fabric/channel-spi";
import {
  DebugChannelStoreError,
  type DebugChannelStore,
} from "@work-fabric/debug-channel-spi";
import {
  SIGNAL_REQUIRED_CAPABILITIES,
  type ProtocolEvent,
  type SignalAdapter,
  type SignalDeliveryResult,
  type SignalDestination,
} from "@work-fabric/exchange-spi";

export interface DebugRouteAwareSignalAdapterOptions {
  readonly tenant_id: string;
  readonly plugin_instance_id: string;
  readonly routes: ChannelRouteStore;
  readonly diagnostics: DebugChannelStore;
  readonly handoff_snapshots: ChannelHandoffSnapshotSource;
  readonly clock: { now(): string };
  readonly retention_days: number;
}

function addDays(timestamp: string, days: number): string {
  const milliseconds = Date.parse(timestamp);
  if (
    !Number.isFinite(milliseconds)
    || !Number.isSafeInteger(days)
    || days < 1
    || days > 365
  ) {
    throw new TypeError("Debug capture retention is invalid");
  }
  return new Date(milliseconds + days * 86_400_000).toISOString();
}

function captureId(
  tenantId: string,
  pluginInstanceId: string,
  eventId: string,
  destinationId: string,
): string {
  return `debug_capture_${createHash("sha256")
    .update(tenantId)
    .update("\0")
    .update(pluginInstanceId)
    .update("\0")
    .update(eventId)
    .update("\0")
    .update(destinationId)
    .digest("base64url")}`;
}

export class DebugRouteAwareSignalAdapter implements SignalAdapter {
  readonly manifest = {
    profile: "exchange.signal.v1",
    adapter: "workfabric-debug-channel-route",
    capabilities: Object.fromEntries([
      ...SIGNAL_REQUIRED_CAPABILITIES,
      "canonical_event_capture",
      "handoff_snapshot_capture",
    ].map((capability) => [capability, true])),
  } as const;

  constructor(private readonly options: DebugRouteAwareSignalAdapterOptions) {}

  async deliver(
    event: ProtocolEvent,
    destination: SignalDestination,
  ): Promise<SignalDeliveryResult> {
    const configuration = destination.configuration;
    if (
      destination.binding !== "collaboration-channel"
      || configuration.plugin_instance_id !== this.options.plugin_instance_id
      || configuration.route_mode !== "handoff"
    ) {
      return {
        kind: "permanent_failure",
        detail: "invalid_debug_plugin_destination",
      };
    }
    if (event.wftenant !== undefined && event.wftenant !== this.options.tenant_id) {
      return { kind: "permanent_failure", detail: "tenant_mismatch" };
    }
    if (event.type !== "workfabric.handoff.result_returned.v1") {
      return { kind: "accepted" };
    }
    if (!Number.isSafeInteger(event.wfsequence) || event.wfsequence < 1) {
      return { kind: "permanent_failure", detail: "invalid_result_event" };
    }
    const handoffId = event.wfhandoff ?? event.subject;
    try {
      const route = await this.options.routes.get({
        tenant_id: this.options.tenant_id,
        plugin_instance_id: this.options.plugin_instance_id,
        handoff_id: handoffId,
      });
      if (route === null) {
        return { kind: "retryable_failure", detail: "channel_route_missing" };
      }
      const snapshot = await this.options.handoff_snapshots.get({
        tenant_id: this.options.tenant_id,
        handoff_id: handoffId,
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
      const capturedAt = this.options.clock.now();
      await this.options.diagnostics.appendCapture({
        capture: {
          tenant_id: this.options.tenant_id,
          plugin_instance_id: this.options.plugin_instance_id,
          capture_id: captureId(
            this.options.tenant_id,
            this.options.plugin_instance_id,
            event.id,
            destination.destination_id,
          ),
          conversation_id: route.external_conversation_id,
          event_id: event.id,
          destination_id: destination.destination_id,
          event: structuredClone(event),
          handoff_snapshot: structuredClone(snapshot.snapshot),
          captured_at: capturedAt,
          expires_at: addDays(capturedAt, this.options.retention_days),
        },
      });
      return { kind: "accepted" };
    } catch (error) {
      if (
        error instanceof DebugChannelStoreError
        && error.code === "capture_conflict"
      ) {
        return {
          kind: "permanent_failure",
          detail: "debug_capture_conflict",
        };
      }
      return {
        kind: "retryable_failure",
        detail: "debug_capture_unavailable",
      };
    }
  }
}
