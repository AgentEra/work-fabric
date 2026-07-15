import type {
  ConnectorResourceQuery,
  ConnectorResourceResolution,
  ConnectorResourceResolver,
} from "@work-fabric/connector-spi";

import {
  createFeishuDocxReference,
  parseFeishuDocumentReference,
} from "./document-reference.js";

export interface FeishuDocumentClient {
  resolveWikiToken(
    wikiToken: string,
    signal: AbortSignal,
  ): Promise<{ readonly document_id: string }>;
  getDocumentMetadata(
    documentId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly document_id: string;
    readonly revision_id: string;
    readonly title: string;
  }>;
  getDocumentRawContent(
    documentId: string,
    signal: AbortSignal,
  ): Promise<{ readonly content: string; readonly media_type: string }>;
}

export interface FeishuDocumentResourceResolverOptions {
  readonly request_timeout_ms: number;
  readonly max_content_bytes: number;
}

export class FeishuDocumentResourceResolver
  implements ConnectorResourceResolver {
  readonly manifest = {
    profile: "connector.resource-resolver.v1",
    adapter: "feishu",
    capabilities: {
      reference_only_authority: true,
      bounded_content: true,
      revision_check: true,
    },
  } as const;

  constructor(
    private readonly client: FeishuDocumentClient,
    private readonly options: FeishuDocumentResourceResolverOptions,
  ) {
    if (
      !Number.isSafeInteger(options.request_timeout_ms) ||
      options.request_timeout_ms <= 0 ||
      !Number.isSafeInteger(options.max_content_bytes) ||
      options.max_content_bytes <= 0
    ) {
      throw new RangeError("Feishu resource limits must be positive integers");
    }
  }

  async resolve(
    query: ConnectorResourceQuery,
  ): Promise<ConnectorResourceResolution> {
    if (!Number.isSafeInteger(query.max_bytes) || query.max_bytes <= 0) {
      throw new RangeError("max_bytes must be a positive safe integer");
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.request_timeout_ms,
    );
    try {
      const parsed = parseFeishuDocumentReference(query.reference);
      const documentId = parsed.kind === "wiki"
        ? (await this.client.resolveWikiToken(
            parsed.wiki_token,
            controller.signal,
          )).document_id
        : parsed.document_id;
      const metadata = await this.client.getDocumentMetadata(
        documentId,
        controller.signal,
      );
      if (
        parsed.kind === "docx" &&
        parsed.revision_id !== metadata.revision_id
      ) {
        return {
          kind: "unavailable",
          reason_code: "revision_mismatch",
          retryable: false,
        };
      }
      const reference = createFeishuDocxReference(metadata);
      if (query.purpose === "metadata") {
        return { kind: "available", reference };
      }
      const raw = await this.client.getDocumentRawContent(
        documentId,
        controller.signal,
      );
      const maximum = Math.min(query.max_bytes, this.options.max_content_bytes);
      if (new TextEncoder().encode(raw.content).byteLength > maximum) {
        return {
          kind: "unavailable",
          reason_code: "content_too_large",
          retryable: false,
        };
      }
      return { kind: "available", reference, content: raw.content };
    } catch (error) {
      return {
        kind: "unavailable",
        reason_code:
          controller.signal.aborted ? "resource_timeout" : "resource_unavailable",
        retryable: true,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
