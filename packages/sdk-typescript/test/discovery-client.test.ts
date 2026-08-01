import { describe, expect, it, vi } from "vitest";

import {
  BearerTokenProvider,
  WorkFabricClient,
  WorkFabricTransportError,
} from "../src/index.js";

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function record(kind: "exchange" | "capability_route" | "participant" | "endpoint" = "capability_route") {
  const payloads = {
    exchange: { exchange_id: "exchange-a", display_name: "A", discovery_profiles: ["workfabric.discovery.v1"], federation_profiles: [], bindings: [], security_schemes: [] },
    capability_route: { capability_id: "software.implementation", versions: ["1.0.0"], input_media_types: ["application/json"], output_media_types: ["application/json"], input_schema_refs: [], output_schema_refs: [], interaction_modes: ["asynchronous"], binding_types: ["http_sse"], security_schemes: ["oauth2"], availability: "available" },
    participant: { actor: { actor_id: "actor-a", actor_type: "agent" }, display_name: "A", endpoint_ids: ["endpoint-a"] },
    endpoint: { endpoint_id: "endpoint-a", actor: { actor_id: "actor-a", actor_type: "agent" }, endpoint_type: "native_agent", display_name: "A", protocol_versions: ["1.0"], bindings: [], capabilities: [], availability: "available", limits: { max_inline_content_bytes: 65536 } },
  } as const;
  return {
    profile: "workfabric.discovery.v1",
    record_id: `${kind}:a`, record_kind: kind, origin_exchange_id: "exchange-a", revision: 1,
    issued_at: "2026-08-01T00:00:00.000Z", expires_at: "2026-08-01T00:01:00.000Z",
    visibility: "public", audiences: [], transitive: false, max_hops: 0,
    payload: payloads[kind], payload_digest: "a".repeat(64), key_id: "key-a", signature: "A".repeat(86),
  };
}

function client(fetch: typeof globalThis.fetch, maxRetries = 0) {
  return new WorkFabricClient({
    baseUrl: "https://fabric.example.test/api/",
    tenantId: "tenant-a",
    exchangeId: "exchange-a",
    representation: { actorId: "actor-a", endpointId: "endpoint-a" },
    authentication: new BearerTokenProvider("token"),
    fetch,
    queryRetry: { maxRetries, baseDelayMs: 1, maxDelayMs: 1 },
  });
}

describe("DiscoveryClient", () => {
  it("maps details, repeated filters, representation override, and unranked POST queries", async () => {
    const requests: Array<{ url: string; method: string; body: unknown; actor: string | null }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
        actor: new Headers(init?.headers).get("x-wf-actor-id"),
      });
      if (url.includes("/capabilities") || init?.method === "POST") {
        return json({ coverage: "partial", items: [record()], warnings: [] });
      }
      if (url.includes("/exchanges/")) return json(record("exchange"));
      if (url.includes("/participants/")) return json(record("participant"));
      return json(record("endpoint"));
    }) as unknown as typeof globalThis.fetch;
    const sdk = client(fetch);

    await sdk.discovery.getExchange("exchange / a");
    const found = await sdk.discovery.findCapabilities({
      capability_id: "software.implementation",
      input_media_types: ["application/json", "text/plain"],
      interaction_modes: ["asynchronous"],
      binding_types: ["http_sse", "websocket"],
      cursor: "cursor / a",
      limit: 20,
    }, { representation: { actorId: "resolver-a", endpointId: "resolver-endpoint" } });
    await sdk.discovery.getParticipant("actor / a");
    await sdk.discovery.getEndpoint("endpoint / a");
    await sdk.discovery.query({
      query_id: "query-a",
      query: { record_kinds: ["capability_route"], capability_id: "software.implementation", limit: 5 },
      budget: {
        deadline: "2026-08-01T00:01:00.000Z", remaining_hops: 2, remaining_fanout: 3,
        remaining_results: 5, remaining_bytes: 32_768,
      },
    });

    expect(Object.isFrozen(sdk.discovery)).toBe(true);
    expect(JSON.stringify(found)).not.toMatch(/score|rank|preferred_target/);
    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", "https://fabric.example.test/api/v1/discovery/exchanges/exchange%20%2F%20a"],
      ["GET", "https://fabric.example.test/api/v1/discovery/capabilities?capability_id=software.implementation&input_media_type=application%2Fjson&input_media_type=text%2Fplain&interaction_mode=asynchronous&binding_type=http_sse&binding_type=websocket&cursor=cursor+%2F+a&limit=20"],
      ["GET", "https://fabric.example.test/api/v1/discovery/participants/actor%20%2F%20a"],
      ["GET", "https://fabric.example.test/api/v1/discovery/endpoints/endpoint%20%2F%20a"],
      ["POST", "https://fabric.example.test/api/v1/discovery/queries"],
    ]);
    expect(requests[1]?.actor).toBe("resolver-a");
    expect(requests[4]?.body).not.toHaveProperty("peer_id");
  });

  it("retries bounded GETs but never automatically retries a federated POST", async () => {
    let calls = 0;
    const getFetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network");
      return json(record("exchange"));
    }) as unknown as typeof globalThis.fetch;
    await expect(client(getFetch, 1).discovery.getExchange("exchange-a")).resolves.toMatchObject({ record_kind: "exchange" });
    expect(getFetch).toHaveBeenCalledTimes(2);

    const postFetch = vi.fn(async () => { throw new Error("ambiguous"); }) as unknown as typeof globalThis.fetch;
    await expect(client(postFetch, 1).discovery.query({
      query: { limit: 1 },
      budget: { deadline: "2026-08-01T00:01:00.000Z", remaining_hops: 0, remaining_fanout: 0, remaining_results: 1, remaining_bytes: 1024 },
    })).rejects.toBeInstanceOf(WorkFabricTransportError);
    expect(postFetch).toHaveBeenCalledOnce();
  });

  it("rejects invalid requests and malformed result records", async () => {
    const fetch = vi.fn(async () => json({ coverage: "global", items: [{}], warnings: [] })) as unknown as typeof globalThis.fetch;
    const sdk = client(fetch);
    expect(() => sdk.discovery.getEndpoint("")).toThrow(TypeError);
    expect(() => sdk.discovery.findCapabilities({ input_media_types: [] })).toThrow(TypeError);
    expect(() => sdk.discovery.findCapabilities({ limit: 201 })).toThrow(TypeError);
    expect(() => sdk.discovery.query({
      query: { limit: 1 },
      budget: { deadline: "invalid", remaining_hops: 9, remaining_fanout: 1, remaining_results: 1, remaining_bytes: 1024 },
    })).toThrow(TypeError);
    await expect(sdk.discovery.findCapabilities()).rejects.toBeInstanceOf(WorkFabricTransportError);
  });
});
