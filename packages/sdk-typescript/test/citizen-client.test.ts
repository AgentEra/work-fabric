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
    tenantId: "tenant-a",
    exchangeId: "exchange-a",
    representation: {
      actorId: "actor-resolver",
      endpointId: "endpoint-resolver",
    },
    authentication: new BearerTokenProvider("token"),
    fetch,
    queryRetry: { maxRetries: 0 },
  });
}

const declaration = {
  declaration_id: "feishu.document.create",
  declaration_kind: "capability" as const,
  version: "1.0.0",
  name: "Create document",
  description: "Create one simple document.",
  interaction_modes: ["asynchronous"] as const,
  risk: "medium" as const,
  confirmation: "none" as const,
  constraints: {},
  extensions: {},
};
const descriptor = {
  citizen_id: "feishu-document-actions",
  citizen_kind: "capability-provider" as const,
  version: "1.0.0",
  identity: {
    principal_id: "principal-feishu-provider",
    actor: {
      actor_id: "actor-feishu-provider",
      actor_type: "system" as const,
    },
    endpoint_id: "endpoint-feishu-provider",
  },
  protocol: {
    versions: ["1"],
    bindings: ["workfabric+https"],
  },
  declarations: {
    count: 1,
    digest: `sha256:${"a".repeat(64)}` as const,
  },
  availability: "available" as const,
  extensions: {},
};
const provisioning = {
  citizen_id: descriptor.citizen_id,
  citizen_kind: descriptor.citizen_kind,
  principal_id: "principal-feishu-provider",
  allowed_actor: descriptor.identity.actor,
  allowed_endpoint_id: descriptor.identity.endpoint_id,
  allowed_declaration_namespaces: ["feishu"],
  maximum_risk: "high" as const,
  administrative_state: "enabled" as const,
  registration_version: 1,
};
const session = {
  citizen_id: descriptor.citizen_id,
  session_id: "session / 01",
  client_session_id: "client-session-1",
  descriptor,
  declarations: [declaration],
  declaration_version: 1,
  declaration_digest: descriptor.declarations.digest,
  accepted_lease_seconds: 60,
  fencing_token: 1,
  heartbeat_sequence: 0,
  state: "active" as const,
  expires_at: "2026-07-27T00:01:00.000Z",
  renew_after: "2026-07-27T00:00:45.000Z",
  registration_version: 1,
};

describe("CitizenClient", () => {
  it("maps all Citizen resources with encoded paths and bounded queries", async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        requests.push({
          url,
          method,
          body:
            init?.body === undefined ? null : JSON.parse(String(init.body)),
        });
        if (url.includes("/sessions/") && url.endsWith("/heartbeat")) {
          return json({
            ...session,
            availability: undefined,
            descriptor: { ...descriptor, availability: "degraded" },
            heartbeat_sequence: 1,
          });
        }
        if (url.includes("/sessions/") && url.endsWith("/declarations")) {
          return json({ ...session, declaration_version: 2 });
        }
        if (url.includes("/sessions/") && url.endsWith("/close")) {
          return json({
            ...session,
            descriptor: { ...descriptor, availability: "unavailable" },
            heartbeat_sequence: 2,
            state: "closed",
          });
        }
        if (url.endsWith("/sessions")) return json(session);
        if (
          url.includes("/declarations/") &&
          !url.endsWith("/declarations")
        ) {
          return json({
            citizen_id: descriptor.citizen_id,
            citizen_kind: descriptor.citizen_kind,
            availability: "available",
            declaration,
            declaration_version: 1,
            fencing_token: 1,
          });
        }
        if (url.endsWith("/declarations")) {
          return json({
            items: [
              {
                declaration_id: declaration.declaration_id,
                declaration_kind: declaration.declaration_kind,
                version: declaration.version,
                name: declaration.name,
                description: declaration.description,
              },
            ],
          });
        }
        if (url.includes("?")) {
          return json({ items: [descriptor], next_cursor: "next / 01" });
        }
        if (method === "PUT") return json(provisioning);
        return json(descriptor);
      },
    ) as unknown as typeof globalThis.fetch;
    const sdk = client(fetch);

    await sdk.citizens.provision(descriptor.citizen_id, provisioning);
    await sdk.citizens.list({
      citizen_kind: "capability-provider",
      declaration_id: declaration.declaration_id,
      availability: ["available", "degraded"],
      executable_only: true,
      cursor: "cursor / 01",
      limit: 20,
    });
    await sdk.citizens.get(descriptor.citizen_id);
    await sdk.citizens.listDeclarations(descriptor.citizen_id);
    await sdk.citizens.getDeclaration(
      descriptor.citizen_id,
      declaration.declaration_id,
    );
    await sdk.citizens.openSession(descriptor.citizen_id, {
      client_session_id: "client-session-1",
      descriptor,
      declarations: [declaration],
      requested_lease_seconds: 60,
      expected_registration_version: 1,
    });
    await sdk.citizens.heartbeat(
      descriptor.citizen_id,
      session.session_id,
      {
        fencing_token: 1,
        heartbeat_sequence: 1,
        availability: "degraded",
        expected_registration_version: 1,
      },
    );
    await sdk.citizens.replaceDeclarations(
      descriptor.citizen_id,
      session.session_id,
      {
        fencing_token: 1,
        expected_registration_version: 1,
        expected_declaration_version: 1,
        declarations: [declaration],
      },
    );
    await sdk.citizens.closeSession(
      descriptor.citizen_id,
      session.session_id,
      {
        fencing_token: 1,
        heartbeat_sequence: 2,
        expected_registration_version: 1,
      },
    );

    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      [
        "PUT",
        "https://fabric.example.test/api/v1/admin/citizens/feishu-document-actions",
      ],
      [
        "GET",
        "https://fabric.example.test/api/v1/citizens?citizen_kind=capability-provider&declaration_id=feishu.document.create&availability=available&availability=degraded&executable_only=true&cursor=cursor+%2F+01&limit=20",
      ],
      [
        "GET",
        "https://fabric.example.test/api/v1/citizens/feishu-document-actions",
      ],
      [
        "GET",
        "https://fabric.example.test/api/v1/citizens/feishu-document-actions/declarations",
      ],
      [
        "GET",
        "https://fabric.example.test/api/v1/citizens/feishu-document-actions/declarations/feishu.document.create",
      ],
      [
        "POST",
        "https://fabric.example.test/api/v1/citizens/feishu-document-actions/sessions",
      ],
      [
        "POST",
        "https://fabric.example.test/api/v1/citizens/feishu-document-actions/sessions/session%20%2F%2001/heartbeat",
      ],
      [
        "PUT",
        "https://fabric.example.test/api/v1/citizens/feishu-document-actions/sessions/session%20%2F%2001/declarations",
      ],
      [
        "POST",
        "https://fabric.example.test/api/v1/citizens/feishu-document-actions/sessions/session%20%2F%2001/close",
      ],
    ]);
  });

  it("rejects credential-like unknown response fields", async () => {
    const fetch = vi.fn(async () =>
      json({ ...descriptor, credential_ref: "feishu-primary" }),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      client(fetch).citizens.get(descriptor.citizen_id),
    ).rejects.toMatchObject({
      code: "invalid_response",
    } satisfies Partial<WorkFabricTransportError>);
  });

  it("never automatically retries Citizen mutations", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ambiguous network failure");
    }) as unknown as typeof globalThis.fetch;

    await expect(
      client(fetch).citizens.replaceDeclarations(
        descriptor.citizen_id,
        session.session_id,
        {
          fencing_token: 1,
          expected_registration_version: 1,
          expected_declaration_version: 1,
          declarations: [declaration],
        },
      ),
    ).rejects.toBeInstanceOf(WorkFabricTransportError);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
