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

const implementationCapability = {
  capability_id: "software.implementation",
  version: "1.0.0",
  name: "Software implementation",
  description: "Implements approved changes in a source repository",
  input_media_types: ["application/json", "text/markdown"],
  output_media_types: ["application/json", "text/markdown"],
  input_schema_refs: ["urn:example:schema:implementation-request:v1"],
  output_schema_refs: ["urn:example:schema:implementation-result:v1"],
  interaction_modes: ["asynchronous", "status_updates"],
  constraints: {
    max_concurrent_handoffs: 4,
  },
  extensions: {},
};

const localAgentRuntime = {
  endpoint_id: "endpoint_runtime_01",
  actor: {
    actor_id: "actor_agent_01",
    actor_type: "agent",
  },
  endpoint_type: "native_agent",
  display_name: "Local Agent Runtime",
  protocol_versions: ["1.0"],
  bindings: [
    {
      binding_type: "local_process",
      uri: "urn:work-fabric:local:endpoint:runtime-01",
      security_schemes: ["local_process_identity"],
      extensions: {},
    },
  ],
  capabilities: [implementationCapability],
  lease: {
    expires_at: "2026-07-13T08:05:00Z",
    renew_after: "2026-07-13T08:03:00Z",
  },
  limits: {
    max_inline_content_bytes: 65536,
  },
  extensions: {},
};

describe("EndpointDescriptor", () => {
  it("describes a local Agent Runtime without exposing implementation", () => {
    expect(errors("endpoint-descriptor", localAgentRuntime)).toBeNull();
  });

  it("rejects credentials embedded in binding metadata", () => {
    const invalid = structuredClone(localAgentRuntime);
    Object.assign(invalid.bindings[0]!, { bearer_token: "secret" });

    expect(errors("endpoint-descriptor", invalid)).not.toBeNull();
  });

  it("rejects an undeclared and unnamespaced binding type", () => {
    const invalid = structuredClone(localAgentRuntime);
    invalid.bindings[0]!.binding_type = "magic";

    expect(errors("endpoint-descriptor", invalid)).not.toBeNull();
  });

  it("rejects executable tool definitions inside a capability", () => {
    const invalid = structuredClone(localAgentRuntime);
    Object.assign(invalid.capabilities[0]!, {
      tools: [{ name: "shell", command: "rm -rf /" }],
    });

    expect(errors("endpoint-descriptor", invalid)).not.toBeNull();
  });

  it("rejects exact duplicate capability declarations", () => {
    const invalid = structuredClone(localAgentRuntime);
    invalid.capabilities.push(structuredClone(implementationCapability));

    expect(errors("endpoint-descriptor", invalid)).not.toBeNull();
  });
});

describe("CapabilityDescriptor", () => {
  it("rejects undeclared interaction modes", () => {
    const invalid = {
      ...implementationCapability,
      interaction_modes: ["execute_arbitrary_tool"],
    };

    expect(errors("capability-descriptor", invalid)).not.toBeNull();
  });
});
