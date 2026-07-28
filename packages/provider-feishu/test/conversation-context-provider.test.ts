import { describe, expect, it, vi } from "vitest";

import type { ConversationContextRequest } from "@work-fabric/channel-spi";
import type {
  FeishuConversationApi,
  FeishuHistoryMessage,
} from "@work-fabric/connector-feishu";

import { FeishuConversationContextProvider } from "../src/index.js";

const timestamp = (value: string) => String(Date.parse(value));

function history(
  message_id: string,
  created_at: string,
  overrides: Partial<FeishuHistoryMessage> = {},
): FeishuHistoryMessage {
  return {
    message_id,
    msg_type: "text",
    create_time: timestamp(created_at),
    update_time: timestamp(created_at),
    deleted: false,
    updated: false,
    chat_id: "oc-chat-1",
    sender: {
      id: "ou-human-1",
      id_type: "open_id",
      sender_type: "user",
      tenant_key: "tenant-key-1",
    },
    body: { content: JSON.stringify({ text: `message ${message_id}` }) },
    ...overrides,
  };
}

function request(
  overrides: Partial<ConversationContextRequest> = {},
): ConversationContextRequest {
  return {
    tenant_id: "tenant-1",
    provider_family: "feishu",
    external_tenant_id: "tenant-key-1",
    conversation_id: "oc-chat-1",
    trigger_message_id: "om-trigger",
    triggered_at: "2026-07-28T12:00:00.000Z",
    represented_actor_id: "actor-human-1",
    recipient_actor_id: "actor-assistant-1",
    recipient_endpoint_id: "endpoint-assistant-1",
    delegation_id: "delegation-1",
    delegation_scopes: ["conversation:read"],
    delegation_expires_at: "2026-07-28T13:00:00.000Z",
    policy: {
      lookback_seconds: 86_400,
      maximum_messages: 20,
      maximum_bytes: 65_536,
    },
    ...overrides,
  };
}

function api(items: readonly FeishuHistoryMessage[]): FeishuConversationApi {
  return {
    getMessage: vi.fn(async () => ({ kind: "accepted" as const, items: [] })),
    listMessages: vi.fn(async () => ({ kind: "accepted" as const, items })),
  };
}

describe("FeishuConversationContextProvider", () => {
  it("selects a 24-hour chat window, filters unsafe records and emits chronological context", async () => {
    const messages = api([
      history("om-trigger", "2026-07-28T12:00:00.000Z"),
      history("om-future", "2026-07-28T12:00:01.000Z"),
      history("om-deleted", "2026-07-28T11:30:00.000Z", { deleted: true }),
      history("om-image", "2026-07-28T11:20:00.000Z", {
        msg_type: "image",
        body: { content: "{\"image_key\":\"secret\"}" },
      }),
      history("om-cross-chat", "2026-07-28T11:10:00.000Z", {
        chat_id: "oc-other",
      }),
      history("om-post", "2026-07-28T11:00:00.000Z", {
        msg_type: "post",
        body: {
          content: JSON.stringify({
            title: "进展",
            content: [[
              { tag: "text", text: "第一项" },
              { tag: "a", text: "参考", href: "https://secret.invalid" },
            ]],
          }),
        },
      }),
      history("om-text", "2026-07-28T10:00:00.000Z"),
      history("om-malformed", "2026-07-28T09:00:00.000Z", {
        body: { content: "not-json" },
      }),
    ]);
    const provider = new FeishuConversationContextProvider({
      api: messages,
      credential_ref: "feishu:primary",
      now: () => "2026-07-28T12:00:00.000Z",
    });

    const result = await provider.materialize(
      request(),
      new AbortController().signal,
    );

    expect(messages.listMessages).toHaveBeenCalledWith({
      credential_ref: "feishu:primary",
      container_type: "chat",
      container_id: "oc-chat-1",
      start_time: 1785153600,
      end_time: 1785240000,
      sort_type: "ByCreateTimeDesc",
      page_size: 20,
    });
    expect(result).toMatchObject({
      kind: "materialized",
      bundle: {
        version: 1,
        created_at: "2026-07-28T12:00:00.000Z",
        visibility_scope: {
          actor_ids: ["actor-assistant-1"],
          endpoint_ids: ["endpoint-assistant-1"],
          expires_at: "2026-07-28T13:00:00.000Z",
        },
        items: [
          {
            kind: "fact",
            data: {
              fact: "conversation_history",
              source_mode: "chat",
              selected_message_count: 2,
            },
          },
          {
            kind: "data",
            data: {
              message_id: "om-text",
              content: {
                media_type: "text/plain",
                text: "message om-text",
              },
            },
          },
          {
            kind: "data",
            data: {
              message_id: "om-post",
              content: {
                media_type: "text/plain",
                text: "进展\n第一项参考",
              },
            },
          },
        ],
        extensions: {
          "workfabric.dev/context_kind": "conversation_history",
          "workfabric.dev/provider_family": "feishu",
          "workfabric.dev/trigger_message_id": "om-trigger",
        },
      },
    });
    if (result.kind !== "materialized") throw new Error("expected materialized");
    expect(result.bundle.context_id).toMatch(/^context_feishu_[a-f0-9]{64}$/);
    expect(result.bundle.digest).toMatchObject({
      algorithm: "sha-256",
      value: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(result)).not.toContain("secret.invalid");
  });

  it("uses thread history directly and keeps only matching thread evidence", async () => {
    const messages = api([
      history("om-thread-2", "2026-07-28T11:30:00.000Z", {
        thread_id: "omt-thread-1",
      }),
      history("om-wrong-thread", "2026-07-28T11:00:00.000Z", {
        thread_id: "omt-other",
      }),
      history("om-root", "2026-07-28T10:00:00.000Z", {
        root_id: "om-root",
        thread_id: "omt-thread-1",
      }),
    ]);
    const provider = new FeishuConversationContextProvider({
      api: messages,
      credential_ref: "feishu:primary",
      now: () => "2026-07-28T12:00:00.000Z",
    });

    const result = await provider.materialize(request({
      thread_id: "omt-thread-1",
      root_message_id: "om-root",
      policy: {
        lookback_seconds: 86_400,
        maximum_messages: 2,
        maximum_bytes: 65_536,
      },
    }), new AbortController().signal);

    expect(messages.listMessages).toHaveBeenCalledWith({
      credential_ref: "feishu:primary",
      container_type: "thread",
      container_id: "omt-thread-1",
      sort_type: "ByCreateTimeDesc",
      page_size: 2,
    });
    expect(result).toMatchObject({
      kind: "materialized",
      bundle: {
        items: [
          { data: { source_mode: "thread", selected_message_count: 2 } },
          { data: { message_id: "om-root", thread_id: "omt-thread-1" } },
          { data: { message_id: "om-thread-2", thread_id: "omt-thread-1" } },
        ],
      },
    });
  });

  it("enforces the final bundle byte ceiling by dropping the oldest messages", async () => {
    const messages = api([
      history("om-new", "2026-07-28T11:30:00.000Z", {
        body: { content: JSON.stringify({ text: "n".repeat(500) }) },
      }),
      history("om-old", "2026-07-28T11:00:00.000Z", {
        body: { content: JSON.stringify({ text: "o".repeat(500) }) },
      }),
    ]);
    const provider = new FeishuConversationContextProvider({
      api: messages,
      credential_ref: "feishu:primary",
      now: () => "2026-07-28T12:00:00.000Z",
    });

    const result = await provider.materialize(request({
      policy: {
        lookback_seconds: 86_400,
        maximum_messages: 20,
        maximum_bytes: 2_000,
      },
    }), new AbortController().signal);

    expect(result.kind).toBe("materialized");
    if (result.kind !== "materialized") throw new Error("expected materialized");
    expect(new TextEncoder().encode(JSON.stringify(result.bundle)).byteLength)
      .toBeLessThanOrEqual(2_000);
    expect(result.bundle.items).toMatchObject([
      { data: { truncated: true, selected_message_count: 1 } },
      { data: { message_id: "om-new" } },
    ]);
  });

  it("returns an explicit empty-history fact and a deterministic body", async () => {
    const provider = new FeishuConversationContextProvider({
      api: api([]),
      credential_ref: "feishu:primary",
      now: () => "2026-07-28T12:00:00.000Z",
    });
    const signal = new AbortController().signal;

    const first = await provider.materialize(request(), signal);
    const second = await provider.materialize(request(), signal);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: "materialized",
      bundle: {
        items: [{
          kind: "fact",
          data: {
            fact: "empty_history",
            selected_message_count: 0,
          },
        }],
      },
    });
  });

  it("maps transport failures and rejects invalid Authority before OpenAPI access", async () => {
    const temporaryApi: FeishuConversationApi = {
      getMessage: vi.fn(),
      listMessages: vi.fn(async () => ({
        kind: "retryable_failure" as const,
        error_code: "http_503",
      })),
    };
    const provider = new FeishuConversationContextProvider({
      api: temporaryApi,
      credential_ref: "feishu:primary",
      now: () => "2026-07-28T12:00:00.000Z",
    });
    await expect(provider.materialize(
      request(),
      new AbortController().signal,
    )).resolves.toEqual({
      kind: "temporarily_unavailable",
      code: "feishu_history_temporarily_unavailable",
    });

    const deniedApi = api([]);
    const denied = new FeishuConversationContextProvider({
      api: deniedApi,
      credential_ref: "feishu:primary",
      now: () => "2026-07-28T12:00:00.000Z",
    });
    await expect(denied.materialize(request({
      delegation_scopes: ["work:read"],
    }), new AbortController().signal)).resolves.toEqual({
      kind: "permanently_unavailable",
      code: "conversation_context_authority_denied",
    });
    expect(deniedApi.listMessages).not.toHaveBeenCalled();
  });
});
