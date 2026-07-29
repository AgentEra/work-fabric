import { describe, expect, it, vi } from "vitest";

import type {
  FeishuConversationApi,
  FeishuHistoryMessage,
} from "@work-fabric/connector-feishu";

import {
  FeishuMessageQueryExecutor,
  HmacConversationCursorCodec,
  type FeishuCapabilityExecutionRequest,
} from "../src/index.js";

function history(
  messageId: string,
  createdAt: string,
  overrides: Partial<FeishuHistoryMessage> = {},
): FeishuHistoryMessage {
  const timestamp = String(Date.parse(createdAt));
  return {
    message_id: messageId,
    msg_type: "text",
    create_time: timestamp,
    update_time: timestamp,
    deleted: false,
    updated: false,
    chat_id: "oc-chat-1",
    sender: {
      id: "ou-human-1",
      id_type: "open_id",
      sender_type: "user",
      tenant_key: "tenant-key-1",
    },
    body: { content: JSON.stringify({ text: messageId }) },
    ...overrides,
  };
}

function sourceReference(
  overrides: Record<string, unknown> = {},
) {
  return {
    uri: "feishu://tenant-key-1/message/om-trigger",
    extensions: {
      "workfabric.dev/provider_family": "feishu",
      "workfabric.dev/resource_kind": "conversation_message",
      "workfabric.dev/external_tenant_id": "tenant-key-1",
      "workfabric.dev/conversation_id": "oc-chat-1",
      "workfabric.dev/message_id": "om-trigger",
      "workfabric.dev/occurred_at": "2026-07-29T10:00:00.000Z",
      ...overrides,
    },
  };
}

function request(
  input: Record<string, unknown> = {
    conversation: { kind: "current_conversation" },
    maximum_messages: 20,
  },
  source = sourceReference(),
): FeishuCapabilityExecutionRequest {
  return {
    tenant_id: "tenant-1",
    original_handoff_id: "handoff-1",
    represented_actor_id: "actor-human-1",
    delegation_id: "delegation-query-1",
    delegation_scopes: ["conversation:read"],
    delegation_expires_at: "2026-07-29T10:30:00.000Z",
    invocation_id: "invocation-query-1",
    idempotency_key: "query-1",
    capability_id: "feishu.conversation.history.read",
    input,
    authority: {
      allowed_target_refs: [],
      confirmation_proof_refs: [],
      source_reference: source,
    },
  };
}

describe("FeishuMessageQueryExecutor", () => {
  it("returns typed first and continuation pages from the trusted source", async () => {
    const listMessages = vi.fn(async (input) => input.page_token === undefined
      ? {
          kind: "accepted" as const,
          items: [
            history("om-trigger", "2026-07-29T10:00:00.000Z"),
            history("om-future", "2026-07-29T10:00:01.000Z"),
            history("om-deleted", "2026-07-29T09:58:00.000Z", {
              deleted: true,
            }),
            history("om-cross-chat", "2026-07-29T09:57:00.000Z", {
              chat_id: "oc-other",
            }),
            history("om-newer", "2026-07-29T09:59:00.000Z"),
            history("om-older", "2026-07-29T09:40:00.000Z"),
          ],
          has_more: true,
          next_page_token: "native-page-2",
        }
      : {
          kind: "accepted" as const,
          items: [history("om-oldest", "2026-07-29T09:20:00.000Z")],
          has_more: false,
        });
    const api: FeishuConversationApi = {
      getMessage: vi.fn(),
      listMessages,
    };
    const executor = new FeishuMessageQueryExecutor({
      api,
      credential_ref: "feishu:primary",
      cursors: new HmacConversationCursorCodec({
        key: Buffer.from("0123456789abcdef0123456789abcdef"),
        now: () => "2026-07-29T10:00:00.000Z",
      }),
      now: () => "2026-07-29T10:00:00.000Z",
    });

    const first = await executor.execute(request());
    expect(first).toMatchObject({
      outcome: "succeeded",
      data: {
        messages: [
          { message_id: "om-older", content: { text: "om-older" } },
          { message_id: "om-newer", content: { text: "om-newer" } },
        ],
        has_more: true,
        next_cursor: expect.any(String),
        coverage: {
          newest_at: "2026-07-29T09:59:00.000Z",
          oldest_at: "2026-07-29T09:40:00.000Z",
        },
        provenance: {
          provider_family: "feishu",
          source: "im.message",
          source_reference:
            "feishu://tenant-key-1/message/om-trigger",
        },
      },
    });
    if (first.outcome !== "succeeded") throw new Error("expected success");
    const cursor = first.data.next_cursor;
    if (typeof cursor !== "string") throw new Error("expected cursor");

    const second = await executor.execute(request({
      conversation: { kind: "current_conversation" },
      maximum_messages: 20,
      cursor,
    }));
    expect(second).toMatchObject({
      outcome: "succeeded",
      data: {
        messages: [{ message_id: "om-oldest" }],
        has_more: false,
        coverage: {
          newest_at: "2026-07-29T09:20:00.000Z",
          oldest_at: "2026-07-29T09:20:00.000Z",
        },
      },
    });
    expect(listMessages).toHaveBeenNthCalledWith(1, {
      credential_ref: "feishu:primary",
      container_type: "chat",
      container_id: "oc-chat-1",
      start_time: Math.floor(Date.parse("2026-07-22T10:00:00.000Z") / 1_000),
      end_time: Math.floor(Date.parse("2026-07-29T10:00:00.000Z") / 1_000),
      sort_type: "ByCreateTimeDesc",
      page_size: 20,
    });
    expect(listMessages).toHaveBeenNthCalledWith(2, {
      credential_ref: "feishu:primary",
      container_type: "chat",
      container_id: "oc-chat-1",
      start_time: Math.floor(Date.parse("2026-07-22T10:00:00.000Z") / 1_000),
      end_time: Math.floor(Date.parse("2026-07-29T10:00:00.000Z") / 1_000),
      sort_type: "ByCreateTimeDesc",
      page_size: 20,
      page_token: "native-page-2",
    });
  });

  it("fails closed for missing scope, foreign sources and malformed message bodies", async () => {
    const api: FeishuConversationApi = {
      getMessage: vi.fn(),
      listMessages: vi.fn(async () => ({
        kind: "accepted" as const,
        items: [history("om-bad", "2026-07-29T09:59:00.000Z", {
          body: { content: "not-json" },
        })],
        has_more: false,
      })),
    };
    const executor = new FeishuMessageQueryExecutor({
      api,
      credential_ref: "feishu:primary",
      cursors: new HmacConversationCursorCodec({
        key: Buffer.from("0123456789abcdef0123456789abcdef"),
        now: () => "2026-07-29T10:00:00.000Z",
      }),
      now: () => "2026-07-29T10:00:00.000Z",
    });

    await expect(executor.execute({
      ...request(),
      delegation_scopes: ["document:read"],
    })).resolves.toMatchObject({
      outcome: "rejected",
      code: "authority_denied",
    });
    await expect(executor.execute(request(
      undefined,
      sourceReference({
        "workfabric.dev/provider_family": "email",
      }),
    ))).resolves.toMatchObject({
      outcome: "rejected",
      code: "authority_denied",
    });
    await expect(executor.execute(request())).resolves.toMatchObject({
      outcome: "succeeded",
      data: {
        messages: [],
        has_more: false,
      },
    });
  });
});
