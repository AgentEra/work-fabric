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
          concurrency: { max_active_runs: 2, queue_capacity: 16 },
          runtime_state: {
            location: ".local/feishu-provider-runtime.db",
            busy_timeout_ms: 5_000,
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
                shared_folder: {
                  token: "${FEISHU_SHARED_FOLDER_TOKEN}",
                  policy_ref: "feishu.shared-folder.default",
                  visibility: "tenant_readable",
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
        FEISHU_SHARED_FOLDER_TOKEN: "folder-token",
      },
    });
    expect(loaded.service.work_fabric.access_token).toBe("provider-token");
    expect(loaded.provider.shared_folder.token).toBe("folder-token");
    expect(loaded.provider.credential_ref).toBe("feishu-primary");
    expect(loaded.participant.endpoint_id).toBe("endpoint-feishu-provider");
  });

  it("fails closed when a required secret is missing", async () => {
    await expect(loadFeishuProviderConfiguration({
      document: bundle,
      environment: { FEISHU_PROVIDER_ACCESS_TOKEN: "provider-token" },
    })).rejects.toThrow();
  });

  it("requires exactly one enabled Feishu Provider instance", async () => {
    const changed = structuredClone(bundle);
    changed.value.applications["feishu-provider"].plugins.instances["feishu-primary"].enabled = false;
    await expect(loadFeishuProviderConfiguration({
      document: changed,
      environment: {},
    })).rejects.toThrow("plugins.instances");
  });
});
