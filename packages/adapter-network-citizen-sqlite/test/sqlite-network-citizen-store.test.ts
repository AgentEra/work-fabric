import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NetworkCitizenDirectoryService } from "@work-fabric/network-citizen-directory";
import {
  canonicalCitizenDigest,
  type CitizenDeclaration,
  type CitizenProvisioning,
  type NetworkCitizenDescriptor,
} from "@work-fabric/network-citizen-spi";
import { describe, expect, it } from "vitest";

import { SqliteNetworkCitizenStore } from "../src/index.js";

const now = "2026-07-27T00:00:00.000Z";
const tenantId = "tenant-a";
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
  input_schema: {
    uri: "urn:work-fabric:schema:feishu.document.create:input:1",
    digest: `sha256:${"a".repeat(64)}`,
  },
  interaction_modes: ["asynchronous"],
  risk: "medium",
  confirmation: "none",
  constraints: {},
  extensions: {},
};

const provisioning: CitizenProvisioning = {
  citizen_id: citizenId,
  citizen_kind: "capability-provider",
  principal_id: "principal-feishu-provider",
  allowed_actor: actor,
  allowed_endpoint_id: "endpoint-feishu-provider",
  allowed_declaration_namespaces: ["feishu"],
  maximum_risk: "destructive",
  administrative_state: "enabled",
  registration_version: 1,
};

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
    protocol: { versions: ["1"], bindings: ["workfabric+https"] },
    declarations: {
      count: declarations.length,
      digest: canonicalCitizenDigest(declarations),
    },
    availability: "available",
    extensions: {},
  };
}

function service(store: SqliteNetworkCitizenStore) {
  return new NetworkCitizenDirectoryService({
    store,
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

const admin = { tenant_id: tenantId, principal_id: "principal-admin" };
const runtime = {
  tenant_id: tenantId,
  principal_id: "principal-feishu-provider",
  represented_actor: actor,
  represented_endpoint_id: "endpoint-feishu-provider",
};

describe("SqliteNetworkCitizenStore", () => {
  it("persists registration fencing declarations and schema bindings across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-citizens-"));
    const location = join(directory, "citizens.db");
    try {
      const firstStore = new SqliteNetworkCitizenStore({ location });
      const first = service(firstStore);
      await first.provision(admin, provisioning, null);
      const session = await first.openSession(runtime, citizenId, {
        client_session_id: "client-1",
        descriptor: descriptor([declaration]),
        declarations: [declaration],
        expected_registration_version: 1,
      });
      const next = [
        declaration,
        {
          ...declaration,
          declaration_id: "feishu.document.read",
          name: "Read document",
          description: "Read a bounded document.",
          input_schema: {
            uri: "urn:work-fabric:schema:feishu.document.read:input:1",
            digest: `sha256:${"b".repeat(64)}` as const,
          },
          risk: "low" as const,
        },
      ];
      await first.replaceDeclarations(runtime, citizenId, session.session_id, {
        fencing_token: session.fencing_token,
        expected_registration_version: 1,
        expected_declaration_version: 1,
        declarations: next,
      });
      await firstStore.close();

      const reopenedStore = new SqliteNetworkCitizenStore({ location });
      const reopened = service(reopenedStore);
      await expect(reopened.listDeclarations(admin, citizenId)).resolves.toMatchObject({
        items: [
          { declaration_id: "feishu.document.create" },
          { declaration_id: "feishu.document.read" },
        ],
      });
      const replacement = [
        {
          ...declaration,
          input_schema: {
            uri: declaration.input_schema!.uri,
            digest: `sha256:${"f".repeat(64)}` as const,
          },
        },
      ];
      await expect(
        reopened.replaceDeclarations(runtime, citizenId, session.session_id, {
          fencing_token: session.fencing_token,
          expected_registration_version: 1,
          expected_declaration_version: 2,
          declarations: replacement,
        }),
      ).rejects.toMatchObject({ code: "schema_digest_conflict" });
      await reopenedStore.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fences the prior active session transactionally", async () => {
    const store = new SqliteNetworkCitizenStore({ location: ":memory:" });
    try {
      await store.putProvisioning({
        tenant_id: tenantId,
        provisioning,
        expected_registration_version: null,
        recorded_at: now,
      });
      const first = await store.openSession({
        tenant_id: tenantId,
        citizen_id: citizenId,
        session_id: "session-1",
        client_session_id: "client-1",
        descriptor: descriptor([declaration]),
        declarations: [declaration],
        accepted_lease_seconds: 60,
        registration_version: 1,
        request_digest: `sha256:${"c".repeat(64)}`,
        expires_at: "2026-07-27T00:01:00.000Z",
        renew_after: "2026-07-27T00:00:45.000Z",
        opened_at: now,
      });
      const second = await store.openSession({
        tenant_id: tenantId,
        citizen_id: citizenId,
        session_id: "session-2",
        client_session_id: "client-2",
        descriptor: descriptor([declaration]),
        declarations: [declaration],
        accepted_lease_seconds: 60,
        registration_version: 1,
        request_digest: `sha256:${"d".repeat(64)}`,
        expires_at: "2026-07-27T00:01:00.000Z",
        renew_after: "2026-07-27T00:00:45.000Z",
        opened_at: now,
      });

      expect(first.fencing_token).toBe(1);
      expect(second.fencing_token).toBe(2);
      await expect(
        store.heartbeat({
          tenant_id: tenantId,
          citizen_id: citizenId,
          session_id: first.session_id,
          fencing_token: first.fencing_token,
          heartbeat_sequence: 1,
          availability: "available",
          request_digest: `sha256:${"e".repeat(64)}`,
          expires_at: "2026-07-27T00:02:00.000Z",
          renew_after: "2026-07-27T00:01:45.000Z",
          updated_at: "2026-07-27T00:01:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "session_fenced" });
    } finally {
      await store.close();
    }
  });

  it("isolates tenant projections and deterministic discovery", async () => {
    const store = new SqliteNetworkCitizenStore({ location: ":memory:" });
    try {
      await store.putProvisioning({
        tenant_id: tenantId,
        provisioning,
        expected_registration_version: null,
        recorded_at: now,
      });
      await store.openSession({
        tenant_id: tenantId,
        citizen_id: citizenId,
        session_id: "session-1",
        client_session_id: "client-1",
        descriptor: descriptor([declaration]),
        declarations: [declaration],
        accepted_lease_seconds: 60,
        registration_version: 1,
        request_digest: `sha256:${"c".repeat(64)}`,
        expires_at: "2026-07-27T00:01:00.000Z",
        renew_after: "2026-07-27T00:00:45.000Z",
        opened_at: now,
      });

      await expect(
        store.getProjectedCitizen("tenant-b", citizenId, now),
      ).resolves.toBeNull();
      await expect(
        store.discover({ tenant_id: "tenant-b", limit: 10, now }),
      ).resolves.toEqual({ items: [] });
      await expect(
        store.discover({ tenant_id: tenantId, limit: 10, now }),
      ).resolves.toMatchObject({
        items: [{ descriptor: { citizen_id: citizenId } }],
      });
    } finally {
      await store.close();
    }
  });
});
