import type { JsonObject } from "@work-fabric/exchange-spi";
import {
  FEDERATION_MAX_ENVELOPE_BYTES,
  FEDERATION_MESSAGE_TYPES,
  FEDERATION_PROFILE,
  type FederationClock,
  type FederationMessageType,
  type FederationPayload,
  type FederationSignedEnvelope,
  type FederationSigner,
  type FederationTransferOffer,
  type FederationTransferReceipt,
  type FederationTrustResolver,
  type FederationUnsignedEnvelope,
} from "@work-fabric/federation-spi";

import { canonicalJsonBytes, canonicalSha256, federationOfferDigest } from "./canonical-json.js";
import { FederationError } from "./errors.js";

const envelopeKeys = [
  "expires_at",
  "issued_at",
  "key_id",
  "message_id",
  "message_type",
  "payload",
  "profile",
  "sequence",
  "signature",
  "source_exchange_id",
  "target_exchange_id",
  "transfer_id",
] as const;
const offerKeys = [
  "handoff_offer",
  "handoff_offer_sha256",
  "source_handoff_id",
  "source_resource_version",
  "source_thread_id",
] as const;
const receiptKeys = [
  "decision",
  "handoff_offer_sha256",
  "reason_code",
  "recorded_at",
  "request_message_id",
  "target_handoff_id",
  "target_resource_version",
] as const;

export interface FederationEnvelopeCodecOptions {
  readonly local_exchange_id: string;
  readonly signer: FederationSigner;
  readonly trust: FederationTrustResolver;
  readonly clock: FederationClock;
  readonly max_clock_skew_seconds?: number;
}

function fail(code: ConstructorParameters<typeof FederationError>[0]): never {
  throw new FederationError(code);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("federation_envelope_invalid");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    fail("federation_envelope_invalid");
  }
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    return fail("federation_envelope_invalid");
  }
  return value;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== "string" || !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value))
  ) return fail("federation_envelope_invalid");
  return new Date(value).toISOString();
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return fail("federation_envelope_invalid");
  }
  return value as number;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    return fail("federation_envelope_invalid");
  }
  return value;
}

function safeJsonObject(value: unknown): JsonObject {
  const candidate = object(value) as JsonObject;
  canonicalJsonBytes(candidate);
  return structuredClone(candidate);
}

function offerPayload(value: unknown): FederationTransferOffer {
  const source = object(value);
  exact(source, offerKeys);
  const handoffOffer = safeJsonObject(source.handoff_offer);
  const expectedDigest = digest(source.handoff_offer_sha256);
  if (federationOfferDigest(handoffOffer) !== expectedDigest) {
    return fail("federation_digest_mismatch");
  }
  return {
    source_handoff_id: identifier(source.source_handoff_id),
    source_thread_id: identifier(source.source_thread_id),
    source_resource_version: positive(source.source_resource_version),
    handoff_offer: handoffOffer,
    handoff_offer_sha256: expectedDigest,
  };
}

function receiptPayload(value: unknown): FederationTransferReceipt {
  const source = object(value);
  exact(source, receiptKeys);
  const common = {
    request_message_id: identifier(source.request_message_id),
    handoff_offer_sha256: digest(source.handoff_offer_sha256),
    recorded_at: timestamp(source.recorded_at),
  };
  if (source.decision === "accepted") {
    if (source.reason_code !== null) return fail("federation_envelope_invalid");
    return {
      ...common,
      decision: "accepted",
      target_handoff_id: identifier(source.target_handoff_id),
      target_resource_version: positive(source.target_resource_version),
      reason_code: null,
    };
  }
  if (
    source.decision !== "rejected" || source.target_handoff_id !== null ||
    source.target_resource_version !== null || typeof source.reason_code !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(source.reason_code)
  ) return fail("federation_envelope_invalid");
  return {
    ...common,
    decision: "rejected",
    target_handoff_id: null,
    target_resource_version: null,
    reason_code: source.reason_code,
  };
}

function validateUnsigned(value: unknown): FederationUnsignedEnvelope {
  const source = object(value);
  const type = source.message_type;
  if (
    source.profile !== FEDERATION_PROFILE || typeof type !== "string" ||
    !FEDERATION_MESSAGE_TYPES.includes(type as FederationMessageType)
  ) return fail("federation_envelope_invalid");
  const messageType = type as FederationMessageType;
  const sequence = positive(source.sequence);
  if (
    (messageType === "transfer_offer" && sequence !== 1) ||
    (messageType === "transfer_receipt" && sequence !== 2)
  ) return fail("federation_envelope_invalid");
  const issuedAt = timestamp(source.issued_at);
  const expiresAt = timestamp(source.expires_at);
  const ttl = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (ttl < 1_000 || ttl > 300_000) return fail("federation_envelope_invalid");
  const sourceExchange = identifier(source.source_exchange_id);
  const targetExchange = identifier(source.target_exchange_id);
  if (sourceExchange === targetExchange) return fail("federation_envelope_invalid");
  if (typeof source.key_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(source.key_id)) {
    return fail("federation_envelope_invalid");
  }
  return {
    profile: FEDERATION_PROFILE,
    message_id: identifier(source.message_id),
    transfer_id: identifier(source.transfer_id),
    message_type: messageType,
    source_exchange_id: sourceExchange,
    target_exchange_id: targetExchange,
    sequence,
    issued_at: issuedAt,
    expires_at: expiresAt,
    key_id: source.key_id,
    payload: messageType === "transfer_offer"
      ? offerPayload(source.payload)
      : receiptPayload(source.payload),
  };
}

function unsigned(envelope: FederationSignedEnvelope): FederationUnsignedEnvelope {
  const { signature: _signature, ...result } = envelope;
  return result;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

export function federationEnvelopeDigest(envelope: FederationSignedEnvelope): string {
  return canonicalSha256(unsigned(envelope) as unknown as JsonObject);
}

export class FederationEnvelopeCodec {
  private readonly skewMilliseconds: number;

  constructor(private readonly options: FederationEnvelopeCodecOptions) {
    identifier(options.local_exchange_id);
    if (
      !Number.isSafeInteger(options.max_clock_skew_seconds ?? 30) ||
      (options.max_clock_skew_seconds ?? 30) < 0 ||
      (options.max_clock_skew_seconds ?? 30) > 60
    ) throw new RangeError("max_clock_skew_seconds must be between 0 and 60");
    this.skewMilliseconds = (options.max_clock_skew_seconds ?? 30) * 1_000;
  }

  async sign(
    input: Omit<FederationUnsignedEnvelope, "profile" | "key_id">,
  ): Promise<Uint8Array> {
    const normalized = validateUnsigned({
      ...input,
      profile: FEDERATION_PROFILE,
      key_id: this.options.signer.key_id,
    });
    if (normalized.source_exchange_id !== this.options.local_exchange_id) {
      fail("federation_wrong_audience");
    }
    const signature = await this.options.signer.sign(
      canonicalJsonBytes(normalized as unknown as JsonObject),
    );
    if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) {
      fail("federation_signature_invalid");
    }
    const encoded = canonicalJsonBytes({
      ...normalized,
      signature,
    } as unknown as JsonObject);
    if (encoded.byteLength > FEDERATION_MAX_ENVELOPE_BYTES) {
      fail("federation_envelope_too_large");
    }
    return encoded;
  }

  async verify(
    bytes: Uint8Array,
    expectedType?: FederationMessageType,
  ): Promise<FederationSignedEnvelope> {
    if (
      !(bytes instanceof Uint8Array) || bytes.byteLength > FEDERATION_MAX_ENVELOPE_BYTES
    ) return fail("federation_envelope_too_large");
    let parsed: Record<string, unknown>;
    try {
      parsed = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch (error) {
      if (error instanceof FederationError) throw error;
      return fail("federation_envelope_invalid");
    }
    if (!sameBytes(bytes, canonicalJsonBytes(parsed as JsonObject))) {
      return fail("federation_envelope_invalid");
    }
    exact(parsed, envelopeKeys);
    if (typeof parsed.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(parsed.signature)) {
      return fail("federation_signature_invalid");
    }
    const signature = parsed.signature;
    const normalized = validateUnsigned(parsed);
    if (normalized.target_exchange_id !== this.options.local_exchange_id) {
      return fail("federation_wrong_audience");
    }
    if (expectedType !== undefined && normalized.message_type !== expectedType) {
      return fail("federation_envelope_invalid");
    }
    const verified = await this.options.trust.verify({
      source_exchange_id: normalized.source_exchange_id,
      target_exchange_id: normalized.target_exchange_id,
      key_id: normalized.key_id,
      canonical: canonicalJsonBytes(normalized as unknown as JsonObject),
      signature,
    });
    if (!verified) return fail("federation_signature_invalid");
    const now = Date.parse(timestamp(this.options.clock.now()));
    if (now + this.skewMilliseconds < Date.parse(normalized.issued_at)) {
      return fail("federation_not_yet_valid");
    }
    if (now - this.skewMilliseconds > Date.parse(normalized.expires_at)) {
      return fail("federation_expired");
    }
    return structuredClone({ ...normalized, signature });
  }
}

export function asFederationOffer(
  payload: FederationPayload,
): FederationTransferOffer {
  return offerPayload(payload);
}

export function asFederationReceipt(
  payload: FederationPayload,
): FederationTransferReceipt {
  return receiptPayload(payload);
}
