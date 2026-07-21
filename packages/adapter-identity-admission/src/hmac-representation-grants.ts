import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  AdmissionRequest,
  AdmissionSubjectType,
  RepresentationGrantIssuer,
  RepresentationGrantVerifier,
} from "@work-fabric/admission-spi";
import {
  addUtcTimestampSeconds,
  compareUtcTimestamps,
  parseUtcTimestamp,
} from "@work-fabric/exchange-spi";

const PAYLOAD_KEYS = [
  "v",
  "kid",
  "grant_id",
  "tenant_id",
  "connector_id",
  "ingress_id",
  "idempotency_key",
  "decision_id",
  "actor_id",
  "actor_type",
  "endpoint_id",
  "external_subject_fingerprint",
  "issued_at",
  "expires_at",
] as const;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ACTOR_TYPES = new Set<AdmissionSubjectType>(["human", "agent", "system"]);
const MAX_GRANT_LENGTH = 16_384;

export interface AdmissionGrantPayload {
  readonly v: 2;
  readonly kid: string;
  readonly grant_id: string;
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly ingress_id: string;
  readonly idempotency_key: string;
  readonly decision_id: string;
  readonly actor_id: string;
  readonly actor_type: AdmissionSubjectType;
  readonly endpoint_id: string;
  readonly external_subject_fingerprint: string;
  readonly issued_at: string;
  readonly expires_at: string;
}

export interface HmacRepresentationGrantsOptions {
  readonly active_key_id: string;
  readonly keys: Readonly<Record<string, Uint8Array>>;
  readonly clock: { now(): string };
  readonly ids: { grantId(): string };
}

function boundedIdentifier(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value.trim() === value;
}

function isPayload(value: unknown): value is AdmissionGrantPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).length !== PAYLOAD_KEYS.length
    || PAYLOAD_KEYS.some((key) => !Object.hasOwn(payload, key))
  ) return false;
  return payload.v === 2
    && boundedIdentifier(payload.kid, 128)
    && boundedIdentifier(payload.grant_id, 128)
    && boundedIdentifier(payload.tenant_id, 255)
    && boundedIdentifier(payload.connector_id, 255)
    && boundedIdentifier(payload.ingress_id, 128)
    && boundedIdentifier(payload.idempotency_key, 256)
    && boundedIdentifier(payload.decision_id, 128)
    && boundedIdentifier(payload.actor_id, 128)
    && typeof payload.actor_type === "string"
    && ACTOR_TYPES.has(payload.actor_type as AdmissionSubjectType)
    && boundedIdentifier(payload.endpoint_id, 128)
    && boundedIdentifier(payload.external_subject_fingerprint, 255)
    && typeof payload.issued_at === "string"
    && typeof payload.expires_at === "string";
}

function serializePayload(payload: AdmissionGrantPayload): string {
  return JSON.stringify({
    v: payload.v,
    kid: payload.kid,
    grant_id: payload.grant_id,
    tenant_id: payload.tenant_id,
    connector_id: payload.connector_id,
    ingress_id: payload.ingress_id,
    idempotency_key: payload.idempotency_key,
    decision_id: payload.decision_id,
    actor_id: payload.actor_id,
    actor_type: payload.actor_type,
    endpoint_id: payload.endpoint_id,
    external_subject_fingerprint: payload.external_subject_fingerprint,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
  });
}

function validTimes(payload: AdmissionGrantPayload, now: string): boolean {
  try {
    parseUtcTimestamp(now, "grant verification time");
    parseUtcTimestamp(payload.issued_at, "grant issued_at");
    parseUtcTimestamp(payload.expires_at, "grant expires_at");
    return compareUtcTimestamps(payload.expires_at, payload.issued_at) > 0
      && compareUtcTimestamps(
        payload.expires_at,
        addUtcTimestampSeconds(payload.issued_at, 300),
      ) <= 0
      && compareUtcTimestamps(now, payload.expires_at) < 0
      && compareUtcTimestamps(
        payload.issued_at,
        addUtcTimestampSeconds(now, 30),
      ) <= 0;
  } catch {
    return false;
  }
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
  if (!BASE64URL.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

function sameBindingScope(request: AdmissionRequest, binding: {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly source_system: string;
  readonly external_tenant_id: string;
  readonly external_subject_type: AdmissionSubjectType;
  readonly actor_type: AdmissionSubjectType;
}): boolean {
  return binding.tenant_id === request.tenant_id
    && binding.connector_id === request.connector_id
    && binding.source_system === request.source_system
    && binding.external_tenant_id === request.external_tenant_id
    && binding.external_subject_type === request.external_subject_type
    && binding.actor_type === request.external_subject_type;
}

export class HmacRepresentationGrants implements RepresentationGrantIssuer, RepresentationGrantVerifier {
  private readonly activeKeyId: string;
  private readonly keys = new Map<string, Uint8Array>();
  private readonly clock: { now(): string };
  private readonly ids: { grantId(): string };

  constructor(options: HmacRepresentationGrantsOptions) {
    if (!boundedIdentifier(options.active_key_id, 128)) {
      throw new TypeError("active_key_id must be a bounded identifier");
    }
    if (
      typeof options.keys !== "object"
      || options.keys === null
      || !Object.hasOwn(options.keys, options.active_key_id)
    ) {
      throw new TypeError("active_key_id must name an own configured key");
    }
    for (const keyId of Object.keys(options.keys)) {
      const descriptor = Object.getOwnPropertyDescriptor(options.keys, keyId);
      const key = descriptor?.value;
      if (!boundedIdentifier(keyId, 128) || !(key instanceof Uint8Array) || key.byteLength < 32) {
        throw new TypeError("Grant keys must be own entries containing at least 32 bytes");
      }
      this.keys.set(keyId, Uint8Array.from(key));
    }
    if (!this.keys.has(options.active_key_id)) {
      throw new TypeError("active_key_id must name an own configured key");
    }
    this.activeKeyId = options.active_key_id;
    this.clock = options.clock;
    this.ids = options.ids;
  }

  async issue(input: Parameters<RepresentationGrantIssuer["issue"]>[0]): Promise<string> {
    const binding = input.decision.binding;
    if (input.decision.kind !== "allow" || !sameBindingScope(input.request, binding)) {
      throw new TypeError("Admission binding does not match the request");
    }
    const issuedAt = this.clock.now();
    const payload: AdmissionGrantPayload = {
      v: 2,
      kid: this.activeKeyId,
      grant_id: this.ids.grantId(),
      tenant_id: input.request.tenant_id,
      connector_id: input.request.connector_id,
      ingress_id: input.request.ingress_id,
      idempotency_key: input.request.idempotency_key,
      decision_id: input.decision.decision_id,
      actor_id: binding.actor_id,
      actor_type: binding.actor_type,
      endpoint_id: binding.endpoint_id,
      external_subject_fingerprint: binding.external_subject_fingerprint,
      issued_at: issuedAt,
      expires_at: input.expires_at,
    };
    if (!isPayload(payload) || !validTimes(payload, issuedAt)) {
      throw new TypeError("Representation grant input is invalid");
    }
    const payloadBytes = Buffer.from(serializePayload(payload), "utf8");
    const key = this.keys.get(this.activeKeyId);
    if (key === undefined) throw new TypeError("Active grant key is unavailable");
    const signature = createHmac("sha256", key).update(payloadBytes).digest("base64url");
    return `${payloadBytes.toString("base64url")}.${signature}`;
  }

  async verify(
    grant: string,
    now: string,
  ): Promise<Awaited<ReturnType<RepresentationGrantVerifier["verify"]>>> {
    try {
      if (typeof grant !== "string" || grant.length === 0 || grant.length > MAX_GRANT_LENGTH) {
        return null;
      }
      const parts = grant.split(".");
      if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
      const payloadBytes = decodeCanonicalBase64Url(parts[0]!);
      const signature = decodeCanonicalBase64Url(parts[1]!);
      if (payloadBytes === null || signature === null || signature.byteLength !== 32) return null;

      const untrusted: unknown = JSON.parse(payloadBytes.toString("utf8"));
      if (typeof untrusted !== "object" || untrusted === null || Array.isArray(untrusted)) return null;
      const untrustedKid = (untrusted as Record<string, unknown>).kid;
      if (typeof untrustedKid !== "string") return null;
      const key = this.keys.get(untrustedKid);
      if (key === undefined) return null;
      const expected = createHmac("sha256", key).update(payloadBytes).digest();
      if (!timingSafeEqual(signature, expected)) return null;
      if (!isPayload(untrusted)) return null;
      const canonicalBytes = Buffer.from(serializePayload(untrusted), "utf8");
      if (!canonicalBytes.equals(payloadBytes) || !validTimes(untrusted, now)) return null;

      return {
        tenant_id: untrusted.tenant_id,
        connector_id: untrusted.connector_id,
        ingress_id: untrusted.ingress_id,
        idempotency_key: untrusted.idempotency_key,
        decision_id: untrusted.decision_id,
        actor_id: untrusted.actor_id,
        actor_type: untrusted.actor_type,
        endpoint_id: untrusted.endpoint_id,
        external_subject_fingerprint: untrusted.external_subject_fingerprint,
        expires_at: untrusted.expires_at,
      };
    } catch {
      return null;
    }
  }
}
