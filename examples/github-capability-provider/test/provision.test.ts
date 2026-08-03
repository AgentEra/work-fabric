import { describe, expect, it, vi } from "vitest";

import { provisionGitHubProviderRecords } from "../src/provision.js";

describe("GitHub Provider provisioning", () => {
  it("provisions one idempotent Endpoint with all twelve descriptors and one system Citizen", async () => {
    const endpoints = { provision: vi.fn(async (_id, input) => input) };
    const citizens = { provision: vi.fn(async (_id, input) => input) };

    await provisionGitHubProviderRecords({
      endpoints,
      citizens,
      citizen: {
        citizen_id: "citizen-github-read",
        principal_id: "principal-github-provider",
        actor_id: "actor-github-provider",
        endpoint_id: "endpoint-github-provider",
        registration_version: 1,
      },
    });

    expect(endpoints.provision).toHaveBeenCalledTimes(1);
    expect(endpoints.provision).toHaveBeenCalledWith(
      "endpoint-github-provider",
      expect.objectContaining({
        endpoint_type: "workfabric.dev/capability_provider",
        allowed_capability_ids: expect.arrayContaining(["github.pull_request.list"]),
      }),
    );
    expect((endpoints.provision.mock.calls[0]![1] as { allowed_capability_ids: string[] }).allowed_capability_ids).toHaveLength(12);
    expect(citizens.provision).toHaveBeenCalledWith("citizen-github-read", {
      citizen_id: "citizen-github-read",
      citizen_kind: "capability-provider",
      principal_id: "principal-github-provider",
      allowed_actor: { actor_id: "actor-github-provider", actor_type: "system" },
      allowed_endpoint_id: "endpoint-github-provider",
      allowed_declaration_namespaces: ["github"],
      maximum_risk: "low",
      administrative_state: "enabled",
      registration_version: 1,
    });
  });
});
