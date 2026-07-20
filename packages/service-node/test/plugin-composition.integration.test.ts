import type {
  FeishuLongConnectionClient,
  FeishuLongConnectionClientFactory,
  FeishuLongConnectionState,
} from "@work-fabric/connector-feishu";
import { NodeFeishuLongConnectionClientFactory } from "@work-fabric/adapter-feishu-long-connection-node";
import { describe, expect, it, vi } from "vitest";
import { composeNodeService, parseServiceConfig } from "../src/index.js";
import type { AdmissionConfigurationSection } from "@work-fabric/adapter-admission-configuration";

const identity = { authentication_evidence: { bearer_token: "token" }, principal: { principal_id: "principal", tenant_id: "tenant-local", actor_claims: [{ actor_id: "actor-human", actor_type: "human" as const, endpoint_ids: ["endpoint-human"] }], attributes: {} } };
const rule = { tenant_id: "tenant-local", principal_id: "principal", actor_id: "actor-human", actor_type: "human" as const, endpoint_id: "endpoint-human", action: "workfabric.operations.health.read.v1", resource_id: null };
const plugin = {
  connector_id: "feishu-primary", external_tenant_id: "tenant-key", bot_open_id: "ou-bot",
  credentials: { app_id: "app", app_secret: "secret", verification_token: "verify", work_fabric_access_token: "connector-token" },
  inbound: { enabled: true, transport: "webhook", route_id: "primary", mention_only: true, intake_target: { actor_id: "actor-agent", endpoint_id: "endpoint-agent" } },
  outbound: { enabled: true, default_render_mode: "card", channels: {}, subscriptions: {} },
  identities: [{ external_open_id: "ou-human", actor_id: "actor-human", actor_type: "human", endpoint_id: "endpoint-human" }],
  worker: { poll_interval_ms: 1000, lease_seconds: 30, batch_limit: 100, max_attempts: 8 },
};
const { identities: _legacyIdentities, ...pluginWithoutIdentities } = plugin;
const admissionPlugin = {
  ...pluginWithoutIdentities,
  identity_admission: { policy_id: "feishu-primary-participants" },
};
const admissionSection = (overrides: Partial<AdmissionConfigurationSection["policies"][string]> = {}): AdmissionConfigurationSection => ({
  evidence_providers: {
    "feishu-directory-primary": {
      type: "feishu.directory",
      config: { plugin_instance_id: "feishu-primary" },
    },
  },
  policies: {
    "feishu-primary-participants": {
      policy_id: "feishu-primary-participants",
      revision: "1",
      tenant_id: "tenant-local",
      connector_id: "feishu-primary",
      source_system: "feishu",
      external_tenant_id: "tenant-key",
      default: "deny",
      allow: { all_internal_members: true, external_subject_ids: [] },
      deny: { external_subject_ids: [] },
      internal_membership: {
        evidence_provider_ref: "feishu-directory-primary",
        positive_ttl_seconds: 300,
        negative_ttl_seconds: 60,
      },
      binding: { actor_type: "human", store_ref: "participant-bindings" },
      ...overrides,
    },
  },
});

const serviceConfig = (role: "all" | "api" = "all") => parseServiceConfig({
  storage_profile: "memory-demo",
  development_mode: true,
  role,
  tenant_id: "tenant-local",
  exchange_id: "exchange-local",
  cursor_secret: "x".repeat(32),
  identities: [identity],
  authority_rules: [rule],
  listen: { port: 0 },
});

const admissionServiceConfig = (
  role: "all" | "api" = "api",
  activeKeyId: "primary" | "previous" = "primary",
) => parseServiceConfig({
  storage_profile: "memory-demo",
  development_mode: true,
  role,
  tenant_id: "tenant-local",
  exchange_id: "exchange-local",
  cursor_secret: "x".repeat(32),
  admission: {
    subject_fingerprint_key: "f".repeat(32),
    grant_active_key_id: activeKeyId,
    grant_keys: { primary: "g".repeat(32), previous: "h".repeat(32) },
    grant_ttl_seconds: 120,
    max_evidence_cache_entries: 10_000,
  },
  identities: [identity],
  authority_rules: [rule],
  listen: { port: 0 },
});

function admissionOfferEnvelope(actorId: string, endpointId: string, suffix: string) {
  const now = Date.now();
  return {
    spec_version: "1.0",
    message_id: `message-${suffix}`,
    message_type: "workfabric.handoff.offer.v1",
    sent_at: new Date(now).toISOString(),
    tenant_id: "tenant-local",
    exchange_id: "exchange-local",
    actor_id: actorId,
    endpoint_id: endpointId,
    idempotency_key: `offer-${suffix}`,
    payload: {
      work_reference: { uri: `urn:test:${suffix}`, extensions: {} },
      target: { actor_id: "actor-agent" },
      intent: [{ kind: "text", media_type: "text/plain", text: "synthetic intake" }],
      authority_scope: {
        delegation_id: `delegation-${suffix}`,
        scopes: ["work:read"],
        resource_refs: [`urn:test:${suffix}`],
        expires_at: new Date(now + 300_000).toISOString(),
        may_redelegate: false,
      },
      acceptance_criteria: [{
        criterion_id: `criterion-${suffix}`,
        description: "synthetic handoff accepted",
        required: true,
        result_schema_ref: null,
        required_evidence_types: [],
      }],
      verifier: { actor_id: actorId, actor_type: "human" },
      priority: "normal",
      accept_by: new Date(now + 60_000).toISOString(),
      result_due_at: new Date(now + 240_000).toISOString(),
    },
  };
}

class FakeLongConnectionClient implements FeishuLongConnectionClient {
  state: FeishuLongConnectionState = "connecting";
  readonly start = vi.fn(async () => {});
  readonly stop = vi.fn(async () => {});

  status() {
    return {
      state: this.state,
      code: this.state === "failed" ? "connection_failed" as const : this.state,
      reconnect_attempts: 0,
      changed_at: "2026-07-17T00:00:00.000Z",
    };
  }
}

const longConnectionPlugin = {
  ...plugin,
  credentials: {
    app_id: plugin.credentials.app_id,
    app_secret: plugin.credentials.app_secret,
    work_fabric_access_token: plugin.credentials.work_fabric_access_token,
  },
  inbound: {
    enabled: true,
    transport: "long_connection",
    mention_only: true,
    intake_target: plugin.inbound.intake_target,
  },
  outbound: { ...plugin.outbound, enabled: false },
};

async function composeLongConnectionService(client: FeishuLongConnectionClient) {
  return composeNodeService(serviceConfig("api"), {
    configuration_revision: "test:long-connection",
    plugins: {
      "feishu-primary": {
        type: "collaboration-channel.feishu",
        enabled: true,
        config: longConnectionPlugin,
      },
    },
    feishu_long_connection_client_factory: { create: () => client },
  });
}

describe("service plugin composition", () => {
  it("fails before plugin prepare when an Admission-backed plugin has no policy", async () => {
    await expect(composeNodeService(admissionServiceConfig(), {
      plugins: {
        "feishu-primary": { type: "collaboration-channel.feishu", enabled: true, config: admissionPlugin },
      },
      admission: { policies: {}, evidence_providers: {} },
    })).rejects.toMatchObject({
      code: "admission_policy_missing",
      path: "admission.policies.feishu-primary-participants",
    });
  });

  it("fails closed on Admission scope mismatch or a missing internal evidence provider", async () => {
    const options = {
      plugins: {
        "feishu-primary": { type: "collaboration-channel.feishu", enabled: true, config: admissionPlugin },
      },
    } as const;
    await expect(composeNodeService(admissionServiceConfig(), {
      ...options,
      admission: admissionSection({ connector_id: "another-connector" }),
    })).rejects.toMatchObject({
      code: "admission_policy_scope_mismatch",
      path: "admission.policies.feishu-primary-participants.connector_id",
    });
    const section = admissionSection();
    await expect(composeNodeService(admissionServiceConfig(), {
      ...options,
      admission: { ...section, evidence_providers: {} },
    })).rejects.toMatchObject({
      code: "admission_configuration_invalid",
      path: "admission.policies.feishu-primary-participants.internal_membership.evidence_provider_ref",
    });
  });

  it("normalizes direct Admission options without invoking nested accessors or proxy traps", async () => {
    let getterCalls = 0;
    const evidenceProviders = Object.defineProperty({}, "feishu-directory-primary", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { type: "feishu.directory", config: { plugin_instance_id: "feishu-primary" } };
      },
    });
    await expect(composeNodeService(admissionServiceConfig(), {
      admission: {
        policies: admissionSection().policies,
        evidence_providers: evidenceProviders,
      } as AdmissionConfigurationSection,
    })).rejects.toMatchObject({
      code: "admission_configuration_invalid",
      path: "admission.evidence_providers.feishu-directory-primary",
    });
    expect(getterCalls).toBe(0);

    const policy = admissionSection().policies["feishu-primary-participants"]!;
    const nestedAccessor = Object.defineProperty({ ...policy }, "allow", {
      enumerable: true,
      get() { getterCalls += 1; return policy.allow; },
    });
    await expect(composeNodeService(admissionServiceConfig(), {
      admission: {
        evidence_providers: admissionSection().evidence_providers,
        policies: { "feishu-primary-participants": nestedAccessor },
      } as unknown as AdmissionConfigurationSection,
    })).rejects.toMatchObject({
      code: "admission_configuration_invalid",
      path: "admission.policies.feishu-primary-participants.allow",
    });
    expect(getterCalls).toBe(0);

    const trapped = new Proxy({ ...policy }, {
      getOwnPropertyDescriptor() { throw new Error("sensitive proxy detail"); },
    });
    await expect(composeNodeService(admissionServiceConfig(), {
      admission: {
        evidence_providers: {},
        policies: { "feishu-primary-participants": trapped },
      } as unknown as AdmissionConfigurationSection,
    })).rejects.toMatchObject({
      code: "admission_configuration_invalid",
      path: "admission.policies.feishu-primary-participants.policy_id",
    });
  });

  it("composes an Admission-backed Feishu plugin with a directory descriptor", async () => {
    const service = await composeNodeService(admissionServiceConfig(), {
      plugins: {
        "feishu-primary": { type: "collaboration-channel.feishu", enabled: true, config: admissionPlugin },
      },
      admission: admissionSection(),
      fetch: async () => { throw new Error("directory lookup is not part of composition"); },
    });
    await expect(service.http.dispatch({ method: "GET", url: "/health/live" }))
      .resolves.toMatchObject({ status_code: 200 });
    await service.close();
  });

  it("lets an API composition admit and verify one scoped grant through HTTP Identity and Authority", async () => {
    const service = await composeNodeService(admissionServiceConfig("api"), {
      plugins: {
        "feishu-primary": { type: "collaboration-channel.feishu", enabled: true, config: admissionPlugin },
      },
      admission: admissionSection({
        allow: { all_internal_members: false, external_subject_ids: ["ou-admitted"] },
      }),
    });
    const admitted = await service.admission!.admit("feishu-primary-participants", {
      tenant_id: "tenant-local",
      connector_id: "feishu-primary",
      source_system: "feishu",
      external_tenant_id: "tenant-key",
      external_subject_type: "human",
      external_subject_id: "ou-admitted",
      ingress_id: "ingress-admission-http",
    });
    expect(admitted).toMatchObject({ decision: { kind: "allow" } });
    const decision = admitted.decision;
    if (decision.kind !== "allow" || admitted.representation_grant === undefined) {
      throw new Error("expected Admission allow grant");
    }
    const response = await service.http.dispatch({
      method: "POST",
      url: "/v1/commands",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${admitted.representation_grant}`,
      },
      payload: admissionOfferEnvelope(decision.binding.actor_id, decision.binding.endpoint_id, "admission-http"),
    });
    expect(response.status_code).toBe(200);
    expect(response.json()).toMatchObject({ operation_status: "accepted" });
    await service.close();
  });

  it("accepts a grant across independently composed processes during key rotation", async () => {
    const plugins = {
      "feishu-primary": { type: "collaboration-channel.feishu", enabled: true, config: admissionPlugin },
    } as const;
    const admission = admissionSection({
      allow: { all_internal_members: false, external_subject_ids: ["ou-rotation"] },
    });
    const issuer = await composeNodeService(admissionServiceConfig("api", "primary"), {
      plugins,
      admission,
    });
    const verifier = await composeNodeService(admissionServiceConfig("api", "previous"), {
      plugins,
      admission,
    });
    try {
      const admitted = await issuer.admission!.admit("feishu-primary-participants", {
        tenant_id: "tenant-local", connector_id: "feishu-primary", source_system: "feishu",
        external_tenant_id: "tenant-key", external_subject_type: "human",
        external_subject_id: "ou-rotation", ingress_id: "ingress-key-rotation",
      });
      if (admitted.decision.kind !== "allow" || admitted.representation_grant === undefined) {
        throw new Error("expected key-rotation Admission grant");
      }
      const response = await verifier.http.dispatch({
        method: "POST",
        url: "/v1/commands",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${admitted.representation_grant}`,
        },
        payload: admissionOfferEnvelope(
          admitted.decision.binding.actor_id,
          admitted.decision.binding.endpoint_id,
          "key-rotation",
        ),
      });
      expect(response.status_code).toBe(200);
      expect(response.json()).toMatchObject({ operation_status: "accepted" });
    } finally {
      await issuer.close();
      await verifier.close();
    }
  });
  it("marks readiness unavailable when the SDK detects a pong blackhole and recovers after reconnect", async () => {
    let sdkStatus: {
      state: "idle" | "connecting" | "connected" | "reconnecting" | "failed";
      reconnect_attempts: number;
    } = { state: "connecting", reconnect_attempts: 0 };
    let callbacks: {
      readonly onReady: () => void;
      readonly onError: () => void;
      readonly onReconnecting: () => void;
      readonly onReconnected: () => void;
    } | undefined;
    let settleRun!: () => void;
    const run = new Promise<void>((resolve) => { settleRun = resolve; });
    const factory = new NodeFeishuLongConnectionClientFactory({
      sdk: {
        createClient(input) {
          callbacks = input.callbacks;
          return {
            start: () => run,
            close: () => settleRun(),
            getConnectionStatus: () => ({ ...sdkStatus }),
          };
        },
        createMessageDispatcher: () => ({}),
      },
    });
    const client = factory.create({
      app_id: "cli_0123456789abcdef",
      app_secret: "secret",
      instance_id: "feishu-primary",
    });
    const service = await composeLongConnectionService(client);

    await service.start();
    sdkStatus = { state: "connected", reconnect_attempts: 0 };
    callbacks?.onReady();
    await expect(service.http.dispatch({ method: "GET", url: "/health/ready" }))
      .resolves.toMatchObject({ status_code: 200 });

    sdkStatus = { state: "reconnecting", reconnect_attempts: 1 };
    await expect(service.http.dispatch({ method: "GET", url: "/health/ready" }))
      .resolves.toMatchObject({ status_code: 503 });

    sdkStatus = { state: "connected", reconnect_attempts: 0 };
    await expect(service.http.dispatch({ method: "GET", url: "/health/ready" }))
      .resolves.toMatchObject({ status_code: 200 });

    await service.close();
  });

  it("prepares the configured Feishu webhook route without making Console part of execution", async () => {
    const create = vi.fn(() => {
      throw new Error("webhook composition must not create a long connection client");
    });
    const service = await composeNodeService(serviceConfig(), {
      configuration_revision: "test:1",
      plugins: { "feishu-primary": { type: "collaboration-channel.feishu", enabled: true, config: plugin } },
      feishu_long_connection_client_factory: { create },
    });
    const response = await service.http.dispatch({ method: "POST", url: "/v1/connectors/feishu/feishu-primary/events", headers: { "content-type": "application/json" }, payload: { type: "url_verification", token: "verify", challenge: "challenge-1" } });
    expect(response.status_code).toBe(200);
    expect(response.json()).toEqual({ challenge: "challenge-1" });
    expect(create).not.toHaveBeenCalled();
    await service.close();
  });

  it("installs the long connection adapter only at the API composition root and maps its state to readiness", async () => {
    const client = new FakeLongConnectionClient();
    const create = vi.fn(() => client);
    const factory: FeishuLongConnectionClientFactory = { create };
    const service = await composeNodeService(serviceConfig("api"), {
      configuration_revision: "test:long-connection",
      plugins: {
        "feishu-primary": {
          type: "collaboration-channel.feishu",
          enabled: true,
          config: longConnectionPlugin,
        },
      },
      feishu_long_connection_client_factory: factory,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      app_id: "app",
      app_secret: "secret",
      instance_id: "feishu-primary",
    });
    await service.start();
    expect(client.start).toHaveBeenCalledTimes(1);

    await expect(service.http.dispatch({ method: "GET", url: "/health/live" }))
      .resolves.toMatchObject({ status_code: 200 });
    await expect(service.http.dispatch({ method: "GET", url: "/health/ready" }))
      .resolves.toMatchObject({ status_code: 503 });

    client.state = "reconnecting";
    await expect(service.http.dispatch({ method: "GET", url: "/health/ready" }))
      .resolves.toMatchObject({ status_code: 503 });

    client.state = "failed";
    await expect(service.http.dispatch({ method: "GET", url: "/health/live" }))
      .resolves.toMatchObject({ status_code: 200 });
    await expect(service.http.dispatch({ method: "GET", url: "/health/ready" }))
      .resolves.toMatchObject({ status_code: 503 });

    client.state = "connected";
    await expect(service.http.dispatch({ method: "GET", url: "/health/ready" }))
      .resolves.toMatchObject({ status_code: 200 });

    await service.close();
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it("releases a prepared long connection client when closed before start", async () => {
    const client = new FakeLongConnectionClient();
    const service = await composeLongConnectionService(client);

    await service.close();
    await service.close();

    expect(client.start).not.toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalledTimes(1);
  });

  it("keeps a started service healthy when start is called again", async () => {
    vi.useFakeTimers();
    const client = new FakeLongConnectionClient();
    client.state = "connected";
    const service = await composeLongConnectionService(client);

    try {
      const first = service.start();
      await first;
      const runningTimers = vi.getTimerCount();
      expect(runningTimers).toBe(2);

      const second = service.start();
      const sharedStart = second === first;
      const [secondOutcome] = await Promise.allSettled([second]);

      expect(sharedStart).toBe(true);
      expect(secondOutcome).toEqual({ status: "fulfilled", value: undefined });
      expect(client.start).toHaveBeenCalledTimes(1);
      expect(client.stop).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(runningTimers);
      await expect(service.http.dispatch({ method: "GET", url: "/health/ready" }))
        .resolves.toMatchObject({ status_code: 200 });
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });

  it("shares one launch across concurrent start calls", async () => {
    vi.useFakeTimers();
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const client = new FakeLongConnectionClient();
    client.state = "connected";
    client.start.mockImplementation(() => startGate);
    const service = await composeLongConnectionService(client);

    try {
      const first = service.start();
      const second = service.start();
      const sharedStart = second === first;
      expect(client.start).toHaveBeenCalledTimes(1);

      releaseStart();
      const outcomes = await Promise.allSettled([first, second]);

      expect(sharedStart).toBe(true);
      expect(outcomes).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(client.start).toHaveBeenCalledTimes(1);
      expect(client.stop).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(2);
      await expect(service.http.dispatch({ method: "GET", url: "/health/ready" }))
        .resolves.toMatchObject({ status_code: 200 });
    } finally {
      releaseStart();
      await service.close();
      vi.useRealTimers();
    }
  });

  it("replays the original failed start without rolling back twice", async () => {
    const failure = new Error("long start failed");
    const client = new FakeLongConnectionClient();
    client.start.mockRejectedValue(failure);
    const service = await composeLongConnectionService(client);

    await expect(service.start()).rejects.toBe(failure);
    expect(client.stop).toHaveBeenCalledTimes(1);
    await expect(service.start()).rejects.toBe(failure);

    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.stop).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it("waits for an in-flight start before closing and never restarts while closing", async () => {
    vi.useFakeTimers();
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const client = new FakeLongConnectionClient();
    client.start.mockImplementation(() => startGate);
    const service = await composeLongConnectionService(client);

    const starting = service.start();
    const closing = service.close();
    const lateStart = service.start();
    const sharedClose = lateStart === closing;

    try {
      releaseStart();
      const outcomes = await Promise.allSettled([starting, closing, lateStart]);

      expect(sharedClose).toBe(true);
      expect(outcomes).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(client.start).toHaveBeenCalledTimes(1);
      expect(client.stop).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      releaseStart();
      await service.close();
      vi.useRealTimers();
    }
  });

  it("does not revive a service after close", async () => {
    vi.useFakeTimers();
    const client = new FakeLongConnectionClient();
    const service = await composeLongConnectionService(client);

    try {
      await service.close();
      const closed = service.start();
      await expect(closed).resolves.toBeUndefined();

      expect(client.start).not.toHaveBeenCalled();
      expect(client.stop).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });
});
