import { describe, expect, it } from "vitest";
import { composeNodeService, parseServiceConfig } from "../src/index.js";

describe("memory Node service composition", () => {
  it("starts a bounded HTTP surface and exposes explicit worker turns", async () => {
    const service = await composeNodeService(parseServiceConfig({
      storage_profile: "memory-demo",
      development_mode: true,
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      identities: [{
        authentication_evidence: { bearer_token: "health-token" },
        principal: {
          principal_id: "principal-local",
          tenant_id: "tenant-local",
          actor_claims: [{ actor_id: "actor-local", actor_type: "human", endpoint_ids: ["endpoint-local"] }],
          attributes: {},
        },
      }],
      authority_rules: [{
        tenant_id: "tenant-local", principal_id: "principal-local",
        actor_id: "actor-local", actor_type: "human", endpoint_id: "endpoint-local",
        action: "workfabric.operations.health.read.v1", resource_id: null,
      }],
    }));
    await expect(service.http.dispatch({ method: "GET", url: "/health/live" }))
      .resolves.toMatchObject({ status_code: 200 });
    await expect(service.runProjection("partition-empty", 100))
      .resolves.toMatchObject({ handoff: { kind: "idle" }, collaboration: { kind: "idle" } });
    await service.close();
  });
});
