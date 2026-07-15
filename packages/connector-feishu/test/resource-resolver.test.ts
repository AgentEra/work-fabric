import { describe, expect, it } from "vitest";

import {
  FeishuDocumentResourceResolver,
  createFeishuDocxReference,
  createFeishuWikiReference,
  type FeishuDocumentClient,
} from "../src/index.js";

function client(overrides: Partial<FeishuDocumentClient> = {}): FeishuDocumentClient {
  return {
    async resolveWikiToken() { return { document_id: "doccnResolved" }; },
    async getDocumentMetadata(documentId) {
      return { document_id: documentId, revision_id: "9", title: "Resolved doc" };
    },
    async getDocumentRawContent() {
      return { content: "authorized content", media_type: "text/plain" };
    },
    ...overrides,
  };
}

describe("Feishu document resource resolver", () => {
  it("resolves wiki identity before fetching bounded raw content", async () => {
    const resolver = new FeishuDocumentResourceResolver(client(), {
      request_timeout_ms: 1_000,
      max_content_bytes: 1_024,
    });
    await expect(resolver.resolve({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      reference: createFeishuWikiReference("wikcnA1b2"),
      purpose: "context",
      max_bytes: 128,
    })).resolves.toEqual({
      kind: "available",
      reference: createFeishuDocxReference({
        document_id: "doccnResolved",
        revision_id: "9",
        title: "Resolved doc",
      }),
      content: "authorized content",
    });
  });

  it("reports revision drift and oversized content explicitly", async () => {
    const resolver = new FeishuDocumentResourceResolver(client({
      async getDocumentRawContent() {
        return { content: "x".repeat(129), media_type: "text/plain" };
      },
    }), { request_timeout_ms: 1_000, max_content_bytes: 1_024 });
    await expect(resolver.resolve({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      reference: createFeishuDocxReference({
        document_id: "doccnResolved",
        revision_id: "8",
        title: "Old",
      }),
      purpose: "context",
      max_bytes: 128,
    })).resolves.toEqual({
      kind: "unavailable",
      reason_code: "revision_mismatch",
      retryable: false,
    });
    await expect(resolver.resolve({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      reference: createFeishuDocxReference({
        document_id: "doccnResolved",
        revision_id: "9",
        title: "Current",
      }),
      purpose: "context",
      max_bytes: 128,
    })).resolves.toEqual({
      kind: "unavailable",
      reason_code: "content_too_large",
      retryable: false,
    });
  });
});
