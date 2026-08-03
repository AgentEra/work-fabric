import { describe, expect, it } from "vitest";
import { Ajv } from "ajv";
import { canonicalCitizenDigest } from "@work-fabric/network-citizen-spi";

import {
  GitHubCapabilitySchemaRegistry,
  type GitHubPage,
  type GitHubReviewRecord,
  githubReadCapabilityDeclarations,
  githubSchemaDocuments,
} from "../src/index.js";

const review: GitHubReviewRecord = {
  repository: { owner: "AgentEra", name: "work-fabric" },
  pull_request_number: 1,
  id: "review-1",
  actor: null,
  state: "COMMENTED",
  submitted_at: null,
  body_preview: "",
  body_truncated: false,
  url: "https://github.com/AgentEra/work-fabric/pull/1#pullrequestreview-1",
};

const evidence = <T extends boolean>(complete: T) => ({
  provider: "github" as const,
  fetched_at: "2026-08-02T00:00:00.000Z",
  installation_id_hash: "sha256:installation",
  api_version: "2022-11-28",
  query_scope: ["github://repository/AgentEra/work-fabric"],
  complete,
});

const coherentReviewPages: readonly GitHubPage<GitHubReviewRecord>[] = [
  { state: "empty", items: [], evidence: evidence(true) },
  { state: "complete", items: [review], evidence: evidence(true) },
  { state: "truncated", items: [review], evidence: evidence(false) },
];

// @ts-expect-error Empty pages cannot carry items or incomplete evidence.
const contradictoryEmptyPage: GitHubPage<GitHubReviewRecord> = {
  state: "empty", items: [review], evidence: evidence(false),
};

// @ts-expect-error Complete pages require at least one item and complete evidence.
const contradictoryCompletePage: GitHubPage<GitHubReviewRecord> = {
  state: "complete", items: [], evidence: evidence(false),
};

// @ts-expect-error Truncated pages require at least one item and incomplete evidence.
const contradictoryTruncatedPage: GitHubPage<GitHubReviewRecord> = {
  state: "truncated", items: [], evidence: evidence(true),
};

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
      .properties.page_size.maximum).toBe(5);
  });

  it("publishes the conservative MVP page, preview, array, and check bounds", async () => {
    const documents = new Map(githubSchemaDocuments());
    const declaration = githubReadCapabilityDeclarations().find((item) =>
      item.declaration_id === "github.pull_request.list"
    )!;
    const input = documents.get(declaration.input_schema!.uri)! as {
      readonly properties: {
        readonly page_size: { readonly maximum: number };
        readonly labels: { readonly maxItems: number };
      };
    };
    const output = documents.get(declaration.output_schema!.uri)! as {
      readonly oneOf: readonly [{}, {
        readonly properties: {
          readonly items: {
            readonly maxItems: number;
            readonly items: {
              readonly properties: {
                readonly title: { readonly maxLength: number };
                readonly labels: { readonly maxItems: number };
              };
            };
          };
        };
      }];
    };
    const detail = documents.get(githubReadCapabilityDeclarations().find((item) =>
      item.declaration_id === "github.pull_request.get"
    )!.output_schema!.uri)! as {
      readonly properties: {
        readonly item: { readonly properties: { readonly body_preview: { readonly maxLength: number } } };
      };
    };
    const checks = documents.get(githubReadCapabilityDeclarations().find((item) =>
      item.declaration_id === "github.pull_request.checks.get"
    )!.output_schema!.uri)! as {
      readonly properties: {
        readonly item: { readonly properties: { readonly checks: { readonly maxItems: number } } };
      };
    };

    expect(input.properties.page_size.maximum).toBe(5);
    expect(input.properties.labels.maxItems).toBe(10);
    expect(output.oneOf[1].properties.items.maxItems).toBe(5);
    expect(output.oneOf[1].properties.items.items.properties.title.maxLength).toBe(512);
    expect(output.oneOf[1].properties.items.items.properties.labels.maxItems).toBe(10);
    expect(detail.properties.item.properties.body_preview.maxLength).toBe(1_024);
    expect(checks.properties.item.properties.checks.maxItems).toBe(20);
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

  it("permits empty review previews", () => {
    const schema = new Map(githubSchemaDocuments()).get(
      githubReadCapabilityDeclarations().find((item) =>
        item.declaration_id === "github.pull_request.reviews.list"
      )!.output_schema!.uri,
    )!;
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);

    expect(validate(coherentReviewPages[1])).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("accepts only coherent page state, item, and evidence combinations", () => {
    const schema = new Map(githubSchemaDocuments()).get(
      githubReadCapabilityDeclarations().find((item) =>
        item.declaration_id === "github.pull_request.reviews.list"
      )!.output_schema!.uri,
    )!;
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);

    for (const page of coherentReviewPages) expect(validate(page)).toBe(true);
    for (const page of [
      contradictoryEmptyPage,
      contradictoryCompletePage,
      contradictoryTruncatedPage,
    ]) expect(validate(page)).toBe(false);
  });
});
