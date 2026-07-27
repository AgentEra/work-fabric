import { describe, expect, it, vi } from "vitest";

import {
  BearerTokenProvider,
  WorkFabricClient,
  WorkFabricTransportError,
} from "../src/index.js";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetch: typeof globalThis.fetch) {
  return new WorkFabricClient({
    baseUrl: "https://fabric.example.test/api",
    tenantId: "tenant_01",
    exchangeId: "exchange_01",
    representation: { actorId: "actor_01", endpointId: "endpoint_01" },
    authentication: new BearerTokenProvider("token"),
    fetch,
    queryRetry: { maxRetries: 0 },
  });
}

const registration = {
  endpoint_id: "agent / 01",
  actor: { actor_id: "actor_agent", actor_type: "agent" as const },
  endpoint_type: "native_agent",
  display_name: "Agent Runtime",
  protocol_versions: ["1.0"],
  bindings: [{ binding_type: "http_sse", uri: "https://runtime.example.test/wf", security_schemes: ["oauth2"] }],
  allowed_capability_ids: ["software.implementation"],
  limits: { max_inline_content_bytes: 65_536 },
  administrative_state: "enabled" as const,
  registration_version: 1,
};
const capability = {
  capability_id: "software.implementation",
  version: "1.0.0",
  name: "Implementation",
  description: "Implements explicit Handoffs",
  input_media_types: ["application/json"],
  output_media_types: ["application/json"],
  input_schema_refs: [],
  output_schema_refs: [],
  interaction_modes: ["asynchronous"] as const,
  constraints: {},
};
const session = {
  endpoint_id: registration.endpoint_id,
  actor: registration.actor,
  session_id: "session / 01",
  client_session_id: "client_01",
  protocol_version: "1.0",
  capabilities: [capability],
  availability: "available" as const,
  accepted_lease_seconds: 60,
  fencing_token: 1,
  heartbeat_sequence: 0,
  state: "active" as const,
  expires_at: "2026-07-15T00:01:00Z",
  renew_after: "2026-07-15T00:00:50Z",
  registration_version: 1,
};

describe("EndpointClient", () => {
  it("maps all Endpoint resources with structural path and query encoding", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      });
      if (url.includes("/sessions/") && url.endsWith("/heartbeat")) return json({ ...session, heartbeat_sequence: 1, availability: "busy" });
      if (url.includes("/sessions/") && url.endsWith("/close")) return json({ ...session, heartbeat_sequence: 2, state: "closed", availability: "unavailable" });
      if (url.endsWith("/sessions")) return json(session);
      if (url.includes("/inbox/partitions")) return json({ items: [], next_cursor: "next / 01" });
      if (url.includes("/capabilities/")) return json({
        endpoint_id: registration.endpoint_id,
        actor: registration.actor,
        availability: "available",
        capability,
      });
      if (url.includes("?")) return json({ items: [] });
      if (init?.method === "PUT") return json(registration);
      return json({ ...registration, capabilities: [], availability: "unavailable", lease: { expires_at: "2026-07-15T00:00:00Z", renew_after: "2026-07-15T00:00:00Z" } });
    }) as unknown as typeof globalThis.fetch;
    const sdk = client(fetch);

    await sdk.endpoints.provision(registration.endpoint_id, registration);
    await sdk.endpoints.get(registration.endpoint_id);
    await sdk.endpoints.discover({
      capability_id: "software.implementation/review",
      required_input_media_types: ["application/json", "text/markdown"],
      availability: ["available", "busy"],
      cursor: "cursor / 01",
      limit: 20,
    });
    await sdk.endpoints.discoverIdentities({
      availability: ["available"],
      limit: 10,
    });
    await sdk.endpoints.discoverCapabilityCards({
      capability_id: "software.implementation",
      limit: 10,
    });
    await sdk.endpoints.getCapability(
      registration.endpoint_id,
      capability.capability_id,
    );
    await sdk.endpoints.openSession(registration.endpoint_id, {
      client_session_id: "client_01",
      protocol_version: "1.0",
      capabilities: [capability],
      availability: "available",
      requested_lease_seconds: 60,
      expected_registration_version: 1,
    });
    await sdk.endpoints.heartbeat(registration.endpoint_id, session.session_id, {
      fencing_token: 1,
      heartbeat_sequence: 1,
      availability: "busy",
      capabilities: [capability],
      expected_registration_version: 1,
    });
    await sdk.endpoints.listInboxPartitions(registration.endpoint_id, {
      cursor: "cursor / 01",
      limit: 10,
    });
    await sdk.endpoints.listClaimableHandoffs(registration.endpoint_id, {
      cursor: "claim cursor / 01",
      limit: 10,
    });
    await sdk.endpoints.closeSession(registration.endpoint_id, session.session_id, {
      fencing_token: 1,
      heartbeat_sequence: 2,
      expected_registration_version: 1,
    });

    expect(requests.map(({ url, method }) => [method, url])).toEqual([
      ["PUT", "https://fabric.example.test/api/v1/admin/endpoints/agent%20%2F%2001"],
      ["GET", "https://fabric.example.test/api/v1/endpoints/agent%20%2F%2001"],
      ["GET", "https://fabric.example.test/api/v1/endpoints?capability_id=software.implementation%2Freview&input_media_type=application%2Fjson&input_media_type=text%2Fmarkdown&availability=available&availability=busy&cursor=cursor+%2F+01&limit=20"],
      ["GET", "https://fabric.example.test/api/v1/endpoints?disclosure=identity&availability=available&limit=10"],
      ["GET", "https://fabric.example.test/api/v1/endpoints?disclosure=summary&capability_id=software.implementation&limit=10"],
      ["GET", "https://fabric.example.test/api/v1/endpoints/agent%20%2F%2001/capabilities/software.implementation"],
      ["POST", "https://fabric.example.test/api/v1/endpoints/agent%20%2F%2001/sessions"],
      ["POST", "https://fabric.example.test/api/v1/endpoints/agent%20%2F%2001/sessions/session%20%2F%2001/heartbeat"],
      ["GET", "https://fabric.example.test/api/v1/endpoints/agent%20%2F%2001/inbox/partitions?cursor=cursor+%2F+01&limit=10"],
      ["GET", "https://fabric.example.test/api/v1/endpoints/agent%20%2F%2001/claimable-handoffs?cursor=claim+cursor+%2F+01&limit=10"],
      ["POST", "https://fabric.example.test/api/v1/endpoints/agent%20%2F%2001/sessions/session%20%2F%2001/close"],
    ]);
  });

  it.each(["provision", "openSession", "heartbeat", "closeSession"] as const)(
    "never automatically retries the %s write",
    async (operation) => {
      const fetch = vi.fn(async () => { throw new Error("ambiguous network failure"); }) as unknown as typeof globalThis.fetch;
      const sdk = client(fetch);
      const invocation = {
        provision: () => sdk.endpoints.provision(registration.endpoint_id, registration),
        openSession: () => sdk.endpoints.openSession(registration.endpoint_id, {
          client_session_id: "client_01", protocol_version: "1.0", capabilities: [capability], availability: "available", requested_lease_seconds: 60, expected_registration_version: 1,
        }),
        heartbeat: () => sdk.endpoints.heartbeat(registration.endpoint_id, session.session_id, {
          fencing_token: 1, heartbeat_sequence: 1, availability: "available", capabilities: [capability], expected_registration_version: 1,
        }),
        closeSession: () => sdk.endpoints.closeSession(registration.endpoint_id, session.session_id, {
          fencing_token: 1, heartbeat_sequence: 2, expected_registration_version: 1,
        }),
      }[operation];

      await expect(invocation()).rejects.toBeInstanceOf(WorkFabricTransportError);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it("rejects invalid identifiers and page bounds before I/O", () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const sdk = client(fetch);

    expect(() => sdk.endpoints.get("")).toThrow(TypeError);
    expect(() => sdk.endpoints.discover({ limit: 0 })).toThrow(TypeError);
    expect(() => sdk.endpoints.listInboxPartitions("endpoint_01", { limit: Number.MAX_SAFE_INTEGER + 1 })).toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
