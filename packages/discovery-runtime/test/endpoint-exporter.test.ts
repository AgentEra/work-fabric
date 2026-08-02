import { describe, expect, it } from "vitest";

import { MemoryDiscoveryStore } from "@work-fabric/adapter-discovery-memory";
import { MemoryEndpointDirectoryStore } from "@work-fabric/adapter-endpoint-memory";
import type { DiscoverySigner, DiscoveryTrustResolver } from "@work-fabric/discovery-spi";

import {
  DiscoveryRecordCodec,
  EndpointDiscoveryExporter,
} from "../src/index.js";

const scope = { tenant_id: "tenant-a", tenant_view_id: "view-a" };
const now = "2026-08-01T00:00:30.000Z";
const signature = "A".repeat(86);
const signer: DiscoverySigner = { key_id: "key-1", async sign() { return signature; } };
const trust: DiscoveryTrustResolver = { async verify() { return true; } };

async function endpoint(directory: MemoryEndpointDirectoryStore, id: string) {
  await directory.putRegistration({
    expected_version: null,
    registration: {
      tenant_id: scope.tenant_id,
      endpoint_id: id,
      actor: { actor_id: `actor-${id}`, actor_type: "agent" },
      endpoint_type: "native_agent",
      display_name: id,
      protocol_versions: ["1.0"],
      bindings: [
        { binding_type: "http_sse", uri: `https://${id}.internal.test`, security_schemes: ["oauth2"] },
        { binding_type: "private_debug", uri: "http://127.0.0.1:9999", security_schemes: [] },
      ],
      allowed_capability_ids: ["software.implementation"],
      limits: { max_inline_content_bytes: 65_536 },
      administrative_state: "enabled",
      registration_version: 1,
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    },
  });
  return directory.openSession({
    tenant_id: scope.tenant_id,
    endpoint_id: id,
    actor: { actor_id: `actor-${id}`, actor_type: "agent" },
    session_id: `session-${id}`,
    client_session_id: `client-${id}`,
    protocol_version: "1.0",
    capabilities: [{
      capability_id: "software.implementation",
      version: "1.0.0",
      name: "Implementation",
      description: "Implements work",
      input_media_types: ["application/json"],
      output_media_types: ["application/json"],
      input_schema_refs: [],
      output_schema_refs: [],
      interaction_modes: ["asynchronous"],
      constraints: { internal_model: "secret" },
    }],
    availability: "available",
    accepted_lease_seconds: 300,
    expires_at: "2026-08-01T00:05:00.000Z",
    renew_after: "2026-08-01T00:04:00.000Z",
    registration_version: 1,
    request_digest: `digest-${id}`,
    opened_at: "2026-08-01T00:00:00.000Z",
  });
}

describe("EndpointDiscoveryExporter", () => {
  it("aggregates Endpoints and emits no revision for heartbeat-only churn", async () => {
    const directory = new MemoryEndpointDirectoryStore();
    const firstSession = await endpoint(directory, "endpoint-a");
    await endpoint(directory, "endpoint-b");
    const store = new MemoryDiscoveryStore({ max_records_per_origin: 20, tombstone_retention_seconds: 300 });
    const codec = new DiscoveryRecordCodec({
      local_exchange_id: "exchange-a", signer, trust, clock: { now: () => now },
    });
    const exporter = new EndpointDiscoveryExporter({
      local_exchange_id: "exchange-a",
      directory,
      store,
      codec,
      clock: { now: () => now },
      audiences: ["exchange-b"],
      safe_binding_types: ["http_sse"],
      record_ttl_seconds: 300,
      renew_ahead_seconds: 30,
      page_size: 10,
      max_endpoints: 100,
    });

    await expect(exporter.refresh(scope.tenant_id, scope.tenant_view_id))
      .resolves.toEqual({ changed: 1, unchanged: 0, withdrawn: 0 });
    const page = await store.query({ ...scope, now, limit: 10, record_kinds: ["capability_route"] });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.record_kind).toBe("capability_route");
    expect(page.items[0]?.payload).toMatchObject({
      capability_id: "software.implementation",
      versions: ["1.0.0"],
      binding_types: ["http_sse"],
    });
    expect(JSON.stringify(page.items[0])).not.toMatch(/session|heartbeat|fencing|internal_model|127\.0\.0\.1|tenant-a/);

    await directory.heartbeat({
      tenant_id: scope.tenant_id,
      endpoint_id: "endpoint-a",
      session_id: firstSession.session_id,
      fencing_token: firstSession.fencing_token,
      heartbeat_sequence: 1,
      availability: "available",
      capabilities: firstSession.capabilities,
      registration_version: 1,
      request_digest: "heartbeat-1",
      expires_at: "2026-08-01T00:05:30.000Z",
      renew_after: "2026-08-01T00:04:30.000Z",
      updated_at: "2026-08-01T00:00:30.000Z",
    });
    await expect(exporter.refresh(scope.tenant_id, scope.tenant_view_id))
      .resolves.toEqual({ changed: 0, unchanged: 1, withdrawn: 0 });

    for (const endpointId of ["endpoint-a", "endpoint-b"]) {
      const registration = await directory.getRegistration(scope.tenant_id, endpointId);
      expect(registration).not.toBeNull();
      await directory.putRegistration({
        expected_version: 1,
        registration: {
          ...registration!,
          administrative_state: "disabled",
          registration_version: 2,
          updated_at: "2026-08-01T00:00:31.000Z",
        },
      });
    }
    await expect(exporter.refresh(scope.tenant_id, scope.tenant_view_id))
      .resolves.toEqual({ changed: 0, unchanged: 0, withdrawn: 1 });
    await expect(store.query({
      ...scope,
      now: "2026-08-01T00:00:32.000Z",
      limit: 10,
      record_kinds: ["capability_route"],
    })).resolves.toMatchObject({ items: [] });
  });
});
