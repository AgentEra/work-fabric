import { createHash } from "node:crypto";

import type { ConnectorIngressEnvelope } from "@work-fabric/connector-spi";
import { parseUtcTimestamp, type JsonObject, type JsonValue } from "@work-fabric/exchange-spi";

import type { FeishuIngressScope } from "./config.js";

export class FeishuIngressError extends TypeError {
  constructor(
    readonly code:
      | "invalid_event"
      | "tenant_mismatch"
      | "unsupported_event_type",
    message: string,
  ) {
    super(message);
  }
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FeishuIngressError("invalid_event", `${label} is required`);
  }
  return value as JsonObject;
}

function string(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 262_144) {
    throw new FeishuIngressError("invalid_event", `${label} is invalid`);
  }
  return value;
}

function optionalString(value: JsonValue | undefined, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}

function mentions(value: JsonValue | undefined): readonly JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new FeishuIngressError("invalid_event", "mentions is invalid");
  }
  return value.map((item, index) => {
    const mention = object(item, `mentions[${index}]`);
    const id = object(mention.id, `mentions[${index}].id`);
    return {
      key: string(mention.key, `mentions[${index}].key`),
      open_id: string(id.open_id, `mentions[${index}].id.open_id`),
    };
  });
}

function occurredAt(header: JsonObject, fallback: string): string {
  const value = header.create_time;
  if (value === undefined) return fallback;
  const milliseconds =
    typeof value === "string"
      ? Number(value)
      : typeof value === "number"
        ? value
        : Number.NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new FeishuIngressError("invalid_event", "create_time is invalid");
  }
  return new Date(milliseconds).toISOString();
}

function messageEnvelope(
  header: JsonObject,
  event: JsonObject,
  scope: FeishuIngressScope,
): ConnectorIngressEnvelope {
  const message = object(event.message, "event.message");
  const sender = object(event.sender, "event.sender");
  const senderId = object(sender.sender_id, "event.sender.sender_id");
  const messageId = string(message.message_id, "message_id");
  const chatId = string(message.chat_id, "chat_id");
  const eventTime = occurredAt(header, scope.received_at);
  const rootId = optionalString(message.root_id, "root_id");
  const parentId = optionalString(message.parent_id, "parent_id");
  return {
    tenant_id: scope.tenant_id,
    connector_id: scope.connector_id,
    source_system: "feishu",
    external_tenant_id: scope.expected_external_tenant_id,
    external_event_id: string(header.event_id, "event_id"),
    dedupe_key: `message:${messageId}`,
    event_type: "im.message.receive_v1",
    partition_key: `chat:${chatId}`,
    occurred_at: eventTime,
    received_at: eventTime,
    payload: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: string(message.chat_type, "chat_type"),
      message_type: string(message.message_type, "message_type"),
      content: string(message.content, "content"),
      sender_open_id: string(senderId.open_id, "sender open_id"),
      sender_type: string(sender.sender_type, "sender_type"),
      mentions: mentions(message.mentions),
      ...(rootId === undefined ? {} : { root_id: rootId }),
      ...(parentId === undefined ? {} : { parent_id: parentId }),
    },
    trace_context: {
      correlation_id: string(header.event_id, "event_id"),
    },
  };
}

function cardEnvelope(
  header: JsonObject,
  event: JsonObject,
  scope: FeishuIngressScope,
): ConnectorIngressEnvelope {
  const operator = object(event.operator, "event.operator");
  const operatorId = object(operator.operator_id, "event.operator.operator_id");
  const action = object(event.action, "event.action");
  const value = object(action.value, "event.action.value");
  const context = object(event.context, "event.context");
  const eventId = string(header.event_id, "event_id");
  const eventTime = occurredAt(header, scope.received_at);
  const actionRef = string(value.action_ref, "action_ref");
  const messageId = string(context.open_message_id, "open_message_id");
  const actionDigest = createHash("sha256").update(actionRef).digest("hex");
  return {
    tenant_id: scope.tenant_id,
    connector_id: scope.connector_id,
    source_system: "feishu",
    external_tenant_id: scope.expected_external_tenant_id,
    external_event_id: eventId,
    dedupe_key: `card:${eventId}:${actionDigest}`,
    event_type: "card.action.trigger",
    partition_key: `message:${messageId}`,
    occurred_at: eventTime,
    received_at: eventTime,
    payload: {
      operator_open_id: string(operatorId.open_id, "operator open_id"),
      action_ref: actionRef,
      message_id: messageId,
      action_tag: string(action.tag, "action tag"),
    },
    trace_context: { correlation_id: eventId },
  };
}

export function normalizeFeishuEvent(
  body: JsonObject,
  scope: FeishuIngressScope,
): ConnectorIngressEnvelope {
  parseUtcTimestamp(scope.received_at, "received_at");
  const header = object(body.header, "header");
  const event = object(body.event, "event");
  const tenantKey = string(header.tenant_key, "tenant_key");
  if (tenantKey !== scope.expected_external_tenant_id) {
    throw new FeishuIngressError(
      "tenant_mismatch",
      "Feishu event tenant does not match connector configuration",
    );
  }
  const eventType = string(header.event_type, "event_type");
  if (eventType === "im.message.receive_v1") {
    return messageEnvelope(header, event, scope);
  }
  if (eventType === "card.action.trigger") {
    return cardEnvelope(header, event, scope);
  }
  throw new FeishuIngressError(
    "unsupported_event_type",
    "Unsupported Feishu event type",
  );
}
