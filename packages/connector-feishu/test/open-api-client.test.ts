import { describe, expect, it, vi } from "vitest";

import {
  FeishuOpenApiClient,
  FeishuTokenError,
  type FeishuTenantTokenProvider,
} from "../src/index.js";

class Tokens implements FeishuTenantTokenProvider {
  readonly calls: boolean[] = [];
  async getToken(_reference: string, forceRefresh = false): Promise<string> {
    this.calls.push(forceRefresh);
    return forceRefresh ? "token-2" : "token-1";
  }
}

const message = {
  credential_ref: "credential-ref-1",
  receive_id_type: "open_id" as const,
  receive_id: "ou-human-1",
  msg_type: "text" as const,
  content: JSON.stringify({ text: "hello" }),
  uuid: "wf_123",
};

describe("FeishuOpenApiClient", () => {
  it("sends native Feishu post content without changing its Markdown payload", async () => {
    const bodies: unknown[] = [];
    const client = new FeishuOpenApiClient({
      token_provider: new Tokens(),
      fetch: (async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          code: 0,
          data: { message_id: "om-post-1" },
        }), { status: 200 });
      }) as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });
    const content = JSON.stringify({
      zh_cn: {
        title: "",
        content: [[{
          tag: "md",
          text: "[文档](https://example.com)",
        }]],
      },
    });

    await expect(client.sendMessage({
      ...message,
      msg_type: "post",
      content,
    })).resolves.toEqual({
      kind: "accepted",
      message_id: "om-post-1",
    });
    expect(bodies).toEqual([{
      receive_id: "ou-human-1",
      msg_type: "post",
      content,
      uuid: "wf_123",
    }]);
  });

  it("lists a bounded Feishu conversation page and returns only validated history fields", async () => {
    const fetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      code: 0,
      msg: "must-not-escape",
      data: {
        has_more: true,
        page_token: "page-2",
        items: [{
          message_id: "om-history-1",
          root_id: "om-root-1",
          parent_id: "om-parent-1",
          thread_id: "omt-thread-1",
          msg_type: "text",
          create_time: "1784073500000",
          update_time: "1784073510000",
          deleted: false,
          updated: true,
          chat_id: "oc-chat-1",
          sender: {
            id: "ou-human-1",
            id_type: "open_id",
            sender_type: "user",
            tenant_key: "tenant-key-1",
            ignored: "must-not-escape",
          },
          body: { content: "{\"text\":\"earlier message\"}", ignored: "must-not-escape" },
          mentions: [{ name: "must-not-escape" }],
        }],
      },
    }), { status: 200 }));
    const client = new FeishuOpenApiClient({
      token_provider: new Tokens(),
      fetch: fetch as unknown as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });

    const result = await client.listMessages({
      credential_ref: "credential-ref-1",
      container_type: "chat",
      container_id: "oc-chat-1",
      start_time: 1783987200,
      end_time: 1784073600,
      sort_type: "ByCreateTimeDesc",
      page_size: 20,
    });

    expect(result).toEqual({
      kind: "accepted",
      has_more: true,
      next_page_token: "page-2",
      items: [{
        message_id: "om-history-1",
        root_id: "om-root-1",
        parent_id: "om-parent-1",
        thread_id: "omt-thread-1",
        msg_type: "text",
        create_time: "1784073500000",
        update_time: "1784073510000",
        deleted: false,
        updated: true,
        chat_id: "oc-chat-1",
        sender: {
          id: "ou-human-1",
          id_type: "open_id",
          sender_type: "user",
          tenant_key: "tenant-key-1",
        },
        body: { content: "{\"text\":\"earlier message\"}" },
      }],
    });
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind !== "accepted") throw new Error("expected accepted result");
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
    expect(Object.isFrozen(result.items[0]!.sender)).toBe(true);
    expect(Object.isFrozen(result.items[0]!.body)).toBe(true);

    const [input, init] = fetch.mock.calls[0]!;
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://open.feishu.test/open-apis/im/v1/messages",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      container_id_type: "chat",
      container_id: "oc-chat-1",
      start_time: "1783987200",
      end_time: "1784073600",
      sort_type: "ByCreateTimeDesc",
      page_size: "20",
    });
    expect(init).toMatchObject({
      method: "GET",
      headers: {
        authorization: "Bearer token-1",
        "content-type": "application/json; charset=utf-8",
      },
    });

    await client.listMessages({
      credential_ref: "credential-ref-1",
      container_type: "chat",
      container_id: "oc-chat-1",
      start_time: 1783987200,
      end_time: 1784073600,
      sort_type: "ByCreateTimeDesc",
      page_size: 20,
      page_token: "page-2",
    });
    expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.get(
      "page_token",
    )).toBe("page-2");
  });

  it("rejects invalid pagination relationships and overlong request cursors", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        has_more: true,
        items: [],
      },
    }), { status: 200 }));
    const client = new FeishuOpenApiClient({
      token_provider: new Tokens(),
      fetch: fetch as unknown as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });

    await expect(client.listMessages({
      credential_ref: "credential-ref-1",
      container_type: "chat",
      container_id: "oc-chat-1",
      sort_type: "ByCreateTimeDesc",
      page_size: 20,
    })).resolves.toEqual({
      kind: "retryable_failure",
      error_code: "invalid_response",
    });

    await expect(client.listMessages({
      credential_ref: "credential-ref-1",
      container_type: "chat",
      container_id: "oc-chat-1",
      sort_type: "ByCreateTimeDesc",
      page_size: 20,
      page_token: "x".repeat(2_049),
    })).resolves.toEqual({
      kind: "permanent_failure",
      error_code: "invalid_request",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("gets one message from the official message resource and refreshes a rejected token once", async () => {
    let call = 0;
    const tokens = new Tokens();
    const fetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      call += 1;
      return new Response(JSON.stringify(call === 1
        ? { code: 99991663, msg: "expired" }
        : {
            code: 0,
            data: {
              items: [{
                message_id: "om-current-1",
                msg_type: "text",
                create_time: "1784073600000",
                update_time: "1784073600000",
                deleted: false,
                updated: false,
                chat_id: "oc-chat-1",
                sender: {
                  id: "ou-human-1",
                  id_type: "open_id",
                  sender_type: "user",
                  tenant_key: "tenant-key-1",
                },
                body: { content: "{\"text\":\"current\"}" },
              }],
            },
          }), { status: 200 });
    });
    const client = new FeishuOpenApiClient({
      token_provider: tokens,
      fetch: fetch as unknown as typeof globalThis.fetch,
      base_url: "https://open.feishu.test/",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });

    await expect(client.getMessage({
      credential_ref: "credential-ref-1",
      message_id: "om-current-1",
    })).resolves.toMatchObject({
      kind: "accepted",
      items: [{ message_id: "om-current-1" }],
    });
    expect(tokens.calls).toEqual([false, true]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]![0])).toBe(
      "https://open.feishu.test/open-apis/im/v1/messages/om-current-1",
    );
  });

  it("validates history requests before I/O and classifies temporary and permanent failures", async () => {
    const fetch = vi.fn();
    const client = new FeishuOpenApiClient({
      token_provider: new Tokens(),
      fetch: fetch as unknown as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });
    await expect(client.listMessages({
      credential_ref: "credential-ref-1",
      container_type: "chat",
      container_id: "oc-chat-1",
      sort_type: "ByCreateTimeDesc",
      page_size: 51,
    })).resolves.toEqual({ kind: "permanent_failure", error_code: "invalid_request" });
    await expect(client.listMessages({
      credential_ref: "credential-ref-1",
      container_type: "thread",
      container_id: "omt-thread-1",
      start_time: 1,
      sort_type: "ByCreateTimeDesc",
      page_size: 20,
    })).resolves.toEqual({ kind: "permanent_failure", error_code: "invalid_request" });
    expect(fetch).not.toHaveBeenCalled();

    for (const [status, kind] of [[429, "retryable_failure"], [503, "retryable_failure"], [403, "permanent_failure"]] as const) {
      const classified = new FeishuOpenApiClient({
        token_provider: new Tokens(),
        fetch: (async () => new Response("upstream-secret", { status })) as typeof globalThis.fetch,
        base_url: "https://open.feishu.test",
        request_timeout_ms: 1_000,
        max_response_bytes: 64_000,
      });
      const result = await classified.getMessage({
        credential_ref: "credential-ref-1",
        message_id: "om-current-1",
      });
      expect(result).toEqual({ kind, error_code: `http_${status}` });
      expect(JSON.stringify(result)).not.toContain("upstream-secret");
    }
  });

  it("rejects malformed history items without leaking the upstream body", async () => {
    const secret = "malformed-secret";
    const client = new FeishuOpenApiClient({
      token_provider: new Tokens(),
      fetch: (async () => new Response(JSON.stringify({
        code: 0,
        data: {
          items: [{
            message_id: "om-history-1",
            msg_type: "text",
            create_time: "1784073500000",
            update_time: "1784073510000",
            deleted: false,
            updated: false,
            chat_id: "oc-chat-1",
            sender: { id: "ou-human-1", id_type: "open_id", sender_type: "user" },
            body: { content: secret },
          }, {
            message_id: " ",
          }],
        },
      }), { status: 200 })) as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });
    const result = await client.getMessage({
      credential_ref: "credential-ref-1",
      message_id: "om-history-1",
    });
    expect(result).toEqual({ kind: "retryable_failure", error_code: "invalid_response" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("pins Contact lookup to the official HTTPS endpoint even when the message base URL is hostile", async () => {
    const fetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      code: 0,
      msg: "sensitive-upstream-message",
      data: { items: [{
        open_id: "ou-user-1",
        name: "sensitive-name",
        mobile: "sensitive-mobile",
        email: "sensitive-email",
        avatar: { avatar_72: "sensitive-avatar" },
        status: { is_activated: true, is_exited: false, is_frozen: false },
      }] },
    }), { status: 200 }));
    const client = new FeishuOpenApiClient({
      token_provider: new Tokens(),
      fetch: fetch as unknown as typeof globalThis.fetch,
      base_url: "http://attacker.test/redirect",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });

    await expect(client.batchUsers({
      credential_ref: "credential-ref-1",
      user_ids: ["ou-user-1", "ou user/2"],
    })).resolves.toEqual({
      kind: "accepted",
      items: [{
        open_id: "ou-user-1",
        status: { is_activated: true, is_exited: false },
      }],
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [input, init] = fetch.mock.calls[0]!;
    const url = new URL(String(input));
    expect(`${url.origin}${url.pathname}`).toBe("https://open.feishu.cn/open-apis/contact/v3/users/batch");
    expect(url.searchParams.getAll("user_ids")).toEqual(["ou-user-1", "ou user/2"]);
    expect(url.searchParams.get("user_id_type")).toBe("open_id");
    expect(init).toMatchObject({
      method: "GET",
      headers: {
        authorization: "Bearer token-1",
        "content-type": "application/json; charset=utf-8",
      },
    });
    expect(init?.body).toBeUndefined();
  });

  it("returns a sanitized failure for a nonzero Contact API code without retaining msg or body", async () => {
    const secret = "sensitive-api-message-and-open-id-ou-secret";
    const client = new FeishuOpenApiClient({
      token_provider: new Tokens(),
      fetch: (async () => new Response(JSON.stringify({
        code: 12345,
        msg: secret,
        data: { items: [{ open_id: secret }] },
      }), { status: 200 })) as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });

    const result = await client.batchUsers({ credential_ref: "credential-ref-1", user_ids: ["ou-user-1"] });
    expect(result).toEqual({ kind: "failure", error_code: "api_rejected" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    ["missing open_id", { status: { is_activated: true, is_exited: false } }],
    ["blank open_id", { open_id: " ", status: { is_activated: true, is_exited: false } }],
    ["missing status", { open_id: "ou-user-1" }],
    ["nonboolean activation", { open_id: "ou-user-1", status: { is_activated: "yes", is_exited: false } }],
    ["nonboolean optional exit", { open_id: "ou-user-1", status: { is_activated: true, is_exited: "no" } }],
  ])("rejects the entire Contact response when one item has %s", async (_label, malformed) => {
    const client = new FeishuOpenApiClient({
      token_provider: new Tokens(),
      fetch: (async () => new Response(JSON.stringify({
        code: 0,
        data: { items: [
          { open_id: "ou-valid", status: { is_activated: true, is_exited: false } },
          malformed,
        ] },
      }), { status: 200 })) as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });

    await expect(client.batchUsers({ credential_ref: "credential-ref-1", user_ids: ["ou-valid"] })).resolves.toEqual({
      kind: "failure",
      error_code: "invalid_response",
    });
  });

  it("rejects a malformed-only Contact item array", async () => {
    const client = new FeishuOpenApiClient({
      token_provider: new Tokens(),
      fetch: (async () => new Response(JSON.stringify({
        code: 0,
        data: { items: [{ status: { is_activated: true } }] },
      }), { status: 200 })) as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });

    await expect(client.batchUsers({ credential_ref: "credential-ref-1", user_ids: ["ou-user-1"] })).resolves.toEqual({
      kind: "failure",
      error_code: "invalid_response",
    });
  });

  it("returns an immutable exact safe Contact item shape and permits absent is_exited", async () => {
    const client = new FeishuOpenApiClient({
      token_provider: new Tokens(),
      fetch: (async () => new Response(JSON.stringify({
        code: 0,
        data: { items: [{
          open_id: "ou-user-1",
          ignored: "raw-secret",
          status: { is_activated: true, ignored: "status-secret" },
        }] },
      }), { status: 200 })) as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });

    const result = await client.batchUsers({ credential_ref: "credential-ref-1", user_ids: ["ou-user-1"] });
    expect(result).toEqual({
      kind: "accepted",
      items: [{ open_id: "ou-user-1", status: { is_activated: true } }],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    if (result.kind !== "accepted") throw new Error("expected accepted result");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
    expect(Object.isFrozen(result.items[0]!.status)).toBe(true);
  });

  it.each([401, 403, 429, 503])("returns only a sanitized failure for Contact HTTP %s", async (status) => {
    const secret = "tenant-token-secret";
    const client = new FeishuOpenApiClient({
      token_provider: { async getToken() { return secret; } },
      fetch: (async () => new Response(`upstream echoed ${secret}`, { status })) as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });

    const result = await client.batchUsers({ credential_ref: "credential-ref-1", user_ids: ["ou-user-1"] });
    expect(result.kind).toBe("failure");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("enforces a fixed 10-second Contact timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })) as unknown as typeof globalThis.fetch;
      const client = new FeishuOpenApiClient({
        token_provider: new Tokens(),
        fetch,
        base_url: "https://open.feishu.test",
        request_timeout_ms: 1,
        max_response_bytes: 1,
      });

      const pending = client.batchUsers({ credential_ref: "credential-ref-1", user_ids: ["ou-user-1"] });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(await Promise.race([pending.then(() => "settled"), Promise.resolve("pending")])).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ kind: "failure", error_code: "request_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a Contact response-body stall as the same fixed request timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
          },
        });
        return new Response(stream, { status: 200 });
      }) as unknown as typeof globalThis.fetch;
      const client = new FeishuOpenApiClient({
        token_provider: new Tokens(),
        fetch,
        base_url: "https://open.feishu.test",
        request_timeout_ms: 1,
        max_response_bytes: 1,
      });

      const pending = client.batchUsers({ credential_ref: "credential-ref-1", user_ids: ["ou-user-1"] });
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toEqual({ kind: "failure", error_code: "request_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces a fixed 64 KiB Contact response limit and rejects malformed JSON", async () => {
    let call = 0;
    const client = new FeishuOpenApiClient({
      token_provider: new Tokens(),
      fetch: (async () => {
        call += 1;
        return call === 1
          ? new Response("x".repeat(65_537), { status: 200 })
          : new Response("not-json", { status: 200 });
      }) as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 1_000_000,
    });

    await expect(client.batchUsers({ credential_ref: "credential-ref-1", user_ids: ["ou-user-1"] })).resolves.toEqual({
      kind: "failure",
      error_code: "response_too_large",
    });
    await expect(client.batchUsers({ credential_ref: "credential-ref-1", user_ids: ["ou-user-1"] })).resolves.toEqual({
      kind: "failure",
      error_code: "invalid_response",
    });
  });

  it("refreshes once after token rejection and preserves UUID", async () => {
    const bodies: unknown[] = [];
    let call = 0;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      call += 1;
      return new Response(JSON.stringify(call === 1
        ? { code: 99991663, msg: "token expired" }
        : { code: 0, data: { message_id: "om-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const tokens = new Tokens();
    const client = new FeishuOpenApiClient({
      token_provider: tokens,
      fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });

    await expect(client.sendMessage(message)).resolves.toEqual({
      kind: "accepted",
      message_id: "om-1",
    });
    expect(tokens.calls).toEqual([false, true]);
    expect(bodies).toEqual([
      expect.objectContaining({ uuid: "wf_123" }),
      expect.objectContaining({ uuid: "wf_123" }),
    ]);
  });

  it.each([
    [429, "retryable_failure"],
    [503, "retryable_failure"],
    [400, "permanent_failure"],
    [403, "permanent_failure"],
  ] as const)("classifies HTTP %s as %s", async (status, kind) => {
    const client = new FeishuOpenApiClient({
      token_provider: new Tokens(),
      fetch: vi.fn(async () => new Response(JSON.stringify({ code: 1 }), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });
    await expect(client.sendMessage(message)).resolves.toMatchObject({ kind });
  });

  it("uses bounded response streaming and preserves permanent token failures", async () => {
    const response = new Response(JSON.stringify({
      code: 0,
      data: { message_id: "om-streamed" },
    }), { status: 200 });
    Object.defineProperty(response, "text", {
      value: () => { throw new Error("unbounded Response.text must not run"); },
    });
    const streamed = new FeishuOpenApiClient({
      token_provider: new Tokens(),
      fetch: (async () => response) as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });
    await expect(streamed.sendMessage(message)).resolves.toEqual({
      kind: "accepted",
      message_id: "om-streamed",
    });

    const rejected = new FeishuOpenApiClient({
      token_provider: {
        async getToken() { throw new FeishuTokenError("credential_rejected"); },
      },
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });
    await expect(rejected.sendMessage(message)).resolves.toEqual({
      kind: "permanent_failure",
      error_code: "token_credential_rejected",
    });
  });

  it("keeps API token rejection retryable after one safe refresh", async () => {
    const tokens = new Tokens();
    const client = new FeishuOpenApiClient({
      token_provider: tokens,
      fetch: (async () => new Response(JSON.stringify({
        code: 99991663,
        msg: "token rejected",
      }), { status: 200 })) as typeof globalThis.fetch,
      base_url: "https://open.feishu.test",
      request_timeout_ms: 1_000,
      max_response_bytes: 64_000,
    });
    await expect(client.sendMessage(message)).resolves.toEqual({
      kind: "retryable_failure",
      error_code: "token_rejected",
    });
    expect(tokens.calls).toEqual([false, true]);
  });
});
