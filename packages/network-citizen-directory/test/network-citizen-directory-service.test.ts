import { describe, expect, it } from "vitest";

import { MemoryNetworkCitizenStore } from "@work-fabric/adapter-network-citizen-memory";
import {
  canonicalCitizenDigest,
  type CitizenDeclaration,
  type CitizenProvisioning,
  type NetworkCitizenDescriptor,
} from "@work-fabric/network-citizen-spi";

import {
  NetworkCitizenDirectoryService,
  type CitizenCallContext,
} from "../src/index.js";

const tenantId = "tenant-a";
const citizenId = "feishu-document-actions";
const now = "2026-07-27T00:00:00.000Z";
const actor = {
  actor_id: "actor-feishu-provider",
  actor_type: "system" as const,
};

function declaration(
  overrides: Partial<CitizenDeclaration> = {},
): CitizenDeclaration {
  return {
    declaration_id: "feishu.document.create",
    declaration_kind: "capability",
    version: "1.0.0",
    name: "Create document",
    description: "Create one simple document.",
    input_schema: {
      uri: "urn:work-fabric:schema:feishu.document.create:input:1",
      digest: `sha256:${"a".repeat(64)}`,
    },
    output_schema: {
      uri: "urn:work-fabric:schema:feishu.document.create:output:1",
      digest: `sha256:${"b".repeat(64)}`,
    },
    interaction_modes: ["asynchronous"],
    risk: "medium",
    confirmation: "none",
    constraints: {},
    extensions: {},
    ...overrides,
  };
}

function descriptor(
  declarations: readonly CitizenDeclaration[],
): NetworkCitizenDescriptor {
  return {
    citizen_id: citizenId,
    citizen_kind: "capability-provider",
    version: "1.0.0",
    identity: {
      principal_id: "principal-feishu-provider",
      actor,
      endpoint_id: "endpoint-feishu-provider",
    },
    protocol: {
      versions: ["1"],
      bindings: ["workfabric+https"],
    },
    declarations: {
      count: declarations.length,
      digest: canonicalCitizenDigest(declarations),
    },
    availability: "available",
    extensions: {},
  };
}

function provisioning(
  overrides: Partial<CitizenProvisioning> = {},
): CitizenProvisioning {
  return {
    citizen_id: citizenId,
    citizen_kind: "capability-provider",
    principal_id: "principal-feishu-provider",
    allowed_actor: actor,
    allowed_endpoint_id: "endpoint-feishu-provider",
    allowed_declaration_namespaces: ["feishu"],
    maximum_risk: "high",
    administrative_state: "enabled",
    registration_version: 1,
    ...overrides,
  };
}

const adminContext: CitizenCallContext = {
  tenant_id: tenantId,
  principal_id: "principal-admin",
};

const runtimeContext: CitizenCallContext = {
  tenant_id: tenantId,
  principal_id: "principal-feishu-provider",
  represented_actor: actor,
  represented_endpoint_id: "endpoint-feishu-provider",
};

function directory() {
  return new NetworkCitizenDirectoryService({
    store: new MemoryNetworkCitizenStore(),
    clock: { now: () => now },
    ids: { sessionId: () => "session-1" },
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
}

async function provision(
  service: NetworkCitizenDirectoryService,
  input: CitizenProvisioning = provisioning(),
): Promise<void> {
  await service.provision(adminContext, input, null);
}

describe("NetworkCitizenDirectoryService", () => {
  it("binds runtime sessions to the provisioned Principal Actor and Endpoint", async () => {
    const service = directory();
    await provision(service);
    const declarations = [declaration()];

    await expect(
      service.openSession(
        {
          ...runtimeContext,
          principal_id: "principal-other",
        },
        citizenId,
        {
          client_session_id: "client-1",
          descriptor: descriptor(declarations),
          declarations,
          expected_registration_version: 1,
        },
      ),
    ).rejects.toMatchObject({ code: "representation_denied" });

    await expect(
      service.openSession(runtimeContext, citizenId, {
        client_session_id: "client-1",
        descriptor: descriptor(declarations),
        declarations,
        expected_registration_version: 1,
      }),
    ).resolves.toMatchObject({
      citizen_id: citizenId,
      fencing_token: 1,
      declaration_version: 1,
    });
  });

  it("enforces provisioned declaration namespace and risk ceilings", async () => {
    const service = directory();
    await provision(service);

    const wrongNamespace = [declaration({ declaration_id: "slack.message.send" })];
    await expect(
      service.openSession(runtimeContext, citizenId, {
        client_session_id: "client-namespace",
        descriptor: descriptor(wrongNamespace),
        declarations: wrongNamespace,
        expected_registration_version: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });

    const excessiveRisk = [declaration({ risk: "destructive" })];
    await expect(
      service.openSession(runtimeContext, citizenId, {
        client_session_id: "client-risk",
        descriptor: descriptor(excessiveRisk),
        declarations: excessiveRisk,
        expected_registration_version: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("rejects descriptor declaration digests that do not describe the payload", async () => {
    const service = directory();
    await provision(service);
    const declarations = [declaration()];

    await expect(
      service.openSession(runtimeContext, citizenId, {
        client_session_id: "client-1",
        descriptor: {
          ...descriptor(declarations),
          declarations: {
            count: 1,
            digest: `sha256:${"f".repeat(64)}`,
          },
        },
        declarations,
        expected_registration_version: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("prevents a schema URI from being rebound to different bytes", async () => {
    const service = directory();
    await provision(service);
    const initial = [declaration()];
    const session = await service.openSession(runtimeContext, citizenId, {
      client_session_id: "client-1",
      descriptor: descriptor(initial),
      declarations: initial,
      expected_registration_version: 1,
    });
    const changed = [
      declaration({
        input_schema: {
          uri: initial[0]!.input_schema!.uri,
          digest: `sha256:${"c".repeat(64)}`,
        },
      }),
    ];

    await expect(
      service.replaceDeclarations(runtimeContext, citizenId, session.session_id, {
        fencing_token: session.fencing_token,
        expected_registration_version: 1,
        expected_declaration_version: 1,
        declarations: changed,
      }),
    ).rejects.toMatchObject({ code: "schema_digest_conflict" });
  });

  it("exposes four progressive disclosure views", async () => {
    const service = directory();
    await provision(service);
    const declarations = [declaration()];
    await service.openSession(runtimeContext, citizenId, {
      client_session_id: "client-1",
      descriptor: descriptor(declarations),
      declarations,
      expected_registration_version: 1,
    });

    const list = await service.discoverCitizens(adminContext);
    const detail = await service.getCitizen(adminContext, citizenId);
    const summaries = await service.listDeclarations(adminContext, citizenId);
    const contract = await service.getDeclaration(
      adminContext,
      citizenId,
      declarations[0]!.declaration_id,
    );

    expect(list.items).toEqual([
      expect.objectContaining({
        citizen_id: citizenId,
        declarations: { count: 1, digest: canonicalCitizenDigest(declarations) },
      }),
    ]);
    expect(detail.identity).toEqual(descriptor(declarations).identity);
    expect(summaries.items).toEqual([
      {
        declaration_id: "feishu.document.create",
        declaration_kind: "capability",
        version: "1.0.0",
        name: "Create document",
        description: "Create one simple document.",
      },
    ]);
    expect(contract).toMatchObject({
      citizen_id: citizenId,
      citizen_kind: "capability-provider",
      declaration: {
        declaration_id: "feishu.document.create",
        constraints: {},
      },
      declaration_version: 1,
      fencing_token: 1,
    });
  });

  it("rejects leases outside configured bounds", async () => {
    const service = directory();
    await provision(service);
    const declarations = [declaration()];

    await expect(
      service.openSession(runtimeContext, citizenId, {
        client_session_id: "client-1",
        descriptor: descriptor(declarations),
        declarations,
        requested_lease_seconds: 301,
        expected_registration_version: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});
