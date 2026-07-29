import { describe, expect, it } from "vitest";
import {
  debugSecretPaths,
  validateDebugPluginConfig,
} from "../src/index.js";
import { validDebugConfig } from "./fixtures.js";

describe("Debug Channel configuration", () => {
  it("parses static and Admission participants with bounded defaults", () => {
    expect(validateDebugPluginConfig(validDebugConfig())).toMatchObject({
      connector_id: "debug-local",
      participants: {
        "internal-user": { mode: "static", actor_id: "actor-debug-user" },
        "admitted-user": {
          mode: "admission",
          policy_id: "debug-local-admission",
        },
      },
      delegation: { scopes: ["work:read"], may_redelegate: false },
      accept_within_seconds: 86_400,
      result_due_within_seconds: 604_800,
      worker: {
        poll_interval_ms: 100,
        lease_seconds: 30,
        batch_limit: 100,
        max_attempts: 8,
      },
    });
  });

  it.each(["localhost", "0.0.0.0", "::", "192.168.1.10"])(
    "rejects non-literal or non-loopback host %s",
    (host) => {
      expect(() => validateDebugPluginConfig({
        ...validDebugConfig(),
        listen: { host, port: 8791 },
      })).toThrow("loopback IP");
    },
  );

  it("accepts IPv4 loopback range and IPv6 loopback", () => {
    expect(validateDebugPluginConfig({
      ...validDebugConfig(),
      listen: { host: "127.42.0.9", port: 8791 },
    }).listen.host).toBe("127.42.0.9");
    expect(validateDebugPluginConfig({
      ...validDebugConfig(),
      listen: { host: "::1", port: 8791 },
    }).listen.host).toBe("::1");
  });

  it("rejects an unknown participant configuration field", () => {
    expect(() => validateDebugPluginConfig({
      ...validDebugConfig(),
      participants: {
        "internal-user": {
          ...validDebugConfig().participants["internal-user"],
          administrator: true,
        },
      },
    })).toThrow("participants.internal-user");
  });

  it("rejects fields from the other participant mode even when undefined", () => {
    expect(() => validateDebugPluginConfig({
      ...validDebugConfig(),
      participants: {
        "internal-user": {
          ...validDebugConfig().participants["internal-user"],
          policy_id: undefined,
        },
      },
    })).toThrow("participants.internal-user");
  });

  it("rejects duplicate external subjects under different fixture names", () => {
    const participant = validDebugConfig().participants["internal-user"];
    expect(() => validateDebugPluginConfig({
      ...validDebugConfig(),
      participants: {
        first: participant,
        second: {
          ...participant,
          actor_id: "actor-other",
          endpoint_id: "endpoint-other",
        },
      },
    })).toThrow("duplicate external subject");
  });

  it("rejects ports and limits outside their bounds", () => {
    expect(() => validateDebugPluginConfig({
      ...validDebugConfig(),
      listen: { host: "127.0.0.1", port: 0 },
    })).toThrow("listen.port");
    expect(() => validateDebugPluginConfig({
      ...validDebugConfig(),
      limits: { ...validDebugConfig().limits, max_content_parts: 0 },
    })).toThrow("max_content_parts");
  });

  it("declares only the debug Bearer token as a secret", () => {
    const parsed = validateDebugPluginConfig(validDebugConfig());
    expect(debugSecretPaths(
      "plugins.instances.debug-local.config",
      parsed,
    )).toEqual([
      "plugins.instances.debug-local.config.credentials.bearer_token",
    ]);
  });
});
