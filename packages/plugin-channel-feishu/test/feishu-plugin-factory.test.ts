import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollaborationAdmissionService } from "@work-fabric/admission-spi";
import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";
import { MemoryChannelRouteStore } from "@work-fabric/adapter-storage-memory";
import type {
  FeishuParticipantResolution,
  FeishuLongConnectionClient,
  FeishuLongConnectionClientFactory,
  FeishuLongConnectionHandler,
  FeishuLongConnectionState,
  FeishuLongConnectionStatus,
} from "@work-fabric/connector-feishu";
import type { ConnectorIngressClaim } from "@work-fabric/connector-spi";
import { MemorySubscriptionStore } from "@work-fabric/exchange-runtime";
import type { JsonObject } from "@work-fabric/exchange-spi";
import type { SignalAdapter } from "@work-fabric/exchange-spi";
import {
  AdmissionFeishuParticipantResolver,
  FeishuPluginFactory,
  FeishuWebhookRegistry,
  LegacyFeishuParticipantResolver,
} from "../src/index.js";

const config = () => ({
  connector_id: "feishu-primary", external_tenant_id: "tenant-key-1", bot_open_id: "ou-bot",
  credentials: { app_id: "app-id", app_secret: "app-secret", verification_token: "verify", work_fabric_access_token: "wf-token" },
  inbound: { enabled: true, transport: "webhook", route_id: "primary", mention_only: true, intake_target: { actor_id: "actor-agent", endpoint_id: "endpoint-agent" } },
  outbound: { enabled: true, default_render_mode: "card", channels: {}, subscriptions: {} },
  identities: [{ external_open_id: "ou-human", actor_id: "actor-human", actor_type: "human", endpoint_id: "endpoint-human" }],
  worker: { poll_interval_ms: 1000, lease_seconds: 30, batch_limit: 100, max_attempts: 8 },
});

const admissionConfig = () => {
  const { identities: _identities, ...configured } = config();
  return { ...configured, identity_admission: { policy_id: "feishu-primary-participants" } };
};

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

function participantClaim(ingressId = "ingress-admission-1"): ConnectorIngressClaim {
  return {
    ingress_id: ingressId,
    envelope: {
      tenant_id: "tenant-1", connector_id: "feishu-primary", source_system: "feishu",
      external_tenant_id: "tenant-key-1", external_event_id: "event-1",
      dedupe_key: "message:om-1", event_type: "im.message.receive_v1",
      occurred_at: "2026-07-20T00:00:00.000Z", received_at: "2026-07-20T00:00:01.000Z",
      payload: {},
    },
    state: "processing", attempt: 1, available_at: "2026-07-20T00:00:01.000Z",
    accepted_at: "2026-07-20T00:00:01.000Z", updated_at: "2026-07-20T00:00:02.000Z",
    claim_owner: "worker-1", claim_token: "claim-1", fencing_token: 1,
    lease_expires_at: "2026-07-20T00:01:02.000Z",
  };
}

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
  it("keeps legacy exact mapping local and never creates a representation grant", async () => {
    const resolver = new LegacyFeishuParticipantResolver({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      external_tenant_id: "tenant-key-1",
      identities: [
        ...config().identities.map((identity) => ({ ...identity, actor_type: "human" as const })),
        { external_open_id: "ou-agent", actor_id: "actor-agent", actor_type: "agent", endpoint_id: "endpoint-agent" },
        { external_open_id: "ou-system", actor_id: "actor-system", actor_type: "system", endpoint_id: "endpoint-system" },
      ],
    });
    await expect(resolver.resolve({
      claim: participantClaim(), external_subject_id: "ou-human", external_subject_type: "human",
    })).resolves.toEqual({
      kind: "resolved",
      identity: { actor_id: "actor-human", actor_type: "human", endpoint_id: "endpoint-human" },
    });
    await expect(resolver.resolve({
      claim: participantClaim(), external_subject_id: "ou-unknown", external_subject_type: "human",
    })).resolves.toEqual({ kind: "denied", reason_code: "identity_unmapped" });
    await expect(resolver.resolve({
      claim: participantClaim(), external_subject_id: "ou-agent", external_subject_type: "human",
    })).resolves.toEqual({
      kind: "resolved", identity: { actor_id: "actor-agent", actor_type: "agent", endpoint_id: "endpoint-agent" },
    });
    await expect(resolver.resolve({
      claim: participantClaim(), external_subject_id: "ou-system", external_subject_type: "human",
    })).resolves.toEqual({
      kind: "resolved", identity: { actor_id: "actor-system", actor_type: "system", endpoint_id: "endpoint-system" },
    });
  });

  it("forwards the complete participant tuple and preserves duplicate ingress stability for active internal allow", async () => {
    const admit = vi.fn<CollaborationAdmissionService["admit"]>(async () => ({
      decision: {
        kind: "allow", reason_code: "internal_member", policy_id: "feishu-primary-participants", policy_revision: "r1",
        decision_id: "decision-stable",
        binding: {
          tenant_id: "tenant-1", connector_id: "feishu-primary", source_system: "feishu", external_tenant_id: "tenant-key-1",
          external_subject_type: "human", external_subject_fingerprint: "fingerprint",
          actor_id: "actor-stable", actor_type: "human", endpoint_id: "endpoint-stable", created_at: "2026-07-20T00:00:00.000Z",
        },
      },
      representation_grant: "opaque-grant",
    }));
    const resolver = new AdmissionFeishuParticipantResolver({
      tenant_id: "tenant-1", connector_id: "feishu-primary", external_tenant_id: "tenant-key-1",
      policy_id: "feishu-primary-participants", admission: { admit },
    });
    const input = { claim: participantClaim(), external_subject_id: "ou-internal", external_subject_type: "human" as const };
    const first = await resolver.resolve(input);
    const duplicate = await resolver.resolve(input);
    expect(first).toEqual({
      kind: "resolved",
      identity: { actor_id: "actor-stable", actor_type: "human", endpoint_id: "endpoint-stable" },
      representation_grant: "opaque-grant",
    } satisfies FeishuParticipantResolution);
    expect(duplicate).toEqual(first);
    expect(admit).toHaveBeenCalledTimes(2);
    expect(admit).toHaveBeenNthCalledWith(1, "feishu-primary-participants", {
      tenant_id: "tenant-1", connector_id: "feishu-primary", source_system: "feishu",
      external_tenant_id: "tenant-key-1", external_subject_type: "human",
      external_subject_id: "ou-internal", ingress_id: "ingress-admission-1",
    });
  });

  it("maps exact Admission allow to only the stable binding and opaque grant", async () => {
    const admission: CollaborationAdmissionService = {
      async admit() {
        return {
          decision: {
            kind: "allow", reason_code: "explicit_allow", policy_id: "feishu-primary-participants", policy_revision: "r1",
            decision_id: "decision-explicit",
            binding: {
              tenant_id: "tenant-1", connector_id: "feishu-primary", source_system: "feishu", external_tenant_id: "tenant-key-1",
              external_subject_type: "human", external_subject_fingerprint: "fingerprint-explicit",
              actor_id: "actor-explicit", actor_type: "human", endpoint_id: "endpoint-explicit", created_at: "2026-07-20T00:00:00.000Z",
            },
          },
          representation_grant: "grant-explicit",
        };
      },
    };
    const resolver = new AdmissionFeishuParticipantResolver({
      tenant_id: "tenant-1", connector_id: "feishu-primary", external_tenant_id: "tenant-key-1",
      policy_id: "feishu-primary-participants", admission,
    });
    await expect(resolver.resolve({
      claim: participantClaim(), external_subject_id: "ou-explicit", external_subject_type: "human",
    })).resolves.toEqual({
      kind: "resolved",
      identity: { actor_id: "actor-explicit", actor_type: "human", endpoint_id: "endpoint-explicit" },
      representation_grant: "grant-explicit",
    });
  });

  it.each(["agent", "system"] as const)("preserves an Admission-bound %s Actor for a human external subject", async (actorType) => {
    const admission: CollaborationAdmissionService = {
      async admit() {
        return {
          decision: {
            kind: "allow", reason_code: "explicit_allow", policy_id: "feishu-primary-participants", policy_revision: "r1",
            decision_id: `decision-${actorType}`,
            binding: {
              tenant_id: "tenant-1", connector_id: "feishu-primary", source_system: "feishu", external_tenant_id: "tenant-key-1",
              external_subject_type: "human", external_subject_fingerprint: `fingerprint-${actorType}`,
              actor_id: `actor-${actorType}`, actor_type: actorType, endpoint_id: `endpoint-${actorType}`, created_at: "2026-07-20T00:00:00.000Z",
            },
          },
          representation_grant: `grant-${actorType}`,
        };
      },
    };
    const resolver = new AdmissionFeishuParticipantResolver({
      tenant_id: "tenant-1", connector_id: "feishu-primary", external_tenant_id: "tenant-key-1",
      policy_id: "feishu-primary-participants", admission,
    });
    await expect(resolver.resolve({
      claim: participantClaim(), external_subject_id: `ou-${actorType}`, external_subject_type: "human",
    })).resolves.toEqual({
      kind: "resolved",
      identity: { actor_id: `actor-${actorType}`, actor_type: actorType, endpoint_id: `endpoint-${actorType}` },
      representation_grant: `grant-${actorType}`,
    });
  });

  it("accepts any positive safe retry delay and rejects invalid retry delays", async () => {
    const input = { claim: participantClaim(), external_subject_id: "ou-subject", external_subject_type: "human" as const };
    const resolverFor = (retryAfterSeconds: number) => new AdmissionFeishuParticipantResolver({
      tenant_id: "tenant-1", connector_id: "feishu-primary", external_tenant_id: "tenant-key-1",
      policy_id: "feishu-primary-participants",
      admission: { async admit() { return { decision: { kind: "temporarily_unavailable", reason_code: "evidence_unavailable", retry_after_seconds: retryAfterSeconds } }; } },
    });
    await expect(resolverFor(86_401).resolve(input)).resolves.toEqual({
      kind: "temporarily_unavailable", reason_code: "evidence_unavailable",
    });
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(resolverFor(invalid).resolve(input)).resolves.toEqual({
        kind: "temporarily_unavailable", reason_code: "admission_unavailable",
      });
    }
  });

  it.each([
    ["explicit_deny", "denied", false],
    ["scope_mismatch", "denied", false],
    ["not_internal_member", "denied", false],
    ["inactive_subject", "denied", false],
    ["default_deny", "denied", false],
    ["evidence_unavailable", "temporarily_unavailable", true],
  ] as const)("maps Admission %s to stable participant resolution", async (reasonCode, expectedKind, unavailable) => {
    const admission: CollaborationAdmissionService = {
      async admit() {
        return unavailable
          ? { decision: { kind: "temporarily_unavailable", reason_code: "evidence_unavailable", retry_after_seconds: 5 } }
          : { decision: { kind: "deny", reason_code: reasonCode as "explicit_deny" | "scope_mismatch" | "not_internal_member" | "inactive_subject" | "default_deny", policy_id: "p", policy_revision: "r", decision_id: "d" } };
      },
    };
    const resolver = new AdmissionFeishuParticipantResolver({
      tenant_id: "tenant-1", connector_id: "feishu-primary", external_tenant_id: "tenant-key-1",
      policy_id: "feishu-primary-participants", admission,
    });
    await expect(resolver.resolve({
      claim: participantClaim(), external_subject_id: "ou-subject", external_subject_type: "human",
    })).resolves.toEqual({ kind: expectedKind, reason_code: reasonCode });
  });

  it("fails closed when an allow has no grant or a mismatched binding", async () => {
    const baseDecision = {
      kind: "allow" as const, reason_code: "explicit_allow" as const,
      policy_id: "feishu-primary-participants", policy_revision: "r1", decision_id: "decision-1",
      binding: {
        tenant_id: "tenant-1", connector_id: "feishu-primary", source_system: "feishu", external_tenant_id: "tenant-key-1",
        external_subject_type: "human" as const, external_subject_fingerprint: "fingerprint",
        actor_id: "actor-1", actor_type: "human" as const, endpoint_id: "endpoint-1", created_at: "2026-07-20T00:00:00.000Z",
      },
    };
    const input = { claim: participantClaim(), external_subject_id: "ou-subject", external_subject_type: "human" as const };
    const withoutGrant = new AdmissionFeishuParticipantResolver({
      tenant_id: "tenant-1", connector_id: "feishu-primary", external_tenant_id: "tenant-key-1", policy_id: "feishu-primary-participants",
      admission: { async admit() { return { decision: baseDecision }; } },
    });
    await expect(withoutGrant.resolve(input)).resolves.toEqual({ kind: "temporarily_unavailable", reason_code: "admission_unavailable" });

    const mismatched = new AdmissionFeishuParticipantResolver({
      tenant_id: "tenant-1", connector_id: "feishu-primary", external_tenant_id: "tenant-key-1", policy_id: "feishu-primary-participants",
      admission: { async admit() { return { decision: { ...baseDecision, binding: { ...baseDecision.binding, external_tenant_id: "wrong-tenant" } }, representation_grant: "grant" }; } },
    });
    await expect(mismatched.resolve(input)).resolves.toEqual({ kind: "denied", reason_code: "scope_mismatch" });
  });

  it("strictly parses Admission results without invoking accessors or reflecting upstream values", async () => {
    const secret = "grant-or-provider-detail-must-not-reflect";
    const decisionGetter = vi.fn(() => ({ kind: "deny", reason_code: secret }));
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "decision", { enumerable: true, get: decisionGetter });
    const validBinding = {
      tenant_id: "tenant-1", connector_id: "feishu-primary", source_system: "feishu", external_tenant_id: "tenant-key-1",
      external_subject_type: "human", external_subject_fingerprint: "fingerprint",
      actor_id: "actor", actor_type: "human", endpoint_id: "endpoint", created_at: "2026-07-20T00:00:00.000Z",
    };
    const malformed = [
      accessor,
      Object.create({ decision: { kind: "deny", reason_code: "explicit_deny", policy_id: "p", policy_revision: "r", decision_id: "d" } }),
      { decision: { kind: "deny", reason_code: secret, policy_id: "p", policy_revision: "r", decision_id: "d" } },
      { decision: { kind: "deny", reason_code: "explicit_deny", policy_id: "p", policy_revision: "r", decision_id: "d", extra: secret } },
      { decision: { kind: "allow", reason_code: "explicit_allow", policy_id: "feishu-primary-participants", policy_revision: "r", decision_id: "d", binding: { ...validBinding, actor_type: "robot" } }, representation_grant: secret },
      { decision: { kind: "allow", reason_code: "explicit_allow", policy_id: "feishu-primary-participants", policy_revision: "r", decision_id: "d", binding: validBinding }, representation_grant: undefined },
      new Proxy({ decision: { kind: "temporarily_unavailable", reason_code: "evidence_unavailable", retry_after_seconds: 5 } }, { getOwnPropertyDescriptor() { throw new Error(secret); } }),
    ];
    const input = { claim: participantClaim(), external_subject_id: "ou-subject", external_subject_type: "human" as const };
    for (const result of malformed) {
      const resolver = new AdmissionFeishuParticipantResolver({
        tenant_id: "tenant-1", connector_id: "feishu-primary", external_tenant_id: "tenant-key-1",
        policy_id: "feishu-primary-participants",
        admission: { async admit() { return result as never; } },
      });
      const resolved = await resolver.resolve(input);
      expect(resolved).toEqual({ kind: "temporarily_unavailable", reason_code: "admission_unavailable" });
      expect(JSON.stringify(resolved)).not.toContain(secret);
    }
    expect(decisionGetter).not.toHaveBeenCalled();
  });

  it("resolves the Admission capability only for identity_admission mode", async () => {
    const fixture = createLongConnectionFixture();
    const factory = new FeishuPluginFactory();
    await factory.create(fixture.context, {
      instance_id: "feishu-primary", type: factory.type, config: factory.validate(config()),
    });
    expect(fixture.requested).not.toContain("collaboration.admission");

    const { identities: _identities, ...configured } = config();
    const requested: string[] = [];
    const admission: CollaborationAdmissionService = { async admit() { throw new Error("not called during composition"); } };
    const context = {
      ...fixture.context,
      service: {
        get<T>(key: string): T {
          requested.push(key);
          if (key === "collaboration.admission") return admission as T;
          return fixture.context.service.get<T>(key);
        },
      },
    };
    await factory.create(context, {
      instance_id: "feishu-primary",
      type: factory.type,
      config: factory.validate({ ...configured, identity_admission: { policy_id: "feishu-primary-participants" } }),
    });
    expect(requested.filter((key) => key === "collaboration.admission")).toHaveLength(1);
  });

  it("accepts a class Admission method but rejects unsafe capabilities before registration", async () => {
    class ClassAdmission implements CollaborationAdmissionService {
      async admit(): ReturnType<CollaborationAdmissionService["admit"]> {
        throw new Error("not called during composition");
      }
    }
    const factory = new FeishuPluginFactory();
    const validFixture = createLongConnectionFixture();
    const validContext = {
      ...validFixture.context,
      service: {
        get<T>(key: string): T {
          if (key === "collaboration.admission") return new ClassAdmission() as T;
          return validFixture.context.service.get<T>(key);
        },
      },
    };
    await expect(factory.create(validContext, {
      instance_id: "feishu-primary", type: factory.type, config: factory.validate(admissionConfig()),
    })).resolves.toBeDefined();

    const admitGetter = vi.fn(() => async () => ({ decision: { kind: "temporarily_unavailable", reason_code: "policy_unavailable", retry_after_seconds: 5 } }));
    const accessorCapability: Record<string, unknown> = {};
    Object.defineProperty(accessorCapability, "admit", { get: admitGetter });
    const unsafeCapabilities = [
      {},
      { admit: "not-a-function" },
      accessorCapability,
      new Proxy({ admit: async () => ({}) }, { getOwnPropertyDescriptor() { throw new Error("private capability detail"); } }),
    ];
    for (const capability of unsafeCapabilities) {
      const fixture = createLongConnectionFixture();
      const context = {
        ...fixture.context,
        service: {
          get<T>(key: string): T {
            if (key === "collaboration.admission") return capability as T;
            return fixture.context.service.get<T>(key);
          },
        },
      };
      await expect(factory.create(context, {
        instance_id: "feishu-primary", type: factory.type, config: factory.validate(admissionConfig()),
      })).rejects.toThrow(/admission/i);
      expect(await fixture.webhook.resolve("feishu-primary")).toBeNull();
      expect(fixture.signalEvents).not.toContain("signal_register");
    }
    expect(admitGetter).not.toHaveBeenCalled();
  });

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
    fixture.client.state = "reconnecting";
    expect(await instance.health()).toEqual({
      state: "degraded",
      code: "feishu_long_connection_reconnecting",
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
