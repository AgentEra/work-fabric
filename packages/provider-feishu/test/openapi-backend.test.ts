import { describe, expect, it, vi } from "vitest";

import type {
  FeishuMessageClient,
  FeishuTenantTokenProvider,
} from "@work-fabric/connector-feishu";

import {
  FeishuOpenApiCapabilityBackend,
  FeishuProviderBackendError,
} from "../src/index.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("FeishuOpenApiCapabilityBackend", () => {
  it("uses the existing message boundary for one explicit target", async () => {
    const sendMessage = vi.fn(async () => ({
      kind: "accepted" as const,
      message_id: "message-1",
    }));
    const backend = new FeishuOpenApiCapabilityBackend({
      credential_ref: "feishu-primary",
      token_provider: {
        async getToken() {
          return "tenant-token";
        },
      },
      messages: { sendMessage },
      fetch: vi.fn(),
      base_url: "https://open.feishu.test",
      request_timeout_ms: 5_000,
      max_response_bytes: 64_000,
      now: () => "2026-07-27T10:00:00.000Z",
    });

    const result = await backend.sendMessage({
      target: { kind: "chat_id", id: "chat-1" },
      content: { media_type: "text/plain", text: "项目已进入实施阶段" },
      idempotency_key: "message-key-1",
    });

    expect(result).toEqual({
      message_id: "message-1",
      target: { kind: "chat_id", id: "chat-1" },
      sent_at: "2026-07-27T10:00:00.000Z",
    });
    expect(sendMessage).toHaveBeenCalledWith({
      credential_ref: "feishu-primary",
      receive_id_type: "chat_id",
      receive_id: "chat-1",
      msg_type: "text",
      content: JSON.stringify({ text: "项目已进入实施阶段" }),
      uuid: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
  });

  it("creates and writes one simple document through bounded OpenAPI requests", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(init === undefined ? { url } : { url, init });
      if (url.endsWith("/open-apis/docx/v1/documents")) {
        return response({
          code: 0,
          data: {
            document: {
              document_id: "doc-1",
              title: "项目需求",
              revision_id: 1,
              url: "https://feishu.example/doc-1",
            },
          },
        });
      }
      if (url.includes("/blocks/doc-1/children")) {
        return response({ code: 0, data: { document_revision_id: 2 } });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const backend = new FeishuOpenApiCapabilityBackend({
      credential_ref: "feishu-primary",
      token_provider: {
        async getToken() {
          return "tenant-token";
        },
      },
      messages: { async sendMessage() {
        return { kind: "accepted", message_id: "unused" };
      } },
      fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 5_000,
      max_response_bytes: 64_000,
      now: () => "2026-07-27T10:00:00.000Z",
    });

    const created = await backend.createDocument({
      title: "项目需求",
      content: { media_type: "text/markdown", text: "# 背景\n\n需求正文" },
      placement: {
        resource_uri: "feishu://drive/folder/fld-project",
      },
      idempotency_key: "create-key-1",
    });

    expect(created).toEqual({
      document_token: "doc-1",
      url: "https://feishu.example/doc-1",
      title: "项目需求",
      revision: "2",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer tenant-token",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      title: "项目需求",
      folder_token: "fld-project",
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      children: [
        { block_type: 3, heading1: { elements: [{ text_run: { content: "背景" } }] } },
        { block_type: 2, text: { elements: [{ text_run: { content: "" } }] } },
        { block_type: 2, text: { elements: [{ text_run: { content: "需求正文" } }] } },
      ],
    });
  });

  it("checks revisions before mutations and maps vendor failures to stable errors", async () => {
    const tokenProvider: FeishuTenantTokenProvider = {
      async getToken() {
        return "tenant-token";
      },
    };
    const messages: FeishuMessageClient = {
      async sendMessage() {
        return { kind: "permanent_failure", error_code: "http_403" };
      },
    };
    const backend = new FeishuOpenApiCapabilityBackend({
      credential_ref: "feishu-primary",
      token_provider: tokenProvider,
      messages,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/open-apis/docx/v1/documents/doc-1")) {
          return response({
            code: 0,
            data: {
              document: {
                document_id: "doc-1",
                title: "项目需求",
                revision_id: 4,
              },
            },
          });
        }
        return response({ code: 99991400, msg: "permission denied" }, 403);
      },
      base_url: "https://open.feishu.test",
      request_timeout_ms: 5_000,
      max_response_bytes: 64_000,
      now: () => "2026-07-27T10:00:00.000Z",
    });

    await expect(backend.appendDocument({
      document_token: "doc-1",
      expected_revision: "3",
      content: { media_type: "text/plain", text: "追加" },
      idempotency_key: "append-key-1",
    })).rejects.toMatchObject({
      code: "revision_conflict",
      retryable: false,
    });
    await expect(backend.sendMessage({
      target: { kind: "open_id", id: "ou-1" },
      content: { media_type: "text/plain", text: "通知" },
      idempotency_key: "message-key-2",
    })).rejects.toEqual(expect.objectContaining<Partial<FeishuProviderBackendError>>({
      code: "feishu_permission_denied",
      retryable: false,
    }));
  });
});
