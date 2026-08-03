import { describe, expect, it } from "vitest";

import { loadGitHubProviderConfiguration } from "../src/configuration.js";

const document = {
  revision: "test",
  value: {
    api_version: "workfabric.config-bundle/v1",
    applications: {
      "github-provider": {
        api_version: "workfabric.config/v1",
        service: {
          runtime_id: "github-provider-local",
          development_mode: false,
          work_fabric: {
            base_url: "http://127.0.0.1:8787",
            tenant_id: "tenant-local",
            exchange_id: "exchange-local",
            subscription_id: "subscription-github-provider",
            access_token: "${GITHUB_PROVIDER_ACCESS_TOKEN}",
          },
          concurrency: {
            max_active_runs: 2,
            queue_capacity: 16,
            max_active_partitions: 8,
          },
          citizen_lease: {
            requested_lease_seconds: 60,
            heartbeat_safety_margin_ms: 5_000,
          },
        },
        plugins: {
          instances: {
            "github-primary": {
              type: "capability-provider.github",
              enabled: true,
              config: {
                authentication: {
                  mode: "github_app",
                  credential_ref: "github-primary",
                  app_id_environment: "GITHUB_APP_ID",
                  installation_id_environment: "GITHUB_INSTALLATION_ID",
                  private_key_environment: "GITHUB_PRIVATE_KEY",
                },
                cursor_signing_key: "${GITHUB_CURSOR_SIGNING_KEY}",
                policy: {
                  allowed_owners: ["AgentEra"],
                  allowed_repositories: [],
                  maximum_page_size: 100,
                  maximum_aggregate_repositories: 100,
                },
                citizen: {
                  citizen_id: "citizen-github-read",
                  principal_id: "principal-github-provider",
                  actor_id: "actor-github-provider",
                  endpoint_id: "endpoint-github-provider",
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

describe("GitHub Provider configuration", () => {
  it("selects the global application view without retaining secret values", async () => {
    const loaded = await loadGitHubProviderConfiguration({
      document,
      environment: {
        GITHUB_PROVIDER_ACCESS_TOKEN: "ghp_not-retained",
        GITHUB_CURSOR_SIGNING_KEY: "PRIVATE KEY not-retained",
      },
    });

    expect(loaded).toMatchObject({
      provider: {
        authentication: { mode: "github_app", credential_ref: "github-primary" },
        policy: {
          allowed_owners: ["AgentEra"],
          maximum_page_size: 100,
          maximum_aggregate_repositories: 100,
        },
        citizen: { citizen_id: "citizen-github-read" },
      },
    });
    expect(JSON.stringify(loaded)).not.toMatch(/PRIVATE KEY|ghp_|github_pat_/);
    expect(loaded.service.work_fabric.access_token).toBe("${GITHUB_PROVIDER_ACCESS_TOKEN}");
  });

  it("fails closed for unknown fields, empty or duplicate owners, PATs, and missing enabled instances", async () => {
    const unknown = structuredClone(document);
    Object.assign(
      unknown.value.applications["github-provider"].plugins.instances["github-primary"].config,
      { token: "github_pat_not-accepted" },
    );
    await expect(loadGitHubProviderConfiguration({ document: unknown })).rejects.toThrow();

    const duplicateOwner = structuredClone(document);
    duplicateOwner.value.applications["github-provider"].plugins.instances["github-primary"].config.policy.allowed_owners = ["AgentEra", "agentera"];
    await expect(loadGitHubProviderConfiguration({ document: duplicateOwner })).rejects.toThrow(/allowed_owners/);

    const emptyOwner = structuredClone(document);
    emptyOwner.value.applications["github-provider"].plugins.instances["github-primary"].config.policy.allowed_owners = [""];
    await expect(loadGitHubProviderConfiguration({ document: emptyOwner })).rejects.toThrow(/allowed_owners/);

    const pat = structuredClone(document);
    pat.value.applications["github-provider"].plugins.instances["github-primary"].config.authentication = {
      mode: "personal_access_token",
      credential_ref: "github-primary",
    } as never;
    await expect(loadGitHubProviderConfiguration({ document: pat })).rejects.toThrow(/authentication/);

    const disabled = structuredClone(document);
    disabled.value.applications["github-provider"].plugins.instances["github-primary"].enabled = false;
    await expect(loadGitHubProviderConfiguration({ document: disabled })).rejects.toThrow(/plugins.instances/);

    const nonStringEnvironmentName = structuredClone(document);
    nonStringEnvironmentName.value.applications["github-provider"].plugins.instances["github-primary"].config.authentication.app_id_environment = 42 as never;
    await expect(loadGitHubProviderConfiguration({ document: nonStringEnvironmentName })).rejects.toThrow(/app_id_environment/);
  });

  it("requires the fixed GitHub system Citizen and Endpoint identity", async () => {
    const changed = structuredClone(document);
    changed.value.applications["github-provider"].plugins.instances["github-primary"].config.citizen.endpoint_id = "endpoint-other";
    await expect(loadGitHubProviderConfiguration({ document: changed })).rejects.toThrow(/GitHub system participant/);
  });
});
