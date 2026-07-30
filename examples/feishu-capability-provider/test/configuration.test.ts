import { describe, expect, it } from "vitest";

import { loadFeishuProviderConfiguration } from "../src/configuration.js";

const bundle = {
  revision: "test",
  value: {
    api_version: "workfabric.config-bundle/v1",
    applications: {
      "feishu-provider": {
        api_version: "workfabric.config/v1",
        service: {
          runtime_id: "feishu-provider-local",
          development_mode: true,
          work_fabric: {
            base_url: "http://127.0.0.1:8787",
            tenant_id: "tenant-local",
            exchange_id: "exchange-local",
            subscription_id: "subscription-feishu-provider",
            access_token: "${FEISHU_PROVIDER_ACCESS_TOKEN}",
          },
          concurrency: {
            max_active_runs: 2,
            queue_capacity: 16,
            max_active_partitions: 32,
          },
          runtime_state: {
            location: ".local/feishu-provider-runtime.db",
            busy_timeout_ms: 5_000,
          },
          document_access: {
            mode: "development_app_identity",
            default_resource_uri: "feishu://drive/root",
          },
          citizen_lease: {
            requested_lease_seconds: 60,
            heartbeat_safety_margin_ms: 5_000,
          },
        },
        participant: {
          actor_id: "actor-feishu-provider",
          actor_type: "agent",
          endpoint_id: "endpoint-feishu-provider",
        },
        plugins: {
          instances: {
            "feishu-primary": {
              type: "capability-provider.feishu",
              enabled: true,
              config: {
                credential_ref: "feishu-primary",
                open_api: {
                  base_url: "https://open.feishu.cn",
                  request_timeout_ms: 10_000,
                  max_response_bytes: 1_048_576,
                },
                state: {
                  type: "sqlite",
                  location: ".local/feishu-provider.db",
                  busy_timeout_ms: 5_000,
                },
                capability_citizen: {
                  citizen_id: "citizen-feishu-capability",
                  principal_id: "principal-feishu-provider",
                  actor_id: "actor-feishu-provider",
                  endpoint_id: "endpoint-feishu-provider",
                  registration_version: 1,
                },
                context_citizen: {
                  citizen_id: "citizen-feishu-context",
                  principal_id: "principal-feishu-provider",
                  actor_id: "actor-feishu-provider",
                  endpoint_id: "endpoint-feishu-provider",
                  registration_version: 1,
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

describe("Feishu Provider configuration", () => {
  it("selects one bundle application and resolves only declared private values", async () => {
    const loaded = await loadFeishuProviderConfiguration({
      document: bundle,
      environment: {
        FEISHU_PROVIDER_ACCESS_TOKEN: "provider-token",
      },
    });
    expect(loaded.service.work_fabric.access_token).toBe("provider-token");
    expect(loaded.service.document_access).toEqual({
      mode: "development_app_identity",
      default_resource_uri: "feishu://drive/root",
    });
    expect(loaded.provider).not.toHaveProperty("shared_folder");
    expect(loaded.provider.credential_ref).toBe("feishu-primary");
    expect(loaded.participant.endpoint_id).toBe("endpoint-feishu-provider");
    expect(loaded.service.concurrency.max_active_partitions).toBe(32);
  });

  it("fails closed when a required secret is missing", async () => {
    await expect(loadFeishuProviderConfiguration({
      document: bundle,
      environment: {},
    })).rejects.toThrow();
  });

  it("loads independently registered Provider facets and resolves the cursor key", async () => {
    const changed = structuredClone(bundle) as unknown as {
      value: {
        applications: Record<string, {
          plugins: {
            instances: Record<string, {
              config: Record<string, unknown>;
            }>;
          };
        }>;
      };
    };
    const provider = changed.value.applications["feishu-provider"]!
      .plugins.instances["feishu-primary"]!.config;
    delete provider.capability_citizen;
    provider.cursor_signing_key = "${FEISHU_CURSOR_SIGNING_KEY}";
    provider.message_citizen = {
      enabled: true,
      citizen_id: "citizen-feishu-message",
      principal_id: "principal-feishu-provider",
      actor_id: "actor-feishu-provider",
      endpoint_id: "endpoint-feishu-provider",
      registration_version: 1,
    };
    provider.document_citizen = { enabled: false };
    provider.calendar_citizen = {
      enabled: true,
      citizen_id: "citizen-feishu-calendar",
      principal_id: "principal-feishu-provider",
      actor_id: "actor-feishu-provider",
      endpoint_id: "endpoint-feishu-provider",
      registration_version: 1,
    };

    const loaded = await loadFeishuProviderConfiguration({
      document: changed as never,
      environment: {
        FEISHU_PROVIDER_ACCESS_TOKEN: "provider-token",
        FEISHU_CURSOR_SIGNING_KEY: "0123456789abcdef0123456789abcdef",
      },
    });

    expect(loaded.provider.cursor_signing_key).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    expect(loaded.provider.message_citizen).toMatchObject({
      enabled: true,
      citizen_id: "citizen-feishu-message",
    });
    expect(loaded.provider.document_citizen).toEqual({ enabled: false });
    expect(loaded.provider.calendar_citizen).toMatchObject({
      enabled: true,
      citizen_id: "citizen-feishu-calendar",
    });
  });

  it("requires exactly one enabled Feishu Provider instance", async () => {
    const changed = structuredClone(bundle);
    changed.value.applications["feishu-provider"].plugins.instances["feishu-primary"].enabled = false;
    await expect(loadFeishuProviderConfiguration({
      document: changed,
      environment: {},
    })).rejects.toThrow("plugins.instances");
  });

  it("strictly rejects unknown and malformed document access modes", async () => {
    const unknown = structuredClone(bundle);
    Object.assign(
      unknown.value.applications["feishu-provider"].service.document_access,
      { allow_all: true },
    );
    await expect(loadFeishuProviderConfiguration({
      document: unknown,
      environment: { FEISHU_PROVIDER_ACCESS_TOKEN: "provider-token" },
    })).rejects.toThrow(/document_access/);

    const malformed = structuredClone(bundle);
    malformed.value.applications[
      "feishu-provider"
    ].service.document_access.mode = "production_allow_all";
    await expect(loadFeishuProviderConfiguration({
      document: malformed,
      environment: { FEISHU_PROVIDER_ACCESS_TOKEN: "provider-token" },
    })).rejects.toThrow(/document_access.mode/);
  });
});
