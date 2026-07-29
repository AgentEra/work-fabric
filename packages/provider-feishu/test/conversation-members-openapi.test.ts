import { describe, expect, it, vi } from "vitest";

import {
  FeishuOpenApiRequestClient,
  FeishuProviderBackendError,
} from "../src/index.js";
import * as provider from "../src/index.js";

type RequestClient = {
  request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

type MembersClient = {
  list(input: {
    readonly chat_id: string;
    readonly page_size: number;
    readonly page_token?: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly members: readonly {
      readonly open_id: string;
      readonly display_name?: string;
    }[];
    readonly next_page_token?: string;
    readonly has_more: boolean;
  }>;
};

type MembersClientConstructor = new (
  requests: RequestClient,
) => MembersClient;

function constructor(): MembersClientConstructor | undefined {
  const value = (provider as Record<string, unknown>)[
    "FeishuOpenApiConversationMembersClient"
  ];
  return typeof value === "function"
    ? value as MembersClientConstructor
    : undefined;
}

function openApi(fetch: typeof globalThis.fetch) {
  return new FeishuOpenApiRequestClient({
    credential_ref: "feishu:primary",
    token_provider: {
      getToken: vi.fn(async () => "tenant-token"),
    },
    fetch,
    base_url: "https://open.feishu.cn",
    request_timeout_ms: 1_000,
    max_response_bytes: 1_024,
  });
}

describe("FeishuOpenApiConversationMembersClient", () => {
  it("is exposed as a bounded OpenAPI adapter", () => {
    expect(constructor()).toBeTypeOf("function");
  });

  it("uses open_id pagination and maps the documented member page", async () => {
    const Constructor = constructor();
    if (Constructor === undefined) return;
    const signal = new AbortController().signal;
    const request = vi.fn(async () => ({
      code: 0,
      data: {
        items: [
          {
            member_id: "ou_1",
            member_id_type: "open_id",
            name: "甲",
            tenant_key: "tenant-key-1",
          },
        ],
        has_more: true,
        page_token: "native-page-2",
      },
    }));
    const client = new Constructor({ request });

    await expect(client.list({
      chat_id: "chat-1",
      page_size: 50,
      page_token: "native-page-1",
      signal,
    })).resolves.toEqual({
      members: [{ open_id: "ou_1", display_name: "甲" }],
      has_more: true,
      next_page_token: "native-page-2",
    });
    expect(request).toHaveBeenCalledWith(
      "GET",
      "/open-apis/im/v1/chats/chat-1/members?member_id_type=open_id&page_size=50&page_token=native-page-1",
      undefined,
      signal,
    );
  });

  it.each([
    [401, "feishu_authentication_failed", false],
    [403, "feishu_permission_denied", false],
    [429, "feishu_rate_limited", true],
  ] as const)(
    "preserves HTTP %s classification from the bounded request client",
    async (status, code, retryable) => {
      const Constructor = constructor();
      if (Constructor === undefined) return;
      const fetch = vi.fn(async () => new Response(
        JSON.stringify({ code: status, msg: "denied" }),
        {
          status,
          headers: status === 429 ? { "retry-after": "3" } : {},
        },
      ));
      const client = new Constructor(openApi(fetch));

      await expect(client.list({
        chat_id: "chat-1",
        page_size: 50,
      })).rejects.toMatchObject({
        name: "FeishuProviderBackendError",
        code,
        retryable,
      });
    },
  );

  it("rejects malformed or oversized member pages as retryable invalid responses", async () => {
    const Constructor = constructor();
    if (Constructor === undefined) return;
    const client = new Constructor({
      request: vi.fn(async () => ({
        code: 0,
        data: {
          items: Array.from({ length: 101 }, (_, index) => ({
            member_id: `ou_${index}`,
            member_id_type: "open_id",
          })),
          has_more: false,
        },
      })),
    });

    await expect(client.list({
      chat_id: "chat-1",
      page_size: 100,
    })).rejects.toEqual(expect.objectContaining<
      Partial<FeishuProviderBackendError>
    >({
      code: "feishu_response_invalid",
      retryable: true,
    }));
  });
});
