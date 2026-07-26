import type { JsonObject, JsonValue } from "@work-fabric/exchange-spi";

export const FEISHU_LONG_CONNECTION_MAX_EVENT_BYTES = 256 * 1024;

const MAX_EVENT_DEPTH = 512;
const MAX_EVENT_NODES = FEISHU_LONG_CONNECTION_MAX_EVENT_BYTES;
const SDK_EVENT_TYPE_SYMBOL_DESCRIPTION = "event-type";

function invalid(): never {
  throw new TypeError("feishu_long_connection_event_invalid");
}

function tooLarge(): never {
  throw new RangeError("feishu_long_connection_event_too_large");
}

interface SnapshotTraversal {
  bytes: number;
  nodes: number;
}

function accountBytes(traversal: SnapshotTraversal, bytes: number): void {
  traversal.bytes += bytes;
  if (traversal.bytes > FEISHU_LONG_CONNECTION_MAX_EVENT_BYTES) tooLarge();
}

function accountSerialized(traversal: SnapshotTraversal, value: string): void {
  accountBytes(traversal, Buffer.byteLength(value, "utf8"));
}

function accountJsonString(traversal: SnapshotTraversal, value: string): void {
  if (
    traversal.bytes + Buffer.byteLength(value, "utf8")
    > FEISHU_LONG_CONNECTION_MAX_EVENT_BYTES
  ) {
    tooLarge();
  }
  accountSerialized(traversal, JSON.stringify(value));
}

function sdkEventTypeSymbol(
  value: object,
  keys: readonly PropertyKey[],
  depth: number,
): string | undefined {
  const symbols = keys.filter((key): key is symbol => typeof key === "symbol");
  if (symbols.length === 0) return undefined;
  if (depth !== 0 || symbols.length !== 1) invalid();

  const symbol = symbols[0];
  if (symbol === undefined) invalid();
  if (symbol.description !== SDK_EVENT_TYPE_SYMBOL_DESCRIPTION) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, symbol);
  if (
    descriptor === undefined
    || !("value" in descriptor)
    || typeof descriptor.value !== "string"
  ) {
    invalid();
  }
  return descriptor.value;
}

function snapshotJsonValue(
  value: unknown,
  ancestors: Set<object>,
  traversal: SnapshotTraversal,
  depth: number,
): JsonValue {
  if (depth > MAX_EVENT_DEPTH) tooLarge();
  traversal.nodes += 1;
  if (traversal.nodes > MAX_EVENT_NODES) tooLarge();
  if (value === null || typeof value === "boolean") {
    accountSerialized(traversal, JSON.stringify(value));
    return value;
  }
  if (typeof value === "string") {
    accountJsonString(traversal, value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    accountSerialized(traversal, JSON.stringify(value));
    return value;
  }
  if (typeof value !== "object") invalid();
  if (ancestors.has(value)) invalid();

  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (
    array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  ) {
    invalid();
  }

  const keys = Reflect.ownKeys(value);
  const sdkEventType = sdkEventTypeSymbol(value, keys, depth);
  const stringKeys = keys.filter((key): key is string => typeof key === "string");

  ancestors.add(value);
  if (array) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) invalid();
    const length = lengthDescriptor.value;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) invalid();
    if (stringKeys.length !== length + 1 || !stringKeys.includes("length")) invalid();
    accountBytes(traversal, 2);
    const snapshot: JsonValue[] = [];
    for (let index = 0; index < length; index += 1) {
      if (index > 0) accountBytes(traversal, 1);
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        invalid();
      }
      snapshot.push(snapshotJsonValue(descriptor.value, ancestors, traversal, depth + 1));
    }
    ancestors.delete(value);
    return Object.freeze(snapshot);
  }

  const snapshot: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  accountBytes(traversal, 2);
  for (let index = 0; index < stringKeys.length; index += 1) {
    const key = stringKeys[index];
    if (key === undefined) invalid();
    if (index > 0) accountBytes(traversal, 1);
    accountJsonString(traversal, key);
    accountBytes(traversal, 1);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid();
    snapshot[key] = snapshotJsonValue(descriptor.value, ancestors, traversal, depth + 1);
  }
  ancestors.delete(value);

  if (sdkEventType !== undefined && snapshot.event_type !== sdkEventType) invalid();
  return Object.freeze(snapshot);
}

export function snapshotFeishuSdkEvent(value: unknown): JsonObject {
  try {
    const snapshot = snapshotJsonValue(value, new Set(), { bytes: 0, nodes: 0 }, 0);
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) invalid();
    const serialized = JSON.stringify(snapshot);
    if (
      Buffer.byteLength(serialized, "utf8")
      > FEISHU_LONG_CONNECTION_MAX_EVENT_BYTES
    ) {
      tooLarge();
    }
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
