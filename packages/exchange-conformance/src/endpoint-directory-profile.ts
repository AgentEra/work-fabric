import assert from "node:assert/strict";

import {
  ENDPOINT_DIRECTORY_REQUIRED_CAPABILITIES,
  assertCapabilities,
  type EndpointDirectoryStore,
  type OpenEndpointSession,
  type StoredEndpointRegistration,
} from "@work-fabric/exchange-spi";

export type EndpointDirectoryStoreFactory = () => EndpointDirectoryStore;

function registration(
  tenantId = "tenant_profile_01",
  endpointId = "endpoint_profile_01",
): StoredEndpointRegistration {
  return {
    tenant_id: tenantId,
    endpoint_id: endpointId,
    actor: { actor_id: "actor_profile_01", actor_type: "agent" },
    endpoint_type: "native_agent",
    display_name: "Profile Runtime",
    protocol_versions: ["1.0"],
    bindings: [{ binding_type: "http_sse", uri: "https://runtime.example.test/wf", security_schemes: ["oauth2"] }],
    allowed_capability_ids: ["software.implementation"],
    limits: { max_inline_content_bytes: 65_536 },
    administrative_state: "enabled",
    registration_version: 1,
    extensions: {},
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
  };
}

function session(
  clientSessionId = "client_profile_01",
  sessionId = "session_profile_01",
  endpointId = "endpoint_profile_01",
): OpenEndpointSession {
  return {
    tenant_id: "tenant_profile_01",
    endpoint_id: endpointId,
    actor: { actor_id: "actor_profile_01", actor_type: "agent" },
    session_id: sessionId,
    client_session_id: clientSessionId,
    protocol_version: "1.0",
    capabilities: [{
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
    }],
    availability: "available",
    accepted_lease_seconds: 60,
    expires_at: "2026-07-15T00:01:00Z",
    renew_after: "2026-07-15T00:00:40Z",
    registration_version: 1,
    request_digest: `digest_${clientSessionId}`,
    opened_at: "2026-07-15T00:00:00Z",
  };
}

async function rejects(operation: Promise<unknown>, message: string): Promise<void> {
  try {
    await operation;
  } catch {
    return;
  }
  assert.fail(message);
}

export async function verifyEndpointDirectoryProfile(
  factory: EndpointDirectoryStoreFactory,
): Promise<void> {
  const store = factory();
  assert.equal(store.manifest.profile, "exchange.endpoint-directory.v1");
  assertCapabilities(store.manifest, ENDPOINT_DIRECTORY_REQUIRED_CAPABILITIES);

  const original = registration();
  await store.putRegistration({ registration: original, expected_version: null });
  (original.bindings[0] as { uri: string }).uri = "https://mutated.invalid";
  assert.equal((await store.getRegistration("tenant_profile_01", "endpoint_profile_01"))?.bindings[0]?.uri, "https://runtime.example.test/wf");
  assert.equal(await store.getRegistration("tenant_other", "endpoint_profile_01"), null);

  await rejects(
    store.putRegistration({ registration: { ...registration(), registration_version: 2, updated_at: "2026-07-15T00:00:01Z" }, expected_version: 9 }),
    "stale registration update must reject",
  );

  const first = await store.openSession(session());
  const replay = await store.openSession(structuredClone(session()));
  assert.deepEqual(replay, first);
  await rejects(
    store.openSession({ ...session(), request_digest: "different" }),
    "semantic client session key reuse must reject",
  );

  const second = await store.openSession(session("client_profile_02", "session_profile_02"));
  assert.ok(second.fencing_token > first.fencing_token);
  assert.equal((await store.getSession("tenant_profile_01", "endpoint_profile_01", first.session_id))?.state, "fenced");

  const renewed = await store.heartbeat({
    tenant_id: second.tenant_id,
    endpoint_id: second.endpoint_id,
    session_id: second.session_id,
    fencing_token: second.fencing_token,
    heartbeat_sequence: 1,
    availability: "busy",
    capabilities: second.capabilities,
    registration_version: 1,
    request_digest: "heartbeat_digest",
    expires_at: "2026-07-15T00:02:00Z",
    renew_after: "2026-07-15T00:01:40Z",
    updated_at: "2026-07-15T00:01:00Z",
  });
  assert.equal(renewed.availability, "busy");
  await rejects(
    store.heartbeat({
      tenant_id: second.tenant_id,
      endpoint_id: second.endpoint_id,
      session_id: second.session_id,
      fencing_token: second.fencing_token,
      heartbeat_sequence: 1,
      availability: "available",
      capabilities: second.capabilities,
      registration_version: 1,
      request_digest: "stale",
      expires_at: "2026-07-15T00:03:00Z",
      renew_after: "2026-07-15T00:02:40Z",
      updated_at: "2026-07-15T00:02:00Z",
    }),
    "stale heartbeat must reject",
  );

  await store.putRegistration({
    registration: registration("tenant_profile_01", "endpoint_profile_02"),
    expected_version: null,
  });
  await store.openSession(
    session("client_profile_03", "session_profile_03", "endpoint_profile_02"),
  );
  const firstPage = await store.discover({
    tenant_id: "tenant_profile_01",
    capability_id: "software.implementation",
    limit: 1,
    now: "2026-07-15T00:00:30Z",
  });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.next_cursor !== undefined);
  const secondPage = await store.discover({
    tenant_id: "tenant_profile_01",
    capability_id: "software.implementation",
    cursor: firstPage.next_cursor,
    limit: 1,
    now: "2026-07-15T00:00:30Z",
  });
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(
    secondPage.items[0]?.endpoint_id,
    firstPage.items[0]?.endpoint_id,
  );
  await rejects(
    store.discover({
      tenant_id: "tenant_other",
      capability_id: "software.implementation",
      cursor: firstPage.next_cursor,
      limit: 1,
      now: "2026-07-15T00:00:30Z",
    }),
    "cross-Tenant cursor reuse must reject",
  );

  assert.equal((await store.discover({ tenant_id: "tenant_profile_01", capability_id: "software.implementation", limit: 10, now: "2026-07-15T00:01:30Z" })).items.length, 1);
  assert.equal((await store.discover({ tenant_id: "tenant_profile_01", capability_id: "software.implementation", version_constraint: ">=2.0.0", limit: 10, now: "2026-07-15T00:01:30Z" })).items.length, 0);
  assert.equal((await store.discover({ tenant_id: "tenant_profile_01", capability_id: "software.implementation", limit: 10, now: "2026-07-15T00:02:01Z" })).items.length, 0);
}
