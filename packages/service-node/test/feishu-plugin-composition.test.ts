import { describe, expect, it } from "vitest";

import type { PluginHostConfiguration } from "@work-fabric/plugin-runtime";

import {
  composeNodeService,
  parseServiceConfig,
  type NodeServiceCompositionOptions,
} from "../src/index.js";
import { assertFeishuPluginRole } from "../src/feishu-plugin-composition.js";

const longConnectionConfig = {
  connector_id: "feishu-primary",
  external_tenant_id: "tenant-key",
  bot_open_id: "ou-bot",
  credentials: {
    app_id: "app",
    app_secret: "secret",
    work_fabric_access_token: "connector-token",
  },
  inbound: {
    enabled: true,
    transport: "long_connection",
    mention_only: true,
    intake_target: { actor_id: "actor-agent", endpoint_id: "endpoint-agent" },
  },
  outbound: {
    enabled: false,
    default_render_mode: "card",
    channels: {},
    subscriptions: {},
  },
  identities: [],
  worker: {
    poll_interval_ms: 1_000,
    lease_seconds: 30,
    batch_limit: 100,
    max_attempts: 8,
  },
};

function plugins(
  config: unknown,
  enabled = true,
): PluginHostConfiguration {
  return {
    "feishu-primary": {
      type: "collaboration-channel.feishu",
      enabled,
      config,
    },
  };
}

describe("Feishu plugin deployment role", () => {
  it.each(["api", "all"] as const)(
    "allows enabled long connection plugins on the %s role",
    (role) => {
      expect(() => assertFeishuPluginRole(role, plugins(longConnectionConfig)))
        .not.toThrow();
    },
  );

  it("rejects an enabled long connection plugin on a pure worker", () => {
    expect(() => assertFeishuPluginRole("worker", plugins(longConnectionConfig)))
      .toThrowError("feishu_long_connection_requires_api_role");
  });

  it("allows webhook plugins on a pure worker", () => {
    const webhook = {
      ...longConnectionConfig,
      credentials: {
        ...longConnectionConfig.credentials,
        verification_token: "verify",
      },
      inbound: {
        ...longConnectionConfig.inbound,
        transport: "webhook",
        route_id: "primary",
      },
    };

    expect(() => assertFeishuPluginRole("worker", plugins(webhook)))
      .not.toThrow();
  });

  it("allows disabled long connection plugins on a pure worker", () => {
    expect(() => assertFeishuPluginRole(
      "worker",
      plugins(longConnectionConfig, false),
    )).not.toThrow();
  });

  it("validates enabled Feishu plugin configurations for every role", () => {
    expect(() => assertFeishuPluginRole("api", plugins({})))
      .toThrowError("exactly one of identities or identity_admission is required");
  });

  it("rejects a pure worker before reading storage or cluster dependencies", async () => {
    const config = parseServiceConfig({
      storage_profile: "postgres",
      role: "worker",
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      postgres: { connection_string: "postgres://deployment-owned" },
      identities: [{
        authentication_evidence: { bearer_token: "token" },
        principal: {
          principal_id: "principal",
          tenant_id: "tenant-local",
          actor_claims: [{
            actor_id: "actor",
            actor_type: "human",
            endpoint_ids: ["endpoint"],
          }],
          attributes: {},
        },
      }],
      authority_rules: [{
        tenant_id: "tenant-local",
        principal_id: "principal",
        actor_id: "actor",
        actor_type: "human",
        endpoint_id: "endpoint",
        action: "workfabric.operations.health.read.v1",
        resource_id: null,
      }],
      cluster: {
        worker_owner_id: "worker-a",
        tenant_ids: ["tenant-local"],
        max_concurrent_turns: 1,
        max_ready_items: 10,
        catalog_page_size: 5,
        turn_item_limit: 10,
        lease_seconds: 30,
        drain_timeout_seconds: 2,
        poll_interval_ms: 1_000,
        max_tenants_per_host: 1,
      },
    });
    let storageRead = false;
    let clusterRead = false;
    const composition = {
      plugins: plugins(longConnectionConfig),
      get postgres_storage(): NonNullable<NodeServiceCompositionOptions["postgres_storage"]> {
        storageRead = true;
        throw new Error("postgres storage was read");
      },
      get cluster_worker(): NonNullable<NodeServiceCompositionOptions["cluster_worker"]> {
        clusterRead = true;
        throw new Error("cluster dependencies were read");
      },
    };

    await expect(composeNodeService(config, composition))
      .rejects.toThrowError("feishu_long_connection_requires_api_role");
    expect(storageRead).toBe(false);
    expect(clusterRead).toBe(false);
  });
});
