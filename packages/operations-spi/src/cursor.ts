import type { JsonObject, JsonValue } from "@work-fabric/exchange-spi";

export interface CursorAuthenticator {
  sign(payload: string): Promise<string>;
  verify(payload: string, signature: string): Promise<boolean>;
}

export interface CursorCodecOptions {
  readonly max_length: number;
}

export interface CursorContext {
  readonly kind:
    | "responsibility"
    | "timeline"
    | "relationship"
    | "audit"
    | "operations";
  readonly sort: string;
  readonly filters: JsonObject;
}

export interface CursorEncodeInput extends CursorContext {
  readonly position: JsonObject;
}

export interface OpaqueCursorCodec {
  encode(input: CursorEncodeInput): Promise<string>;
  decode(cursor: string, context: CursorContext): Promise<JsonObject>;
}

export interface PageLimitOptions {
  readonly default_limit: number;
  readonly max_limit: number;
}

const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeBytes(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value =
      (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    result += alphabet[(value >> 18) & 63];
    result += alphabet[(value >> 12) & 63];
    if (second !== undefined) result += alphabet[(value >> 6) & 63];
    if (third !== undefined) result += alphabet[value & 63];
  }
  return result;
}

function decodeBytes(value: string): Uint8Array {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("cursor encoding is invalid");
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const next = alphabet.indexOf(character);
    if (next < 0) throw new TypeError("cursor encoding is invalid");
    buffer = (buffer << 6) | next;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  return Uint8Array.from(bytes);
}

function encodeText(value: string): string {
  return encodeBytes(new TextEncoder().encode(value));
}

function decodeText(value: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(decodeBytes(value));
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function object(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} is invalid`);
  }
  return value as JsonObject;
}

function boundedString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function validateContext(value: unknown): CursorContext {
  const candidate = object(value, "cursor context");
  const kind = boundedString(candidate.kind, "cursor kind");
  if (
    kind !== "responsibility" &&
    kind !== "timeline" &&
    kind !== "relationship" &&
    kind !== "audit" &&
    kind !== "operations"
  ) {
    throw new TypeError("cursor kind is invalid");
  }
  return {
    kind,
    sort: boundedString(candidate.sort, "cursor sort"),
    filters: object(candidate.filters, "cursor filters"),
  };
}

function contextJson(context: CursorContext): JsonObject {
  return {
    kind: context.kind,
    sort: context.sort,
    filters: context.filters,
  };
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

export function normalizePageLimit(
  value: number | undefined,
  options: PageLimitOptions,
): number {
  const defaultLimit = positive(options.default_limit, "default limit");
  const maxLimit = positive(options.max_limit, "maximum limit");
  if (defaultLimit > maxLimit) {
    throw new TypeError("default limit must not exceed maximum limit");
  }
  const result = value ?? defaultLimit;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maxLimit) {
    throw new TypeError("limit is outside the allowed range");
  }
  return result;
}

export function createOpaqueCursorCodec(
  authenticator: CursorAuthenticator,
  options: CursorCodecOptions,
): OpaqueCursorCodec {
  const maxLength = positive(options.max_length, "cursor maximum length");
  return {
    async encode(input) {
      const context = validateContext({
        kind: input.kind,
        sort: input.sort,
        filters: input.filters,
      });
      const payload = canonical({
        version: 1,
        context: contextJson(context),
        position: object(input.position, "cursor position"),
      });
      const signature = await authenticator.sign(payload);
      boundedString(signature, "cursor signature");
      const cursor = `${encodeText(payload)}.${encodeText(signature)}`;
      if (cursor.length > maxLength) throw new TypeError("cursor length exceeds limit");
      return cursor;
    },
    async decode(cursor, expectedContext) {
      if (
        typeof cursor !== "string" ||
        cursor.length === 0 ||
        cursor.length > maxLength
      ) {
        throw new TypeError("cursor length is invalid");
      }
      const parts = cursor.split(".");
      const encodedPayload = parts[0];
      const encodedSignature = parts[1];
      if (
        parts.length !== 2 ||
        encodedPayload === undefined ||
        encodedSignature === undefined
      ) {
        throw new TypeError("cursor encoding is invalid");
      }
      const payload = decodeText(encodedPayload);
      const signature = decodeText(encodedSignature);
      if (!(await authenticator.verify(payload, signature))) {
        throw new TypeError("cursor signature is invalid");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(payload);
      } catch {
        throw new TypeError("cursor payload is invalid");
      }
      const envelope = object(decoded, "cursor payload");
      if (envelope.version !== 1) throw new TypeError("cursor version is invalid");
      const actualContext = validateContext(envelope.context);
      const expected = validateContext(expectedContext);
      if (canonical(contextJson(actualContext)) !== canonical(contextJson(expected))) {
        throw new TypeError("cursor context does not match query");
      }
      return structuredClone(object(envelope.position, "cursor position"));
    },
  };
}
