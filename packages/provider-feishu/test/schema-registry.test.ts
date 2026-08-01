import { describe, expect, it } from "vitest";

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
