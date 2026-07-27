import type { FeishuCapabilityBackend } from "./contracts.js";

export interface FeishuDocumentContextProviderDependencies {
  readonly backend: FeishuCapabilityBackend;
}

export class FeishuDocumentContextProvider {
  constructor(
    private readonly dependencies: FeishuDocumentContextProviderDependencies,
  ) {}

  async read(input: {
    readonly tenant_id: string;
    readonly document_token: string;
    readonly max_bytes: number;
    readonly authority: {
      readonly allowed_document_tokens: readonly string[];
    };
    readonly signal?: AbortSignal;
  }) {
    if (!input.authority.allowed_document_tokens.includes(input.document_token)) {
      throw new Error("Feishu document context Authority denied");
    }
    if (
      !Number.isSafeInteger(input.max_bytes) ||
      input.max_bytes < 1 ||
      input.max_bytes > 131_072
    ) throw new RangeError("max_bytes is invalid");
    const result = await this.dependencies.backend.readDocument({
      document_token: input.document_token,
      max_bytes: input.max_bytes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (new TextEncoder().encode(result.content.text).byteLength > input.max_bytes) {
      throw new RangeError("Feishu document context exceeds max_bytes");
    }
    return Object.freeze({
      ...result,
      provenance: Object.freeze({
        citizen_kind: "context-provider",
        source: "feishu.docx",
        tenant_id: input.tenant_id,
      }),
    });
  }
}
