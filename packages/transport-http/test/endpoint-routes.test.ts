import { beforeAll, describe, expect, it } from "vitest";

import {
  MemoryEndpointDirectoryStore,
  MemoryEndpointInboxStore,
} from "@work-fabric/adapter-endpoint-memory";
import { LocalIdentityProvider } from "@work-fabric/adapter-identity-local";
import {
  EndpointDirectoryService,
} from "@work-fabric/endpoint-directory";
import {
  EndpointInboxQueryService,
} from "@work-fabric/exchange-runtime";
import type {
  AuthorityPolicy,
  AuthorityDecision,
  AuthorityRequest,
  CapabilityManifest,
} from "@work-fabric/exchange-spi";
import {
  loadWfppSchemaValidator,
  type WfppSchemaValidator,
} from "@work-fabric/protocol-runtime";

import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
} from "../src/index.js";

let schemas: WfppSchemaValidator;
beforeAll(async () => {
  schemas = await loadWfppSchemaValidator("protocol/schemas/v1");
});

const actorAgent = { actor_id: "actor_agent", actor_type: "agent" as const };
const registration = {
  endpoint_id: "endpoint_agent",
  actor: actorAgent,
  endpoint_type: "native_agent",
  display_name: "Agent Runtime",
  protocol_versions: ["1.0"],
  bindings: [{
    binding_type: "http_sse",
    uri: "https://runtime.example.test/wf",
    security_schemes: ["oauth2"],
    extensions: {},
  }],
  allowed_capability_ids: ["software.implementation"],
  limits: { max_inline_content_bytes: 65_536 },
  administrative_state: "enabled",
  registration_version: 1,
  extensions: {},
};
const capability = {
  capability_id: "software.implementation",
  version: "1.0.0",
  name: "Implementation",
  description: "Implements an explicit Handoff",
  input_media_types: ["application/json"],
  output_media_types: ["application/json"],
  input_schema_refs: [],
  output_schema_refs: [],
  interaction_modes: ["asynchronous"],
  constraints: {},
  extensions: {},
};
const open = {
  client_session_id: "client_01",
  protocol_version: "1.0",
  capabilities: [capability],
  availability: "available",
  requested_lease_seconds: 60,
  expected_registration_version: 1,
};

const principals = {
  admin: {
    principal_id: "principal_admin",
    tenant_id: "tenant_01",
    actor_claims: [{ actor_id: "actor_admin", actor_type: "human" as const, endpoint_ids: ["endpoint_admin"] }],
    attributes: {},
  },
  runtime: {
    principal_id: "principal_runtime",
    tenant_id: "tenant_01",
    actor_claims: [{ ...actorAgent, endpoint_ids: ["endpoint_agent"] }],
    attributes: {},
  },
  resolver: {
    principal_id: "principal_resolver",
    tenant_id: "tenant_01",
    actor_claims: [{ actor_id: "actor_resolver", actor_type: "system" as const, endpoint_ids: ["endpoint_resolver"] }],
    attributes: {},
  },
};

class TrackingAuthority implements AuthorityPolicy {
  readonly requests: AuthorityRequest[] = [];
  readonly manifest: CapabilityManifest = {
    profile: "exchange.authority.v1",
    adapter: "tracking",
    capabilities: {
      explicit_decision: true,
      default_deny: true,
      resource_scoping: true,
    },
  };

  async authorize(request: AuthorityRequest): Promise<AuthorityDecision> {
    this.requests.push(structuredClone(request));
    return { kind: "allow" as const };
  }
}

function headers(role: keyof typeof principals) {
  const claim = principals[role].actor_claims[0]!;
  return {
    authorization: `Bearer ${role}`,
    "content-type": "application/json",
    "x-wf-actor-id": claim.actor_id,
    "x-wf-endpoint-id": claim.endpoint_ids[0]!,
  };
}

function fixture() {
  const directoryStore = new MemoryEndpointDirectoryStore();
  const inboxStore = new MemoryEndpointInboxStore();
  let session = 0;
  const directory = new EndpointDirectoryService({
    store: directoryStore,
    clock: { now: () => "2026-07-15T00:00:00Z" },
    ids: { sessionId: () => `session_${++session}` },
    limits: {
      min_lease_seconds: 30,
      default_lease_seconds: 60,
      max_lease_seconds: 300,
      renew_ahead_seconds: 10,
      max_capabilities: 64,
      max_bindings: 16,
      default_page_limit: 20,
      max_page_limit: 100,
    },
  });
  const inbox = new EndpointInboxQueryService({
    directory: directoryStore,
    inbox: inboxStore,
    clock: { now: () => "2026-07-15T00:00:00Z" },
    defaultPageLimit: 20,
    maxPageLimit: 100,
  });
  const authority = new TrackingAuthority();
  const identity = new LocalIdentityProvider(
    Object.entries(principals).map(([token, principal]) => ({
      authentication_evidence: { bearer_token: token },
      principal,
    })),
  );
  const service = createHttpService({
    application: { async handle() { throw new Error("not used"); } },
    authenticator: new BearerAuthenticationEvidenceMapper(),
    identity,
    authority,
    schemas,
    endpoint_directory: directory,
    endpoint_inbox: inbox,
  }, normalizeHttpServiceConfig({}));
  return { service, authority, inboxStore };
}

describe("Endpoint HTTP resources", () => {
  it("binds provision, facts, lease, discovery, and inbox to exact actions", async () => {
    const { service, authority, inboxStore } = fixture();
    const provision = await service.dispatch({
      method: "PUT",
      url: "/v1/admin/endpoints/endpoint_agent",
      headers: headers("admin"),
      payload: registration,
    });
    expect(provision.status_code).toBe(200);

    const get = await service.dispatch({
      method: "GET",
      url: "/v1/endpoints/endpoint_agent",
      headers: headers("admin"),
    });
    expect(get.status_code).toBe(200);

    const discovery = await service.dispatch({
      method: "GET",
      url: "/v1/endpoints?capability_id=software.implementation&limit=10",
      headers: headers("resolver"),
    });
    expect(discovery.status_code).toBe(200);

    const opened = await service.dispatch({
      method: "POST",
      url: "/v1/endpoints/endpoint_agent/sessions",
      headers: headers("runtime"),
      payload: open,
    });
    expect(opened.status_code).toBe(200);
    const session = opened.json() as { session_id: string; fencing_token: number };

    const heartbeat = await service.dispatch({
      method: "POST",
      url: `/v1/endpoints/endpoint_agent/sessions/${session.session_id}/heartbeat`,
      headers: headers("runtime"),
      payload: {
        fencing_token: session.fencing_token,
        heartbeat_sequence: 1,
        availability: "busy",
        capabilities: [capability],
        expected_registration_version: 1,
      },
    });
    expect(heartbeat.status_code).toBe(200);

    const identities = await service.dispatch({
      method: "GET",
      url: "/v1/endpoints?disclosure=identity&limit=10",
      headers: headers("resolver"),
    });
    expect(identities.status_code).toBe(200);
    expect(identities.json()).toMatchObject({
      items: [{ endpoint_id: "endpoint_agent", availability: "busy" }],
    });
    expect(JSON.stringify(identities.json())).not.toContain("bindings");
    expect(JSON.stringify(identities.json())).not.toContain("capabilities");

    const summaries = await service.dispatch({
      method: "GET",
      url: "/v1/endpoints?disclosure=summary&capability_id=software.implementation",
      headers: headers("resolver"),
    });
    expect(summaries.status_code).toBe(200);
    expect(summaries.json()).toMatchObject({
      items: [{
        endpoint_id: "endpoint_agent",
        capabilities: [{ capability_id: "software.implementation" }],
      }],
    });
    expect(JSON.stringify(summaries.json())).not.toContain("input_schema_refs");
    expect(JSON.stringify(summaries.json())).not.toContain("constraints");

    const contract = await service.dispatch({
      method: "GET",
      url: "/v1/endpoints/endpoint_agent/capabilities/software.implementation",
      headers: headers("resolver"),
    });
    expect(contract.status_code).toBe(200);
    expect(contract.json()).toMatchObject({
      endpoint_id: "endpoint_agent",
      capability,
    });

    const inbox = await service.dispatch({
      method: "GET",
      url: "/v1/endpoints/endpoint_agent/inbox/partitions?limit=10",
      headers: headers("runtime"),
    });
    expect(inbox.status_code).toBe(200);
    expect(inbox.json()).toEqual({ items: [] });

    await inboxStore.upsertRoutingFact({
      tenant_id: "tenant_01",
      partition_id: "partition_claimable",
      handoff_id: "handoff_claimable",
      resource_version: 1,
      lifecycle_state: "claimable",
      capability_ids: ["software.implementation"],
      last_event_id: "event_claimable",
      observed_position: 1,
      visible_actor_ids: [],
      visible_endpoint_ids: [],
      active: true,
    });
    const claimable = await service.dispatch({
      method: "GET",
      url: "/v1/endpoints/endpoint_agent/claimable-handoffs?limit=10",
      headers: headers("runtime"),
    });
    expect(claimable.status_code).toBe(200);
    expect(claimable.json()).toMatchObject({
      items: [{
        handoff_id: "handoff_claimable",
        capability_ids: ["software.implementation"],
      }],
    });

    const closed = await service.dispatch({
      method: "POST",
      url: `/v1/endpoints/endpoint_agent/sessions/${session.session_id}/close`,
      headers: headers("runtime"),
      payload: {
        fencing_token: session.fencing_token,
        heartbeat_sequence: 2,
        expected_registration_version: 1,
      },
    });
    expect(closed.status_code).toBe(200);

    expect(authority.requests.map(({ action }) => action)).toEqual([
      "workfabric.endpoint.provision.v1",
      "workfabric.endpoint.read.v1",
      "workfabric.endpoint.discover.v1",
      "workfabric.endpoint.session.open.v1",
      "workfabric.endpoint.session.heartbeat.v1",
      "workfabric.endpoint.identity.discover.v1",
      "workfabric.endpoint.capability-summary.discover.v1",
      "workfabric.endpoint.capability.read.v1",
      "workfabric.endpoint.inbox.read.v1",
      "workfabric.endpoint.claim-pool.read.v1",
      "workfabric.endpoint.session.close.v1",
    ]);
    await service.close();
  });

  it("does not let a lower disclosure grant escalate to full Endpoint contracts", async () => {
    const { service, authority } = fixture();
    authority.authorize = async (request: AuthorityRequest) => {
      authority.requests.push(structuredClone(request));
      if (request.action === "workfabric.endpoint.discover.v1") {
        return { kind: "deny" as const, reason: "full disclosure denied" };
      }
      return { kind: "allow" as const };
    };

    const identity = await service.dispatch({
      method: "GET",
      url: "/v1/endpoints?disclosure=identity",
      headers: headers("resolver"),
    });
    const full = await service.dispatch({
      method: "GET",
      url: "/v1/endpoints?disclosure=full",
      headers: headers("resolver"),
    });

    expect(identity.status_code).toBe(200);
    expect(full.status_code).toBe(403);
    await service.close();
  });

  it("does not let an admin identity open another Actor's Runtime session", async () => {
    const { service } = fixture();
    await service.dispatch({ method: "PUT", url: "/v1/admin/endpoints/endpoint_agent", headers: headers("admin"), payload: registration });

    const response = await service.dispatch({
      method: "POST",
      url: "/v1/endpoints/endpoint_agent/sessions",
      headers: headers("admin"),
      payload: open,
    });

    expect(response.status_code).toBe(404);
    expect(JSON.stringify(response.json())).not.toContain("actor_agent");
    await service.close();
  });

  it("rejects invalid representations before invoking the service", async () => {
    const { service } = fixture();
    const response = await service.dispatch({
      method: "PUT",
      url: "/v1/admin/endpoints/endpoint_agent",
      headers: headers("admin"),
      payload: { ...registration, endpoint_id: "different" },
    });

    expect(response.status_code).toBe(400);
    await service.close();
  });

  it("uses the distinct disable action for an administrative shutdown", async () => {
    const { service, authority } = fixture();
    await service.dispatch({
      method: "PUT",
      url: "/v1/admin/endpoints/endpoint_agent",
      headers: headers("admin"),
      payload: registration,
    });

    const response = await service.dispatch({
      method: "PUT",
      url: "/v1/admin/endpoints/endpoint_agent",
      headers: headers("admin"),
      payload: {
        ...registration,
        administrative_state: "disabled",
        registration_version: 2,
      },
    });

    expect(response.status_code).toBe(200);
    expect(authority.requests.at(-1)?.action).toBe(
      "workfabric.endpoint.disable.v1",
    );
    await service.close();
  });
});
