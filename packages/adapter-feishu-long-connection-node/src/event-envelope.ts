import type { JsonObject, JsonValue } from "@work-fabric/exchange-spi";

const MAX_ID_LENGTH = 512;
const MAX_CREATE_TIME_LENGTH = 64;
const MAX_MENTIONS = 100;
const MAX_EVENT_BYTES = 256 * 1024;

function invalid(): never {
  throw new TypeError("feishu_long_connection_event_invalid");
}

function tooLarge(): never {
  throw new RangeError("feishu_long_connection_event_too_large");
}

function snapshotJsonValue(value: unknown, ancestors: Set<object>): JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return value;
  }
  if (typeof value !== "object") invalid();
  if (ancestors.has(value)) invalid();

  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    invalid();
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key === "symbol")) invalid();

  ancestors.add(value);
  if (array) {
    const lengthDescriptor = descriptors.length;
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) invalid();
    const length = lengthDescriptor.value;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) invalid();
    if (keys.length !== length + 1 || !keys.includes("length")) invalid();
    const snapshot: JsonValue[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        invalid();
      }
      snapshot.push(snapshotJsonValue(descriptor.value, ancestors));
    }
    ancestors.delete(value);
    return Object.freeze(snapshot);
  }

  const snapshot: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of keys) {
    if (typeof key !== "string") invalid();
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid();
    snapshot[key] = snapshotJsonValue(descriptor.value, ancestors);
  }
  ancestors.delete(value);
  return Object.freeze(snapshot);
}

function boundedJsonObject(value: unknown): JsonObject {
  try {
    const snapshot = snapshotJsonValue(value, new Set());
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) invalid();
    const serialized = JSON.stringify(snapshot);
    if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_BYTES) tooLarge();
    return snapshot as JsonObject;
  } catch (error) {
    if (
      error instanceof TypeError
      && error.message === "feishu_long_connection_event_invalid"
    ) throw error;
    if (
      error instanceof RangeError
      && error.message === "feishu_long_connection_event_too_large"
    ) throw error;
    return invalid();
  }
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
  const input = boundedJsonObject(value);
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
        content: string(message.content, MAX_EVENT_BYTES),
        ...(rootId === undefined ? {} : { root_id: rootId }),
        ...(parentId === undefined ? {} : { parent_id: parentId }),
        ...(mentionList === undefined ? {} : { mentions: mentionList }),
      },
    },
  };

  if (Buffer.byteLength(JSON.stringify(reconstructed), "utf8") > MAX_EVENT_BYTES) {
    tooLarge();
  }
  return reconstructed;
}
