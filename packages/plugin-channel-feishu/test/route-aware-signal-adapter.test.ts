import { describe, expect, it } from "vitest";
import { MemoryChannelRouteStore } from "@work-fabric/adapter-storage-memory";
import type { ProtocolEvent } from "@work-fabric/exchange-spi";
import { FeishuRouteAwareSignalAdapter } from "../src/index.js";

const event = { id: "event-1", subject: "handoff-1", wfhandoff: "handoff-1" } as ProtocolEvent;

describe("FeishuRouteAwareSignalAdapter", () => {
  it("resolves a Handoff route and sends to the original chat without credentials in the destination", async () => {
    const routes = new MemoryChannelRouteStore();
    await routes.put({ route: { tenant_id: "tenant-1", plugin_instance_id: "feishu-primary", handoff_id: "handoff-1", external_conversation_id: "oc-1", external_message_id: "om-1", version: 1, created_at: "2026-07-17T00:00:00.000Z", updated_at: "2026-07-17T00:00:00.000Z" }, expected_version: 0 });
    const observed: unknown[] = [];
    const adapter = new FeishuRouteAwareSignalAdapter({
      tenant_id: "tenant-1", plugin_instance_id: "feishu-primary", connector_id: "feishu-primary",
      external_tenant_id: "tenant-key-1", credential_ref: "private-ref", render_mode: "card",
      actor_id: "actor-channel", routes, static_channels: {},
      delegate: { manifest: { profile: "exchange.signal.v1", adapter: "fake", capabilities: {} }, async deliver(_event, destination) { observed.push(destination); return { kind: "accepted" }; } },
    });
    await expect(adapter.deliver(event, { destination_id: "handoff:handoff-1", binding: "collaboration-channel", configuration: { plugin_instance_id: "feishu-primary", route_mode: "handoff" } })).resolves.toEqual({ kind: "accepted" });
    expect(observed[0]).toMatchObject({ binding: "feishu", configuration: { receive_id_type: "chat_id", receive_id: "oc-1", credential_ref: "private-ref" } });
  });

  it("classifies a missing route as retryable and another instance as permanent", async () => {
    const adapter = new FeishuRouteAwareSignalAdapter({ tenant_id: "tenant-1", plugin_instance_id: "feishu-primary", connector_id: "feishu-primary", external_tenant_id: "tenant-key-1", credential_ref: "ref", render_mode: "text", actor_id: "actor", routes: new MemoryChannelRouteStore(), static_channels: {}, delegate: { manifest: { profile: "exchange.signal.v1", adapter: "fake", capabilities: {} }, async deliver() { return { kind: "accepted" }; } } });
    await expect(adapter.deliver(event, { destination_id: "1", binding: "collaboration-channel", configuration: { plugin_instance_id: "feishu-primary", route_mode: "handoff" } })).resolves.toEqual({ kind: "retryable_failure", detail: "channel_route_missing" });
    await expect(adapter.deliver(event, { destination_id: "2", binding: "collaboration-channel", configuration: { plugin_instance_id: "other", route_mode: "handoff" } })).resolves.toEqual({ kind: "permanent_failure", detail: "invalid_feishu_plugin_destination" });
  });
});
