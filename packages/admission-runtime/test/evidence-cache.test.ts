import { describe, expect, it } from "vitest";

import type { ExternalSubjectEvidence } from "@work-fabric/admission-spi";
import { BoundedEvidenceCache, type EvidenceCacheKey } from "../src/index.js";

const epoch = Date.parse("2026-07-20T00:00:00.000Z");

function key(overrides: Partial<EvidenceCacheKey> = {}): EvidenceCacheKey {
  return {
    tenant_id: "tenant-1",
    connector_id: "connector-1",
    source_system: "source-1",
    external_tenant_id: "external-tenant-1",
    subject_type: "human",
    subject_fingerprint: "fingerprint-1",
    provider_ref: "directory-1",
    ...overrides,
  };
}

function evidence(overrides: Partial<ExternalSubjectEvidence> = {}): ExternalSubjectEvidence {
  return {
    membership: "internal",
    active: true,
    observed_at: "2026-07-20T00:00:00.000Z",
    provider_revision: "directory-revision-1",
    ...overrides,
  };
}

describe("BoundedEvidenceCache", () => {
  it("expires positive evidence at the positive TTL boundary and clones returned values", () => {
    const cache = new BoundedEvidenceCache(2);
    expect(cache.put(key(), evidence(), 10, 2, epoch)).toBe(true);

    const first = cache.get(key(), epoch + 9_999);
    expect(first).toEqual(evidence());
    (first as { membership: string }).membership = "external";
    expect(cache.get(key(), epoch + 9_999)).toEqual(evidence());
    expect(cache.get(key(), epoch + 10_000)).toBeNull();
  });

  it.each([
    ["external", true],
    ["unknown", null],
    ["internal", false],
  ] as const)("uses negative TTL for %s/%s evidence", (membership, active) => {
    const cache = new BoundedEvidenceCache(2);
    expect(cache.put(key(), evidence({ membership, active }), 10, 2, epoch)).toBe(true);
    expect(cache.get(key(), epoch + 1_999)).not.toBeNull();
    expect(cache.get(key(), epoch + 2_000)).toBeNull();
  });

  it.each([
    ["invalid timestamp", "not-a-date", epoch],
    ["non-finite timestamp", "+275760-09-13T00:00:00.001Z", epoch],
    ["future timestamp", "2026-07-20T00:00:01.000Z", epoch],
    ["already stale evidence", "2026-07-19T23:59:49.999Z", epoch],
  ])("rejects %s without caching it", (_label, observedAt, nowMs) => {
    const cache = new BoundedEvidenceCache(2);
    expect(cache.put(key(), evidence({ observed_at: observedAt }), 10, 2, nowMs)).toBe(false);
    expect(cache.size).toBe(0);
    expect(cache.get(key(), nowMs)).toBeNull();
  });

  it("evicts the oldest insertion without promoting cache hits", () => {
    const cache = new BoundedEvidenceCache(2);
    const keyA = key({ subject_fingerprint: "a" });
    const keyB = key({ subject_fingerprint: "b" });
    const keyC = key({ subject_fingerprint: "c" });
    cache.put(keyA, evidence(), 10, 2, epoch);
    cache.put(keyB, evidence(), 10, 2, epoch);
    expect(cache.get(keyA, epoch)).not.toBeNull();
    cache.put(keyC, evidence(), 10, 2, epoch);

    expect(cache.size).toBe(2);
    expect(cache.get(keyA, epoch)).toBeNull();
    expect(cache.get(keyB, epoch)).not.toBeNull();
    expect(cache.get(keyC, epoch)).not.toBeNull();
  });

  it.each([
    { connector_id: "connector-2" },
    { source_system: "source-2" },
    { external_tenant_id: "external-tenant-2" },
    { subject_type: "agent" as const },
    { subject_fingerprint: "fingerprint-2" },
    { provider_ref: "directory-2" },
  ])("isolates every cache-key component: %j", (override) => {
    const cache = new BoundedEvidenceCache(2);
    cache.put(key(), evidence(), 10, 2, epoch);
    expect(cache.get(key(override), epoch)).toBeNull();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid maximum size %s", (maximum) => {
    expect(() => new BoundedEvidenceCache(maximum)).toThrow();
  });
});
