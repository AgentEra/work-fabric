import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalCitizenDigest } from "@work-fabric/network-citizen-spi";

import { composeNodeService, parseServiceConfig } from "../src/index.js";

const tenantId = "tenant-citizen";
const citizenId = "citizen-feishu-provider";
const actor = {
  actor_id: "actor-feishu-provider",
  actor_type: "system" as const,
};
const declaration = {
  declaration_id: "feishu.document.create",
  declaration_kind: "capability" as const,
  version: "1.0.0",
  name: "Create document",
  description: "Create one simple Feishu document.",
  interaction_modes: ["asynchronous" as const],
  risk: "medium" as const,
  confirmation: "none" as const,
  constraints: {},
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
const descriptor = {
  citizen_id: citizenId,
  citizen_kind: "capability-provider" as const,
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
    count: 1,
    digest: canonicalCitizenDigest([declaration]),
  },
  availability: "available" as const,
  extensions: {},
};

const headers = {
  authorization: "Bearer citizen-runtime-token",
  "content-type": "application/json",
  "x-wf-actor-id": actor.actor_id,
  "x-wf-endpoint-id": "endpoint-feishu-provider",
};

function config(
  storage:
    | { readonly storage_profile: "memory-demo" }
    | {
        readonly storage_profile: "sqlite-local";
        readonly sqlite: { readonly location: string };
      },
) {
  const actions = [
    ["workfabric.citizen.provision.v1", citizenId],
    ["workfabric.citizen.session.open.v1", citizenId],
    ["workfabric.citizen.discover.v1", null],
  ];
  return parseServiceConfig({
    ...storage,
    development_mode: storage.storage_profile === "memory-demo",
    role: "api",
    tenant_id: tenantId,
    exchange_id: "exchange-citizen",
    cursor_secret: "x".repeat(32),
    identities: [{
      authentication_evidence: {
        bearer_token: "citizen-runtime-token",
      },
      principal: {
        principal_id: "principal-feishu-provider",
        tenant_id: tenantId,
        actor_claims: [{
          ...actor,
          endpoint_ids: ["endpoint-feishu-provider"],
        }],
        attributes: {},
      },
    }],
    authority_rules: actions.map(([action, resource_id]) => ({
      tenant_id: tenantId,
      principal_id: "principal-feishu-provider",
      actor_id: actor.actor_id,
      actor_type: actor.actor_type,
      endpoint_id: "endpoint-feishu-provider",
      action,
      resource_id,
    })),
  });
}

async function registerCitizen(
  service: Awaited<ReturnType<typeof composeNodeService>>,
) {
  const provisioned = await service.http.dispatch({
    method: "PUT",
    url: `/v1/admin/citizens/${citizenId}`,
    headers,
    payload: provisioning,
  });
  expect(provisioned.status_code).toBe(200);

  const opened = await service.http.dispatch({
    method: "POST",
    url: `/v1/citizens/${citizenId}/sessions`,
    headers,
    payload: {
      client_session_id: "client-session-composition",
      descriptor,
      declarations: [declaration],
      requested_lease_seconds: 300,
      expected_registration_version: 1,
    },
  });
  expect(opened.status_code).toBe(200);
}

async function expectCitizenDiscoverable(
  service: Awaited<ReturnType<typeof composeNodeService>>,
) {
  const response = await service.http.dispatch({
    method: "GET",
    url: "/v1/citizens?citizen_kind=capability-provider&limit=10",
    headers,
  });
  expect(response.status_code).toBe(200);
  expect(response.json()).toMatchObject({
    items: [{
      citizen_id: citizenId,
      citizen_kind: "capability-provider",
      availability: "available",
      declarations: {
        count: 1,
      },
    }],
  });
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Network Citizen service-node composition", () => {
  it("exposes a live Citizen catalog in the memory profile", async () => {
    const service = await composeNodeService(config({
      storage_profile: "memory-demo",
    }));
    try {
      await registerCitizen(service);
      await expectCitizenDiscoverable(service);
    } finally {
      await service.close();
    }
  });

  it("restores Citizen registrations and live sessions after SQLite restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "work-fabric-citizen-"));
    temporaryDirectories.push(directory);
    const serviceConfig = config({
      storage_profile: "sqlite-local",
      sqlite: { location: join(directory, "work-fabric.db") },
    });

    const first = await composeNodeService(serviceConfig);
    await registerCitizen(first);
    await first.close();

    const second = await composeNodeService(serviceConfig);
    try {
      await expectCitizenDiscoverable(second);
    } finally {
      await second.close();
    }
  });
});
