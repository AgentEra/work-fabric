import { describe, expect, it } from "vitest";

import { MemoryEndpointDirectoryStore } from "@work-fabric/adapter-endpoint-memory";
import type { EndpointRegistration } from "@work-fabric/exchange-spi";

import {
  EndpointDirectoryError,
  EndpointDirectoryService,
} from "../src/index.js";

const registration: EndpointRegistration = {
  endpoint_id: "endpoint_runtime_01",
  actor: { actor_id: "actor_agent_01", actor_type: "agent" },
  endpoint_type: "native_agent",
  display_name: "Local Agent Runtime",
  protocol_versions: ["1.0"],
  bindings: [
    {
      binding_type: "http_sse",
      uri: "https://runtime.example.test/work-fabric",
      security_schemes: ["oauth2_client"],
      extensions: {},
    },
  ],
  allowed_capability_ids: ["software.implementation"],
  limits: {
    max_inline_content_bytes: 65_536,
    max_context_bytes: 1_048_576,
    max_concurrent_handoffs: 4,
  },
  administrative_state: "enabled",
  registration_version: 1,
  extensions: {},
};

const capability = {
  capability_id: "software.implementation",
  version: "1.0.0",
  name: "Software implementation",
  description: "Implements explicit software Handoffs",
  input_media_types: ["application/json"],
  output_media_types: ["application/json"],
  input_schema_refs: [],
  output_schema_refs: [],
  interaction_modes: ["asynchronous", "status_updates"] as const,
  constraints: {},
  extensions: {},
};

class ManualClock {
  constructor(private current = "2026-07-15T09:00:00Z") {}

  now(): string {
    return this.current;
  }

  set(value: string): void {
    this.current = value;
  }
}

function createFixture() {
  const clock = new ManualClock();
  let nextId = 0;
  const service = new EndpointDirectoryService({
    store: new MemoryEndpointDirectoryStore(),
    clock,
    ids: { sessionId: () => `session_${++nextId}` },
    limits: {
      min_lease_seconds: 30,
      default_lease_seconds: 60,
      max_lease_seconds: 300,
      renew_ahead_seconds: 20,
      max_capabilities: 64,
      max_bindings: 16,
      default_page_limit: 50,
      max_page_limit: 200,
    },
  });
  return { service, clock };
}

const adminContext = {
  tenant_id: "tenant_01",
  principal_id: "admin_01",
};

const runtimeContext = {
  tenant_id: "tenant_01",
  principal_id: "runtime_01",
  represented_actor: registration.actor,
  represented_endpoint_id: registration.endpoint_id,
};

const openRequest = {
  client_session_id: "client_session_01",
  protocol_version: "1.0",
  capabilities: [capability],
  availability: "available" as const,
  requested_lease_seconds: 60,
  expected_registration_version: 1,
};

describe("EndpointDirectoryService", () => {
  it("provisions an immutable Actor binding with optimistic versioning", async () => {
    const { service } = createFixture();

    await expect(
      service.provision(adminContext, registration, null),
    ).resolves.toEqual(registration);
    await expect(
      service.provision(
        adminContext,
        { ...registration, display_name: "Updated Runtime", registration_version: 2 },
        1,
      ),
    ).resolves.toMatchObject({
      display_name: "Updated Runtime",
      registration_version: 2,
    });
    await expect(
      service.provision(
        adminContext,
        { ...registration, actor: { actor_id: "stolen", actor_type: "agent" } },
        2,
      ),
    ).rejects.toMatchObject({ code: "immutable_binding" });
  });

  it("replays an identical open and rejects semantic key reuse", async () => {
    const { service } = createFixture();
    await service.provision(adminContext, registration, null);

    const first = await service.openSession(
      runtimeContext,
      registration.endpoint_id,
      openRequest,
    );
    const replay = await service.openSession(
      runtimeContext,
      registration.endpoint_id,
      structuredClone(openRequest),
    );

    expect(replay).toEqual(first);
    await expect(
      service.openSession(runtimeContext, registration.endpoint_id, {
        ...openRequest,
        availability: "busy",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("fences the previous session and enforces monotonic heartbeats", async () => {
    const { service } = createFixture();
    await service.provision(adminContext, registration, null);
    const first = await service.openSession(
      runtimeContext,
      registration.endpoint_id,
      openRequest,
    );
    const second = await service.openSession(
      runtimeContext,
      registration.endpoint_id,
      { ...openRequest, client_session_id: "client_session_02" },
    );

    expect(second.fencing_token).toBeGreaterThan(first.fencing_token);
    await expect(
      service.heartbeat(runtimeContext, registration.endpoint_id, first.session_id, {
        fencing_token: first.fencing_token,
        heartbeat_sequence: 1,
        availability: "available",
        capabilities: [capability],
        expected_registration_version: 1,
      }),
    ).rejects.toMatchObject({ code: "session_fenced" });

    const heartbeat = {
      fencing_token: second.fencing_token,
      heartbeat_sequence: 1,
      availability: "busy" as const,
      capabilities: [capability],
      expected_registration_version: 1,
    };
    const renewed = await service.heartbeat(
      runtimeContext,
      registration.endpoint_id,
      second.session_id,
      heartbeat,
    );
    await expect(
      service.heartbeat(
        runtimeContext,
        registration.endpoint_id,
        second.session_id,
        heartbeat,
      ),
    ).resolves.toEqual(renewed);
  });

  it("makes an expired session unavailable without a reaper", async () => {
    const { service, clock } = createFixture();
    await service.provision(adminContext, registration, null);
    await service.openSession(
      runtimeContext,
      registration.endpoint_id,
      openRequest,
    );

    clock.set("2026-07-15T09:01:01Z");
    await expect(
      service.getEndpoint(adminContext, registration.endpoint_id),
    ).resolves.toMatchObject({ availability: "unavailable" });
    await expect(
      service.discover(adminContext, {
        capability_id: "software.implementation",
      }),
    ).resolves.toEqual({ items: [] });
  });

  it("rejects a Runtime that cannot represent the provisioned Actor and Endpoint", async () => {
    const { service } = createFixture();
    await service.provision(adminContext, registration, null);

    await expect(
      service.openSession(
        { ...runtimeContext, represented_endpoint_id: "endpoint_other" },
        registration.endpoint_id,
        openRequest,
      ),
    ).rejects.toBeInstanceOf(EndpointDirectoryError);
  });
});
