import type {
  FeishuConversationApi,
  FeishuHistoryMessage,
} from "@work-fabric/connector-feishu";
import type { RuntimeJsonObject } from "@work-fabric/agent-runtime-spi";

import type {
  ConversationCursorCodec,
} from "./conversation-cursor.js";
import type {
  FeishuCapabilityExecutionRequest,
  FeishuCapabilityOutcome,
} from "./contracts.js";

export interface FeishuMessageQueryExecutorDependencies {
  readonly api: FeishuConversationApi;
  readonly credential_ref: string;
  readonly cursors: ConversationCursorCodec;
  readonly now?: () => string;
}

interface TrustedSource {
  readonly uri: string;
  readonly external_tenant_id: string;
  readonly conversation_id: string;
  readonly trigger_message_id: string;
  readonly triggered_at: string;
  readonly thread_id?: string;
}

type SelectedMessage = RuntimeJsonObject & {
  readonly message_id: string;
  readonly sender: {
    readonly external_id: string;
    readonly sender_type: string;
  };
  readonly created_at: string;
  readonly content: {
    readonly media_type: "text/plain";
    readonly text: string;
  };
  readonly provenance: {
    readonly provider_family: "feishu";
    readonly source: "im.message";
    readonly updated: boolean;
  };
};

const LOOKBACK_SECONDS = 604_800;
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

function source(request: FeishuCapabilityExecutionRequest): TrustedSource | null {
  const reference = record(request.authority.source_reference);
  const extensions = record(reference?.extensions);
  const uri = text(reference?.uri, 2_048);
  if (
    uri === null ||
    !uri.startsWith("feishu://") ||
    extensions?.["workfabric.dev/provider_family"] !== "feishu" ||
    extensions["workfabric.dev/resource_kind"] !== "conversation_message"
  ) return null;
  const externalTenantId = text(
    extensions["workfabric.dev/external_tenant_id"],
    255,
  );
  const conversationId = text(
    extensions["workfabric.dev/conversation_id"],
    255,
  );
  const triggerMessageId = text(
    extensions["workfabric.dev/message_id"],
    255,
  );
  const triggeredAt = text(
    extensions["workfabric.dev/occurred_at"],
    64,
  );
  const threadId = extensions["workfabric.dev/thread_id"] === undefined
    ? undefined
    : text(extensions["workfabric.dev/thread_id"], 255);
  if (
    externalTenantId === null ||
    conversationId === null ||
    triggerMessageId === null ||
    triggeredAt === null ||
    !Number.isFinite(Date.parse(triggeredAt)) ||
    threadId === null
  ) return null;
  return Object.freeze({
    uri,
    external_tenant_id: externalTenantId,
    conversation_id: conversationId,
    trigger_message_id: triggerMessageId,
    triggered_at: triggeredAt,
    ...(threadId === undefined ? {} : { thread_id: threadId }),
  });
}

function input(value: unknown): {
  readonly maximum_messages: number;
  readonly cursor?: string;
} | null {
  const source = record(value);
  const conversation = record(source?.conversation);
  if (
    source === null ||
    conversation?.kind !== "current_conversation" ||
    Object.keys(conversation).length !== 1 ||
    Object.keys(source).some((key) =>
      !["conversation", "maximum_messages", "cursor"].includes(key)
    ) ||
    !Number.isSafeInteger(source.maximum_messages) ||
    (source.maximum_messages as number) < 1 ||
    (source.maximum_messages as number) > 50
  ) return null;
  const cursor = source.cursor === undefined
    ? undefined
    : text(source.cursor, 4_096);
  if (cursor === null) return null;
  return Object.freeze({
    maximum_messages: source.maximum_messages as number,
    ...(cursor === undefined ? {} : { cursor }),
  });
}

function plainText(content: string): string | null {
  try {
    const body = record(JSON.parse(content));
    const value = body?.text;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function richNodeText(value: unknown): string {
  const node = record(value);
  if (node === null) return "";
  if (
    (node.tag === "text" || node.tag === "a") &&
    typeof node.text === "string"
  ) return node.text;
  if (node.tag === "at" && typeof node.user_name === "string") {
    return `@${node.user_name}`;
  }
  return "";
}

function richText(content: string): string | null {
  try {
    let document = record(JSON.parse(content));
    if (document === null) return null;
    if (!Array.isArray(document.content)) {
      document = ["zh_cn", "en_us", "ja_jp"]
        .map((key) => record(document?.[key]))
        .find((candidate) => Array.isArray(candidate?.content)) ?? null;
    }
    if (document === null || !Array.isArray(document.content)) return null;
    const title = typeof document.title === "string"
      ? document.title.trim()
      : "";
    const blocks = document.content.flatMap((block) => {
      if (!Array.isArray(block)) return [];
      const value = block.map(richNodeText).join("").trim();
      return value.length === 0 ? [] : [value];
    });
    const value = [title, ...blocks].filter(Boolean).join("\n");
    return value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

function selected(
  message: FeishuHistoryMessage,
  source: TrustedSource,
): SelectedMessage | null {
  const created = Number(message.create_time);
  if (
    message.message_id === source.trigger_message_id ||
    message.deleted ||
    message.chat_id !== source.conversation_id ||
    !Number.isSafeInteger(created) ||
    created >= Date.parse(source.triggered_at) ||
    (
      source.thread_id !== undefined &&
      message.thread_id !== source.thread_id
    )
  ) return null;
  const decoded = message.msg_type === "text"
    ? plainText(message.body.content)
    : message.msg_type === "post"
      ? richText(message.body.content)
      : null;
  if (decoded === null) return null;
  return Object.freeze({
    message_id: message.message_id,
    sender: Object.freeze({
      external_id: message.sender.id,
      sender_type: message.sender.sender_type,
    }),
    created_at: new Date(created).toISOString(),
    content: Object.freeze({
      media_type: "text/plain" as const,
      text: decoded,
    }),
    provenance: Object.freeze({
      provider_family: "feishu" as const,
      source: "im.message" as const,
      updated: message.updated,
    }),
  });
}

function rejected(code: string): FeishuCapabilityOutcome {
  return {
    outcome: "rejected",
    code,
    message: "Feishu conversation history request was rejected",
    retryable: false,
  };
}

export class FeishuMessageQueryExecutor {
  private readonly now: () => string;

  constructor(
    private readonly dependencies: FeishuMessageQueryExecutorDependencies,
  ) {
    if (
      dependencies.credential_ref.length === 0 ||
      dependencies.credential_ref.length > 255
    ) throw new TypeError("credential_ref is invalid");
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async execute(
    request: FeishuCapabilityExecutionRequest,
  ): Promise<FeishuCapabilityOutcome> {
    if (request.capability_id !== "feishu.conversation.history.read") {
      return rejected("unsupported_capability");
    }
    const trustedSource = source(request);
    const query = input(request.input);
    if (
      trustedSource === null ||
      query === null ||
      !request.delegation_scopes.includes("conversation:read") ||
      request.tenant_id.length === 0 ||
      Date.parse(request.delegation_expires_at) <= Date.parse(this.now())
    ) return rejected("authority_denied");

    let nativePageToken: string | undefined;
    if (query.cursor !== undefined) {
      let decoded;
      try {
        decoded = this.dependencies.cursors.decode(query.cursor, {
          tenant_id: request.tenant_id,
          source_uri: trustedSource.uri,
        });
      } catch {
        return rejected("invalid_cursor");
      }
      if (
        decoded.conversation_id !== trustedSource.conversation_id ||
        decoded.trigger_message_id !== trustedSource.trigger_message_id ||
        decoded.trigger_time !== trustedSource.triggered_at
      ) return rejected("invalid_cursor");
      nativePageToken = decoded.native_page_token;
    }

    const trigger = Date.parse(trustedSource.triggered_at);
    const result = await this.dependencies.api.listMessages(
      trustedSource.thread_id === undefined
        ? {
            credential_ref: this.dependencies.credential_ref,
            container_type: "chat",
            container_id: trustedSource.conversation_id,
            start_time: Math.floor(
              (trigger - LOOKBACK_SECONDS * 1_000) / 1_000,
            ),
            end_time: Math.floor(trigger / 1_000),
            sort_type: "ByCreateTimeDesc",
            page_size: query.maximum_messages,
            ...(nativePageToken === undefined
              ? {}
              : { page_token: nativePageToken }),
          }
        : {
            credential_ref: this.dependencies.credential_ref,
            container_type: "thread",
            container_id: trustedSource.thread_id,
            sort_type: "ByCreateTimeDesc",
            page_size: query.maximum_messages,
            ...(nativePageToken === undefined
              ? {}
              : { page_token: nativePageToken }),
          },
    );
    if (result.kind !== "accepted") {
      return result.kind === "retryable_failure"
        ? {
            outcome: "failed",
            code: "feishu_history_temporarily_unavailable",
            message: "Feishu conversation history is temporarily unavailable",
            retryable: true,
          }
        : rejected("feishu_history_unavailable");
    }
    const messages = result.items
      .flatMap((message) => {
        const value = selected(message, trustedSource);
        return value === null ? [] : [value];
      })
      .sort((left, right) =>
        Date.parse(left.created_at) - Date.parse(right.created_at) ||
        left.message_id.localeCompare(right.message_id)
      );
    const oldestAt = messages[0]?.created_at;
    const newestAt = messages.at(-1)?.created_at;
    let nextCursor: string | undefined;
    if (result.has_more) {
      const expiresAt = new Date(Math.min(
        Date.parse(request.delegation_expires_at),
        Date.parse(this.now()) + CURSOR_LIFETIME_SECONDS * 1_000,
      )).toISOString();
      nextCursor = this.dependencies.cursors.encode({
        version: 1,
        tenant_id: request.tenant_id,
        source_uri: trustedSource.uri,
        conversation_id: trustedSource.conversation_id,
        trigger_message_id: trustedSource.trigger_message_id,
        trigger_time: trustedSource.triggered_at,
        native_page_token: result.next_page_token!,
        expires_at: expiresAt,
      });
    }
    const data: RuntimeJsonObject = {
      messages,
      has_more: result.has_more,
      ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
      coverage: {
        ...(newestAt === undefined ? {} : { newest_at: newestAt }),
        ...(oldestAt === undefined ? {} : { oldest_at: oldestAt }),
      },
      provenance: {
        provider_family: "feishu",
        source: "im.message",
        source_reference: trustedSource.uri,
      },
    };
    return {
      outcome: "succeeded",
      data,
      artifacts: [],
    };
  }
}
