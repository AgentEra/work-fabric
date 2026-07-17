import { describe, expect, it, vi } from "vitest";
import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";
import { MemoryChannelRouteStore } from "@work-fabric/adapter-storage-memory";
import { MemorySubscriptionStore } from "@work-fabric/exchange-runtime";
import type { SignalAdapter } from "@work-fabric/exchange-spi";
import { FeishuPluginFactory, FeishuWebhookRegistry } from "../src/index.js";

const config = () => ({
  connector_id: "feishu-primary", external_tenant_id: "tenant-key-1", bot_open_id: "ou-bot",
  credentials: { app_id: "app-id", app_secret: "app-secret", verification_token: "verify", work_fabric_access_token: "wf-token" },
  inbound: { enabled: true, transport: "webhook", route_id: "primary", mention_only: true, intake_target: { actor_id: "actor-agent", endpoint_id: "endpoint-agent" } },
  outbound: { enabled: true, default_render_mode: "card", channels: {}, subscriptions: {} },
  identities: [{ external_open_id: "ou-human", actor_id: "actor-human", actor_type: "human", endpoint_id: "endpoint-human" }],
  worker: { poll_interval_ms: 1000, lease_seconds: 30, batch_limit: 100, max_attempts: 8 },
});

describe("FeishuPluginFactory", () => {
  it("composes isolated inbound and outbound seams and cleans registrations", async () => {
    const webhook = new FeishuWebhookRegistry();
    const signals = new Map<string, SignalAdapter>();
    const services = new Map<string, unknown>([
      ["workfabric.tenant_id", "tenant-1"],
      ["channel.routes", new MemoryChannelRouteStore()],
      ["exchange.subscriptions", new MemorySubscriptionStore()],
      ["connector.ingress", new MemoryConnectorIngressStore()],
      ["connector.command_sink", { manifest: { profile: "connector.command-sink.v1", adapter: "fake", capabilities: {} }, async execute() { return { kind: "accepted" as const, receipt_id: "r", event_ids: [] }; } }],
      ["channel.signal_registry", { register(id: string, adapter: SignalAdapter) { signals.set(id, adapter); }, unregister(id: string) { signals.delete(id); } }],
      ["feishu.webhook_registry", webhook],
      ["runtime.clock", { now: () => "2026-07-17T00:00:00.000Z", nowEpochSeconds: () => 1_784_275_200 }],
      ["runtime.fetch", vi.fn(async () => new Response('{"code":0,"tenant_access_token":"token","expire":7200}', { status: 200 }))],
    ]);
    const factory = new FeishuPluginFactory();
    const instance = await factory.create({ configuration_revision: "1", service: { get<T>(key: string) { if (!services.has(key)) throw new Error(key); return services.get(key) as T; } } }, { instance_id: "feishu-primary", type: factory.type, config: factory.validate(config()) });
    await instance.prepare();
    expect(await webhook.resolve("feishu-primary")).toMatchObject({ tenant_id: "tenant-1" });
    expect(signals.has("feishu-primary")).toBe(true);
    await instance.start();
    await instance.stop();
    expect(await webhook.resolve("feishu-primary")).toBeNull();
    expect(signals.has("feishu-primary")).toBe(false);
    expect(await instance.health()).toMatchObject({ state: "healthy" });
  });
});
