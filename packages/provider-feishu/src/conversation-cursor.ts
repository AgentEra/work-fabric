import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";

export interface FeishuConversationCursorPayload {
  readonly version: 1;
  readonly tenant_id: string;
  readonly source_uri: string;
  readonly conversation_id: string;
  readonly trigger_message_id: string;
  readonly trigger_time: string;
  readonly native_page_token: string;
  readonly expires_at: string;
}

export interface ConversationCursorBinding {
  readonly tenant_id: string;
  readonly source_uri: string;
}

export interface ConversationCursorCodec {
  encode(payload: FeishuConversationCursorPayload): string;
  decode(
    cursor: string,
    binding: ConversationCursorBinding,
  ): FeishuConversationCursorPayload;
}

export interface HmacConversationCursorCodecOptions {
  readonly key: Uint8Array;
  readonly now?: () => string;
}

const CURSOR = /^wfc1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

function text(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) throw new TypeError(`Conversation cursor ${field} is invalid`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field, 64);
  if (!Number.isFinite(Date.parse(result))) {
    throw new TypeError(`Conversation cursor ${field} is invalid`);
  }
  return result;
}

function normalize(value: unknown): FeishuConversationCursorPayload {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) throw new TypeError("Conversation cursor payload is invalid");
  const source = value as Record<string, unknown>;
  const fields = [
    "version",
    "tenant_id",
    "source_uri",
    "conversation_id",
    "trigger_message_id",
    "trigger_time",
    "native_page_token",
    "expires_at",
  ];
  if (
    source.version !== 1 ||
    Object.keys(source).length !== fields.length ||
    Object.keys(source).some((field) => !fields.includes(field))
  ) throw new TypeError("Conversation cursor payload is invalid");
  return Object.freeze({
    version: 1,
    tenant_id: text(source.tenant_id, "tenant_id", 128),
    source_uri: text(source.source_uri, "source_uri", 2_048),
    conversation_id: text(source.conversation_id, "conversation_id", 255),
    trigger_message_id: text(
      source.trigger_message_id,
      "trigger_message_id",
      255,
    ),
    trigger_time: timestamp(source.trigger_time, "trigger_time"),
    native_page_token: text(
      source.native_page_token,
      "native_page_token",
      2_048,
    ),
    expires_at: timestamp(source.expires_at, "expires_at"),
  });
}

function canonical(payload: FeishuConversationCursorPayload): string {
  return JSON.stringify({
    version: payload.version,
    tenant_id: payload.tenant_id,
    source_uri: payload.source_uri,
    conversation_id: payload.conversation_id,
    trigger_message_id: payload.trigger_message_id,
    trigger_time: payload.trigger_time,
    native_page_token: payload.native_page_token,
    expires_at: payload.expires_at,
  });
}

export class HmacConversationCursorCodec
  implements ConversationCursorCodec {
  private readonly key: Uint8Array;
  private readonly now: () => string;

  constructor(options: HmacConversationCursorCodecOptions) {
    if (!(options.key instanceof Uint8Array) || options.key.byteLength < 32) {
      throw new TypeError("Conversation cursor key is invalid");
    }
    this.key = new Uint8Array(options.key);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  encode(value: FeishuConversationCursorPayload): string {
    const payload = normalize(value);
    if (Date.parse(payload.expires_at) <= Date.parse(this.now())) {
      throw new TypeError("Conversation cursor is expired");
    }
    const body = Buffer.from(canonical(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.key)
      .update(body)
      .digest("base64url");
    const cursor = `wfc1.${body}.${signature}`;
    if (cursor.length > 4_096) {
      throw new RangeError("Conversation cursor exceeds its bound");
    }
    return cursor;
  }

  decode(
    cursor: string,
    binding: ConversationCursorBinding,
  ): FeishuConversationCursorPayload {
    if (
      typeof cursor !== "string" ||
      cursor.length === 0 ||
      cursor.length > 4_096
    ) throw new TypeError("Conversation cursor is invalid");
    const match = CURSOR.exec(cursor);
    if (match === null) throw new TypeError("Conversation cursor is invalid");
    const expected = createHmac("sha256", this.key)
      .update(match[1]!)
      .digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(match[2]!, "base64url");
    } catch {
      throw new TypeError("Conversation cursor is invalid");
    }
    if (
      supplied.byteLength !== expected.byteLength ||
      !timingSafeEqual(supplied, expected)
    ) throw new TypeError("Conversation cursor is invalid");
    let decoded: unknown;
    try {
      decoded = JSON.parse(
        Buffer.from(match[1]!, "base64url").toString("utf8"),
      );
    } catch {
      throw new TypeError("Conversation cursor is invalid");
    }
    const payload = normalize(decoded);
    if (
      payload.tenant_id !== binding.tenant_id ||
      payload.source_uri !== binding.source_uri
    ) throw new TypeError("Conversation cursor binding is invalid");
    if (Date.parse(payload.expires_at) <= Date.parse(this.now())) {
      throw new TypeError("Conversation cursor is expired");
    }
    return payload;
  }
}
