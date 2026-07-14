import { createHmac, timingSafeEqual } from "node:crypto";

import {
  assertNonNegativeSafeInteger,
  assertOpaqueId,
  assertTimestamp,
  compareTimestamps,
} from "./validation.js";

export interface CursorPayload {
  readonly subscription_id: string;
  readonly partition_id: string;
  readonly position: number;
  readonly expires_at: string;
}

export class CursorCodecError extends Error {
  constructor(
    readonly code: "invalid_cursor" | "cursor_expired",
    message: string,
  ) {
    super(message);
    this.name = "CursorCodecError";
  }
}

function validatePayload(value: unknown): asserts value is CursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CursorCodecError("invalid_cursor", "invalid cursor payload");
  }
  const payload = value as Record<string, unknown>;
  const keys = [
    "subscription_id",
    "partition_id",
    "position",
    "expires_at",
  ];
  if (
    Object.keys(payload).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(payload, key))
  ) {
    throw new CursorCodecError("invalid_cursor", "invalid cursor payload");
  }
  try {
    assertOpaqueId(payload.subscription_id, "cursor subscription_id");
    assertOpaqueId(payload.partition_id, "cursor partition_id");
    assertNonNegativeSafeInteger(payload.position, "cursor position");
    assertTimestamp(payload.expires_at, "cursor expires_at");
  } catch {
    throw new CursorCodecError("invalid_cursor", "invalid cursor payload");
  }
}

function canonicalPayload(payload: CursorPayload): string {
  return JSON.stringify({
    expires_at: payload.expires_at,
    partition_id: payload.partition_id,
    position: payload.position,
    subscription_id: payload.subscription_id,
  });
}

export class OpaqueCursorCodec {
  private readonly secret: Buffer;

  constructor(secret: Uint8Array) {
    if (!(secret instanceof Uint8Array) || secret.byteLength < 32) {
      throw new TypeError("Cursor secret must contain at least 32 bytes");
    }
    this.secret = Buffer.from(secret);
  }

  encode(payload: CursorPayload): string {
    try {
      validatePayload(payload);
    } catch {
      throw new CursorCodecError("invalid_cursor", "invalid cursor payload");
    }
    const encodedPayload = Buffer.from(canonicalPayload(payload)).toString(
      "base64url",
    );
    const signature = createHmac("sha256", this.secret)
      .update(encodedPayload)
      .digest("base64url");
    return `${encodedPayload}.${signature}`;
  }

  decode(cursor: string, now: string): CursorPayload {
    try {
      assertTimestamp(now, "cursor current time");
    } catch {
      throw new CursorCodecError("invalid_cursor", "invalid cursor time");
    }
    const decoded = this.decodeAuthenticated(cursor);
    if (
      compareTimestamps(decoded.expires_at, now) <= 0
    ) {
      throw new CursorCodecError("cursor_expired", "cursor expired");
    }
    return decoded;
  }

  decodeAuthenticated(cursor: string): CursorPayload {
    if (
      typeof cursor !== "string" ||
      cursor.length === 0 ||
      cursor.length > 2048
    ) {
      throw new CursorCodecError("invalid_cursor", "invalid cursor");
    }
    const parts = cursor.split(".");
    const encodedPayload = parts[0];
    const encodedSignature = parts[1];
    if (
      parts.length !== 2 ||
      encodedPayload === undefined ||
      encodedSignature === undefined ||
      !/^[A-Za-z0-9_-]+$/.test(encodedPayload) ||
      !/^[A-Za-z0-9_-]+$/.test(encodedSignature)
    ) {
      throw new CursorCodecError("invalid_cursor", "invalid cursor");
    }
    const expected = createHmac("sha256", this.secret)
      .update(encodedPayload)
      .digest();
    const actual = Buffer.from(encodedSignature, "base64url");
    if (
      actual.toString("base64url") !== encodedSignature ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new CursorCodecError("invalid_cursor", "invalid cursor");
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
      validatePayload(decoded);
    } catch {
      throw new CursorCodecError("invalid_cursor", "invalid cursor payload");
    }
    return structuredClone(decoded);
  }
}
