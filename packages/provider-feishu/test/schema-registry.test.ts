import { describe, expect, it } from "vitest";

import {
  FeishuCapabilitySchemaRegistry,
  feishuCapabilityDeclarations,
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
});
