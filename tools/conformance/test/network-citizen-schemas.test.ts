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
  const schemaId = `urn:work-fabric:schema:v1:${schemaName}`;
  const validator = registry.getSchema(schemaId);
  if (validator === undefined) {
    throw new Error(`Schema not registered: ${schemaId}`);
  }
  validator(value);
  return validator.errors ?? null;
}

const declaration = {
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

const descriptor = {
  citizen_id: "feishu-document-actions",
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
    count: 1,
    digest: `sha256:${"b".repeat(64)}`,
  },
  availability: "available",
  extensions: {},
};

describe("Network Citizen schemas", () => {
  it("accepts provisioning descriptor declaration and leased session payloads", () => {
    expect(
      errors("citizen-provisioning", {
        citizen_id: "feishu-document-actions",
        citizen_kind: "capability-provider",
        principal_id: "principal-feishu-provider",
        allowed_actor: {
          actor_id: "actor-feishu-provider",
          actor_type: "system",
        },
        allowed_endpoint_id: "endpoint-feishu-provider",
        allowed_declaration_namespaces: ["feishu"],
        maximum_risk: "high",
        administrative_state: "enabled",
        registration_version: 1,
      }),
    ).toBeNull();
    expect(errors("citizen-descriptor", descriptor)).toBeNull();
    expect(errors("citizen-declaration", declaration)).toBeNull();
    expect(
      errors("citizen-session-open", {
        client_session_id: "client-session-1",
        descriptor,
        declarations: [declaration],
        requested_lease_seconds: 60,
        expected_registration_version: 1,
      }),
    ).toBeNull();
    expect(
      errors("citizen-heartbeat", {
        fencing_token: 1,
        heartbeat_sequence: 1,
        availability: "available",
        expected_registration_version: 1,
      }),
    ).toBeNull();
    expect(
      errors("citizen-declaration-replace", {
        fencing_token: 1,
        expected_registration_version: 1,
        expected_declaration_version: 1,
        declarations: [declaration],
      }),
    ).toBeNull();
    expect(
      errors("citizen-session-close", {
        fencing_token: 1,
        heartbeat_sequence: 2,
        expected_registration_version: 1,
      }),
    ).toBeNull();
  });

  it("rejects non-citizen infrastructure classifications", () => {
    expect(
      errors("citizen-provisioning", {
        citizen_id: "storage-primary",
        citizen_kind: "database",
        principal_id: "principal-storage",
        allowed_declaration_namespaces: [],
        maximum_risk: "low",
        administrative_state: "enabled",
        registration_version: 1,
      }),
    ).not.toBeNull();
  });

  it("rejects unknown credential fields and malformed digests", () => {
    expect(
      errors("citizen-descriptor", {
        ...descriptor,
        credential_ref: "feishu-primary",
      }),
    ).not.toBeNull();
    expect(
      errors("citizen-declaration", {
        ...declaration,
        input_schema: {
          uri: declaration.input_schema.uri,
          digest: "sha256:not-valid",
        },
      }),
    ).not.toBeNull();
  });

  it("requires declaration replacement CAS fields", () => {
    expect(
      errors("citizen-declaration-replace", {
        fencing_token: 1,
        expected_registration_version: 1,
        declarations: [declaration],
      }),
    ).not.toBeNull();
  });

  it("validates bounded progressive disclosure pages", () => {
    expect(
      errors("citizen-discovery-page", {
        items: [descriptor],
      }),
    ).toBeNull();
    expect(
      errors("citizen-declaration-page", {
        items: [
          {
            declaration_id: declaration.declaration_id,
            declaration_kind: declaration.declaration_kind,
            version: declaration.version,
            name: declaration.name,
            description: declaration.description,
          },
        ],
      }),
    ).toBeNull();
  });
});
