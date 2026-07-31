import { describe, expect, it } from "vitest";
import { JsonSchemaInvocationValidator } from "@work-fabric/agent-capability-runtime";

import {
  FeishuCapabilitySchemaRegistry,
  feishuCapabilityDeclarations,
  feishuMessageCapabilityDeclarations,
} from "../src/index.js";

describe("FeishuCapabilitySchemaRegistry", () => {
  it("serves only digest-bound declared schemas", async () => {
    const declaration = feishuCapabilityDeclarations()
      .find((item) => item.declaration_id === "feishu.document.create")!;
    const registry = new FeishuCapabilitySchemaRegistry();
    await expect(registry.load(
      declaration.input_schema!,
      new AbortController().signal,
    )).resolves.toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    await expect(registry.load({
      ...declaration.input_schema!,
      digest: `sha256:${"0".repeat(64)}`,
    }, new AbortController().signal)).rejects.toThrow(/changed/i);
  });

  it("rejects an unqualified document placement policy before Provider execution", async () => {
    const declaration = feishuCapabilityDeclarations()
      .find((item) => item.declaration_id === "feishu.document.create")!;
    const validator = new JsonSchemaInvocationValidator(
      new FeishuCapabilitySchemaRegistry(),
    );
    const contract = {
      candidate: {
        citizen_id: "citizen-feishu-document",
        endpoint_id: "endpoint-feishu-provider",
        capability_id: "feishu.document.create",
        capability_version: "2.0.0",
        contract_digest:
          `sha256:${"a".repeat(64)}` as `sha256:${string}`,
      },
      input_schema: declaration.input_schema!,
      output_schema: declaration.output_schema!,
      confirmation: "none" as const,
      risk: "medium" as const,
      operation_kind: "command" as const,
    };
    const base = {
      title: "办公网内部主机环境记录",
      content: {
        media_type: "text/markdown",
        text: "# 主机环境",
      },
    };

    await expect(validator.validateInput(contract, {
      ...base,
      placement: { policy_ref: "default" },
    }, new AbortController().signal)).rejects.toThrow(
      /input schema validation failed/i,
    );
    await expect(validator.validateInput(contract, {
      ...base,
      placement: { policy_ref: "customer.project.default" },
    }, new AbortController().signal)).resolves.toBeUndefined();
  });

  it("publishes the corrected document-create schema under a new immutable URI", () => {
    const declaration = feishuCapabilityDeclarations()
      .find((item) => item.declaration_id === "feishu.document.create");

    expect(declaration).toMatchObject({
      version: "2.0.1",
      input_schema: {
        uri: "urn:work-fabric:schema:feishu:documentCreateInput:3",
      },
    });
  });

  it("declares bounded conversation member lookup on the Message Citizen", async () => {
    const declaration = feishuMessageCapabilityDeclarations().find(
      (item) =>
        item.declaration_id === "feishu.conversation.members.list",
    );

    expect(declaration).toMatchObject({
      version: "1.0.0",
      risk: "low",
      confirmation: "none",
      constraints: {
        operation_kind: "query",
        provider_output: "typed_facts_only",
      },
    });
    const registry = new FeishuCapabilitySchemaRegistry();
    await expect(registry.load(
      declaration!.input_schema!,
      new AbortController().signal,
    )).resolves.toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["conversation", "page_size"],
      properties: {
        page_size: { type: "integer", minimum: 1, maximum: 100 },
      },
    });
    await expect(registry.load(
      declaration!.output_schema!,
      new AbortController().signal,
    )).resolves.toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["members", "has_more", "provenance"],
      properties: {
        members: { type: "array", maxItems: 100 },
      },
    });
  });
});
