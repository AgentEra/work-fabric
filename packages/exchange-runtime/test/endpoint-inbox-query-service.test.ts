import { describe, expect, it } from "vitest";

import {
  MemoryEndpointDirectoryStore,
  MemoryEndpointInboxStore,
} from "@work-fabric/adapter-endpoint-memory";
import type {
  ResolvedPrincipal,
  StoredEndpointRegistration,
} from "@work-fabric/exchange-spi";

import {
  EndpointInboxQueryService,
  EndpointInboxQueryError,
} from "../src/index.js";

const registration: StoredEndpointRegistration = {
  tenant_id: "tenant_01",
  endpoint_id: "endpoint_agent",
  actor: { actor_id: "actor_agent", actor_type: "agent" },
  endpoint_type: "native_agent",
  display_name: "Agent Runtime",
  protocol_versions: ["1.0"],
  bindings: [{ binding_type: "http_sse", uri: "https://runtime.example.test/wf", security_schemes: ["oauth2"] }],
  allowed_capability_ids: ["software.implementation"],
  limits: { max_inline_content_bytes: 65_536 },
  administrative_state: "enabled",
  registration_version: 1,
  created_at: "2026-07-15T00:00:00Z",
  updated_at: "2026-07-15T00:00:00Z",
};

const principal: ResolvedPrincipal = {
  principal_id: "runtime_01",
  tenant_id: "tenant_01",
  actor_claims: [{
    actor_id: "actor_agent",
    actor_type: "agent",
    endpoint_ids: ["endpoint_agent"],
  }],
  attributes: {},
};

async function fixture() {
  const directory = new MemoryEndpointDirectoryStore();
  const inbox = new MemoryEndpointInboxStore();
  await directory.putRegistration({ registration, expected_version: null });
  await inbox.upsertRoutingFact({
    tenant_id: "tenant_01",
    partition_id: "handoff:h_01",
    handoff_id: "h_01",
    resource_version: 1,
    lifecycle_state: "offered",
    last_event_id: "event_01",
    observed_position: 1,
    visible_actor_ids: ["actor_agent"],
    visible_endpoint_ids: [],
    active: true,
  });
  return new EndpointInboxQueryService({
    directory,
    inbox,
    defaultPageLimit: 20,
    maxPageLimit: 100,
  });
}

describe("EndpointInboxQueryService", () => {
  it("unions the immutable Actor and Endpoint audiences", async () => {
    const service = await fixture();

    await expect(service.listPartitions(
      { tenant_id: "tenant_01", principal },
      "endpoint_agent",
      {},
    )).resolves.toEqual({
      items: [{
        partition_id: "handoff:h_01",
        latest_position: 1,
        active_handoff_count: 1,
      }],
    });
  });

  it("hides an Endpoint from an unrelated Principal", async () => {
    const service = await fixture();
    const unrelated = { ...principal, actor_claims: [] };

    await expect(service.listPartitions(
      { tenant_id: "tenant_01", principal: unrelated },
      "endpoint_agent",
      {},
    )).rejects.toBeInstanceOf(EndpointInboxQueryError);
  });

  it("rejects unbounded page sizes", async () => {
    const service = await fixture();

    await expect(service.listPartitions(
      { tenant_id: "tenant_01", principal },
      "endpoint_agent",
      { limit: 101 },
    )).rejects.toMatchObject({ code: "invalid_request" });
  });
});
