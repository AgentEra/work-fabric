import { describe, expect, it } from "vitest";

import { MemoryDiscoveryStore } from "@work-fabric/adapter-discovery-memory";
import type { LocalAuthorityAllowRule } from "@work-fabric/adapter-identity-local";
import type { DiscoveryRecord } from "@work-fabric/discovery-spi";

import { composeNodeService, parseServiceConfig } from "../src/index.js";

const identity = {
  authentication_evidence: { bearer_token: "token-a" },
  principal: {
    principal_id: "principal-a", tenant_id: "tenant-a",
    actor_claims: [{ actor_id: "actor-a", actor_type: "agent" as const, endpoint_ids: ["endpoint-a"] }],
    attributes: {},
  },
};
const rules: LocalAuthorityAllowRule[] = ["workfabric.discovery.query.v1", "workfabric.discovery.resolve.v1"].map((action) => ({
  tenant_id: "tenant-a", principal_id: "principal-a", actor_id: "actor-a",
  actor_type: "agent" as const, endpoint_id: "endpoint-a", action, resource_id: null,
}));
rules.push({
  tenant_id: "tenant-a", principal_id: "principal-a", actor_id: "actor-a",
  actor_type: "agent", endpoint_id: "endpoint-a",
  action: "workfabric.discovery.resolve.v1", resource_id: "endpoint-remote",
});
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

  it("keeps Endpoint detail private by default and allows a caller-scoped deployment policy", async () => {
    const records = new MemoryDiscoveryStore({ max_records_per_origin: 10, tombstone_retention_seconds: 330 });
    const record: DiscoveryRecord<"endpoint"> = {
      profile: "workfabric.discovery.v1",
      record_id: "endpoint:endpoint-remote",
      record_kind: "endpoint",
      origin_exchange_id: "exchange-remote",
      revision: 1,
      issued_at: "2026-08-01T00:00:00.000Z",
      expires_at: "2026-08-01T00:01:00.000Z",
      visibility: "peer",
      audiences: ["exchange-a"],
      transitive: false,
      max_hops: 0,
      payload: {
        endpoint_id: "endpoint-remote",
        actor: { actor_id: "actor-remote", actor_type: "agent" },
        endpoint_type: "native_agent",
        display_name: "Remote Agent",
        protocol_versions: ["1.0"],
        bindings: [{
          binding_type: "http_sse",
          uri: "https://remote.example.test/work-fabric",
          security_schemes: ["oauth2"],
        }],
        capabilities: [],
        availability: "available",
        limits: { max_inline_content_bytes: 65_536 },
      },
      payload_digest: "a".repeat(64),
      key_id: "key-1",
      signature: "A".repeat(86),
    };
    await records.apply({
      tenant_id: "tenant-a", tenant_view_id: "view-a", source_peer_id: "peer-remote", value: record,
    });
    const fixedClock = { now: () => "2026-08-01T00:00:30.000Z" };

    const privateService = await composeNodeService(config(), {
      discovery_records: records,
      clock: fixedClock,
    });
    await expect(privateService.http.dispatch({
      method: "GET", url: "/v1/discovery/endpoints/endpoint-remote", headers,
    })).resolves.toMatchObject({ status_code: 404 });
    await privateService.close();

    let scopedPrincipal = "";
    const disclosedService = await composeNodeService(config(), {
      discovery_records: records,
      clock: fixedClock,
      discovery_disclosure_policy: {
        async canRead({ context, record: candidate }) {
          scopedPrincipal = context.principal_id;
          return candidate.record_kind === "endpoint" &&
            candidate.audiences.includes("exchange-a");
        },
      },
    });
    const response = await disclosedService.http.dispatch({
      method: "GET", url: "/v1/discovery/endpoints/endpoint-remote", headers,
    });
    expect(response.status_code).toBe(200);
    expect(response.json()).toMatchObject({
      payload: {
        endpoint_id: "endpoint-remote",
        bindings: [{ uri: "https://remote.example.test/work-fabric" }],
      },
    });
    expect(scopedPrincipal).toBe("principal-a");
    await disclosedService.close();
  });
});
