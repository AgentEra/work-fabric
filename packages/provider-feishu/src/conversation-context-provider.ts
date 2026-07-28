import { createHash } from "node:crypto";

import type {
  ConversationContextMaterialization,
  ConversationContextMaterializer,
  ConversationContextRequest,
} from "@work-fabric/channel-spi";
import type {
  FeishuConversationApi,
  FeishuHistoryMessage,
} from "@work-fabric/connector-feishu";
import type { JsonObject, JsonValue } from "@work-fabric/exchange-spi";

export interface FeishuConversationContextProviderDependencies {
  readonly api: FeishuConversationApi;
  readonly credential_ref: string;
  readonly now?: () => string;
}

interface SelectedMessage {
  readonly message_id: string;
  readonly conversation_id: string;
  readonly thread_id?: string;
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
    readonly external_tenant_id: string;
    readonly updated: boolean;
  };
}

const encoder = new TextEncoder();

function bounded(value: unknown, field: string, maximum = 255): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new RangeError(`${field} is invalid`);
  }
  return value as number;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== "string") throw new TypeError(`${field} is invalid`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} is invalid`);
  return parsed;
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(object[key] as JsonValue)}`
  ).join(",")}}`;
}

function sha256(value: JsonValue): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function plainText(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) return null;
    const text = (parsed as Record<string, unknown>).text;
    if (typeof text !== "string" || text.length === 0) return null;
    return text;
  } catch {
    return null;
  }
}

function richNodeText(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const node = value as Record<string, unknown>;
  if (
    (node.tag === "text" || node.tag === "a") &&
    typeof node.text === "string"
  ) return node.text;
  if (node.tag === "at" && typeof node.user_name === "string") {
    return `@${node.user_name}`;
  }
  return "";
}

function richDocument(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  let document = value as Record<string, unknown>;
  if (!Array.isArray(document.content)) {
    const localized = ["zh_cn", "en_us", "ja_jp"]
      .map((key) => document[key])
      .find((item) =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        Array.isArray((item as Record<string, unknown>).content)
      );
    if (localized === undefined) return null;
    document = localized as Record<string, unknown>;
  }
  const title = typeof document.title === "string"
    ? document.title.trim()
    : "";
  const blocks = (document.content as unknown[]).flatMap((block) => {
    if (!Array.isArray(block)) return [];
    const text = block.map(richNodeText).join("").trim();
    return text.length === 0 ? [] : [text];
  });
  const text = [title, ...blocks].filter((item) => item.length > 0).join("\n");
  return text.length === 0 ? null : text;
}

function decodedText(message: FeishuHistoryMessage): string | null {
  if (message.msg_type === "text") return plainText(message.body.content);
  if (message.msg_type !== "post") return null;
  try {
    return richDocument(JSON.parse(message.body.content));
  } catch {
    return null;
  }
}

function selectedMessage(
  message: FeishuHistoryMessage,
  request: ConversationContextRequest,
  triggerTime: number,
): SelectedMessage | null {
  if (
    message.message_id === request.trigger_message_id ||
    message.deleted ||
    message.chat_id !== request.conversation_id
  ) return null;
  const created = Number(message.create_time);
  if (!Number.isSafeInteger(created) || created >= triggerTime) return null;
  if (
    request.thread_id !== undefined &&
    message.thread_id !== request.thread_id
  ) return null;
  const text = decodedText(message);
  if (text === null || text.length === 0) return null;
  return {
    message_id: message.message_id,
    conversation_id: request.conversation_id,
    ...(message.thread_id === undefined ? {} : { thread_id: message.thread_id }),
    sender: {
      external_id: message.sender.id,
      sender_type: message.sender.sender_type,
    },
    created_at: new Date(created).toISOString(),
    content: { media_type: "text/plain", text },
    provenance: {
      provider_family: "feishu",
      source: "im.message",
      external_tenant_id: request.external_tenant_id,
      updated: message.updated,
    },
  };
}

function messageItem(message: SelectedMessage): JsonObject {
  return {
    kind: "data",
    schema_ref: "urn:work-fabric:schema:conversation-message:1",
    data: message as unknown as JsonObject,
  };
}

function contextSeed(request: ConversationContextRequest): JsonObject {
  return {
    tenant_id: request.tenant_id,
    provider_family: request.provider_family,
    external_tenant_id: request.external_tenant_id,
    conversation_id: request.conversation_id,
    trigger_message_id: request.trigger_message_id,
    thread_id: request.thread_id ?? null,
    recipient_actor_id: request.recipient_actor_id,
    recipient_endpoint_id: request.recipient_endpoint_id,
    delegation_id: request.delegation_id,
    delegation_expires_at: request.delegation_expires_at,
    policy: request.policy,
  };
}

function bundleWithoutDigest(
  request: ConversationContextRequest,
  selected: readonly SelectedMessage[],
  truncated: boolean,
): JsonObject {
  const sourceMode = request.thread_id === undefined ? "chat" : "thread";
  const fact = selected.length === 0 ? "empty_history" : "conversation_history";
  return {
    context_id: `context_feishu_${sha256(contextSeed(request))}`,
    version: 1,
    created_at: request.triggered_at,
    items: [
      {
        kind: "data",
        schema_ref: "urn:work-fabric:schema:conversation-history-fact:1",
        data: {
          fact,
          source_mode: sourceMode,
          selected_message_count: selected.length,
          truncated,
          lookback_seconds: request.policy.lookback_seconds,
          maximum_messages: request.policy.maximum_messages,
        },
      },
      ...selected.map(messageItem),
    ],
    visibility_scope: {
      actor_ids: [request.recipient_actor_id],
      endpoint_ids: [request.recipient_endpoint_id],
      expires_at: request.delegation_expires_at,
    },
    extensions: {
      "workfabric.dev/context_kind": "conversation_history",
      "workfabric.dev/provider_family": "feishu",
      "workfabric.dev/trigger_message_id": request.trigger_message_id,
    },
  };
}

function finalBundle(body: JsonObject): JsonObject {
  return {
    ...body,
    digest: {
      algorithm: "sha-256",
      value: sha256(body),
    },
  };
}

function validate(
  request: ConversationContextRequest,
  now: string,
): void {
  bounded(request.tenant_id, "tenant_id", 128);
  if (request.provider_family !== "feishu") {
    throw new TypeError("provider_family is invalid");
  }
  bounded(request.external_tenant_id, "external_tenant_id");
  bounded(request.conversation_id, "conversation_id");
  bounded(request.trigger_message_id, "trigger_message_id");
  if (request.thread_id !== undefined) bounded(request.thread_id, "thread_id");
  if (request.root_message_id !== undefined) {
    bounded(request.root_message_id, "root_message_id");
  }
  bounded(request.represented_actor_id, "represented_actor_id", 128);
  bounded(request.recipient_actor_id, "recipient_actor_id", 128);
  bounded(request.recipient_endpoint_id, "recipient_endpoint_id", 128);
  bounded(request.delegation_id, "delegation_id", 128);
  const trigger = timestamp(request.triggered_at, "triggered_at");
  const expiry = timestamp(
    request.delegation_expires_at,
    "delegation_expires_at",
  );
  if (expiry <= timestamp(now, "now") || trigger >= expiry) {
    throw new TypeError("delegation is expired");
  }
  if (
    !Array.isArray(request.delegation_scopes) ||
    !request.delegation_scopes.includes("conversation:read")
  ) {
    throw new TypeError("conversation context Authority denied");
  }
  positiveInteger(
    request.policy.lookback_seconds,
    "lookback_seconds",
    60,
    604_800,
  );
  positiveInteger(
    request.policy.maximum_messages,
    "maximum_messages",
    1,
    50,
  );
  positiveInteger(
    request.policy.maximum_bytes,
    "maximum_bytes",
    1_024,
    131_072,
  );
}

export class FeishuConversationContextProvider
  implements ConversationContextMaterializer {
  private readonly now: () => string;

  constructor(
    private readonly dependencies:
      FeishuConversationContextProviderDependencies,
  ) {
    bounded(dependencies.credential_ref, "credential_ref");
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async materialize(
    request: ConversationContextRequest,
    signal: AbortSignal,
  ): Promise<ConversationContextMaterialization> {
    try {
      validate(request, this.now());
    } catch {
      return {
        kind: "permanently_unavailable",
        code: "conversation_context_authority_denied",
      };
    }
    if (signal.aborted) {
      return {
        kind: "temporarily_unavailable",
        code: "conversation_context_cancelled",
      };
    }
    const triggerTime = Date.parse(request.triggered_at);
    const result = request.thread_id === undefined
      ? await this.dependencies.api.listMessages({
          credential_ref: this.dependencies.credential_ref,
          container_type: "chat",
          container_id: request.conversation_id,
          start_time: Math.floor(
            (triggerTime - request.policy.lookback_seconds * 1_000) / 1_000,
          ),
          end_time: Math.floor(triggerTime / 1_000),
          sort_type: "ByCreateTimeDesc",
          page_size: request.policy.maximum_messages,
        })
      : await this.dependencies.api.listMessages({
          credential_ref: this.dependencies.credential_ref,
          container_type: "thread",
          container_id: request.thread_id,
          sort_type: "ByCreateTimeDesc",
          page_size: request.policy.maximum_messages,
        });
    if (result.kind !== "accepted") {
      return result.kind === "retryable_failure"
        ? {
            kind: "temporarily_unavailable",
            code: "feishu_history_temporarily_unavailable",
          }
        : {
            kind: "permanently_unavailable",
            code: "feishu_history_unavailable",
          };
    }
    if (signal.aborted) {
      return {
        kind: "temporarily_unavailable",
        code: "conversation_context_cancelled",
      };
    }
    const eligible = result.items
      .flatMap((item) => {
        const value = selectedMessage(item, request, triggerTime);
        return value === null ? [] : [value];
      })
      .sort((left, right) =>
        Date.parse(left.created_at) - Date.parse(right.created_at) ||
        left.message_id.localeCompare(right.message_id)
      );
    const selected = eligible.slice(-request.policy.maximum_messages);
    let retained = [...selected];
    let truncated = selected.length < eligible.length;
    let bundle = finalBundle(bundleWithoutDigest(request, retained, truncated));
    while (
      retained.length > 0 &&
      encoder.encode(JSON.stringify(bundle)).byteLength >
        request.policy.maximum_bytes
    ) {
      retained.shift();
      truncated = true;
      bundle = finalBundle(bundleWithoutDigest(request, retained, truncated));
    }
    if (
      encoder.encode(JSON.stringify(bundle)).byteLength >
      request.policy.maximum_bytes
    ) {
      return {
        kind: "permanently_unavailable",
        code: "conversation_context_too_large",
      };
    }
    return {
      kind: "materialized",
      bundle: deepFreeze(bundle),
    };
  }
}
