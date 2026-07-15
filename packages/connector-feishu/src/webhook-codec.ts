import {
  createDecipheriv,
  createHash,
  timingSafeEqual,
} from "node:crypto";

import type { JsonObject, JsonValue } from "@work-fabric/exchange-spi";

import {
  assertFeishuWebhookLimits,
  type FeishuWebhookLimits,
} from "./config.js";
import {
  assertFeishuWebhookCredentials,
  type FeishuWebhookCredentials,
} from "./credentials.js";

export type FeishuWebhookErrorCode =
  | "body_too_large"
  | "invalid_json"
  | "json_too_deep"
  | "signature_required"
  | "invalid_signature"
  | "invalid_timestamp"
  | "stale_timestamp"
  | "invalid_encryption"
  | "invalid_verification_token"
  | "invalid_challenge"
  | "invalid_event";

export class FeishuWebhookError extends Error {
  constructor(readonly code: FeishuWebhookErrorCode) {
    super(`Feishu webhook rejected: ${code}`);
  }
}

export interface VerifyFeishuWebhookInput {
  readonly raw_body: Uint8Array;
  readonly timestamp?: string;
  readonly nonce?: string;
  readonly signature?: string;
  readonly now_epoch_seconds: number;
  readonly credentials: FeishuWebhookCredentials;
  readonly limits: FeishuWebhookLimits;
}

export type VerifiedFeishuWebhook =
  | { readonly kind: "challenge"; readonly challenge: string }
  | { readonly kind: "event"; readonly body: JsonObject };

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) {
    const padded = Buffer.alloc(leftBytes.length);
    rightBytes.copy(padded, 0, 0, Math.min(rightBytes.length, padded.length));
    timingSafeEqual(leftBytes, padded);
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

function assertDepth(value: unknown, maximum: number): void {
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > maximum) throw new FeishuWebhookError("json_too_deep");
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
    } else if (candidate !== null && typeof candidate === "object") {
      for (const item of Object.values(candidate)) visit(item, depth + 1);
    }
  };
  visit(value, 1);
}

function parseObject(raw: Uint8Array, maximumDepth: number): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    throw new FeishuWebhookError("invalid_json");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new FeishuWebhookError("invalid_json");
  }
  assertDepth(value, maximumDepth);
  return value as JsonObject;
}

function requireString(
  value: JsonValue | undefined,
  code: FeishuWebhookErrorCode,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FeishuWebhookError(code);
  }
  return value;
}

function verifySignature(input: VerifyFeishuWebhookInput): void {
  const encryptKey = input.credentials.encrypt_key;
  if (encryptKey === undefined) return;
  if (
    input.timestamp === undefined ||
    input.nonce === undefined ||
    input.signature === undefined
  ) {
    throw new FeishuWebhookError("signature_required");
  }
  const timestamp = Number(input.timestamp);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new FeishuWebhookError("invalid_timestamp");
  }
  if (
    Math.abs(input.now_epoch_seconds - timestamp) >
    input.limits.max_clock_skew_seconds
  ) {
    throw new FeishuWebhookError("stale_timestamp");
  }
  const expected = createHash("sha256")
    .update(input.timestamp)
    .update(input.nonce)
    .update(encryptKey)
    .update(input.raw_body)
    .digest("hex");
  if (!safeEqual(expected, input.signature.toLowerCase())) {
    throw new FeishuWebhookError("invalid_signature");
  }
}

function decryptBody(encrypted: string, encryptKey: string): Uint8Array {
  try {
    const value = Buffer.from(encrypted, "base64");
    if (value.length <= 16) throw new Error("ciphertext is too short");
    const key = createHash("sha256").update(encryptKey).digest();
    const decipher = createDecipheriv(
      "aes-256-cbc",
      key,
      value.subarray(0, 16),
    );
    return Buffer.concat([
      decipher.update(value.subarray(16)),
      decipher.final(),
    ]);
  } catch {
    throw new FeishuWebhookError("invalid_encryption");
  }
}

function verificationToken(body: JsonObject): string | undefined {
  if (typeof body.token === "string") return body.token;
  const header = body.header;
  if (
    header !== null &&
    typeof header === "object" &&
    !Array.isArray(header) &&
    typeof (header as JsonObject).token === "string"
  ) return (header as JsonObject).token as string;
  return undefined;
}

function withoutVerificationMaterial(body: JsonObject): JsonObject {
  const clone = structuredClone(body) as Record<string, JsonValue>;
  delete clone.token;
  if (
    clone.header !== null &&
    typeof clone.header === "object" &&
    !Array.isArray(clone.header)
  ) {
    const header = { ...clone.header } as Record<string, JsonValue>;
    delete header.token;
    clone.header = header;
  }
  return clone;
}

export async function verifyFeishuWebhook(
  input: VerifyFeishuWebhookInput,
): Promise<VerifiedFeishuWebhook> {
  assertFeishuWebhookLimits(input.limits);
  assertFeishuWebhookCredentials(input.credentials);
  if (!Number.isSafeInteger(input.now_epoch_seconds)) {
    throw new FeishuWebhookError("invalid_timestamp");
  }
  if (input.raw_body.byteLength > input.limits.max_body_bytes) {
    throw new FeishuWebhookError("body_too_large");
  }
  verifySignature(input);
  const outer = parseObject(input.raw_body, input.limits.max_json_depth);
  const body = input.credentials.encrypt_key === undefined
    ? outer
    : parseObject(
        decryptBody(
          requireString(outer.encrypt, "invalid_encryption"),
          input.credentials.encrypt_key,
        ),
        input.limits.max_json_depth,
      );
  const token = verificationToken(body);
  if (
    token === undefined ||
    !safeEqual(input.credentials.verification_token, token)
  ) {
    throw new FeishuWebhookError("invalid_verification_token");
  }
  if (body.type === "url_verification") {
    return {
      kind: "challenge",
      challenge: requireString(body.challenge, "invalid_challenge"),
    };
  }
  if (body.event === undefined || body.event === null) {
    throw new FeishuWebhookError("invalid_event");
  }
  return { kind: "event", body: withoutVerificationMaterial(body) };
}
