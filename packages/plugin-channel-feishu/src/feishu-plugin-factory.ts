import { createHash } from "node:crypto";
import type { ChannelRouteStore } from "@work-fabric/channel-spi";
import {
  FeishuActionReferenceCodec,
  FeishuEventMapper,
  FeishuEventRenderer,
  FeishuIdentityMapper,
  FeishuOpenApiClient,
  FeishuSignalAdapter,
  FeishuTenantAccessTokenProvider,
} from "@work-fabric/connector-feishu";
import { ConnectorWorker } from "@work-fabric/connector-runtime";
import type { ConnectorCommandSink, ConnectorIngressStore, ConnectorObservationSink } from "@work-fabric/connector-spi";
import type { RuntimeSubscription, SignalAdapter, SubscriptionStore } from "@work-fabric/exchange-spi";
import type { PluginContext, PluginFactory, PluginHealth, PluginInstance, PluginInstanceConfiguration } from "@work-fabric/plugin-spi";
import { validateFeishuPluginConfig, type FeishuPluginConfig, type FeishuStaticChannelConfig, type FeishuStaticSubscriptionConfig } from "./config.js";
import { FeishuIntakeMessagePolicy } from "./intake-message-policy.js";
import { FeishuIntakeReceiptHandler } from "./intake-receipt-handler.js";
import { FeishuRouteAwareSignalAdapter } from "./route-aware-signal-adapter.js";
import type { FeishuWebhookRegistry } from "./webhook-registry.js";

export interface ChannelSignalRegistration {
  register(instanceId: string, adapter: SignalAdapter): void;
  unregister(instanceId: string): void;
}
interface RuntimeClock { now(): string; nowEpochSeconds(): number; }

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1000).toISOString();
}
function staticSubscriptionId(tenantId: string, instanceId: string, name: string): string {
  return `channel_${createHash("sha256").update(tenantId).update("\0").update(instanceId).update("\0static\0").update(name).digest("base64url")}`;
}

function increasingTimestamp(now: string, previous: string): string {
  return Date.parse(now) > Date.parse(previous) ? now : new Date(Date.parse(previous) + 1).toISOString();
}

function staticSubscription(
  tenantId: string,
  instanceId: string,
  name: string,
  config: FeishuStaticSubscriptionConfig,
  maxAttempts: number,
  createdAt: string,
  updatedAt: string,
): RuntimeSubscription {
  return {
    subscription_id: staticSubscriptionId(tenantId, instanceId, name),
    tenant_id: tenantId,
    owner: { actor_id: config.owner.actor_id, actor_type: config.owner.actor_type },
    endpoint_id: config.owner.endpoint_id,
    filter: structuredClone(config.filter),
    destination: { destination_id: `static:${name}`, binding: "collaboration-channel", configuration: { plugin_instance_id: instanceId, route_mode: "static", channel_ref: config.channel_ref } },
    delivery_mode: "webhook",
    state: "active",
    max_attempts: maxAttempts,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

class FeishuPluginInstance implements PluginInstance {
  readonly signal_adapter: SignalAdapter;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | null = null;
  private stopped = false;
  private prepared = false;
  private healthValue: PluginHealth = { state: "healthy", code: "ready" };
  constructor(
    private readonly instanceId: string,
    private readonly tenantId: string,
    private readonly config: FeishuPluginConfig,
    private readonly worker: ConnectorWorker,
    signalAdapter: SignalAdapter,
    private readonly signals: ChannelSignalRegistration,
    private readonly webhooks: FeishuWebhookRegistry,
    private readonly subscriptions: SubscriptionStore,
    private readonly clock: RuntimeClock,
  ) { this.signal_adapter = signalAdapter; }
  async prepare(): Promise<void> {
    if (this.prepared) return;
    if (this.config.inbound.enabled) this.webhooks.register(this.instanceId, {
      tenant_id: this.tenantId, connector_id: this.config.connector_id,
      external_tenant_id: this.config.external_tenant_id, credential_ref: `feishu:${this.instanceId}`,
      credentials: { verification_token: this.config.credentials.verification_token, ...(this.config.credentials.encrypt_key === undefined ? {} : { encrypt_key: this.config.credentials.encrypt_key }) },
    });
    if (this.config.outbound.enabled) {
      for (const [name, subscriptionConfig] of Object.entries(this.config.outbound.subscriptions).sort(([left], [right]) => left.localeCompare(right))) {
        const id = staticSubscriptionId(this.tenantId, this.instanceId, name);
        const existing = await this.subscriptions.getSubscription(id);
        const now = this.clock.now();
        const desired = staticSubscription(this.tenantId, this.instanceId, name, subscriptionConfig, this.config.worker.max_attempts, existing?.created_at ?? now, existing?.updated_at ?? now);
        if (existing === null || JSON.stringify(existing) !== JSON.stringify(desired)) {
          await this.subscriptions.putSubscription(existing === null ? desired : { ...desired, updated_at: increasingTimestamp(now, existing.updated_at) });
        }
      }
      this.signals.register(this.instanceId, this.signal_adapter);
    }
    this.prepared = true;
  }
  async start(): Promise<void> { if (!this.prepared) throw new Error("feishu_plugin_not_prepared"); this.stopped = false; if (this.config.inbound.enabled) this.schedule(0); }
  private schedule(delay: number): void { if (this.stopped) return; this.timer = setTimeout(() => { this.active = this.turn().finally(() => { this.active = null; this.schedule(this.config.worker.poll_interval_ms); }); }, delay); }
  private async turn(): Promise<void> { try { await this.worker.runBatch(); this.healthValue = { state: "healthy", code: "ready" }; } catch { this.healthValue = { state: "degraded", code: "connector_turn_failed" }; } }
  async health(): Promise<PluginHealth> { return this.healthValue; }
  async stop(): Promise<void> { this.stopped = true; if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; await this.active; if (this.prepared) { this.signals.unregister(this.instanceId); this.webhooks.unregister(this.instanceId); } this.prepared = false; }
}

export class FeishuPluginFactory implements PluginFactory {
  readonly type = "collaboration-channel.feishu";
  validate(config: unknown): FeishuPluginConfig { return validateFeishuPluginConfig(config); }
  async create(context: PluginContext, instance: PluginInstanceConfiguration): Promise<PluginInstance> {
    const config = validateFeishuPluginConfig(instance.config);
    if (config.connector_id !== instance.instance_id) throw new TypeError("connector_id must equal plugin instance_id");
    const tenantId = context.service.get<string>("workfabric.tenant_id");
    const routes = context.service.get<ChannelRouteStore>("channel.routes");
    const subscriptions = context.service.get<SubscriptionStore>("exchange.subscriptions");
    const ingress = context.service.get<ConnectorIngressStore>("connector.ingress");
    const commandSink = context.service.get<ConnectorCommandSink>("connector.command_sink");
    const signals = context.service.get<ChannelSignalRegistration>("channel.signal_registry");
    const webhooks = context.service.get<FeishuWebhookRegistry>("feishu.webhook_registry");
    const clock = context.service.get<RuntimeClock>("runtime.clock");
    const wakeHandoff = context.service.get<(handoffId: string) => void>("runtime.handoff_wakeup");
    const fetch = context.service.get<typeof globalThis.fetch>("runtime.fetch");
    const identities = new Map(config.identities.map((item) => [item.external_open_id, item]));
    const identityResolver = new FeishuIdentityMapper(async (query) => {
      if (query.tenant_id !== tenantId || query.connector_id !== config.connector_id || query.external_tenant_id !== config.external_tenant_id) return null;
      const value = identities.get(query.external_subject_id); return value === undefined ? null : { actor_id: value.actor_id, endpoint_id: value.endpoint_id };
    });
    const actionCodec = new FeishuActionReferenceCodec({ encryption_key: createHash("sha256").update(config.credentials.app_secret).digest() });
    const mapper = new FeishuEventMapper({ identity_resolver: identityResolver, action_codec: actionCodec, clock, message_policy: new FeishuIntakeMessagePolicy({ bot_open_id: config.bot_open_id, identity_resolver: identityResolver, target: config.inbound.intake_target, clock, accept_within_seconds: config.inbound.accept_within_seconds, result_due_within_seconds: config.inbound.result_due_within_seconds, max_intent_length: 4_000 }) });
    const receipt = new FeishuIntakeReceiptHandler({ plugin_instance_id: instance.instance_id, routes, subscriptions, actor_type_for: (actorId) => config.identities.find((item) => item.actor_id === actorId)?.actor_type ?? "human", max_delivery_attempts: config.worker.max_attempts, on_handoff_ready: wakeHandoff });
    const observation: ConnectorObservationSink = { manifest: { profile: "connector.observation-sink.v1", adapter: "feishu-inert", capabilities: {} }, async record(input) { return { kind: "accepted", receipt_id: `ignored:${input.ingress_id}`, event_ids: [] }; } };
    const worker = new ConnectorWorker({ store: ingress, mapper, command_sink: commandSink, observation_sink: observation, accepted_receipt_handler: receipt, clock, retry_policy: { nextAvailableAt(attempt, _code, now) { return addSeconds(now, Math.min(300, 2 ** Math.min(attempt, 8))); } }, scope: { tenant_id: tenantId, connector_id: config.connector_id, worker_id: `plugin:${instance.instance_id}`, lease_seconds: config.worker.lease_seconds, batch_limit: config.worker.batch_limit, max_attempts: config.worker.max_attempts, max_error_detail_length: 256 } });
    const credentialRef = `feishu:${instance.instance_id}`;
    const tokenProvider = new FeishuTenantAccessTokenProvider({ credential_provider: { async loadAppCredentials(reference) { if (reference !== credentialRef) throw new TypeError("credential scope mismatch"); return { app_id: config.credentials.app_id, app_secret: config.credentials.app_secret }; } }, fetch, base_url: "https://open.feishu.cn", clock, expiry_skew_seconds: 60, request_timeout_ms: 10_000, max_cache_entries: 1 });
    const messages = new FeishuOpenApiClient({ token_provider: tokenProvider, fetch, base_url: "https://open.feishu.cn", request_timeout_ms: 10_000, max_response_bytes: 64_000 });
    const delegate = new FeishuSignalAdapter({ messages, renderer: new FeishuEventRenderer({ action_codec: actionCodec, clock, max_text_bytes: 100_000, max_card_bytes: 25_000 }) });
    const routeAdapter = new FeishuRouteAwareSignalAdapter({ tenant_id: tenantId, plugin_instance_id: instance.instance_id, connector_id: config.connector_id, external_tenant_id: config.external_tenant_id, credential_ref: credentialRef, render_mode: config.outbound.default_render_mode, actor_id: config.inbound.intake_target.actor_id, endpoint_id: config.inbound.intake_target.endpoint_id, routes, static_channels: config.outbound.channels satisfies Readonly<Record<string, FeishuStaticChannelConfig>>, delegate });
    return new FeishuPluginInstance(instance.instance_id, tenantId, config, worker, routeAdapter, signals, webhooks, subscriptions, clock);
  }
}
