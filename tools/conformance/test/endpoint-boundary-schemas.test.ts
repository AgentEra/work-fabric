import { beforeAll, describe, expect, it } from "vitest";

import {
  loadSchemaRegistry,
  type SchemaRegistryError,
} from "../src/schema-registry.js";

let registry: Awaited<ReturnType<typeof loadSchemaRegistry>>;

beforeAll(async () => {
  registry = await loadSchemaRegistry("protocol/schemas/v1");
});

function errors(
  schemaName: string,
  value: unknown,
): readonly SchemaRegistryError[] | null {
  const validator = registry.getSchema(
    `urn:work-fabric:schema:v1:${schemaName}`,
  );
  if (validator === undefined) {
    throw new Error(`Schema not registered: ${schemaName}`);
  }
  validator(value);
  return validator.errors ?? null;
}

const actor = {
  actor_id: "actor_agent_01",
  actor_type: "agent",
};

const binding = {
  binding_type: "http_sse",
  uri: "https://runtime.example.test/work-fabric",
  security_schemes: ["oauth2_client"],
  extensions: {},
};

const capability = {
  capability_id: "software.implementation",
  version: "1.0.0",
  name: "Software implementation",
  description: "Implements an explicitly handed-off software change",
  input_media_types: ["application/json", "text/markdown"],
  output_media_types: ["application/json"],
  input_schema_refs: [],
  output_schema_refs: [],
  interaction_modes: ["asynchronous", "status_updates"],
  constraints: {},
  extensions: {},
};

const registration = {
  endpoint_id: "endpoint_runtime_01",
  actor,
  endpoint_type: "native_agent",
  display_name: "Local Agent Runtime",
  protocol_versions: ["1.0"],
  bindings: [binding],
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

const openSession = {
  client_session_id: "client_session_01",
  protocol_version: "1.0",
  capabilities: [capability],
  availability: "available",
  requested_lease_seconds: 60,
  expected_registration_version: 1,
};

const session = {
  endpoint_id: "endpoint_runtime_01",
  actor,
  session_id: "session_01",
  client_session_id: "client_session_01",
  protocol_version: "1.0",
  capabilities: [capability],
  availability: "available",
  accepted_lease_seconds: 60,
  fencing_token: 1,
  heartbeat_sequence: 0,
  state: "active",
  expires_at: "2026-07-15T09:01:00Z",
  renew_after: "2026-07-15T09:00:40Z",
  registration_version: 1,
};

const heartbeat = {
  fencing_token: 1,
  heartbeat_sequence: 1,
  availability: "busy",
  capabilities: [capability],
  expected_registration_version: 1,
};

const closeSession = {
  fencing_token: 1,
  heartbeat_sequence: 2,
  expected_registration_version: 1,
};

const projectedEndpoint = {
  endpoint_id: "endpoint_runtime_01",
  actor,
  endpoint_type: "native_agent",
  display_name: "Local Agent Runtime",
  protocol_versions: ["1.0"],
  bindings: [binding],
  capabilities: [capability],
  availability: "available",
  lease: {
    expires_at: "2026-07-15T09:01:00Z",
    renew_after: "2026-07-15T09:00:40Z",
  },
  limits: registration.limits,
  extensions: {},
};

describe("Endpoint boundary resource schemas", () => {
  it.each([
    ["endpoint-registration", registration],
    ["endpoint-session-open", openSession],
    ["endpoint-session", session],
    ["endpoint-heartbeat", heartbeat],
    ["endpoint-session-close", closeSession],
    [
      "endpoint-discovery-page",
      { items: [projectedEndpoint], next_cursor: "cursor_02" },
    ],
    [
      "endpoint-inbox-partition-page",
      {
        items: [
          {
            partition_id: "handoff:h_01",
            latest_position: 7,
            active_handoff_count: 1,
          },
        ],
        next_cursor: "cursor_02",
      },
    ],
  ])("accepts %s", (schemaName, value) => {
    expect(errors(schemaName, value)).toBeNull();
  });

  it("rejects credential-shaped registration extensions", () => {
    const invalid = structuredClone(registration);
    invalid.extensions = {
      "example.test/client_secret": "must-not-enter-the-contract",
    };

    expect(errors("endpoint-registration", invalid)).not.toBeNull();
  });

  it("rejects an unprovisioned capability shape in a session", () => {
    const invalid = structuredClone(openSession);
    invalid.capabilities = Array.from({ length: 65 }, () => capability);

    expect(errors("endpoint-session-open", invalid)).not.toBeNull();
  });

  it("rejects unknown fields on lease-control messages", () => {
    expect(
      errors("endpoint-heartbeat", { ...heartbeat, bearer_token: "secret" }),
    ).not.toBeNull();
    expect(
      errors("endpoint-session-close", { ...closeSession, execute: true }),
    ).not.toBeNull();
  });
});
