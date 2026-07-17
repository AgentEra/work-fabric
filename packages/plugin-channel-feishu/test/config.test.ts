import { describe, expect, it } from "vitest";
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
  },
  outbound: { enabled: true, default_render_mode: "card", channels: {}, subscriptions: {} },
  identities: [{ external_open_id: "ou-human", actor_id: "actor-human", actor_type: "human", endpoint_id: "endpoint-human" }],
  worker: { poll_interval_ms: 1000, lease_seconds: 30, batch_limit: 100, max_attempts: 8 },
});

describe("Feishu plugin configuration", () => {
  it("strictly validates a bounded instance and declares secret paths", () => {
    const parsed = validateFeishuPluginConfig(valid());
    expect(parsed.inbound.intake_target.actor_id).toBe("actor-agent");
    expect(feishuSecretPaths("plugins.instances.feishu-primary.config", parsed)).toEqual([
      "plugins.instances.feishu-primary.config.credentials.app_id",
      "plugins.instances.feishu-primary.config.credentials.app_secret",
      "plugins.instances.feishu-primary.config.credentials.verification_token",
      "plugins.instances.feishu-primary.config.credentials.work_fabric_access_token",
    ]);
  });

  it("rejects unknown keys, duplicate identities, and unsafe bounds", () => {
    expect(() => validateFeishuPluginConfig({ ...valid(), surprise: true })).toThrow(/unknown/);
    expect(() => validateFeishuPluginConfig({ ...valid(), identities: [...valid().identities, ...valid().identities] })).toThrow(/duplicate/);
    expect(() => validateFeishuPluginConfig({ ...valid(), worker: { ...valid().worker, batch_limit: 1001 } })).toThrow(/batch_limit/);
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
