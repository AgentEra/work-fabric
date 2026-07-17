import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";
import { MemoryChannelRouteStore } from "@work-fabric/adapter-storage-memory";
import type {
  FeishuLongConnectionClient,
  FeishuLongConnectionClientFactory,
  FeishuLongConnectionHandler,
  FeishuLongConnectionState,
  FeishuLongConnectionStatus,
} from "@work-fabric/connector-feishu";
import { MemorySubscriptionStore } from "@work-fabric/exchange-runtime";
import type { JsonObject } from "@work-fabric/exchange-spi";
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

const longConnectionConfig = (enabled = true) => ({
  ...config(),
  credentials: {
    app_id: "app-id",
    app_secret: "app-secret",
    work_fabric_access_token: "wf-token",
  },
  inbound: {
    enabled,
    transport: "long_connection",
    mention_only: true,
    intake_target: { actor_id: "actor-agent", endpoint_id: "endpoint-agent" },
  },
});

const longConnectionBody: JsonObject = {
  schema: "2.0",
  header: {
    event_id: "event-message-1",
    event_type: "im.message.receive_v1",
    create_time: "1784160000000",
    tenant_key: "tenant-key-1",
  },
  event: {
    sender: {
      sender_id: { open_id: "ou-human" },
      sender_type: "user",
    },
    message: {
      message_id: "om-message-1",
      chat_id: "oc-chat-1",
      chat_type: "group",
      message_type: "text",
      content: "{\"text\":\"hello\"}",
    },
  },
};

function statusFor(state: FeishuLongConnectionState): FeishuLongConnectionStatus {
  return {
    state,
    code: state === "failed" ? "connection_failed" : state,
    reconnect_attempts: 0,
    changed_at: "2026-07-17T00:00:00.000Z",
  };
}

class FakeLongConnectionClient implements FeishuLongConnectionClient {
  handler: FeishuLongConnectionHandler | undefined;
  state: FeishuLongConnectionState = "connecting";
  startCalls = 0;
  stopCalls = 0;
  onStart: (() => Promise<void>) | undefined;
  onStop: (() => Promise<void>) | undefined;

  async start(handler: FeishuLongConnectionHandler): Promise<void> {
    this.handler = handler;
    this.startCalls += 1;
    await this.onStart?.();
  }

  status(): FeishuLongConnectionStatus {
    return statusFor(this.state);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    await this.onStop?.();
  }
}

function createLongConnectionFixture(options: {
  readonly enabled?: boolean;
  readonly ingress?: MemoryConnectorIngressStore;
  readonly signalEvents?: string[];
} = {}) {
  const client = new FakeLongConnectionClient();
  const createClient = vi.fn(() => client);
  const clientFactory: FeishuLongConnectionClientFactory = { create: createClient };
  const ingress = options.ingress ?? new MemoryConnectorIngressStore();
  const webhook = new FeishuWebhookRegistry();
  const signalEvents = options.signalEvents ?? [];
  const requested: string[] = [];
  const services = new Map<string, unknown>([
    ["workfabric.tenant_id", "tenant-1"],
    ["channel.routes", new MemoryChannelRouteStore()],
    ["exchange.subscriptions", new MemorySubscriptionStore()],
    ["connector.ingress", ingress],
    ["connector.command_sink", { manifest: { profile: "connector.command-sink.v1", adapter: "fake", capabilities: {} }, async execute() { return { kind: "accepted" as const, receipt_id: "r", event_ids: [] }; } }],
    ["channel.signal_registry", { register() { signalEvents.push("signal_register"); }, unregister() { signalEvents.push("signal_unregister"); } }],
    ["feishu.webhook_registry", webhook],
    ["feishu.long_connection_client_factory", clientFactory],
    ["runtime.clock", { now: () => "2026-07-17T00:00:00.000Z", nowEpochSeconds: () => 1_784_275_200 }],
    ["runtime.fetch", vi.fn()],
    ["runtime.handoff_wakeup", () => {}],
  ]);
  const context = {
    configuration_revision: "1",
    service: {
      get<T>(key: string) {
        requested.push(key);
        if (!services.has(key)) throw new Error(key);
        return services.get(key) as T;
      },
    },
  };
  return { client, createClient, ingress, webhook, requested, signalEvents, context };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FeishuPluginFactory", () => {
  it("composes isolated inbound and outbound seams and cleans registrations", async () => {
    const webhook = new FeishuWebhookRegistry();
    const signals = new Map<string, SignalAdapter>();
    const subscriptions = new MemorySubscriptionStore();
    const services = new Map<string, unknown>([
      ["workfabric.tenant_id", "tenant-1"],
      ["channel.routes", new MemoryChannelRouteStore()],
      ["exchange.subscriptions", subscriptions],
      ["connector.ingress", new MemoryConnectorIngressStore()],
      ["connector.command_sink", { manifest: { profile: "connector.command-sink.v1", adapter: "fake", capabilities: {} }, async execute() { return { kind: "accepted" as const, receipt_id: "r", event_ids: [] }; } }],
      ["channel.signal_registry", { register(id: string, adapter: SignalAdapter) { signals.set(id, adapter); }, unregister(id: string) { signals.delete(id); } }],
      ["feishu.webhook_registry", webhook],
      ["runtime.clock", { now: () => "2026-07-17T00:00:00.000Z", nowEpochSeconds: () => 1_784_275_200 }],
      ["runtime.fetch", vi.fn(async () => new Response('{"code":0,"tenant_access_token":"token","expire":7200}', { status: 200 }))],
      ["runtime.handoff_wakeup", () => {}],
    ]);
    const factory = new FeishuPluginFactory();
    const requested: string[] = [];
    const instance = await factory.create({ configuration_revision: "1", service: { get<T>(key: string) { requested.push(key); if (!services.has(key)) throw new Error(key); return services.get(key) as T; } } }, { instance_id: "feishu-primary", type: factory.type, config: factory.validate(config()) });
    expect(requested).not.toContain("feishu.long_connection_client_factory");
    await instance.prepare();
    expect(await webhook.resolve("feishu-primary")).toMatchObject({ tenant_id: "tenant-1" });
    expect(signals.has("feishu-primary")).toBe(true);
    await instance.start();
    await instance.stop();
    expect(await webhook.resolve("feishu-primary")).toBeNull();
    expect(signals.has("feishu-primary")).toBe(false);
    expect(await instance.health()).toMatchObject({ state: "healthy" });
  });

  it("composes enabled long connection credentials without preparing network resources", async () => {
    const fixture = createLongConnectionFixture();
    const factory = new FeishuPluginFactory();
    const instance = await factory.create(fixture.context, {
      instance_id: "feishu-primary",
      type: factory.type,
      config: factory.validate(longConnectionConfig()),
    });

    expect(fixture.requested.filter((key) => key === "feishu.long_connection_client_factory")).toHaveLength(1);
    expect(fixture.createClient).toHaveBeenCalledWith({
      app_id: "app-id",
      app_secret: "app-secret",
      instance_id: "feishu-primary",
    });
    await instance.prepare();
    expect(fixture.client.startCalls).toBe(0);
    expect(await fixture.webhook.resolve("feishu-primary")).toBeNull();
  });

  it("starts the long source and worker and persists delivered bodies in real ingress", async () => {
    vi.useFakeTimers();
    const fixture = createLongConnectionFixture();
    const claim = vi.spyOn(fixture.ingress, "claim");
    const factory = new FeishuPluginFactory();
    const instance = await factory.create(fixture.context, {
      instance_id: "feishu-primary",
      type: factory.type,
      config: factory.validate(longConnectionConfig()),
    });

    await instance.prepare();
    await instance.start();
    expect(fixture.client.startCalls).toBe(1);
    await expect(fixture.client.handler?.(longConnectionBody)).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
    });
    expect((await fixture.ingress.list({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      limit: 10,
    })).items).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(claim).toHaveBeenCalledTimes(1);
    await instance.stop();
  });

  it("combines long connection and worker health independently", async () => {
    vi.useFakeTimers();
    const fixture = createLongConnectionFixture();
    vi.spyOn(fixture.ingress, "claim").mockRejectedValueOnce(new Error("worker unavailable"));
    const factory = new FeishuPluginFactory();
    const instance = await factory.create(fixture.context, {
      instance_id: "feishu-primary",
      type: factory.type,
      config: factory.validate(longConnectionConfig()),
    });
    await instance.prepare();
    await instance.start();

    expect(await instance.health()).toEqual({
      state: "degraded",
      code: "feishu_long_connection_connecting",
    });
    fixture.client.state = "connected";
    expect(await instance.health()).toEqual({ state: "healthy", code: "ready" });
    fixture.client.state = "failed";
    expect(await instance.health()).toEqual({
      state: "unhealthy",
      code: "feishu_long_connection_failed",
    });

    fixture.client.state = "connected";
    await vi.advanceTimersByTimeAsync(0);
    expect(await instance.health()).toEqual({
      state: "degraded",
      code: "connector_turn_failed",
    });
    await instance.stop();
  });

  it("stops the long source, drains the worker, then unregisters prepared resources", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const fixture = createLongConnectionFixture({ signalEvents: events });
    let releaseWorker!: (claims: readonly []) => void;
    const workerDrain = new Promise<readonly []>((resolve) => { releaseWorker = resolve; });
    vi.spyOn(fixture.ingress, "claim").mockImplementationOnce(async () => {
      events.push("worker_started");
      return workerDrain;
    });
    let releaseSource!: () => void;
    const sourceDrain = new Promise<void>((resolve) => { releaseSource = resolve; });
    fixture.client.onStop = async () => {
      events.push("source_stop_started");
      await sourceDrain;
      events.push("source_stopped");
    };
    const factory = new FeishuPluginFactory();
    const instance = await factory.create(fixture.context, {
      instance_id: "feishu-primary",
      type: factory.type,
      config: factory.validate(longConnectionConfig()),
    });
    await instance.prepare();
    await instance.start();
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    expect(events).toContain("worker_started");

    const stopping = instance.stop();
    expect(events).toContain("source_stop_started");
    expect(events).not.toContain("signal_unregister");
    releaseSource();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toContain("source_stopped");
    expect(events).not.toContain("signal_unregister");
    releaseWorker([]);
    await stopping;
    expect(events.indexOf("source_stopped")).toBeLessThan(events.indexOf("signal_unregister"));
  });

  it("does not create a long client or schedule a worker when inbound is disabled", async () => {
    vi.useFakeTimers();
    const fixture = createLongConnectionFixture({ enabled: false });
    const factory = new FeishuPluginFactory();
    const configured = longConnectionConfig(false);
    configured.outbound.enabled = false;
    const instance = await factory.create(fixture.context, {
      instance_id: "feishu-primary",
      type: factory.type,
      config: factory.validate(configured),
    });
    await instance.prepare();
    await instance.start();

    expect(fixture.requested).not.toContain("feishu.long_connection_client_factory");
    expect(fixture.createClient).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await instance.stop();
  });

  it("rolls back Webhook registration when subscription preparation fails", async () => {
    const webhook = new FeishuWebhookRegistry();
    const subscriptions = new MemorySubscriptionStore();
    vi.spyOn(subscriptions, "getSubscription").mockRejectedValueOnce(new Error("subscription unavailable"));
    const services = new Map<string, unknown>([
      ["workfabric.tenant_id", "tenant-1"],
      ["channel.routes", new MemoryChannelRouteStore()],
      ["exchange.subscriptions", subscriptions],
      ["connector.ingress", new MemoryConnectorIngressStore()],
      ["connector.command_sink", { manifest: { profile: "connector.command-sink.v1", adapter: "fake", capabilities: {} }, async execute() { return { kind: "accepted" as const, receipt_id: "r", event_ids: [] }; } }],
      ["channel.signal_registry", { register() {}, unregister() {} }],
      ["feishu.webhook_registry", webhook],
      ["runtime.clock", { now: () => "2026-07-17T00:00:00.000Z", nowEpochSeconds: () => 1_784_275_200 }],
      ["runtime.fetch", vi.fn()],
      ["runtime.handoff_wakeup", () => {}],
    ]);
    const configured = config();
    configured.outbound.channels = { project: { receive_id_type: "chat_id", receive_id: "oc-project" } };
    configured.outbound.subscriptions = {
      results: {
        channel_ref: "project",
        owner: { actor_id: "actor-owner", actor_type: "human", endpoint_id: "endpoint-owner" },
        filter: {},
      },
    };
    const factory = new FeishuPluginFactory();
    const instance = await factory.create({ configuration_revision: "1", service: { get<T>(key: string) { if (!services.has(key)) throw new Error(key); return services.get(key) as T; } } }, {
      instance_id: "feishu-primary",
      type: factory.type,
      config: factory.validate(configured),
    });

    await expect(instance.prepare()).rejects.toThrow("subscription unavailable");
    await instance.stop();

    expect(await webhook.resolve("feishu-primary")).toBeNull();
  });

  it("rolls back partially installed Signal and Webhook registrations", async () => {
    const webhook = new FeishuWebhookRegistry();
    const signals = new Set<string>();
    const services = new Map<string, unknown>([
      ["workfabric.tenant_id", "tenant-1"],
      ["channel.routes", new MemoryChannelRouteStore()],
      ["exchange.subscriptions", new MemorySubscriptionStore()],
      ["connector.ingress", new MemoryConnectorIngressStore()],
      ["connector.command_sink", { manifest: { profile: "connector.command-sink.v1", adapter: "fake", capabilities: {} }, async execute() { return { kind: "accepted" as const, receipt_id: "r", event_ids: [] }; } }],
      ["channel.signal_registry", {
        register(id: string) { signals.add(id); throw new Error("signal register failed"); },
        unregister(id: string) { signals.delete(id); },
      }],
      ["feishu.webhook_registry", webhook],
      ["runtime.clock", { now: () => "2026-07-17T00:00:00.000Z", nowEpochSeconds: () => 1_784_275_200 }],
      ["runtime.fetch", vi.fn()],
      ["runtime.handoff_wakeup", () => {}],
    ]);
    const factory = new FeishuPluginFactory();
    const instance = await factory.create({ configuration_revision: "1", service: { get<T>(key: string) { if (!services.has(key)) throw new Error(key); return services.get(key) as T; } } }, {
      instance_id: "feishu-primary",
      type: factory.type,
      config: factory.validate(config()),
    });

    await expect(instance.prepare()).rejects.toThrow("signal register failed");
    await instance.stop();

    expect(signals.has("feishu-primary")).toBe(false);
    expect(await webhook.resolve("feishu-primary")).toBeNull();
  });

  it("stops a long client after start rejects and preserves the start failure", async () => {
    vi.useFakeTimers();
    const fixture = createLongConnectionFixture();
    fixture.client.onStart = () => Promise.reject(new Error("long start failed"));
    const factory = new FeishuPluginFactory();
    const instance = await factory.create(fixture.context, {
      instance_id: "feishu-primary",
      type: factory.type,
      config: factory.validate(longConnectionConfig()),
    });
    await instance.prepare();

    await expect(instance.start()).rejects.toThrow("long start failed");
    await instance.stop();

    expect(fixture.client.stopCalls).toBe(1);
    expect(fixture.signalEvents).toContain("signal_unregister");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains registrations before surfacing a stable source cleanup failure", async () => {
    vi.useFakeTimers();
    const fixture = createLongConnectionFixture();
    let releaseWorker!: (claims: readonly []) => void;
    const workerDrain = new Promise<readonly []>((resolve) => { releaseWorker = resolve; });
    vi.spyOn(fixture.ingress, "claim").mockImplementationOnce(() => workerDrain);
    fixture.client.onStop = () => Promise.reject(new Error("private source cleanup detail"));
    const factory = new FeishuPluginFactory();
    const instance = await factory.create(fixture.context, {
      instance_id: "feishu-primary",
      type: factory.type,
      config: factory.validate(longConnectionConfig()),
    });
    await instance.prepare();
    await instance.start();
    vi.advanceTimersByTime(0);
    await Promise.resolve();

    let cleanupResult: Error | undefined;
    const stopping = instance.stop().catch((error: unknown) => {
      cleanupResult = error instanceof Error ? error : new Error("unexpected cleanup failure");
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(cleanupResult).toBeUndefined();
    expect(fixture.signalEvents).not.toContain("signal_unregister");

    releaseWorker([]);
    await stopping;

    expect(cleanupResult?.message).toBe("feishu_plugin_cleanup_failed");
    expect(fixture.signalEvents).toContain("signal_unregister");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues Webhook cleanup when Signal unregister throws", async () => {
    const webhook = new FeishuWebhookRegistry();
    const services = new Map<string, unknown>([
      ["workfabric.tenant_id", "tenant-1"],
      ["channel.routes", new MemoryChannelRouteStore()],
      ["exchange.subscriptions", new MemorySubscriptionStore()],
      ["connector.ingress", new MemoryConnectorIngressStore()],
      ["connector.command_sink", { manifest: { profile: "connector.command-sink.v1", adapter: "fake", capabilities: {} }, async execute() { return { kind: "accepted" as const, receipt_id: "r", event_ids: [] }; } }],
      ["channel.signal_registry", { register() {}, unregister() { throw new Error("private signal cleanup detail"); } }],
      ["feishu.webhook_registry", webhook],
      ["runtime.clock", { now: () => "2026-07-17T00:00:00.000Z", nowEpochSeconds: () => 1_784_275_200 }],
      ["runtime.fetch", vi.fn()],
      ["runtime.handoff_wakeup", () => {}],
    ]);
    const factory = new FeishuPluginFactory();
    const instance = await factory.create({ configuration_revision: "1", service: { get<T>(key: string) { if (!services.has(key)) throw new Error(key); return services.get(key) as T; } } }, {
      instance_id: "feishu-primary",
      type: factory.type,
      config: factory.validate(config()),
    });
    await instance.prepare();

    await expect(instance.stop()).rejects.toThrow(/^feishu_plugin_cleanup_failed$/);

    expect(await webhook.resolve("feishu-primary")).toBeNull();
  });

  it("provisions configured static channels as canonical idempotent subscriptions", async () => {
    const subscriptions = new MemorySubscriptionStore();
    const services = new Map<string, unknown>([
      ["workfabric.tenant_id", "tenant-1"],
      ["channel.routes", new MemoryChannelRouteStore()],
      ["exchange.subscriptions", subscriptions],
      ["connector.ingress", new MemoryConnectorIngressStore()],
      ["connector.command_sink", { manifest: { profile: "connector.command-sink.v1", adapter: "fake", capabilities: {} }, async execute() { return { kind: "accepted" as const, receipt_id: "r", event_ids: [] }; } }],
      ["channel.signal_registry", { register() {}, unregister() {} }],
      ["feishu.webhook_registry", new FeishuWebhookRegistry()],
      ["runtime.clock", { now: () => "2026-07-17T00:00:00.000Z", nowEpochSeconds: () => 1_784_275_200 }],
      ["runtime.fetch", vi.fn()],
      ["runtime.handoff_wakeup", () => {}],
    ]);
    const configured = config();
    configured.outbound = {
      enabled: true,
      default_render_mode: "card",
      channels: { project: { receive_id_type: "chat_id", receive_id: "oc-project" } },
      subscriptions: {
        results: {
          channel_ref: "project",
          owner: { actor_id: "actor-owner", actor_type: "human", endpoint_id: "endpoint-owner" },
          filter: { event_types: ["workfabric.handoff.result_returned.v1"] },
        },
      },
    };
    const factory = new FeishuPluginFactory();
    const context = { configuration_revision: "1", service: { get<T>(key: string) { if (!services.has(key)) throw new Error(key); return services.get(key) as T; } } };
    const instance = await factory.create(context, { instance_id: "feishu-primary", type: factory.type, config: factory.validate(configured) });
    await instance.prepare();
    await instance.stop();
    const active = await subscriptions.listActiveSubscriptions("tenant-1");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      owner: { actor_id: "actor-owner", actor_type: "human" },
      endpoint_id: "endpoint-owner",
      filter: { event_types: ["workfabric.handoff.result_returned.v1"] },
      destination: { binding: "collaboration-channel", configuration: { plugin_instance_id: "feishu-primary", route_mode: "static", channel_ref: "project" } },
      delivery_mode: "webhook",
    });

    const restarted = await factory.create(context, { instance_id: "feishu-primary", type: factory.type, config: factory.validate(configured) });
    await restarted.prepare();
    await restarted.stop();
    expect(await subscriptions.listActiveSubscriptions("tenant-1")).toHaveLength(1);
  });
});
