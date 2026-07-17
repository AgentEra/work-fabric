import { describe, expect, it } from "vitest";
import { composeNodeService, parseServiceConfig } from "../src/index.js";

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

describe("service plugin composition", () => {
  it("prepares the configured Feishu webhook route without making Console part of execution", async () => {
    const service = await composeNodeService(parseServiceConfig({ storage_profile: "memory-demo", development_mode: true, tenant_id: "tenant-local", exchange_id: "exchange-local", cursor_secret: "x".repeat(32), identities: [identity], authority_rules: [rule], listen: { port: 0 } }), {
      configuration_revision: "test:1",
      plugins: { "feishu-primary": { type: "collaboration-channel.feishu", enabled: true, config: plugin } },
    });
    const response = await service.http.dispatch({ method: "POST", url: "/v1/connectors/feishu/feishu-primary/events", headers: { "content-type": "application/json" }, payload: { type: "url_verification", token: "verify", challenge: "challenge-1" } });
    expect(response.status_code).toBe(200);
    expect(response.json()).toEqual({ challenge: "challenge-1" });
    await service.close();
  });
});
