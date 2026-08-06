import { describe, expect, it } from "vitest";

import type { CitizenSchemaReference } from "@work-fabric/network-citizen-spi";

import { RoutedInvocationSchemaRegistry } from "../src/index.js";

const reference = (
  uri: string,
): CitizenSchemaReference => ({
  uri,
  digest: `sha256:${"a".repeat(64)}`,
});

describe("RoutedInvocationSchemaRegistry", () => {
  it("loads a schema only through the Registry that owns its URI namespace", async () => {
    const registry = new RoutedInvocationSchemaRegistry([
      {
        uri_prefix: "urn:work-fabric:schema:feishu:",
        registry: {
          async load() {
            throw new Error("the wrong schema Registry handled the URI");
          },
        },
      },
      {
        uri_prefix: "urn:work-fabric:schema:github:",
        registry: { load: async () => ({ owner: "github" }) },
      },
    ]);
    const githubReference = reference(
      "urn:work-fabric:schema:github:pullRequestListInput:1",
    );

    await expect(registry.load(
      githubReference,
      new AbortController().signal,
    )).resolves.toEqual({ owner: "github" });
  });

  it("rejects a schema namespace that the Agent composition did not install", async () => {
    const registry = new RoutedInvocationSchemaRegistry([{
      uri_prefix: "urn:work-fabric:schema:feishu:",
      registry: { load: async () => ({}) },
    }]);

    await expect(registry.load(
      reference("urn:work-fabric:schema:unknown:input:1"),
      new AbortController().signal,
    )).rejects.toThrow("No invocation schema Registry owns this URI");
  });
});
