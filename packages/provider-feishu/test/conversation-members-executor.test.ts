import { describe, expect, it, vi } from "vitest";

import type {
  FeishuCapabilityExecutionRequest,
  FeishuCapabilityOutcome,
} from "../src/index.js";
import * as provider from "../src/index.js";

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

type MembersExecutor = {
  execute(request: FeishuCapabilityExecutionRequest):
    Promise<FeishuCapabilityOutcome>;
};

type MembersExecutorConstructor = new (input: {
  readonly client: MembersClient;
  readonly cursors: {
    encode(payload: Record<string, unknown>): string;
    decode(
      cursor: string,
      binding: Record<string, unknown>,
    ): Record<string, unknown>;
  };
  readonly now?: () => string;
}) => MembersExecutor;

function constructor(): MembersExecutorConstructor | undefined {
  const value = (provider as Record<string, unknown>)[
    "FeishuConversationMembersExecutor"
  ];
  return typeof value === "function"
    ? value as MembersExecutorConstructor
    : undefined;
}

function request(
  input: Record<string, unknown> = {
    conversation: { kind: "current_conversation" },
    page_size: 50,
  },
  allowedTargetRefs: readonly string[] = ["feishu://chat/oc-chat-1"],
): FeishuCapabilityExecutionRequest {
  return {
    tenant_id: "tenant-1",
    original_handoff_id: "handoff-1",
    represented_actor_id: "actor-human-1",
    delegation_id: "delegation-members-1",
    delegation_scopes: ["conversation_members:read"],
    delegation_expires_at: "2026-07-29T10:30:00.000Z",
    invocation_id: "invocation-members-1",
    idempotency_key: "members-1",
    capability_id: "feishu.conversation.members.list",
    input,
    authority: {
      allowed_target_refs: allowedTargetRefs,
      confirmation_proof_refs: [],
      source_reference: {
        uri: "feishu://tenant-key-1/message/om-trigger",
        extensions: {
          "workfabric.dev/provider_family": "feishu",
          "workfabric.dev/resource_kind": "conversation_message",
          "workfabric.dev/external_tenant_id": "tenant-key-1",
          "workfabric.dev/conversation_id": "oc-chat-1",
          "workfabric.dev/message_id": "om-trigger",
          "workfabric.dev/occurred_at": "2026-07-29T10:00:00.000Z",
        },
      },
    },
  };
}

describe("FeishuConversationMembersExecutor", () => {
  it("is exposed as a Message-owned capability executor", () => {
    expect(constructor()).toBeTypeOf("function");
  });

  it("returns an ordered bounded member page for the authorized current conversation", async () => {
    const Constructor = constructor();
    if (Constructor === undefined) return;
    const list = vi.fn(async () => ({
      members: [
        { open_id: "ou_2", display_name: "乙" },
        { open_id: "ou_1", display_name: "甲" },
      ],
      next_page_token: "native-page-2",
      has_more: true,
    }));
    const encode = vi.fn(() => "opaque-members-cursor");
    const executor = new Constructor({
      client: { list },
      cursors: {
        encode,
        decode: vi.fn(),
      },
      now: () => "2026-07-29T10:00:00.000Z",
    });

    await expect(executor.execute(request())).resolves.toEqual({
      outcome: "succeeded",
      data: {
        members: [
          {
            resource_uri: "feishu://user/open-id/ou_1",
            display_name: "甲",
          },
          {
            resource_uri: "feishu://user/open-id/ou_2",
            display_name: "乙",
          },
        ],
        has_more: true,
        next_cursor: "opaque-members-cursor",
        provenance: {
          provider_family: "feishu",
          source: "im.chat.members",
          source_reference: "feishu://chat/oc-chat-1",
        },
      },
      artifacts: [],
    });
    expect(list).toHaveBeenCalledWith({
      chat_id: "oc-chat-1",
      page_size: 50,
      signal: undefined,
    });
    expect(encode).toHaveBeenCalledWith({
      version: 1,
      tenant_id: "tenant-1",
      source_uri: "feishu://chat/oc-chat-1",
      conversation_id: "oc-chat-1",
      trigger_message_id: "handoff-1",
      trigger_time: "2026-07-29T10:30:00.000Z",
      native_page_token: "native-page-2",
      expires_at: "2026-07-29T10:10:00.000Z",
    });
  });

  it("rejects a referenced chat outside capability Authority", async () => {
    const Constructor = constructor();
    if (Constructor === undefined) return;
    const list = vi.fn();
    const executor = new Constructor({
      client: { list },
      cursors: {
        encode: vi.fn(),
        decode: vi.fn(),
      },
      now: () => "2026-07-29T10:00:00.000Z",
    });

    await expect(executor.execute(request({
      conversation: {
        kind: "resource_reference",
        resource_uri: "feishu://chat/chat-2",
      },
      page_size: 50,
    }, ["feishu://chat/chat-1"]))).resolves.toMatchObject({
      outcome: "rejected",
      code: "target_not_allowed",
      retryable: false,
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects a malformed continuation cursor before calling Feishu", async () => {
    const Constructor = constructor();
    if (Constructor === undefined) return;
    const list = vi.fn();
    const executor = new Constructor({
      client: { list },
      cursors: {
        encode: vi.fn(),
        decode: vi.fn(() => {
          throw new TypeError("invalid cursor");
        }),
      },
      now: () => "2026-07-29T10:00:00.000Z",
    });

    await expect(executor.execute(request({
      conversation: { kind: "current_conversation" },
      page_size: 50,
      cursor: "tampered",
    }))).resolves.toMatchObject({
      outcome: "rejected",
      code: "invalid_cursor",
    });
    expect(list).not.toHaveBeenCalled();
  });
});
