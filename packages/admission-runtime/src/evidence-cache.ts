import type { AdmissionSubjectType, ExternalSubjectEvidence } from "@work-fabric/admission-spi";

export interface EvidenceCacheKey {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly source_system: string;
  readonly external_tenant_id: string;
  readonly subject_type: AdmissionSubjectType;
  readonly subject_fingerprint: string;
  readonly provider_ref: string;
}

interface EvidenceCacheEntry {
  readonly evidence: ExternalSubjectEvidence;
  readonly expires_at_ms: number;
}

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function cacheKey(key: EvidenceCacheKey): string {
  return [
    key.tenant_id,
    key.connector_id,
    key.source_system,
    key.external_tenant_id,
    key.subject_type,
    key.subject_fingerprint,
    key.provider_ref,
  ].join("\0");
}

export class BoundedEvidenceCache {
  private readonly entries = new Map<string, EvidenceCacheEntry>();

  constructor(private readonly maximumEntries: number) {
    positiveSafeInteger(maximumEntries, "maximumEntries");
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: EvidenceCacheKey, nowMs: number): ExternalSubjectEvidence | null {
    const encoded = cacheKey(key);
    const entry = this.entries.get(encoded);
    if (entry === undefined) return null;
    if (entry.expires_at_ms <= nowMs) {
      this.entries.delete(encoded);
      return null;
    }
    return structuredClone(entry.evidence);
  }

  put(
    key: EvidenceCacheKey,
    evidence: ExternalSubjectEvidence,
    positiveTtlSeconds: number,
    negativeTtlSeconds: number,
    nowMs: number,
  ): boolean {
    const observedAtMs = Date.parse(evidence.observed_at);
    if (!Number.isFinite(observedAtMs) || observedAtMs > nowMs) return false;
    const ttlSeconds = evidence.membership === "internal" && evidence.active === true
      ? positiveTtlSeconds
      : negativeTtlSeconds;
    const expiresAtMs = observedAtMs + ttlSeconds * 1_000;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return false;

    const encoded = cacheKey(key);
    if (!this.entries.has(encoded) && this.entries.size >= this.maximumEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(encoded, { evidence: structuredClone(evidence), expires_at_ms: expiresAtMs });
    return true;
  }
}
