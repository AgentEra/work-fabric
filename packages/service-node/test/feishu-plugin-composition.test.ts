import { describe, expect, it } from "vitest";

import type { PluginHostConfiguration } from "@work-fabric/plugin-runtime";

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
      .toThrowError("inbound must be an object");
  });
});
