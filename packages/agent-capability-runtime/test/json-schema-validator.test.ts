import { describe, expect, it } from "vitest";
import { canonicalCitizenDigest } from "@work-fabric/network-citizen-spi";

import {
  JsonSchemaInvocationValidator,
  type BoundCapabilityContract,
} from "../src/index.js";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: { title: { type: "string", minLength: 1 } },
};
const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["document_token"],
  properties: { document_token: { type: "string", minLength: 1 } },
};
const contract: BoundCapabilityContract = {
  candidate: {
    citizen_id: "feishu-actions",
    endpoint_id: "endpoint-feishu-actions",
    capability_id: "feishu.document.create",
    capability_version: "1.0.0",
    contract_digest: `sha256:${"a".repeat(64)}`,
  },
  input_schema: {
    uri: "urn:input",
    digest: canonicalCitizenDigest(inputSchema),
  },
  output_schema: {
    uri: "urn:output",
    digest: canonicalCitizenDigest(outputSchema),
  },
  confirmation: "none",
  risk: "medium",
};

describe("JsonSchemaInvocationValidator", () => {
  it("loads immutable schemas and validates both directions", async () => {
    const validator = new JsonSchemaInvocationValidator({
      load: async (reference) =>
        reference.uri === "urn:input" ? inputSchema : outputSchema,
    });
    await expect(validator.validateInput(
      contract,
      { title: "项目需求" },
      new AbortController().signal,
    )).resolves.toBeUndefined();
    await expect(validator.validateOutput(
      contract,
      { document_token: "doc-1" },
      [],
      new AbortController().signal,
    )).resolves.toEqual({
      data: { document_token: "doc-1" },
      artifacts: [],
    });
    await expect(validator.validateInput(
      contract,
      { title: "", extra: true },
      new AbortController().signal,
    )).rejects.toThrow(/schema/i);
  });
});
