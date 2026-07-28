import { describe, expect, it } from "vitest";

import { validateFeishuProviderConfig } from "../src/index.js";

const config = {
  credential_ref: "feishu-primary",
  open_api: {
    base_url: "https://open.feishu.cn",
    request_timeout_ms: 10_000,
    max_response_bytes: 131_072,
  },
  state: {
    type: "sqlite",
    location: "./var/feishu-provider.db",
    busy_timeout_ms: 5_000,
  },
  capability_citizen: {
    citizen_id: "feishu-actions",
    principal_id: "principal-feishu-actions",
    actor_id: "actor-feishu-actions",
    endpoint_id: "endpoint-feishu-actions",
    registration_version: 1,
  },
  context_citizen: {
    citizen_id: "feishu-context",
    principal_id: "principal-feishu-context",
    actor_id: "actor-feishu-context",
    endpoint_id: "endpoint-feishu-context",
    registration_version: 1,
  },
};

describe("validateFeishuProviderConfig", () => {
  it("accepts bootstrap references and bounds without static capabilities or secrets", () => {
    const result = validateFeishuProviderConfig(config);
    expect(result.state.type).toBe("sqlite");
    expect(result).not.toHaveProperty("shared_folder");
    expect(JSON.stringify(result)).not.toMatch(/app_secret|access_token/);
  });

  it("rejects unknown fields and embedded secrets", () => {
    expect(() => validateFeishuProviderConfig({
      ...config,
      app_secret: "must-not-be-here",
    })).toThrow(/field/i);
  });

  it("rejects document ACL and placement policy embedded in deployment config", () => {
    expect(() => validateFeishuProviderConfig({
      ...config,
      shared_folder: {
        token: "fld-forbidden",
        policy_ref: "customer.default",
        visibility: "tenant_readable",
      },
    })).toThrow(/field/i);
    expect(() => validateFeishuProviderConfig({
      ...config,
      allowed_document_tokens: ["doc-forbidden"],
    })).toThrow(/field/i);
  });
});
