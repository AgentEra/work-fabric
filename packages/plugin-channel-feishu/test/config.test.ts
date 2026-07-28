import { describe, expect, it, vi } from "vitest";
import { feishuSecretPaths, validateFeishuPluginConfig } from "../src/index.js";

const valid = () => ({
  connector_id: "feishu-primary", external_tenant_id: "tenant-key-1", bot_open_id: "ou-bot",
  credentials: {
    app_id: "${FEISHU_APP_ID}", app_secret: "${FEISHU_APP_SECRET}",
    verification_token: "${FEISHU_VERIFICATION_TOKEN}",
    work_fabric_access_token: "${FEISHU_CONNECTOR_ACCESS_TOKEN}",
  },
  inbound: {
    enabled: true, transport: "webhook", route_id: "primary", mention_only: true,
    intake_target: { actor_id: "actor-agent", endpoint_id: "endpoint-agent" },
    delegation: {
      scopes: ["work:read", "document:read", "document:write"],
      may_redelegate: true,
    },
  },
  outbound: { enabled: true, default_render_mode: "card", channels: {}, subscriptions: {} },
  identities: [{ external_open_id: "ou-human", actor_id: "actor-human", actor_type: "human", endpoint_id: "endpoint-human" }],
  worker: { poll_interval_ms: 1000, lease_seconds: 30, batch_limit: 100, max_attempts: 8 },
});

const longConnection = () => ({
  connector_id: "feishu-primary",
  external_tenant_id: "tenant-key-1",
  bot_open_id: "ou-bot",
  credentials: {
    app_id: "${FEISHU_APP_ID}",
    app_secret: "${FEISHU_APP_SECRET}",
    work_fabric_access_token: "${FEISHU_CONNECTOR_ACCESS_TOKEN}",
  },
  inbound: {
    enabled: true,
    transport: "long_connection",
    mention_only: true,
    intake_target: {
      actor_id: "actor-agent",
      endpoint_id: "endpoint-agent",
    },
  },
  outbound: valid().outbound,
  identities: valid().identities,
  worker: valid().worker,
});

const admission = () => {
  const { identities: _identities, ...configuration } = valid();
  return {
    ...configuration,
    identity_admission: { policy_id: "feishu-primary-participants" },
  };
};

describe("Feishu plugin configuration", () => {
  it("keeps valid Webhook configuration source-compatible", () => {
    const parsed = validateFeishuPluginConfig(valid());
    expect(parsed.inbound.intake_target.actor_id).toBe("actor-agent");
    expect(parsed.inbound.delegation).toEqual({
      scopes: ["work:read", "document:read", "document:write"],
      may_redelegate: true,
    });
    expect(feishuSecretPaths("plugins.instances.feishu-primary.config", parsed)).toEqual([
      "plugins.instances.feishu-primary.config.credentials.app_id",
      "plugins.instances.feishu-primary.config.credentials.app_secret",
      "plugins.instances.feishu-primary.config.credentials.verification_token",
      "plugins.instances.feishu-primary.config.credentials.work_fabric_access_token",
    ]);
  });

  it("accepts long connection without Webhook-only fields", () => {
    expect(validateFeishuPluginConfig(longConnection())).toMatchObject({
      credentials: {
        app_id: "${FEISHU_APP_ID}",
        app_secret: "${FEISHU_APP_SECRET}",
        work_fabric_access_token: "${FEISHU_CONNECTOR_ACCESS_TOKEN}",
      },
      inbound: { transport: "long_connection" },
    });
  });

  it("accepts exactly one strict participant identity mode", () => {
    expect(validateFeishuPluginConfig(admission())).toMatchObject({
      identity_admission: { policy_id: "feishu-primary-participants" },
    });
    expect(() => validateFeishuPluginConfig({
      ...valid(),
      identity_admission: { policy_id: "feishu-primary-participants" },
    })).toThrow(/exactly one|both/i);
    const { identities: _identities, ...neither } = valid();
    expect(() => validateFeishuPluginConfig(neither)).toThrow(/exactly one|identity/i);
  });

  it("rejects unknown or invalid identity admission configuration", () => {
    expect(() => validateFeishuPluginConfig({
      ...admission(),
      identity_admission: { policy_id: "feishu-primary-participants", precedence: "allow-first" },
    })).toThrow(/identity_admission/);
    expect(() => validateFeishuPluginConfig({
      ...admission(),
      identity_admission: { policy_id: " spaced " },
    })).toThrow(/policy_id/);
  });

  it("reads identity mode and policy only from exact own data descriptors", () => {
    const identityModeGetter = vi.fn(() => ({ policy_id: "should-not-run" }));
    const topLevelAccessor = admission();
    Object.defineProperty(topLevelAccessor, "identity_admission", {
      enumerable: true,
      get: identityModeGetter,
    });
    expect(() => validateFeishuPluginConfig(topLevelAccessor)).toThrow(/identity/i);
    expect(identityModeGetter).not.toHaveBeenCalled();

    const inherited = Object.create({ policy_id: "inherited-policy" }) as Record<string, unknown>;
    expect(() => validateFeishuPluginConfig({ ...admission(), identity_admission: inherited })).toThrow(/identity_admission/);

    const policyGetter = vi.fn(() => "should-not-run");
    const nestedAccessor: Record<string, unknown> = {};
    Object.defineProperty(nestedAccessor, "policy_id", { enumerable: true, get: policyGetter });
    expect(() => validateFeishuPluginConfig({ ...admission(), identity_admission: nestedAccessor })).toThrow(/policy_id/);
    expect(policyGetter).not.toHaveBeenCalled();

    expect(() => validateFeishuPluginConfig({ ...admission(), identity_admission: { policy_id: undefined } })).toThrow(/policy_id/);
  });

  it("fails closed on identity-mode descriptor proxy errors", () => {
    const proxy = new Proxy(admission(), {
      getOwnPropertyDescriptor(target, property) {
        if (property === "identity_admission") throw new Error("private descriptor detail");
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(() => validateFeishuPluginConfig(proxy)).toThrow(/config|identity/i);
  });

  it.each([
    ["verification_token", { credentials: { ...longConnection().credentials, verification_token: "verify" } }],
    ["encrypt_key", { credentials: { ...longConnection().credentials, encrypt_key: "encrypt" } }],
    ["route_id", { inbound: { ...longConnection().inbound, route_id: "primary" } }],
  ])("rejects Webhook-only %s for long connection", (_field, replacement) => {
    expect(() => validateFeishuPluginConfig({ ...longConnection(), ...replacement })).toThrow(/unknown key/);
  });

  it("still requires verification_token for Webhook", () => {
    const { verification_token: _verificationToken, ...credentials } = valid().credentials;
    expect(() => validateFeishuPluginConfig({ ...valid(), credentials })).toThrow(/verification_token/);
  });

  it("still requires route_id for Webhook", () => {
    const { route_id: _routeId, ...inbound } = valid().inbound;
    expect(() => validateFeishuPluginConfig({ ...valid(), inbound })).toThrow(/route_id/);
  });

  it("rejects unsupported transports", () => {
    expect(() => validateFeishuPluginConfig({
      ...longConnection(),
      inbound: { ...longConnection().inbound, transport: "polling" },
    })).toThrow(/transport/);
  });

  it("rejects unknown keys in long-connection branches", () => {
    expect(() => validateFeishuPluginConfig({
      ...longConnection(),
      credentials: { ...longConnection().credentials, surprise: true },
    })).toThrow(/unknown key surprise/);
  });

  it("declares only common secret paths for long connection", () => {
    const parsed = validateFeishuPluginConfig(longConnection());
    expect(feishuSecretPaths("plugins.instances.feishu-primary.config", parsed)).toEqual([
      "plugins.instances.feishu-primary.config.credentials.app_id",
      "plugins.instances.feishu-primary.config.credentials.app_secret",
      "plugins.instances.feishu-primary.config.credentials.work_fabric_access_token",
    ]);
  });

  it("rejects unknown keys, duplicate identities, and unsafe bounds", () => {
    expect(() => validateFeishuPluginConfig({ ...valid(), surprise: true })).toThrow(/unknown/);
    expect(() => validateFeishuPluginConfig({ ...valid(), identities: [...valid().identities, ...valid().identities] })).toThrow(/duplicate/);
    expect(() => validateFeishuPluginConfig({ ...valid(), worker: { ...valid().worker, batch_limit: 1001 } })).toThrow(/batch_limit/);
    expect(() => validateFeishuPluginConfig({
      ...valid(),
      inbound: {
        ...valid().inbound,
        delegation: { scopes: ["document:write", "document:write"], may_redelegate: true },
      },
    })).toThrow(/duplicate/i);
    expect(() => validateFeishuPluginConfig({
      ...valid(),
      inbound: {
        ...valid().inbound,
        delegation: { scopes: ["document:write"], may_redelegate: "yes" },
      },
    })).toThrow(/may_redelegate/i);
  });

  it("normalizes strict static channels and canonical subscription filters", () => {
    const parsed = validateFeishuPluginConfig({
      ...valid(),
      outbound: {
        enabled: true,
        default_render_mode: "card",
        channels: { project: { receive_id_type: "chat_id", receive_id: "oc-project", render_mode: "text" } },
        subscriptions: {
          results: {
            channel_ref: "project",
            owner: { actor_id: "actor-owner", actor_type: "human", endpoint_id: "endpoint-owner" },
            filter: { event_types: ["workfabric.handoff.result_returned.v1"] },
          },
        },
      },
    });
    expect(parsed.outbound.subscriptions.results).toMatchObject({
      channel_ref: "project",
      filter: {
        event_types: ["workfabric.handoff.result_returned.v1"],
        actor_ids: [], endpoint_ids: [], thread_ids: [], handoff_ids: [],
        work_reference_uris: [], capability_ids: [], lifecycle_states: [],
      },
    });
    expect(() => validateFeishuPluginConfig({
      ...valid(),
      outbound: { ...valid().outbound, subscriptions: { bad: { channel_ref: "missing", owner: { actor_id: "a", actor_type: "human", endpoint_id: "e" }, filter: {} } } },
    })).toThrow(/channel_ref/);
  });
});
