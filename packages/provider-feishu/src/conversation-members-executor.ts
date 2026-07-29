import type { RuntimeJsonObject } from "@work-fabric/agent-runtime-spi";

import type {
  ConversationCursorCodec,
} from "./conversation-cursor.js";
import {
  FeishuProviderBackendError,
  type FeishuCapabilityExecutionRequest,
  type FeishuCapabilityOutcome,
} from "./contracts.js";

export interface FeishuConversationMembersClient {
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
}

export interface FeishuConversationMembersExecutorDependencies {
  readonly client: FeishuConversationMembersClient;
  readonly cursors: ConversationCursorCodec;
  readonly now?: () => string;
}

const CURSOR_LIFETIME_SECONDS = 600;

function record(value: unknown): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number): string | null {
  return typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximum &&
      value.trim() === value
    ? value
    : null;
}

function chatReference(chatId: string): string {
  return `feishu://chat/${encodeURIComponent(chatId)}`;
}

function parseChatReference(value: unknown): {
  readonly chat_id: string;
  readonly resource_uri: string;
} | null {
  const resourceUri = text(value, 2_048);
  if (resourceUri === null) return null;
  let url: URL;
  try {
    url = new URL(resourceUri);
  } catch {
    return null;
  }
  if (
    url.protocol !== "feishu:" ||
    url.hostname !== "chat" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith("/") ||
    url.pathname.slice(1).includes("/")
  ) return null;
  let chatId: string;
  try {
    chatId = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
  if (
    chatId.length === 0 ||
    chatId.length > 255 ||
    chatId.trim() !== chatId ||
    chatReference(chatId) !== resourceUri
  ) return null;
  return { chat_id: chatId, resource_uri: resourceUri };
}

function currentConversation(
  request: FeishuCapabilityExecutionRequest,
): {
  readonly chat_id: string;
  readonly resource_uri: string;
} | null {
  const source = record(request.authority.source_reference);
  const extensions = record(source?.extensions);
  if (
    extensions?.["workfabric.dev/provider_family"] !== "feishu" ||
    extensions["workfabric.dev/resource_kind"] !== "conversation_message"
  ) return null;
  const chatId = text(
    extensions["workfabric.dev/conversation_id"],
    255,
  );
  return chatId === null
    ? null
    : { chat_id: chatId, resource_uri: chatReference(chatId) };
}

function input(
  request: FeishuCapabilityExecutionRequest,
): {
  readonly chat_id: string;
  readonly resource_uri: string;
  readonly page_size: number;
  readonly cursor?: string;
} | null {
  const value = record(request.input);
  const conversation = record(value?.conversation);
  if (
    value === null ||
    conversation === null ||
    Object.keys(value).some((key) =>
      !["conversation", "page_size", "cursor"].includes(key)
    ) ||
    !Number.isSafeInteger(value.page_size) ||
    (value.page_size as number) < 1 ||
    (value.page_size as number) > 100
  ) return null;
  let selected;
  if (
    conversation.kind === "current_conversation" &&
    Object.keys(conversation).length === 1
  ) {
    selected = currentConversation(request);
  } else if (
    conversation.kind === "resource_reference" &&
    Object.keys(conversation).length === 2
  ) {
    selected = parseChatReference(conversation.resource_uri);
  } else {
    return null;
  }
  const cursor = value.cursor === undefined
    ? undefined
    : text(value.cursor, 4_096);
  if (selected === null || cursor === null) return null;
  return {
    ...selected,
    page_size: value.page_size as number,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function rejected(code: string, message: string): FeishuCapabilityOutcome {
  return {
    outcome: "rejected",
    code,
    message,
    retryable: false,
  };
}

export class FeishuConversationMembersExecutor {
  private readonly now: () => string;

  constructor(
    private readonly dependencies:
      FeishuConversationMembersExecutorDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async execute(
    request: FeishuCapabilityExecutionRequest,
  ): Promise<FeishuCapabilityOutcome> {
    if (request.capability_id !== "feishu.conversation.members.list") {
      return rejected(
        "unsupported_capability",
        "Feishu conversation member capability is unavailable",
      );
    }
    const selected = input(request);
    if (selected === null) {
      return rejected("invalid_input", "Conversation member input is invalid");
    }
    if (
      !request.delegation_scopes.includes("conversation:members:read") ||
      Date.parse(request.delegation_expires_at) <= Date.parse(this.now())
    ) {
      return rejected(
        "scope_not_granted",
        "Conversation members scope is absent",
      );
    }
    if (
      !request.authority.allowed_target_refs.includes(
        selected.resource_uri,
      )
    ) {
      return rejected(
        "target_not_allowed",
        "Conversation is not authorized",
      );
    }

    let nativePageToken: string | undefined;
    if (selected.cursor !== undefined) {
      try {
        const cursor = this.dependencies.cursors.decode(selected.cursor, {
          tenant_id: request.tenant_id,
          source_uri: selected.resource_uri,
        });
        if (
          cursor.conversation_id !== selected.chat_id ||
          cursor.trigger_message_id !== request.original_handoff_id ||
          cursor.trigger_time !== request.delegation_expires_at
        ) {
          return rejected("invalid_cursor", "Conversation cursor is invalid");
        }
        nativePageToken = cursor.native_page_token;
      } catch {
        return rejected("invalid_cursor", "Conversation cursor is invalid");
      }
    }

    try {
      const result = await this.dependencies.client.list({
        chat_id: selected.chat_id,
        page_size: selected.page_size,
        ...(nativePageToken === undefined
          ? {}
          : { page_token: nativePageToken }),
        ...(request.signal === undefined
          ? {}
          : { signal: request.signal }),
      });
      if (
        result.members.length > selected.page_size ||
        (
          result.has_more &&
          (
            typeof result.next_page_token !== "string" ||
            result.next_page_token.length === 0
          )
        )
      ) {
        throw new FeishuProviderBackendError(
          "feishu_response_invalid",
          true,
        );
      }
      const members = result.members
        .map((member) => ({
          resource_uri:
            `feishu://user/open-id/${encodeURIComponent(member.open_id)}`,
          ...(member.display_name === undefined
            ? {}
            : { display_name: member.display_name }),
        }))
        .sort((left, right) =>
          left.resource_uri.localeCompare(right.resource_uri)
        );
      let nextCursor: string | undefined;
      if (result.has_more) {
        const expiresAt = new Date(Math.min(
          Date.parse(request.delegation_expires_at),
          Date.parse(this.now()) + CURSOR_LIFETIME_SECONDS * 1_000,
        )).toISOString();
        nextCursor = this.dependencies.cursors.encode({
          version: 1,
          tenant_id: request.tenant_id,
          source_uri: selected.resource_uri,
          conversation_id: selected.chat_id,
          trigger_message_id: request.original_handoff_id,
          trigger_time: request.delegation_expires_at,
          native_page_token: result.next_page_token!,
          expires_at: expiresAt,
        });
      }
      const data: RuntimeJsonObject = {
        members,
        has_more: result.has_more,
        ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
        provenance: {
          provider_family: "feishu",
          source: "im.chat.members",
          source_reference: selected.resource_uri,
        },
      };
      return { outcome: "succeeded", data, artifacts: [] };
    } catch (error) {
      if (error instanceof FeishuProviderBackendError) {
        return {
          outcome: "failed",
          code: error.code,
          message: "Feishu conversation members request failed",
          retryable: error.retryable,
          ...(error.retry_after === undefined
            ? {}
            : { retry_after: error.retry_after }),
        };
      }
      return {
        outcome: "failed",
        code: "feishu_temporarily_unavailable",
        message: "Feishu conversation members request failed",
        retryable: true,
      };
    }
  }
}
