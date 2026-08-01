import { createHash } from "node:crypto";

import type { JsonObject, JsonValue } from "@work-fabric/exchange-spi";
import {
  DISCOVERY_MAX_MESSAGE_BYTES,
  DISCOVERY_PROFILE,
  type DiscoveryClock,
  type DiscoveryMessageDraft,
  type DiscoveryMessagePayload,
  type DiscoveryMessageType,
  type DiscoverySignedMessage,
  type DiscoverySigner,
  type DiscoverySyncRequest,
  type DiscoverySyncResponse,
  type DiscoveryTrustResolver,
  type DiscoveryUnsignedMessage,
} from "@work-fabric/discovery-spi";

import { discoveryCanonicalJsonBytes } from "./canonical-json.js";
import { DiscoveryError } from "./errors.js";

const unsignedKeys = [
  "expires_at", "issued_at", "key_id", "message_id", "message_type", "payload",
  "profile", "source_exchange_id", "target_exchange_id",
] as const;
const signedKeys = [...unsignedKeys, "signature"].sort();

function fail(code: ConstructorParameters<typeof DiscoveryError>[0]): never {
  throw new DiscoveryError(code);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("discovery_record_invalid");
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    fail("discovery_record_invalid");
  }
}

function identifier(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.trim() !== value) {
    return fail("discovery_record_invalid");
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    return fail("discovery_record_invalid");
  }
  return value;
}

function boundedInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    return fail("discovery_record_invalid");
  }
  return value as number;
}

function optionalIdentifier(source: Record<string, unknown>, key: string, maximum = 4096): { readonly [key: string]: string } {
  const value = source[key];
  return value === undefined ? {} : { [key]: identifier(value, maximum) };
}

function normalizeSyncRequest(value: unknown): DiscoverySyncRequest {
  const source = object(value);
  exact(source, ["limit"], ["cursor", "etag"]);
  return {
    limit: boundedInteger(source.limit, 10_000),
    ...optionalIdentifier(source, "cursor"),
    ...optionalIdentifier(source, "etag"),
  };
}

function normalizeSyncResponse(value: unknown): DiscoverySyncResponse {
  const source = object(value);
  exact(source, ["complete", "etag", "items", "request_digest", "request_message_id"], ["next_cursor"]);
  if (!Array.isArray(source.items) || source.items.length > 10_000 || typeof source.complete !== "boolean") {
    return fail("discovery_record_invalid");
  }
  const digest = identifier(source.request_digest, 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) return fail("discovery_record_invalid");
  return {
    request_message_id: identifier(source.request_message_id),
    request_digest: digest,
    items: structuredClone(source.items) as DiscoverySyncResponse["items"],
    etag: identifier(source.etag, 4096),
    complete: source.complete,
    ...optionalIdentifier(source, "next_cursor"),
  };
}

function normalizePayload(type: DiscoveryMessageType, value: unknown): DiscoveryMessagePayload {
  if (type === "sync_request") return normalizeSyncRequest(value);
  if (type === "sync_response") return normalizeSyncResponse(value);
  // Query envelopes are added with the bounded-query gateway. Rejecting them here keeps
  // this direct-sync codec closed until their budget members are validated in that layer.
  return fail("discovery_record_invalid");
}

function normalizeUnsigned(value: unknown): DiscoveryUnsignedMessage {
  const source = object(value);
  exact(source, unsignedKeys);
  if (source.profile !== DISCOVERY_PROFILE) return fail("discovery_record_invalid");
  if (!(source.message_type === "sync_request" || source.message_type === "sync_response")) {
    return fail("discovery_record_invalid");
  }
  const issuedAt = timestamp(source.issued_at);
  const expiresAt = timestamp(source.expires_at);
  const ttl = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (ttl < 1_000 || ttl > 60_000) return fail("discovery_record_invalid");
  if (typeof source.key_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(source.key_id)) {
    return fail("discovery_record_invalid");
  }
  return {
    profile: DISCOVERY_PROFILE,
    message_id: identifier(source.message_id),
    message_type: source.message_type,
    source_exchange_id: identifier(source.source_exchange_id),
    target_exchange_id: identifier(source.target_exchange_id),
    issued_at: issuedAt,
    expires_at: expiresAt,
    key_id: source.key_id,
    payload: normalizePayload(source.message_type, source.payload),
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

export function discoveryMessageDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface DiscoveryMessageCodecOptions {
  readonly local_exchange_id: string;
  readonly signer: DiscoverySigner;
  readonly trust: DiscoveryTrustResolver;
  readonly clock: DiscoveryClock;
  readonly max_clock_skew_seconds?: number;
}

export class DiscoveryMessageCodec {
  private readonly skewMilliseconds: number;

  constructor(private readonly options: DiscoveryMessageCodecOptions) {
    identifier(options.local_exchange_id);
    const skew = options.max_clock_skew_seconds ?? 5;
    if (!Number.isSafeInteger(skew) || skew < 0 || skew > 60) throw new RangeError("max_clock_skew_seconds is invalid");
    this.skewMilliseconds = skew * 1_000;
    timestamp(options.clock.now());
  }

  async sign(input: DiscoveryMessageDraft): Promise<Uint8Array> {
    const unsigned = normalizeUnsigned({
      ...input,
      profile: DISCOVERY_PROFILE,
      source_exchange_id: this.options.local_exchange_id,
      key_id: this.options.signer.key_id,
    });
    if (unsigned.source_exchange_id === unsigned.target_exchange_id) return fail("discovery_wrong_audience");
    const signature = await this.options.signer.sign(discoveryCanonicalJsonBytes(unsigned as unknown as JsonValue));
    if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return fail("discovery_signature_invalid");
    const bytes = discoveryCanonicalJsonBytes({ ...unsigned, signature } as unknown as JsonValue);
    if (bytes.byteLength > DISCOVERY_MAX_MESSAGE_BYTES) return fail("discovery_record_too_large");
    return bytes;
  }

  async verify(bytes: Uint8Array): Promise<DiscoverySignedMessage> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > DISCOVERY_MAX_MESSAGE_BYTES) {
      return fail("discovery_record_too_large");
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch (error) {
      if (error instanceof DiscoveryError) throw error;
      return fail("discovery_record_invalid");
    }
    if (!sameBytes(bytes, discoveryCanonicalJsonBytes(parsed as JsonObject))) return fail("discovery_record_invalid");
    exact(parsed, signedKeys);
    if (typeof parsed.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(parsed.signature)) {
      return fail("discovery_signature_invalid");
    }
    const { signature, ...rawUnsigned } = parsed;
    const unsigned = normalizeUnsigned(rawUnsigned);
    if (unsigned.target_exchange_id !== this.options.local_exchange_id) return fail("discovery_wrong_audience");
    const verified = await this.options.trust.verify({
      origin_exchange_id: unsigned.source_exchange_id,
      audience_exchange_id: this.options.local_exchange_id,
      key_id: unsigned.key_id,
      canonical: discoveryCanonicalJsonBytes(unsigned as unknown as JsonValue),
      signature,
    });
    if (!verified) return fail("discovery_signature_invalid");
    const now = Date.parse(timestamp(this.options.clock.now()));
    if (now + this.skewMilliseconds < Date.parse(unsigned.issued_at)) return fail("discovery_not_yet_valid");
    if (now - this.skewMilliseconds > Date.parse(unsigned.expires_at)) return fail("discovery_expired");
    return structuredClone({ ...unsigned, signature });
  }
}
