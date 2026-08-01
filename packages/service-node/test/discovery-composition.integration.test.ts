import { describe, expect, it } from "vitest";

import { MemoryDiscoveryStore } from "@work-fabric/adapter-discovery-memory";

import { composeNodeService, parseServiceConfig } from "../src/index.js";

const identity = {
  authentication_evidence: { bearer_token: "token-a" },
  principal: {
    principal_id: "principal-a", tenant_id: "tenant-a",
    actor_claims: [{ actor_id: "actor-a", actor_type: "agent" as const, endpoint_ids: ["endpoint-a"] }],
    attributes: {},
  },
};
const rules = ["workfabric.discovery.query.v1", "workfabric.discovery.resolve.v1"].map((action) => ({
  tenant_id: "tenant-a", principal_id: "principal-a", actor_id: "actor-a",
  actor_type: "agent" as const, endpoint_id: "endpoint-a", action, resource_id: null,
}));
const discovery = {
  enabled: true,
  tenant_view_id: "view-a",
  record_ttl_seconds: 60,
  default_page_limit: 20,
  max_page_limit: 100,
  max_records_per_origin: 10_000,
  sync_page_size: 100,
  query_max_hops: 2,
  query_max_fanout: 4,
  query_max_bytes: 32_768,
};
const headers = {
  authorization: "Bearer token-a",
  "x-wf-actor-id": "actor-a",
  "x-wf-endpoint-id": "endpoint-a",
};

function config(enabled = true) {
  return parseServiceConfig({
    storage_profile: "memory-demo",
    development_mode: true,
    tenant_id: "tenant-a",
    exchange_id: "exchange-a",
    cursor_secret: "x".repeat(32),
    identities: [identity],
    authority_rules: rules,
    discovery: { ...discovery, enabled },
  });
}

describe("Node discovery composition", () => {
  it("composes an optional local query service without creating network trust", async () => {
    const service = await composeNodeService(config());
    const response = await service.http.dispatch({ method: "GET", url: "/v1/discovery/capabilities", headers });
    expect(response.status_code).toBe(200);
    expect(response.json()).toEqual({ coverage: "complete", items: [], warnings: [] });
    expect(await service.http.dispatch({ method: "GET", url: "/.well-known/work-fabric" }))
      .toMatchObject({ status_code: 404 });
    await service.close();
  });

  it("leaves the HTTP shape unchanged when disabled", async () => {
    const service = await composeNodeService(config(false));
    await expect(service.http.dispatch({ method: "GET", url: "/v1/discovery/capabilities", headers }))
      .resolves.toMatchObject({ status_code: 404 });
    await service.close();
  });

  it("isolates discovery store failure from the rest of the local service", async () => {
    const failing = new MemoryDiscoveryStore({ max_records_per_origin: 10, tombstone_retention_seconds: 330 });
    failing.query = async () => { throw new Error("discovery storage down"); };
    const service = await composeNodeService(config(), { discovery_records: failing });
    await expect(service.http.dispatch({ method: "GET", url: "/v1/discovery/capabilities", headers }))
      .resolves.toMatchObject({ status_code: 503 });
    await expect(service.http.dispatch({ method: "GET", url: "/health/live" }))
      .resolves.toMatchObject({ status_code: 200 });
    await service.close();
  });
});
