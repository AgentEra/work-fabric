import { createHash } from "node:crypto";

import type {
  FeishuMessageClient,
  FeishuTenantTokenProvider,
} from "@work-fabric/connector-feishu";

import {
  FeishuProviderBackendError,
  type FeishuCapabilityBackend,
  type SimpleDocumentContent,
} from "./contracts.js";

export interface FeishuOpenApiCapabilityBackendOptions {
  readonly credential_ref: string;
  readonly token_provider: FeishuTenantTokenProvider;
  readonly messages: FeishuMessageClient;
  readonly fetch: typeof globalThis.fetch;
  readonly base_url: string;
  readonly request_timeout_ms: number;
  readonly max_response_bytes: number;
  readonly now?: () => string;
}

type Json = null | boolean | number | string | Json[] | {
  readonly [key: string]: Json;
};

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FeishuProviderBackendError(
      "feishu_temporarily_unavailable",
      true,
    );
  }
  return value as Record<string, unknown>;
}

function valueAt(
  value: unknown,
  path: readonly string[],
): unknown {
  let current = value;
  for (const part of path) current = object(current, part)[part];
  return current;
}

function requiredString(
  value: unknown,
  path: readonly string[],
): string {
  const result = valueAt(value, path);
  if (typeof result !== "string" || result.length === 0) {
    throw new FeishuProviderBackendError(
      "feishu_temporarily_unavailable",
      true,
    );
  }
  return result;
}

function revision(value: unknown): string {
  const raw = valueAt(value, ["data", "document", "revision_id"]);
  if (
    (typeof raw !== "string" && typeof raw !== "number") ||
    String(raw).length === 0
  ) {
    throw new FeishuProviderBackendError(
      "feishu_temporarily_unavailable",
      true,
    );
  }
  return String(raw);
}

function textElements(content: string) {
  return [{ text_run: { content } }];
}

function simpleBlocks(content: SimpleDocumentContent): Json[] {
  if (content.media_type === "text/plain") {
    return content.text.split("\n").map((line) => ({
      block_type: 2,
      text: { elements: textElements(line) },
    }));
  }
  return content.text.split("\n").map((line) => {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = heading[1]!.length;
      return {
        block_type: 2 + level,
        [`heading${level}`]: { elements: textElements(heading[2]!) },
      };
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      return {
        block_type: 12,
        bullet: { elements: textElements(bullet[1]!) },
      };
    }
    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    if (ordered !== null) {
      return {
        block_type: 13,
        ordered: { elements: textElements(ordered[1]!) },
      };
    }
    return {
      block_type: 2,
      text: { elements: textElements(line) },
    };
  });
}

async function boundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maximumBytes) {
    throw new FeishuProviderBackendError(
      "feishu_temporarily_unavailable",
      true,
    );
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new FeishuProviderBackendError(
          "feishu_temporarily_unavailable",
          true,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export class FeishuOpenApiCapabilityBackend
  implements FeishuCapabilityBackend {
  private readonly baseUrl: string;
  private readonly now: () => string;

  constructor(private readonly options: FeishuOpenApiCapabilityBackendOptions) {
    this.baseUrl = new URL(options.base_url).toString().replace(/\/$/, "");
    this.now = options.now ?? (() => new Date().toISOString());
    if (
      !Number.isSafeInteger(options.request_timeout_ms) ||
      options.request_timeout_ms < 1 ||
      !Number.isSafeInteger(options.max_response_bytes) ||
      options.max_response_bytes < 1
    ) throw new RangeError("Feishu OpenAPI bounds are invalid");
  }

  async sendMessage(
    input: Parameters<FeishuCapabilityBackend["sendMessage"]>[0],
  ): ReturnType<FeishuCapabilityBackend["sendMessage"]> {
    const result = await this.options.messages.sendMessage({
      credential_ref: this.options.credential_ref,
      receive_id_type: input.target.kind,
      receive_id: input.target.id,
      msg_type: "text",
      content: JSON.stringify({ text: input.content.text }),
      uuid: createHash("sha256")
        .update(input.idempotency_key)
        .digest("hex")
        .slice(0, 32),
    });
    if (result.kind === "accepted") {
      return {
        message_id: result.message_id,
        target: input.target,
        sent_at: this.now(),
      };
    }
    if (result.kind === "retryable_failure") {
      throw new FeishuProviderBackendError(
        result.error_code.includes("429")
          ? "feishu_rate_limited"
          : "feishu_temporarily_unavailable",
        true,
      );
    }
    throw new FeishuProviderBackendError(
      result.error_code.includes("403")
        ? "feishu_permission_denied"
        : "external_outcome_unknown",
      false,
    );
  }

  async createDocument(
    input: Parameters<FeishuCapabilityBackend["createDocument"]>[0],
  ): ReturnType<FeishuCapabilityBackend["createDocument"]> {
    const created = await this.request(
      "POST",
      "/open-apis/docx/v1/documents",
      {
        title: input.title,
        ...(input.folder_token === undefined
          ? {}
          : { folder_token: input.folder_token }),
      },
      input.signal,
    );
    const token = requiredString(created, [
      "data", "document", "document_id",
    ]);
    const writtenRevision = await this.appendBlocks(
      token,
      input.content,
      input.signal,
    );
    const url = (() => {
      try {
        return requiredString(created, ["data", "document", "url"]);
      } catch {
        return `https://feishu.cn/docx/${token}`;
      }
    })();
    return {
      document_token: token,
      url,
      title: requiredString(created, ["data", "document", "title"]),
      revision: writtenRevision,
    };
  }

  async readDocument(
    input: Parameters<FeishuCapabilityBackend["readDocument"]>[0],
  ): ReturnType<FeishuCapabilityBackend["readDocument"]> {
    const metadata = await this.metadata(input.document_token, input.signal);
    const raw = await this.request(
      "GET",
      `/open-apis/docx/v1/documents/${encodeURIComponent(
        input.document_token,
      )}/raw_content`,
      undefined,
      input.signal,
    );
    const text = requiredString(raw, ["data", "content"]);
    if (new TextEncoder().encode(text).byteLength > input.max_bytes) {
      throw new FeishuProviderBackendError("invalid_input", false);
    }
    return {
      document_token: input.document_token,
      title: requiredString(metadata, ["data", "document", "title"]),
      content: { media_type: "text/plain", text },
      revision: revision(metadata),
    };
  }

  async replaceDocument(
    input: Parameters<FeishuCapabilityBackend["replaceDocument"]>[0],
  ): ReturnType<FeishuCapabilityBackend["replaceDocument"]> {
    const metadata = await this.metadata(input.document_token, input.signal);
    this.assertRevision(metadata, input.expected_revision);
    if (input.title !== undefined) {
      await this.request(
        "PATCH",
        `/open-apis/docx/v1/documents/${encodeURIComponent(
          input.document_token,
        )}`,
        { title: input.title },
        input.signal,
      );
    }
    await this.request(
      "DELETE",
      `/open-apis/docx/v1/documents/${encodeURIComponent(
        input.document_token,
      )}/blocks/${encodeURIComponent(
        input.document_token,
      )}/children/batch_delete`,
      { start_index: 0, end_index: -1 },
      input.signal,
    );
    const nextRevision = await this.appendBlocks(
      input.document_token,
      input.content,
      input.signal,
    );
    return {
      document_token: input.document_token,
      title:
        input.title ??
        requiredString(metadata, ["data", "document", "title"]),
      revision: nextRevision,
    };
  }

  async appendDocument(
    input: Parameters<FeishuCapabilityBackend["appendDocument"]>[0],
  ): ReturnType<FeishuCapabilityBackend["appendDocument"]> {
    const metadata = await this.metadata(input.document_token, input.signal);
    this.assertRevision(metadata, input.expected_revision);
    const nextRevision = await this.appendBlocks(
      input.document_token,
      input.content,
      input.signal,
    );
    return {
      document_token: input.document_token,
      title: requiredString(metadata, ["data", "document", "title"]),
      revision: nextRevision,
    };
  }

  async deleteDocument(
    input: Parameters<FeishuCapabilityBackend["deleteDocument"]>[0],
  ): ReturnType<FeishuCapabilityBackend["deleteDocument"]> {
    const metadata = await this.metadata(input.document_token, input.signal);
    this.assertRevision(metadata, input.expected_revision);
    await this.request(
      "DELETE",
      `/open-apis/drive/v1/files/${encodeURIComponent(
        input.document_token,
      )}?type=docx`,
      undefined,
      input.signal,
    );
    return {
      document_token: input.document_token,
      deleted_at: this.now(),
    };
  }

  private async metadata(
    documentToken: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(
      "GET",
      `/open-apis/docx/v1/documents/${encodeURIComponent(documentToken)}`,
      undefined,
      signal,
    );
  }

  private assertRevision(value: unknown, expected: string): void {
    if (revision(value) !== expected) {
      throw new FeishuProviderBackendError("revision_conflict", false);
    }
  }

  private async appendBlocks(
    documentToken: string,
    content: SimpleDocumentContent,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.request(
      "POST",
      `/open-apis/docx/v1/documents/${encodeURIComponent(
        documentToken,
      )}/blocks/${encodeURIComponent(documentToken)}/children`,
      { children: simpleBlocks(content), index: -1 },
      signal,
    );
    const raw = valueAt(result, ["data", "document_revision_id"]);
    if (typeof raw !== "number" && typeof raw !== "string") {
      throw new FeishuProviderBackendError(
        "feishu_temporarily_unavailable",
        true,
      );
    }
    return String(raw);
  }

  private async request(
    method: string,
    path: string,
    body?: Json,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let forceRefresh = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let token: string;
      try {
        token = await this.options.token_provider.getToken(
          this.options.credential_ref,
          forceRefresh,
        );
      } catch {
        throw new FeishuProviderBackendError(
          "feishu_temporarily_unavailable",
          true,
        );
      }
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.options.request_timeout_ms,
      );
      try {
        const combined =
          signal === undefined
            ? controller.signal
            : AbortSignal.any([signal, controller.signal]);
        const response = await this.options.fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: combined,
        });
        if (response.status === 401) {
          forceRefresh = true;
          continue;
        }
        if (response.status === 403) {
          throw new FeishuProviderBackendError(
            "feishu_permission_denied",
            false,
          );
        }
        if (response.status === 404) {
          throw new FeishuProviderBackendError("document_not_found", false);
        }
        if (response.status === 429) {
          throw new FeishuProviderBackendError(
            "feishu_rate_limited",
            true,
            response.headers.get("retry-after") ?? undefined,
          );
        }
        if (response.status >= 500) {
          throw new FeishuProviderBackendError(
            "feishu_temporarily_unavailable",
            true,
          );
        }
        const text = await boundedText(
          response,
          this.options.max_response_bytes,
        );
        if (text === "" && response.ok) return {};
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new FeishuProviderBackendError(
            "feishu_temporarily_unavailable",
            true,
          );
        }
        const code = object(parsed, "response").code;
        if (!response.ok || code !== 0) {
          throw new FeishuProviderBackendError(
            response.status >= 500
              ? "feishu_temporarily_unavailable"
              : "external_outcome_unknown",
            response.status >= 500,
          );
        }
        return parsed;
      } catch (error) {
        if (error instanceof FeishuProviderBackendError) throw error;
        throw new FeishuProviderBackendError(
          controller.signal.aborted || signal?.aborted
            ? "deadline_exceeded"
            : "feishu_temporarily_unavailable",
          !signal?.aborted,
        );
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new FeishuProviderBackendError(
      "feishu_temporarily_unavailable",
      true,
    );
  }
}
