import { createHash } from "node:crypto";
import type { CollaborationAdmissionService } from "@work-fabric/admission-spi";
import type { ChannelRouteStore } from "@work-fabric/channel-spi";
import {
  FeishuActionReferenceCodec,
  FeishuEventMapper,
  FeishuEventRenderer,
  FeishuLongConnectionSource,
  FeishuOpenApiClient,
  FeishuSignalAdapter,
  FeishuTenantAccessTokenProvider,
  type FeishuLongConnectionClient,
  type FeishuLongConnectionClientFactory,
  type FeishuTenantTokenProvider,
} from "@work-fabric/connector-feishu";
import { ConnectorWorker } from "@work-fabric/connector-runtime";
import type { ConnectorCommandSink, ConnectorIngressStore, ConnectorObservationSink } from "@work-fabric/connector-spi";
import type { RuntimeSubscription, SignalAdapter, SubscriptionStore } from "@work-fabric/exchange-spi";
import type { PluginContext, PluginFactory, PluginHealth, PluginInstance, PluginInstanceConfiguration } from "@work-fabric/plugin-spi";
import { validateFeishuPluginConfig, type FeishuPluginConfig, type FeishuStaticChannelConfig, type FeishuStaticSubscriptionConfig } from "./config.js";
import { FeishuIntakeMessagePolicy } from "./intake-message-policy.js";
import { FeishuIntakeReceiptHandler } from "./intake-receipt-handler.js";
import {
  AdmissionFeishuParticipantResolver,
  LegacyFeishuParticipantResolver,
} from "./participant-resolver.js";
import { FeishuRouteAwareSignalAdapter } from "./route-aware-signal-adapter.js";
import type { FeishuWebhookRegistry } from "./webhook-registry.js";

export interface ChannelSignalRegistration {
  register(instanceId: string, adapter: SignalAdapter): void;
  unregister(instanceId: string): void;
}
interface RuntimeClock { now(): string; nowEpochSeconds(): number; }

function sharedTenantTokenProvider(
  context: PluginContext,
  instanceId: string,
): FeishuTenantTokenProvider | null {
  try {
    const providers = context.service.get<ReadonlyMap<string, FeishuTenantTokenProvider>>(
      "feishu.tenant_token_providers",
    );
    return providers instanceof Map ? providers.get(instanceId) ?? null : null;
  } catch {
    return null;
  }
}

function validatedAdmissionCapability(value: unknown): CollaborationAdmissionService {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    throw new TypeError("collaboration.admission capability is invalid");
  }
  const visited = new Set<object>();
  let current: object | null = value as object;
  try {
    while (current !== null && visited.size < 32) {
      if (visited.has(current)) throw new TypeError("collaboration.admission capability is invalid");
      visited.add(current);
      const descriptor = Object.getOwnPropertyDescriptor(current, "admit");
      if (descriptor !== undefined) {
        if (!("value" in descriptor) || typeof descriptor.value !== "function") {
          throw new TypeError("collaboration.admission capability is invalid");
        }
        const method = descriptor.value as CollaborationAdmissionService["admit"];
        return {
          admit(policyId, request) {
            return Reflect.apply(method, value, [policyId, request]) as ReturnType<CollaborationAdmissionService["admit"]>;
          },
        };
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    throw new TypeError("collaboration.admission capability is invalid");
  }
  throw new TypeError("collaboration.admission capability is invalid");
}

type FeishuWebhookPluginConfig = Extract<
  FeishuPluginConfig,
  { readonly inbound: { readonly transport: "webhook" } }
>;

function isWebhookConfig(config: FeishuPluginConfig): config is FeishuWebhookPluginConfig {
  return config.inbound.transport === "webhook";
}

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
  private signalRegistrationAttempted = false;
  private webhookRegistrationAttempted = false;
  private workerHealthValue: PluginHealth = { state: "healthy", code: "ready" };
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
    private readonly longConnection: FeishuLongConnectionClient | undefined,
    private readonly longConnectionSource: FeishuLongConnectionSource | undefined,
  ) { this.signal_adapter = signalAdapter; }
  async prepare(): Promise<void> {
    if (this.prepared) return;
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
    }
    if (this.config.inbound.enabled && isWebhookConfig(this.config)) {
      this.webhookRegistrationAttempted = true;
      this.webhooks.register(this.instanceId, {
        tenant_id: this.tenantId, connector_id: this.config.connector_id,
        external_tenant_id: this.config.external_tenant_id, credential_ref: `feishu:${this.instanceId}`,
        credentials: { verification_token: this.config.credentials.verification_token, ...(this.config.credentials.encrypt_key === undefined ? {} : { encrypt_key: this.config.credentials.encrypt_key }) },
      });
    }
    if (this.config.outbound.enabled) {
      this.signalRegistrationAttempted = true;
      this.signals.register(this.instanceId, this.signal_adapter);
    }
    this.prepared = true;
  }
  async start(): Promise<void> { if (!this.prepared) throw new Error("feishu_plugin_not_prepared"); this.stopped = false; await this.longConnectionSource?.start(); if (this.config.inbound.enabled) this.schedule(0); }
  private schedule(delay: number): void { if (this.stopped) return; this.timer = setTimeout(() => { this.active = this.turn().finally(() => { this.active = null; this.schedule(this.config.worker.poll_interval_ms); }); }, delay); }
  private async turn(): Promise<void> { try { await this.worker.runBatch(); this.workerHealthValue = { state: "healthy", code: "ready" }; } catch { this.workerHealthValue = { state: "degraded", code: "connector_turn_failed" }; } }
  async health(): Promise<PluginHealth> {
    if (this.longConnection === undefined) return this.workerHealthValue;
    const connectionState = this.longConnection.status().state;
    if (connectionState === "failed") return { state: "unhealthy", code: "feishu_long_connection_failed" };
    if (connectionState === "connected") return this.workerHealthValue;
    return { state: "degraded", code: `feishu_long_connection_${connectionState}` };
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const failures: unknown[] = [];
    try { await this.longConnectionSource?.stop(); } catch (error) { failures.push(error); }
    try { await this.active; } catch (error) { failures.push(error); }
    if (this.signalRegistrationAttempted) {
      try {
        this.signals.unregister(this.instanceId);
        this.signalRegistrationAttempted = false;
      } catch (error) { failures.push(error); }
    }
    if (this.webhookRegistrationAttempted) {
      try {
        this.webhooks.unregister(this.instanceId);
        this.webhookRegistrationAttempted = false;
      } catch (error) { failures.push(error); }
    }
    this.prepared = false;
    if (failures.length > 0) throw new Error("feishu_plugin_cleanup_failed");
  }
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
    const longConnection = config.inbound.enabled && config.inbound.transport === "long_connection"
      ? context.service.get<FeishuLongConnectionClientFactory>("feishu.long_connection_client_factory").create({
          app_id: config.credentials.app_id,
          app_secret: config.credentials.app_secret,
          instance_id: instance.instance_id,
        })
      : undefined;
    const longConnectionSource = longConnection === undefined
      ? undefined
      : new FeishuLongConnectionSource({
          client: longConnection,
          ingress,
          scope: {
            tenant_id: tenantId,
            connector_id: config.connector_id,
            expected_external_tenant_id: config.external_tenant_id,
          },
          clock,
        });
    const wakeHandoff = context.service.get<(handoffId: string) => void>("runtime.handoff_wakeup");
    const fetch = context.service.get<typeof globalThis.fetch>("runtime.fetch");
    const participantResolver = config.identity_admission === undefined
      ? new LegacyFeishuParticipantResolver({
          tenant_id: tenantId,
          connector_id: config.connector_id,
          external_tenant_id: config.external_tenant_id,
          identities: config.identities,
        })
      : new AdmissionFeishuParticipantResolver({
          tenant_id: tenantId,
          connector_id: config.connector_id,
          external_tenant_id: config.external_tenant_id,
          policy_id: config.identity_admission.policy_id,
          admission: validatedAdmissionCapability(
            context.service.get<unknown>("collaboration.admission"),
          ),
        });
    const actionCodec = new FeishuActionReferenceCodec({ encryption_key: createHash("sha256").update(config.credentials.app_secret).digest() });
    const mapper = new FeishuEventMapper({ participant_resolver: participantResolver, action_codec: actionCodec, clock, message_policy: new FeishuIntakeMessagePolicy({ bot_open_id: config.bot_open_id, participant_resolver: participantResolver, target: config.inbound.intake_target, clock, accept_within_seconds: config.inbound.accept_within_seconds, result_due_within_seconds: config.inbound.result_due_within_seconds, max_intent_length: 4_000 }) });
    const receipt = new FeishuIntakeReceiptHandler({ plugin_instance_id: instance.instance_id, routes, subscriptions, max_delivery_attempts: config.worker.max_attempts, on_handoff_ready: wakeHandoff });
    const observation: ConnectorObservationSink = { manifest: { profile: "connector.observation-sink.v1", adapter: "feishu-inert", capabilities: {} }, async record(input) { return { kind: "accepted", receipt_id: `ignored:${input.ingress_id}`, event_ids: [] }; } };
    const worker = new ConnectorWorker({ store: ingress, mapper, command_sink: commandSink, observation_sink: observation, accepted_receipt_handler: receipt, clock, retry_policy: { nextAvailableAt(attempt, _code, now) { return addSeconds(now, Math.min(300, 2 ** Math.min(attempt, 8))); } }, scope: { tenant_id: tenantId, connector_id: config.connector_id, worker_id: `plugin:${instance.instance_id}`, lease_seconds: config.worker.lease_seconds, batch_limit: config.worker.batch_limit, max_attempts: config.worker.max_attempts, max_error_detail_length: 256 } });
    const credentialRef = `feishu:${instance.instance_id}`;
    const tokenProvider = sharedTenantTokenProvider(context, instance.instance_id)
      ?? new FeishuTenantAccessTokenProvider({ credential_provider: { async loadAppCredentials(reference) { if (reference !== credentialRef) throw new TypeError("credential scope mismatch"); return { app_id: config.credentials.app_id, app_secret: config.credentials.app_secret }; } }, fetch, base_url: "https://open.feishu.cn", clock, expiry_skew_seconds: 60, request_timeout_ms: 10_000, max_cache_entries: 1 });
    const messages = new FeishuOpenApiClient({ token_provider: tokenProvider, fetch, base_url: "https://open.feishu.cn", request_timeout_ms: 10_000, max_response_bytes: 64_000 });
    const delegate = new FeishuSignalAdapter({ messages, renderer: new FeishuEventRenderer({ action_codec: actionCodec, clock, max_text_bytes: 100_000, max_card_bytes: 25_000 }) });
    const routeAdapter = new FeishuRouteAwareSignalAdapter({ tenant_id: tenantId, plugin_instance_id: instance.instance_id, connector_id: config.connector_id, external_tenant_id: config.external_tenant_id, credential_ref: credentialRef, render_mode: config.outbound.default_render_mode, actor_id: config.inbound.intake_target.actor_id, endpoint_id: config.inbound.intake_target.endpoint_id, routes, static_channels: config.outbound.channels satisfies Readonly<Record<string, FeishuStaticChannelConfig>>, delegate });
    return new FeishuPluginInstance(instance.instance_id, tenantId, config, worker, routeAdapter, signals, webhooks, subscriptions, clock, longConnection, longConnectionSource);
  }
}
