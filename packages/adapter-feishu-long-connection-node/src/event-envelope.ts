import type { JsonObject, JsonValue } from "@work-fabric/exchange-spi";

import {
  FEISHU_LONG_CONNECTION_MAX_EVENT_BYTES,
  snapshotFeishuSdkEvent,
} from "./sdk-event-boundary.js";

const MAX_ID_LENGTH = 512;
const MAX_CREATE_TIME_LENGTH = 64;
const MAX_MENTIONS = 100;

function invalid(): never {
  throw new TypeError("feishu_long_connection_event_invalid");
}

function tooLarge(): never {
  throw new RangeError("feishu_long_connection_event_too_large");
}

function object(value: JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as JsonObject;
}

function string(value: JsonValue | undefined, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return invalid();
  }
  return value;
}

function optionalString(value: JsonValue | undefined, maxLength: number): string | undefined {
  return value === undefined ? undefined : string(value, maxLength);
}

function mentions(value: JsonValue | undefined): readonly JsonObject[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_MENTIONS) invalid();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid();
  }
  return value.map((item) => {
    const mention = object(item);
    const id = object(mention.id);
    const name = optionalString(mention.name, MAX_ID_LENGTH);
    return {
      key: string(mention.key, MAX_ID_LENGTH),
      id: { open_id: string(id.open_id, MAX_ID_LENGTH) },
      ...(name === undefined ? {} : { name }),
    };
  });
}

export function reconstructFeishuMessageEvent(value: unknown): JsonObject {
  const input = snapshotFeishuSdkEvent(value);
  const eventType = string(input.event_type, MAX_ID_LENGTH);
  if (eventType !== "im.message.receive_v1") {
    throw new TypeError("feishu_long_connection_event_type_unsupported");
  }

  const sender = object(input.sender);
  const senderId = object(sender.sender_id);
  const message = object(input.message);
  const rootId = optionalString(message.root_id, MAX_ID_LENGTH);
  const parentId = optionalString(message.parent_id, MAX_ID_LENGTH);
  const mentionList = mentions(message.mentions);

  const reconstructed: JsonObject = {
    schema: "2.0",
    header: {
      event_id: string(input.event_id, MAX_ID_LENGTH),
      event_type: eventType,
      create_time: string(input.create_time, MAX_CREATE_TIME_LENGTH),
      tenant_key: string(input.tenant_key, MAX_ID_LENGTH),
    },
    event: {
      sender: {
        sender_id: { open_id: string(senderId.open_id, MAX_ID_LENGTH) },
        sender_type: string(sender.sender_type, MAX_ID_LENGTH),
      },
      message: {
        message_id: string(message.message_id, MAX_ID_LENGTH),
        chat_id: string(message.chat_id, MAX_ID_LENGTH),
        chat_type: string(message.chat_type, MAX_ID_LENGTH),
        message_type: string(message.message_type, MAX_ID_LENGTH),
        content: string(message.content, FEISHU_LONG_CONNECTION_MAX_EVENT_BYTES),
        ...(rootId === undefined ? {} : { root_id: rootId }),
        ...(parentId === undefined ? {} : { parent_id: parentId }),
        ...(mentionList === undefined ? {} : { mentions: mentionList }),
      },
    },
  };

  if (
    Buffer.byteLength(JSON.stringify(reconstructed), "utf8")
    > FEISHU_LONG_CONNECTION_MAX_EVENT_BYTES
  ) {
    tooLarge();
  }
  return reconstructed;
}
