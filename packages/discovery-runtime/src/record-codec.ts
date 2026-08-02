import type { CapabilityDescriptor, JsonObject, JsonValue } from "@work-fabric/exchange-spi";
import {
  DISCOVERY_MAX_MESSAGE_BYTES,
  DISCOVERY_PROFILE,
  type DiscoveryClock,
  type DiscoveryRecord,
  type DiscoveryRecordDraft,
  type DiscoveryRecordKind,
  type DiscoveryRecordPayload,
  type DiscoverySigner,
  type DiscoveryTombstone,
  type DiscoveryTrustResolver,
  type DiscoveryUnsignedRecord,
} from "@work-fabric/discovery-spi";

import {
  discoveryCanonicalJsonBytes,
  discoveryCanonicalSha256,
} from "./canonical-json.js";
import { DiscoveryError } from "./errors.js";

const unsignedKeys = [
  "audiences", "expires_at", "issued_at", "key_id", "max_hops",
  "origin_exchange_id", "payload", "payload_digest", "profile", "record_id",
  "record_kind", "revision", "transitive", "visibility",
] as const;
const signedKeys = [...unsignedKeys, "signature"].sort();
const tombstoneUnsignedKeys = [
  "key_id", "origin_exchange_id", "profile", "record_id", "retain_until",
  "revision", "withdrawn_at",
] as const;
const tombstoneSignedKeys = [...tombstoneUnsignedKeys, "signature"].sort();

function fail(code: ConstructorParameters<typeof DiscoveryError>[0]): never {
  throw new DiscoveryError(code);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("discovery_record_invalid");
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || actual.some((key) => !allowed.has(key))) {
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
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    return fail("discovery_record_invalid");
  }
  const normalized = new Date(value).toISOString();
  if (normalized !== value) return fail("discovery_record_invalid");
  return normalized;
}

function natural(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    return fail("discovery_record_invalid");
  }
  return value as number;
}

function positive(value: unknown): number {
  const result = natural(value);
  if (result === 0) return fail("discovery_record_invalid");
  return result;
}

function strings(value: unknown, maximum = 128): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) return fail("discovery_record_invalid");
  const items = value.map((item) => identifier(item, 2048));
  if (new Set(items).size !== items.length) return fail("discovery_record_invalid");
  return items;
}

function bindings(value: unknown): readonly {
  readonly binding_type: string;
  readonly uri: string;
  readonly security_schemes: readonly string[];
  readonly extensions?: JsonObject;
}[] {
  if (!Array.isArray(value) || value.length > 16) return fail("discovery_record_invalid");
  return value.map((item) => {
    const source = object(item);
    exact(source, ["binding_type", "security_schemes", "uri"], ["extensions"]);
    return {
      binding_type: identifier(source.binding_type, 256),
      uri: identifier(source.uri, 2048),
      security_schemes: strings(source.security_schemes, 16),
      ...(source.extensions === undefined ? {} : { extensions: safeObject(source.extensions) }),
    };
  });
}

function safeObject(value: unknown): JsonObject {
  const source = object(value) as JsonObject;
  discoveryCanonicalJsonBytes(source);
  return structuredClone(source);
}

function actor(value: unknown): { readonly actor_id: string; readonly actor_type: "human" | "agent" | "system" } {
  const source = object(value);
  exact(source, ["actor_id", "actor_type"]);
  if (!(["human", "agent", "system"] as const).includes(source.actor_type as never)) {
    return fail("discovery_record_invalid");
  }
  return { actor_id: identifier(source.actor_id), actor_type: source.actor_type as "human" | "agent" | "system" };
}

function interactionModes(value: unknown): CapabilityDescriptor["interaction_modes"] {
  const result = strings(value, 3);
  if (result.some((item) => !("synchronous" === item || "asynchronous" === item || "status_updates" === item))) {
    return fail("discovery_record_invalid");
  }
  return result as CapabilityDescriptor["interaction_modes"];
}

function capabilities(value: unknown): readonly CapabilityDescriptor[] {
  if (!Array.isArray(value) || value.length > 64) return fail("discovery_record_invalid");
  return value.map((item) => {
    const source = object(item);
    exact(source, [
      "capability_id", "constraints", "description", "input_media_types",
      "input_schema_refs", "interaction_modes", "name", "output_media_types",
      "output_schema_refs", "version",
    ], ["extensions"]);
    return {
      capability_id: identifier(source.capability_id, 128),
      version: identifier(source.version, 128),
      name: identifier(source.name, 256),
      description: identifier(source.description, 2_048),
      input_media_types: strings(source.input_media_types, 64),
      output_media_types: strings(source.output_media_types, 64),
      input_schema_refs: strings(source.input_schema_refs, 64),
      output_schema_refs: strings(source.output_schema_refs, 64),
      interaction_modes: interactionModes(source.interaction_modes),
      constraints: safeObject(source.constraints),
      ...(source.extensions === undefined ? {} : { extensions: safeObject(source.extensions) }),
    };
  });
}

function payload(value: unknown, kind: DiscoveryRecordKind, origin: string): DiscoveryRecordPayload {
  const source = object(value);
  if (kind === "exchange") {
    exact(source, ["bindings", "discovery_profiles", "display_name", "exchange_id", "federation_profiles", "security_schemes"], ["extensions"]);
    const exchangeId = identifier(source.exchange_id);
    if (exchangeId !== origin) return fail("discovery_record_invalid");
    return {
      exchange_id: exchangeId,
      display_name: identifier(source.display_name),
      discovery_profiles: strings(source.discovery_profiles, 16),
      federation_profiles: strings(source.federation_profiles, 16),
      bindings: bindings(source.bindings),
      security_schemes: strings(source.security_schemes, 16),
      ...(source.extensions === undefined ? {} : { extensions: safeObject(source.extensions) }),
    };
  }
  if (kind === "capability_route") {
    exact(source, ["availability", "binding_types", "capability_id", "input_media_types", "input_schema_refs", "interaction_modes", "output_media_types", "output_schema_refs", "security_schemes", "versions"], ["detail_uri", "extensions"]);
    if (!["available", "constrained", "unavailable"].includes(String(source.availability))) return fail("discovery_record_invalid");
    return {
      capability_id: identifier(source.capability_id, 128),
      versions: strings(source.versions, 64),
      input_media_types: strings(source.input_media_types, 64),
      output_media_types: strings(source.output_media_types, 64),
      input_schema_refs: strings(source.input_schema_refs, 64),
      output_schema_refs: strings(source.output_schema_refs, 64),
      interaction_modes: interactionModes(source.interaction_modes),
      binding_types: strings(source.binding_types, 32),
      security_schemes: strings(source.security_schemes, 32),
      availability: source.availability as "available" | "constrained" | "unavailable",
      ...(source.detail_uri === undefined ? {} : { detail_uri: identifier(source.detail_uri, 2048) }),
      ...(source.extensions === undefined ? {} : { extensions: safeObject(source.extensions) }),
    };
  }
  if (kind === "participant") {
    exact(source, ["actor", "display_name", "endpoint_ids"], ["extensions"]);
    return {
      actor: actor(source.actor),
      display_name: identifier(source.display_name),
      endpoint_ids: strings(source.endpoint_ids, 128),
      ...(source.extensions === undefined ? {} : { extensions: safeObject(source.extensions) }),
    };
  }
  exact(source, ["actor", "availability", "bindings", "capabilities", "display_name", "endpoint_id", "endpoint_type", "limits", "protocol_versions"], ["extensions"]);
  if (!["available", "busy", "draining", "unavailable"].includes(String(source.availability))) return fail("discovery_record_invalid");
  const limits = object(source.limits);
  exact(limits, ["max_inline_content_bytes"], ["max_concurrent_handoffs", "max_context_bytes"]);
  return {
    endpoint_id: identifier(source.endpoint_id),
    actor: actor(source.actor),
    endpoint_type: identifier(source.endpoint_type),
    display_name: identifier(source.display_name),
    protocol_versions: strings(source.protocol_versions, 16),
    bindings: bindings(source.bindings),
    capabilities: capabilities(source.capabilities),
    availability: source.availability as "available" | "busy" | "draining" | "unavailable",
    limits: {
      max_inline_content_bytes: natural(limits.max_inline_content_bytes),
      ...(limits.max_context_bytes === undefined ? {} : { max_context_bytes: natural(limits.max_context_bytes) }),
      ...(limits.max_concurrent_handoffs === undefined ? {} : { max_concurrent_handoffs: natural(limits.max_concurrent_handoffs) }),
    },
    ...(source.extensions === undefined ? {} : { extensions: safeObject(source.extensions) }),
  };
}

function normalizeUnsigned(value: unknown): DiscoveryUnsignedRecord {
  const source = object(value);
  exact(source, unsignedKeys);
  if (source.profile !== DISCOVERY_PROFILE) return fail("discovery_record_invalid");
  const kinds = ["exchange", "capability_route", "participant", "endpoint"] as const;
  if (!kinds.includes(source.record_kind as never)) return fail("discovery_record_invalid");
  const kind = source.record_kind as DiscoveryRecordKind;
  const origin = identifier(source.origin_exchange_id);
  const issuedAt = timestamp(source.issued_at);
  const expiresAt = timestamp(source.expires_at);
  const ttl = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (ttl < 1_000 || ttl > 300_000) return fail("discovery_record_invalid");
  const visibility = source.visibility;
  if (!(["public", "federated", "peer"] as const).includes(visibility as never)) return fail("discovery_record_invalid");
  const normalizedVisibility = visibility as "public" | "federated" | "peer";
  const audiences = strings(source.audiences, 128);
  if ((normalizedVisibility === "public") !== (audiences.length === 0)) return fail("discovery_record_invalid");
  if (typeof source.transitive !== "boolean") return fail("discovery_record_invalid");
  const maxHops = natural(source.max_hops, 8);
  if ((!source.transitive && maxHops !== 0) || (source.transitive && maxHops === 0)) return fail("discovery_record_invalid");
  const normalizedPayload = payload(source.payload, kind, origin);
  const expectedDigest = discoveryPayloadDigest(normalizedPayload);
  if (source.payload_digest !== expectedDigest) return fail("discovery_digest_mismatch");
  if (typeof source.key_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(source.key_id)) return fail("discovery_record_invalid");
  return {
    profile: DISCOVERY_PROFILE,
    record_id: identifier(source.record_id),
    record_kind: kind,
    origin_exchange_id: origin,
    revision: positive(source.revision),
    issued_at: issuedAt,
    expires_at: expiresAt,
    visibility: normalizedVisibility,
    audiences,
    transitive: source.transitive,
    max_hops: maxHops,
    payload: normalizedPayload,
    payload_digest: expectedDigest,
    key_id: source.key_id,
  } as unknown as DiscoveryUnsignedRecord;
}

function unsigned(record: DiscoveryRecord): DiscoveryUnsignedRecord {
  const { signature: _signature, ...value } = record;
  return value;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

export function discoveryPayloadDigest(payload: DiscoveryRecordPayload): string {
  return discoveryCanonicalSha256(payload as unknown as JsonValue);
}

export interface DiscoveryRecordCodecOptions {
  readonly local_exchange_id: string;
  readonly signer: DiscoverySigner;
  readonly trust: DiscoveryTrustResolver;
  readonly clock: DiscoveryClock;
  readonly max_clock_skew_seconds?: number;
}

export class DiscoveryRecordCodec {
  private readonly skewMilliseconds: number;

  constructor(private readonly options: DiscoveryRecordCodecOptions) {
    identifier(options.local_exchange_id);
    const skew = options.max_clock_skew_seconds ?? 30;
    if (!Number.isSafeInteger(skew) || skew < 0 || skew > 60) throw new RangeError("max_clock_skew_seconds must be between 0 and 60");
    this.skewMilliseconds = skew * 1_000;
    timestamp(options.clock.now());
  }

  async sign(input: DiscoveryRecordDraft): Promise<Uint8Array> {
    const normalized = normalizeUnsigned({
      ...input,
      profile: DISCOVERY_PROFILE,
      key_id: this.options.signer.key_id,
      payload_digest: discoveryPayloadDigest(input.payload),
    });
    if (normalized.origin_exchange_id !== this.options.local_exchange_id) return fail("discovery_wrong_audience");
    const signature = await this.options.signer.sign(discoveryCanonicalJsonBytes(normalized as unknown as JsonValue));
    if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return fail("discovery_signature_invalid");
    const bytes = discoveryCanonicalJsonBytes({ ...normalized, signature } as unknown as JsonValue);
    if (bytes.byteLength > DISCOVERY_MAX_MESSAGE_BYTES) return fail("discovery_record_too_large");
    return bytes;
  }

  async signTombstone(input: Omit<DiscoveryTombstone, "profile" | "key_id" | "signature">): Promise<Uint8Array> {
    const normalized = normalizeTombstone({
      ...input,
      profile: DISCOVERY_PROFILE,
      key_id: this.options.signer.key_id,
    });
    if (normalized.origin_exchange_id !== this.options.local_exchange_id) return fail("discovery_wrong_audience");
    const { signature: _signature, ...unsignedValue } = normalized;
    const signature = await this.options.signer.sign(discoveryCanonicalJsonBytes(unsignedValue as unknown as JsonValue));
    if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return fail("discovery_signature_invalid");
    const bytes = discoveryCanonicalJsonBytes({ ...unsignedValue, signature } as unknown as JsonValue);
    if (bytes.byteLength > DISCOVERY_MAX_MESSAGE_BYTES) return fail("discovery_record_too_large");
    return bytes;
  }

  async verify(bytes: Uint8Array, input: { readonly audience: string }): Promise<DiscoveryRecord> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > DISCOVERY_MAX_MESSAGE_BYTES) return fail("discovery_record_too_large");
    identifier(input.audience);
    if (input.audience !== this.options.local_exchange_id) return fail("discovery_wrong_audience");
    let parsed: Record<string, unknown>;
    try {
      parsed = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch (error) {
      if (error instanceof DiscoveryError) throw error;
      return fail("discovery_record_invalid");
    }
    if (!sameBytes(bytes, discoveryCanonicalJsonBytes(parsed as JsonObject))) return fail("discovery_record_invalid");
    exact(parsed, signedKeys);
    if (typeof parsed.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(parsed.signature)) return fail("discovery_signature_invalid");
    const { signature: _signature, ...rawUnsigned } = parsed;
    const normalized = normalizeUnsigned(rawUnsigned);
    if (normalized.visibility !== "public" && !normalized.audiences.includes(input.audience)) return fail("discovery_wrong_audience");
    const verified = await this.options.trust.verify({
      origin_exchange_id: normalized.origin_exchange_id,
      audience_exchange_id: input.audience,
      key_id: normalized.key_id,
      canonical: discoveryCanonicalJsonBytes(normalized as unknown as JsonValue),
      signature: parsed.signature,
    });
    if (!verified) return fail("discovery_signature_invalid");
    const now = Date.parse(timestamp(this.options.clock.now()));
    if (now + this.skewMilliseconds < Date.parse(normalized.issued_at)) return fail("discovery_not_yet_valid");
    if (now - this.skewMilliseconds > Date.parse(normalized.expires_at)) return fail("discovery_expired");
    return structuredClone({ ...normalized, signature: parsed.signature });
  }

  async verifyTombstone(bytes: Uint8Array, input: { readonly audience: string }): Promise<DiscoveryTombstone> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > DISCOVERY_MAX_MESSAGE_BYTES) return fail("discovery_record_too_large");
    identifier(input.audience);
    if (input.audience !== this.options.local_exchange_id) return fail("discovery_wrong_audience");
    let parsed: Record<string, unknown>;
    try {
      parsed = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch (error) {
      if (error instanceof DiscoveryError) throw error;
      return fail("discovery_record_invalid");
    }
    if (!sameBytes(bytes, discoveryCanonicalJsonBytes(parsed as JsonObject))) return fail("discovery_record_invalid");
    exact(parsed, tombstoneSignedKeys);
    const normalized = normalizeTombstone(parsed);
    const { signature, ...unsignedValue } = normalized;
    const verified = await this.options.trust.verify({
      origin_exchange_id: normalized.origin_exchange_id,
      audience_exchange_id: input.audience,
      key_id: normalized.key_id,
      canonical: discoveryCanonicalJsonBytes(unsignedValue as unknown as JsonValue),
      signature,
    });
    if (!verified) return fail("discovery_signature_invalid");
    const now = Date.parse(timestamp(this.options.clock.now()));
    if (now + this.skewMilliseconds < Date.parse(normalized.withdrawn_at)) return fail("discovery_not_yet_valid");
    if (now - this.skewMilliseconds > Date.parse(normalized.retain_until)) return fail("discovery_expired");
    return structuredClone(normalized);
  }
}

function normalizeTombstone(value: unknown): DiscoveryTombstone {
  const source = object(value);
  const hasSignature = Object.hasOwn(source, "signature");
  exact(source, hasSignature ? tombstoneSignedKeys : tombstoneUnsignedKeys);
  if (source.profile !== DISCOVERY_PROFILE) return fail("discovery_record_invalid");
  const withdrawnAt = timestamp(source.withdrawn_at);
  const retainUntil = timestamp(source.retain_until);
  const retention = Date.parse(retainUntil) - Date.parse(withdrawnAt);
  if (retention < 1_000 || retention > 360_000) return fail("discovery_record_invalid");
  if (typeof source.key_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(source.key_id)) return fail("discovery_record_invalid");
  const signature = hasSignature && typeof source.signature === "string" && /^[A-Za-z0-9_-]{86}$/.test(source.signature)
    ? source.signature
    : hasSignature
      ? fail("discovery_signature_invalid")
      : "";
  return {
    profile: DISCOVERY_PROFILE,
    record_id: identifier(source.record_id),
    origin_exchange_id: identifier(source.origin_exchange_id),
    revision: positive(source.revision),
    withdrawn_at: withdrawnAt,
    retain_until: retainUntil,
    key_id: source.key_id,
    signature,
  };
}
