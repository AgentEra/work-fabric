import type {
  FeishuLongConnectionClient,
  FeishuLongConnectionClientFactory,
  FeishuLongConnectionState,
} from "@work-fabric/connector-feishu";
import { describe, expect, it, vi } from "vitest";
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

describe("service plugin composition", () => {
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
    const service = await composeNodeService(serviceConfig("api"), {
      plugins: {
        "feishu-primary": {
          type: "collaboration-channel.feishu",
          enabled: true,
          config: {
            ...plugin,
            credentials: {
              app_id: "app",
              app_secret: "secret",
              work_fabric_access_token: "connector-token",
            },
            inbound: {
              enabled: true,
              transport: "long_connection",
              mention_only: true,
              intake_target: plugin.inbound.intake_target,
            },
          },
        },
      },
      feishu_long_connection_client_factory: { create: () => client },
    });

    await service.close();
    await service.close();

    expect(client.start).not.toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalledTimes(1);
  });
});
