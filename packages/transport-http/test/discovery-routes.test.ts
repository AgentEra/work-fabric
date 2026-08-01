import { describe, expect, it } from "vitest";

import { LocalIdentityProvider } from "@work-fabric/adapter-identity-local";
import { DiscoveryError } from "@work-fabric/discovery-runtime";
import type { AuthorityPolicy, AuthorityRequest, CapabilityManifest } from "@work-fabric/exchange-spi";

import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
} from "../src/index.js";

const principal = {
  principal_id: "principal-a",
  tenant_id: "tenant-a",
  actor_claims: [{ actor_id: "actor-a", actor_type: "agent" as const, endpoint_ids: ["endpoint-a"] }],
  attributes: {},
};
const headers = {
  authorization: "Bearer token-a",
  "x-wf-actor-id": "actor-a",
  "x-wf-endpoint-id": "endpoint-a",
};

class Authority implements AuthorityPolicy {
  readonly requests: AuthorityRequest[] = [];
  readonly manifest: CapabilityManifest = {
    profile: "exchange.authority.v1", adapter: "test",
    capabilities: { explicit_decision: true, default_deny: true, resource_scoping: true },
  };
  async authorize(request: AuthorityRequest) {
    this.requests.push(structuredClone(request));
    return { kind: "allow" as const };
  }
}

function fixture(discovery: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const authority = new Authority();
  const service = createHttpService({
    application: { async handle() { throw new Error("not used"); } },
    authenticator: new BearerAuthenticationEvidenceMapper(),
    identity: new LocalIdentityProvider([{ authentication_evidence: { bearer_token: "token-a" }, principal }]),
    authority,
    discovery,
    discovery_tenant_view_id: "view-a",
    ...extra,
  } as never, normalizeHttpServiceConfig({}));
  return { service, authority };
}

describe("discovery HTTP routes", () => {
  it("authorizes participant queries and propagates a frozen narrow context and repeated filters", async () => {
    let receivedContext: unknown;
    let receivedInput: unknown;
    const { service, authority } = fixture({
      async findCapabilities(context: unknown, input: unknown) {
        receivedContext = context;
        receivedInput = input;
        return { coverage: "complete", items: [], warnings: [] };
      },
    });
    const response = await service.dispatch({
      method: "GET",
      url: "/v1/discovery/capabilities?capability_id=software.implementation&input_media_type=application%2Fjson&input_media_type=text%2Fplain&binding_type=http_sse&limit=10",
      headers,
    });

    expect(response.status_code).toBe(200);
    expect(receivedContext).toEqual({
      tenant_id: "tenant-a", tenant_view_id: "view-a", principal_id: "principal-a",
      represented_actor: { actor_id: "actor-a", actor_type: "agent" }, represented_endpoint_id: "endpoint-a",
    });
    expect(Object.isFrozen(receivedContext)).toBe(true);
    expect(Object.isFrozen((receivedContext as { represented_actor: object }).represented_actor)).toBe(true);
    expect(receivedInput).toEqual({
      capability_id: "software.implementation",
      input_media_types: ["application/json", "text/plain"],
      binding_types: ["http_sse"],
      limit: 10,
    });
    expect(authority.requests.at(-1)?.action).toBe("workfabric.discovery.query.v1");
    await service.close();
  });

  it("maps hidden and missing details identically and maps bounded failures", async () => {
    let failure: DiscoveryError = new DiscoveryError("discovery_not_found");
    const { service, authority } = fixture({
      async getEndpoint() { throw failure; },
    });
    for (const id of ["hidden", "missing"]) {
      const response = await service.dispatch({ method: "GET", url: `/v1/discovery/endpoints/${id}`, headers });
      expect(response.status_code).toBe(404);
      expect(response.json()).toMatchObject({ code: "not_found", title: "Discovery resource not found" });
    }
    failure = new DiscoveryError("discovery_rate_limited");
    expect((await service.dispatch({ method: "GET", url: "/v1/discovery/endpoints/rate", headers })).status_code).toBe(429);
    failure = new DiscoveryError("discovery_unavailable");
    expect((await service.dispatch({ method: "GET", url: "/v1/discovery/endpoints/down", headers })).status_code).toBe(503);
    expect((await service.dispatch({ method: "GET", url: "/v1/discovery/capabilities?limit=0", headers })).status_code).toBe(400);
    expect(authority.requests.every((request) => request.action === "workfabric.discovery.resolve.v1" || request.action === "workfabric.discovery.query.v1")).toBe(true);
    await service.close();
  });

  it("keeps peer envelopes as bounded opaque bytes", async () => {
    const received: Uint8Array[] = [];
    const gateway = {
      async receiveSync(bytes: Uint8Array) { received.push(bytes.slice()); return new TextEncoder().encode("signed-sync-response"); },
      async receiveQuery(bytes: Uint8Array) { received.push(bytes.slice()); return new TextEncoder().encode("signed-query-response"); },
    };
    const { service } = fixture({}, {
      discovery_gateway: gateway,
      discovery_manifest: async () => new TextEncoder().encode("signed-manifest"),
    });
    const manifest = await service.dispatch({ method: "GET", url: "/.well-known/work-fabric" });
    expect(manifest.status_code).toBe(200);
    expect(manifest.body).toBe("signed-manifest");
    const sync = await service.dispatch({
      method: "POST", url: "/v1/discovery/peer/sync",
      headers: { "content-type": "application/workfabric-discovery+json" }, payload: "not generic json",
    });
    expect(sync.status_code).toBe(200);
    expect(new TextDecoder().decode(received[0])).toBe("not generic json");
    const resolve = await service.dispatch({
      method: "POST", url: "/v1/discovery/peer/resolve",
      headers: { "content-type": "application/workfabric-discovery+json" }, payload: "signed-resolve-query",
    });
    expect(resolve.status_code).toBe(200);
    expect(new TextDecoder().decode(received[1])).toBe("signed-resolve-query");
    const oversized = await service.dispatch({
      method: "POST", url: "/v1/discovery/peer/query",
      headers: { "content-type": "application/workfabric-discovery+json" }, payload: "x".repeat(65_537),
    });
    expect(oversized.status_code).toBe(413);
    await service.close();
  });

  it("re-applies caller disclosure to federated results and strips peer correlation fields", async () => {
    let filteredContext: unknown;
    const { service, authority } = fixture({
      async filterFederated(context: unknown, page: { readonly items: readonly unknown[] }) {
        filteredContext = context;
        return { coverage: "partial", items: page.items.slice(0, 1), warnings: [] };
      },
    }, {
      discovery_gateway: {
        async executeQueryAny() {
          return {
            request_message_id: "internal-message",
            request_digest: "a".repeat(64),
            query_id: "internal-query",
            coverage: "partial",
            items: [{ record_id: "visible" }, { record_id: "hidden" }],
            warnings: [],
            budget: { deadline: "2026-08-01T00:01:00.000Z", remaining_hops: 0, remaining_fanout: 0, remaining_results: 0, remaining_bytes: 0 },
          };
        },
        async receiveSync() { throw new Error("not used"); },
        async receiveQuery() { throw new Error("not used"); },
      },
    });
    const response = await service.dispatch({
      method: "POST",
      url: "/v1/discovery/queries",
      headers: { ...headers, "content-type": "application/json" },
      payload: {
        query_id: "query-a",
        query: { limit: 5 },
        budget: { deadline: "2026-08-01T00:01:00.000Z", remaining_hops: 1, remaining_fanout: 1, remaining_results: 5, remaining_bytes: 32_768 },
      },
    });
    expect(response.status_code).toBe(200);
    expect(response.json()).toEqual({ coverage: "partial", items: [{ record_id: "visible" }], warnings: [] });
    expect(filteredContext).toMatchObject({ principal_id: "principal-a", tenant_view_id: "view-a" });
    expect(authority.requests.at(-1)?.action).toBe("workfabric.discovery.query.v1");
    await service.close();
  });
});
