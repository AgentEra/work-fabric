import { describe, expect, it } from "vitest";

import {
  CitizenStoreError,
  canonicalCitizenDigest,
  type CitizenDeclaration,
  type CitizenProvisioning,
  type NetworkCitizenDescriptor,
  type OpenCitizenSession,
} from "@work-fabric/network-citizen-spi";

import { MemoryNetworkCitizenStore } from "../src/index.js";

const tenantId = "tenant-a";
const citizenId = "feishu-document-actions";
const openedAt = "2026-07-27T00:00:00.000Z";
const declarations: readonly CitizenDeclaration[] = [
  {
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
  },
];

function provisioning(
  version = 1,
  overrides: Partial<CitizenProvisioning> = {},
): CitizenProvisioning {
  return {
    citizen_id: citizenId,
    citizen_kind: "capability-provider",
    principal_id: "principal-feishu-provider",
    allowed_actor: {
      actor_id: "actor-feishu-provider",
      actor_type: "system",
    },
    allowed_endpoint_id: "endpoint-feishu-provider",
    allowed_declaration_namespaces: ["feishu"],
    maximum_risk: "destructive",
    administrative_state: "enabled",
    registration_version: version,
    ...overrides,
  };
}

function descriptor(
  availability: NetworkCitizenDescriptor["availability"] = "available",
): NetworkCitizenDescriptor {
  return {
    citizen_id: citizenId,
    citizen_kind: "capability-provider",
    version: "1.0.0",
    identity: {
      principal_id: "principal-feishu-provider",
      actor: {
        actor_id: "actor-feishu-provider",
        actor_type: "system",
      },
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
    availability,
    extensions: {},
  };
}

function openInput(
  sessionId: string,
  clientSessionId: string,
  requestDigest = `sha256:${"c".repeat(64)}`,
): OpenCitizenSession {
  return {
    tenant_id: tenantId,
    citizen_id: citizenId,
    session_id: sessionId,
    client_session_id: clientSessionId,
    descriptor: descriptor(),
    declarations,
    accepted_lease_seconds: 60,
    registration_version: 1,
    request_digest: requestDigest,
    expires_at: "2026-07-27T00:01:00.000Z",
    renew_after: "2026-07-27T00:00:45.000Z",
    opened_at: openedAt,
  };
}

async function provision(store: MemoryNetworkCitizenStore): Promise<void> {
  await store.putProvisioning({
    tenant_id: tenantId,
    provisioning: provisioning(),
    expected_registration_version: null,
    recorded_at: openedAt,
  });
}

describe("MemoryNetworkCitizenStore", () => {
  it("applies provisioning CAS and preserves immutable citizen bindings", async () => {
    const store = new MemoryNetworkCitizenStore();

    await expect(
      store.putProvisioning({
        tenant_id: tenantId,
        provisioning: provisioning(),
        expected_registration_version: null,
        recorded_at: openedAt,
      }),
    ).resolves.toMatchObject({
      tenant_id: tenantId,
      citizen_id: citizenId,
      registration_version: 1,
    });

    await expect(
      store.putProvisioning({
        tenant_id: tenantId,
        provisioning: provisioning(2, { citizen_kind: "channel" }),
        expected_registration_version: 1,
        recorded_at: "2026-07-27T00:00:01.000Z",
      }),
    ).rejects.toMatchObject({
      code: "immutable_binding",
    } satisfies Partial<CitizenStoreError>);

    await expect(
      store.putProvisioning({
        tenant_id: tenantId,
        provisioning: provisioning(3),
        expected_registration_version: 1,
        recorded_at: "2026-07-27T00:00:01.000Z",
      }),
    ).rejects.toMatchObject({
      code: "registration_version_conflict",
    } satisfies Partial<CitizenStoreError>);
  });

  it("replays identical client sessions and rejects conflicting reuse", async () => {
    const store = new MemoryNetworkCitizenStore();
    await provision(store);

    const first = await store.openSession(openInput("session-1", "client-1"));
    const replay = await store.openSession(
      openInput("session-other", "client-1"),
    );

    expect(replay).toEqual(first);
    await expect(
      store.openSession(
        openInput(
          "session-other",
          "client-1",
          `sha256:${"d".repeat(64)}`,
        ),
      ),
    ).rejects.toMatchObject({
      code: "idempotency_conflict",
    } satisfies Partial<CitizenStoreError>);
  });

  it("fences the previous active session and increments the fencing token", async () => {
    const store = new MemoryNetworkCitizenStore();
    await provision(store);

    const first = await store.openSession(openInput("session-1", "client-1"));
    const second = await store.openSession(openInput("session-2", "client-2"));

    expect(first.fencing_token).toBe(1);
    expect(second.fencing_token).toBe(2);
    await expect(
      store.heartbeat({
        tenant_id: tenantId,
        citizen_id: citizenId,
        session_id: "session-1",
        fencing_token: 1,
        heartbeat_sequence: 1,
        availability: "available",
        request_digest: `sha256:${"e".repeat(64)}`,
        expires_at: "2026-07-27T00:01:30.000Z",
        renew_after: "2026-07-27T00:01:15.000Z",
        updated_at: "2026-07-27T00:00:30.000Z",
      }),
    ).rejects.toMatchObject({
      code: "session_fenced",
    } satisfies Partial<CitizenStoreError>);
  });

  it("replaces declarations with fenced declaration CAS", async () => {
    const store = new MemoryNetworkCitizenStore();
    await provision(store);
    const session = await store.openSession(openInput("session-1", "client-1"));
    const next = [
      ...declarations,
      {
        ...declarations[0]!,
        declaration_id: "feishu.document.read",
        name: "Read document",
        description: "Read one bounded simple document.",
        risk: "low" as const,
      },
    ];

    const replaced = await store.replaceDeclarations({
      tenant_id: tenantId,
      citizen_id: citizenId,
      session_id: session.session_id,
      fencing_token: session.fencing_token,
      registration_version: 1,
      expected_declaration_version: 1,
      declarations: next,
      declaration_digest: canonicalCitizenDigest(next),
      request_digest: `sha256:${"f".repeat(64)}`,
      updated_at: "2026-07-27T00:00:10.000Z",
    });

    expect(replaced.declaration_version).toBe(2);
    expect(replaced.descriptor.declarations).toEqual({
      count: 2,
      digest: canonicalCitizenDigest(next),
    });
    await expect(
      store.replaceDeclarations({
        tenant_id: tenantId,
        citizen_id: citizenId,
        session_id: session.session_id,
        fencing_token: session.fencing_token,
        registration_version: 1,
        expected_declaration_version: 1,
        declarations: next,
        declaration_digest: canonicalCitizenDigest(next),
        request_digest: `sha256:${"0".repeat(64)}`,
        updated_at: "2026-07-27T00:00:11.000Z",
      }),
    ).rejects.toMatchObject({
      code: "declaration_version_conflict",
    } satisfies Partial<CitizenStoreError>);
  });

  it("projects expired sessions as unavailable", async () => {
    const store = new MemoryNetworkCitizenStore();
    await provision(store);
    await store.openSession(openInput("session-1", "client-1"));

    await expect(
      store.getProjectedCitizen(
        tenantId,
        citizenId,
        "2026-07-27T00:02:00.000Z",
      ),
    ).resolves.toMatchObject({
      descriptor: {
        citizen_id: citizenId,
        availability: "unavailable",
      },
    });
  });

  it("discovers draining citizens but excludes them from executable discovery", async () => {
    const store = new MemoryNetworkCitizenStore();
    await provision(store);
    const session = await store.openSession(openInput("session-1", "client-1"));
    await store.heartbeat({
      tenant_id: tenantId,
      citizen_id: citizenId,
      session_id: session.session_id,
      fencing_token: session.fencing_token,
      heartbeat_sequence: 1,
      availability: "draining",
      request_digest: `sha256:${"1".repeat(64)}`,
      expires_at: "2026-07-27T00:02:00.000Z",
      renew_after: "2026-07-27T00:01:45.000Z",
      updated_at: "2026-07-27T00:01:00.000Z",
    });

    await expect(
      store.discover({
        tenant_id: tenantId,
        limit: 10,
        now: "2026-07-27T00:01:10.000Z",
      }),
    ).resolves.toMatchObject({ items: [{ descriptor: { availability: "draining" } }] });
    await expect(
      store.discover({
        tenant_id: tenantId,
        executable_only: true,
        limit: 10,
        now: "2026-07-27T00:01:10.000Z",
      }),
    ).resolves.toEqual({ items: [] });
  });

  it("returns clones so callers cannot mutate stored declarations", async () => {
    const store = new MemoryNetworkCitizenStore();
    await provision(store);
    const session = await store.openSession(openInput("session-1", "client-1"));
    (session.declarations[0] as { name: string }).name = "mutated";

    const persisted = await store.getSession(
      tenantId,
      citizenId,
      "session-1",
    );
    expect(persisted?.declarations[0]?.name).toBe("Create document");
  });
});
