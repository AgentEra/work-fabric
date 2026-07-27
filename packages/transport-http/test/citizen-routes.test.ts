import { beforeAll, describe, expect, it } from "vitest";

import { MemoryNetworkCitizenStore } from "@work-fabric/adapter-network-citizen-memory";
import { LocalIdentityProvider } from "@work-fabric/adapter-identity-local";
import { NetworkCitizenDirectoryService } from "@work-fabric/network-citizen-directory";
import {
  canonicalCitizenDigest,
  type CitizenDeclaration,
} from "@work-fabric/network-citizen-spi";
import type {
  AuthorityDecision,
  AuthorityPolicy,
  AuthorityRequest,
  CapabilityManifest,
  JsonObject,
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

const citizenId = "feishu-document-actions";
const actor = {
  actor_id: "actor-feishu-provider",
  actor_type: "system" as const,
};
const declaration: CitizenDeclaration = {
  declaration_id: "feishu.document.create",
  declaration_kind: "capability",
  version: "1.0.0",
  name: "Create document",
  description: "Create one simple document.",
  interaction_modes: ["asynchronous"],
  risk: "medium",
  confirmation: "none",
  constraints: {},
  extensions: {},
};
const descriptor = {
  citizen_id: citizenId,
  citizen_kind: "capability-provider" as const,
  version: "1.0.0",
  identity: {
    principal_id: "principal-feishu-provider",
    actor,
    endpoint_id: "endpoint-feishu-provider",
  },
  protocol: { versions: ["1"], bindings: ["workfabric+https"] },
  declarations: {
    count: 1,
    digest: canonicalCitizenDigest([declaration]),
  },
  availability: "available" as const,
  extensions: {},
};
const provisioning = {
  citizen_id: citizenId,
  citizen_kind: "capability-provider" as const,
  principal_id: "principal-feishu-provider",
  allowed_actor: actor,
  allowed_endpoint_id: "endpoint-feishu-provider",
  allowed_declaration_namespaces: ["feishu"],
  maximum_risk: "high" as const,
  administrative_state: "enabled" as const,
  registration_version: 1,
};

const principals = {
  admin: {
    principal_id: "principal-admin",
    tenant_id: "tenant-a",
    actor_claims: [{
      actor_id: "actor-admin",
      actor_type: "human" as const,
      endpoint_ids: ["endpoint-admin"],
    }],
    attributes: {},
  },
  runtime: {
    principal_id: "principal-feishu-provider",
    tenant_id: "tenant-a",
    actor_claims: [{
      ...actor,
      endpoint_ids: ["endpoint-feishu-provider"],
    }],
    attributes: {},
  },
  resolver: {
    principal_id: "principal-resolver",
    tenant_id: "tenant-a",
    actor_claims: [{
      actor_id: "actor-resolver",
      actor_type: "system" as const,
      endpoint_ids: ["endpoint-resolver"],
    }],
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
    return { kind: "allow" };
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
  let sessionSequence = 0;
  const directory = new NetworkCitizenDirectoryService({
    store: new MemoryNetworkCitizenStore(),
    clock: { now: () => "2026-07-27T00:00:00.000Z" },
    ids: { sessionId: () => `session-${++sessionSequence}` },
    limits: {
      min_lease_seconds: 30,
      default_lease_seconds: 60,
      max_lease_seconds: 300,
      renew_ahead_seconds: 15,
      max_declarations: 64,
      default_page_limit: 20,
      max_page_limit: 100,
    },
  });
  const authority = new TrackingAuthority();
  const identity = new LocalIdentityProvider(
    Object.entries(principals).map(([token, principal]) => ({
      authentication_evidence: { bearer_token: token },
      principal,
    })),
  );
  const service = createHttpService(
    {
      application: {
        async handle() {
          throw new Error("not used");
        },
      },
      authenticator: new BearerAuthenticationEvidenceMapper(),
      identity,
      authority,
      schemas,
      citizen_directory: directory,
    },
    normalizeHttpServiceConfig({}),
  );
  return { service, authority };
}

describe("Network Citizen HTTP resources", () => {
  it("binds registration disclosure and session lifecycle to exact actions", async () => {
    const { service, authority } = fixture();

    const provisioned = await service.dispatch({
      method: "PUT",
      url: `/v1/admin/citizens/${citizenId}`,
      headers: headers("admin"),
      payload: provisioning,
    });
    expect(provisioned.status_code).toBe(200);

    const opened = await service.dispatch({
      method: "POST",
      url: `/v1/citizens/${citizenId}/sessions`,
      headers: headers("runtime"),
      payload: {
        client_session_id: "client-session-1",
        descriptor,
        declarations: [declaration],
        requested_lease_seconds: 60,
        expected_registration_version: 1,
      } as unknown as JsonObject,
    });
    expect(opened.status_code).toBe(200);
    const session = opened.json() as {
      session_id: string;
      fencing_token: number;
    };

    const list = await service.dispatch({
      method: "GET",
      url: "/v1/citizens?citizen_kind=capability-provider&limit=10",
      headers: headers("resolver"),
    });
    expect(list.status_code).toBe(200);
    expect(list.json()).toMatchObject({
      items: [{ citizen_id: citizenId, declarations: { count: 1 } }],
    });

    const detail = await service.dispatch({
      method: "GET",
      url: `/v1/citizens/${citizenId}`,
      headers: headers("resolver"),
    });
    expect(detail.status_code).toBe(200);

    const summaries = await service.dispatch({
      method: "GET",
      url: `/v1/citizens/${citizenId}/declarations`,
      headers: headers("resolver"),
    });
    expect(summaries.status_code).toBe(200);
    expect(JSON.stringify(summaries.json())).not.toContain("constraints");

    const contract = await service.dispatch({
      method: "GET",
      url: `/v1/citizens/${citizenId}/declarations/feishu.document.create`,
      headers: headers("resolver"),
    });
    expect(contract.status_code).toBe(200);
    expect(contract.json()).toMatchObject({
      citizen_id: citizenId,
      declaration: { declaration_id: "feishu.document.create" },
    });

    const heartbeat = await service.dispatch({
      method: "POST",
      url: `/v1/citizens/${citizenId}/sessions/${session.session_id}/heartbeat`,
      headers: headers("runtime"),
      payload: {
        fencing_token: session.fencing_token,
        heartbeat_sequence: 1,
        availability: "degraded",
        expected_registration_version: 1,
      } as unknown as JsonObject,
    });
    expect(heartbeat.status_code).toBe(200);

    const replaced = await service.dispatch({
      method: "PUT",
      url: `/v1/citizens/${citizenId}/sessions/${session.session_id}/declarations`,
      headers: headers("runtime"),
      payload: {
        fencing_token: session.fencing_token,
        expected_registration_version: 1,
        expected_declaration_version: 1,
        declarations: [declaration],
      } as unknown as JsonObject,
    });
    expect(replaced.status_code).toBe(200);

    const closed = await service.dispatch({
      method: "POST",
      url: `/v1/citizens/${citizenId}/sessions/${session.session_id}/close`,
      headers: headers("runtime"),
      payload: {
        fencing_token: session.fencing_token,
        heartbeat_sequence: 2,
        expected_registration_version: 1,
      },
    });
    expect(closed.status_code).toBe(200);

    expect(authority.requests.map(({ action }) => action)).toEqual([
      "workfabric.citizen.provision.v1",
      "workfabric.citizen.session.open.v1",
      "workfabric.citizen.discover.v1",
      "workfabric.citizen.read.v1",
      "workfabric.citizen.declaration-summary.read.v1",
      "workfabric.citizen.declaration.read.v1",
      "workfabric.citizen.session.heartbeat.v1",
      "workfabric.citizen.session.declarations.replace.v1",
      "workfabric.citizen.session.close.v1",
    ]);
    await service.close();
  });

  it("conceals representation failures and rejects mismatched route identities", async () => {
    const { service } = fixture();
    await service.dispatch({
      method: "PUT",
      url: `/v1/admin/citizens/${citizenId}`,
      headers: headers("admin"),
      payload: provisioning,
    });

    const representedByAdmin = await service.dispatch({
      method: "POST",
      url: `/v1/citizens/${citizenId}/sessions`,
      headers: headers("admin"),
      payload: {
        client_session_id: "client-session-1",
        descriptor,
        declarations: [declaration],
        expected_registration_version: 1,
      } as unknown as JsonObject,
    });
    expect(representedByAdmin.status_code).toBe(404);

    const mismatch = await service.dispatch({
      method: "PUT",
      url: "/v1/admin/citizens/different-citizen",
      headers: headers("admin"),
      payload: provisioning,
    });
    expect(mismatch.status_code).toBe(400);
    await service.close();
  });
});
