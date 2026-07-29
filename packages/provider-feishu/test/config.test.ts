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

  it("accepts independently enabled message and document Provider facets", () => {
    const { capability_citizen: _legacy, ...shared } = config;
    const result = validateFeishuProviderConfig({
      ...shared,
      cursor_signing_key: "${WORK_FABRIC_FEISHU_CURSOR_SECRET}",
      message_citizen: {
        enabled: true,
        citizen_id: "citizen-feishu-message",
        principal_id: "principal-feishu-provider",
        actor_id: "actor-feishu-provider",
        endpoint_id: "endpoint-feishu-provider",
        registration_version: 1,
      },
      document_citizen: {
        enabled: false,
      },
    });

    expect(result).toMatchObject({
      cursor_signing_key: "${WORK_FABRIC_FEISHU_CURSOR_SECRET}",
      message_citizen: {
        enabled: true,
        citizen_id: "citizen-feishu-message",
      },
      document_citizen: { enabled: false },
    });
    expect(result).not.toHaveProperty("capability_citizen");
  });

  it("allows either facet to be disabled but rejects duplicate enabled Citizen IDs", () => {
    const { capability_citizen: _legacy, ...shared } = config;
    const citizen = {
      enabled: true,
      citizen_id: "citizen-duplicate",
      principal_id: "principal-feishu-provider",
      actor_id: "actor-feishu-provider",
      endpoint_id: "endpoint-feishu-provider",
      registration_version: 1,
    };
    expect(() => validateFeishuProviderConfig({
      ...shared,
      cursor_signing_key: "${WORK_FABRIC_FEISHU_CURSOR_SECRET}",
      message_citizen: citizen,
      document_citizen: citizen,
    })).toThrow(/duplicate/i);
  });

  it("accepts an independent Calendar facet and a disabled Calendar needs no identity", () => {
    const { capability_citizen: _legacy, ...shared } = config;
    const enabled = validateFeishuProviderConfig({
      ...shared,
      message_citizen: { enabled: false },
      document_citizen: { enabled: false },
      calendar_citizen: {
        enabled: true,
        citizen_id: "citizen-feishu-calendar",
        principal_id: "principal-feishu-provider",
        actor_id: "actor-feishu-provider",
        endpoint_id: "endpoint-feishu-provider",
        registration_version: 1,
      },
    });
    expect(enabled).toMatchObject({
      calendar_citizen: {
        enabled: true,
        citizen_id: "citizen-feishu-calendar",
      },
    });

    expect(validateFeishuProviderConfig({
      ...shared,
      cursor_signing_key: "${WORK_FABRIC_FEISHU_CURSOR_SECRET}",
      message_citizen: {
        enabled: true,
        citizen_id: "citizen-feishu-message",
        principal_id: "principal-feishu-provider",
        actor_id: "actor-feishu-provider",
        endpoint_id: "endpoint-feishu-provider",
        registration_version: 1,
      },
      document_citizen: { enabled: false },
      calendar_citizen: { enabled: false },
    })).toMatchObject({
      calendar_citizen: { enabled: false },
    });
  });

  it("rejects Calendar Citizen IDs duplicated by another facet or Context", () => {
    const { capability_citizen: _legacy, ...shared } = config;
    const calendar = {
      enabled: true,
      citizen_id: "feishu-context",
      principal_id: "principal-feishu-provider",
      actor_id: "actor-feishu-provider",
      endpoint_id: "endpoint-feishu-provider",
      registration_version: 1,
    };
    expect(() => validateFeishuProviderConfig({
      ...shared,
      message_citizen: { enabled: false },
      document_citizen: { enabled: false },
      calendar_citizen: calendar,
    })).toThrow(/duplicate/i);
  });

  it("rejects mixing the legacy aggregate and independent facet forms", () => {
    expect(() => validateFeishuProviderConfig({
      ...config,
      message_citizen: {
        enabled: false,
      },
      document_citizen: {
        enabled: false,
      },
    })).toThrow(/legacy|facet/i);
  });
});
