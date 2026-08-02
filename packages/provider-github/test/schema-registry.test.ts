import { describe, expect, it } from "vitest";
import { canonicalCitizenDigest } from "@work-fabric/network-citizen-spi";

import {
  GitHubCapabilitySchemaRegistry,
  githubReadCapabilityDeclarations,
  githubSchemaDocuments,
} from "../src/index.js";

describe("GitHub capability schema registry", () => {
  it("loads every declared schema as an independent digest-checked clone", async () => {
    const registry = new GitHubCapabilitySchemaRegistry();
    const documents = new Map(githubSchemaDocuments());

    for (const declaration of githubReadCapabilityDeclarations()) {
      for (const reference of [
        declaration.input_schema,
        declaration.output_schema,
      ]) {
        expect(reference).toBeDefined();
        const document = documents.get(reference!.uri);
        expect(document).toBeDefined();
        expect(canonicalCitizenDigest(document)).toBe(reference!.digest);

        const loaded = await registry.load(reference!, new AbortController().signal);
        expect(loaded).toEqual(document);
        expect(loaded).not.toBe(document);
      }
    }
  });

  it("keeps registered schema documents immutable to callers", async () => {
    const registry = new GitHubCapabilitySchemaRegistry();
    const reference = githubReadCapabilityDeclarations().find((item) =>
      item.declaration_id === "github.repository.list"
    )!.input_schema!;
    const first = await registry.load(reference, new AbortController().signal);
    (first as { properties?: { page_size?: { maximum?: number } } }).properties!
      .page_size!.maximum = 1;

    const second = await registry.load(reference, new AbortController().signal);
    expect((second as { properties: { page_size: { maximum: number } } })
      .properties.page_size.maximum).toBe(100);
  });

  it("rejects unknown, changed, and aborted schema loads", async () => {
    const registry = new GitHubCapabilitySchemaRegistry();
    const reference = githubReadCapabilityDeclarations()[0]!.input_schema!;
    const aborted = new AbortController();
    aborted.abort();

    await expect(registry.load({
      uri: "urn:work-fabric:schema:github:unknown:1",
      digest: reference.digest,
    }, new AbortController().signal)).rejects.toThrow(
      "Unknown or changed GitHub capability schema",
    );
    await expect(registry.load({
      ...reference,
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    }, new AbortController().signal)).rejects.toThrow(
      "Unknown or changed GitHub capability schema",
    );
    await expect(registry.load(reference, aborted.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
