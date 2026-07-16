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
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      credential_ref: "credential-ref-1",
      authorize_content: async () => true,
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
    }), {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      credential_ref: "credential-ref-1",
      authorize_content: async () => true,
      request_timeout_ms: 1_000,
      max_content_bytes: 1_024,
    });
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

  it("rejects cross-scope, unknown-purpose, and unauthorized content queries", async () => {
    let contentReads = 0;
    const resolver = new FeishuDocumentResourceResolver(client({
      async getDocumentRawContent() {
        contentReads += 1;
        return { content: "must not be read", media_type: "text/plain" };
      },
    }), {
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      credential_ref: "credential-ref-1",
      authorize_content: async () => false,
      request_timeout_ms: 1_000,
      max_content_bytes: 1_024,
    });
    const reference = createFeishuDocxReference({
      document_id: "doccnResolved",
      revision_id: "9",
      title: "Current",
    });

    await expect(resolver.resolve({
      tenant_id: "another-tenant",
      connector_id: "feishu-primary",
      reference,
      purpose: "metadata",
      max_bytes: 128,
    })).resolves.toEqual({
      kind: "unavailable",
      reason_code: "scope_mismatch",
      retryable: false,
    });
    await expect(resolver.resolve({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      reference,
      purpose: "export_everything",
      max_bytes: 128,
    })).resolves.toEqual({
      kind: "unavailable",
      reason_code: "unsupported_purpose",
      retryable: false,
    });
    await expect(resolver.resolve({
      tenant_id: "tenant-1",
      connector_id: "feishu-primary",
      reference,
      purpose: "context",
      max_bytes: 128,
    })).resolves.toEqual({
      kind: "unavailable",
      reason_code: "content_access_denied",
      retryable: false,
    });
    expect(contentReads).toBe(0);
  });
});
