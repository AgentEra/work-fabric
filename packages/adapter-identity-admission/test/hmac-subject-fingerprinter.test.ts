import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AdmissionRequest } from "@work-fabric/admission-spi";

import { HmacSubjectFingerprinter } from "../src/index.js";

const key = new Uint8Array(32).fill(0x41);

function request(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    tenant_id: "tenant-a",
    connector_id: "connector-a",
    source_system: "feishu",
    external_tenant_id: "external-tenant-a",
    external_subject_type: "human",
    external_subject_id: "raw-external-subject-42",
    ingress_id: "ingress-a",
    ...overrides,
  };
}

describe("HmacSubjectFingerprinter", () => {
  it("uses the documented JSON tuple and returns a deterministic bounded fingerprint", () => {
    const fingerprinter = new HmacSubjectFingerprinter(key);
    const input = request();
    const expected = `afp_${createHmac("sha256", key)
      .update(JSON.stringify([
        "workfabric-admission-subject-v1",
        input.tenant_id,
        input.connector_id,
        input.source_system,
        input.external_tenant_id,
        input.external_subject_type,
        input.external_subject_id,
      ]), "utf8")
      .digest("base64url")}`;

    expect(fingerprinter.fingerprint(input)).toBe(expected);
    expect(fingerprinter.fingerprint(input)).toBe(expected);
    expect(expected).toMatch(/^afp_[A-Za-z0-9_-]{43}$/);
    expect(expected).not.toContain(input.external_subject_id);
  });

  it("separates deployment keys and tenant scopes", () => {
    const first = new HmacSubjectFingerprinter(new Uint8Array(32).fill(1));
    const second = new HmacSubjectFingerprinter(new Uint8Array(32).fill(2));

    expect(first.fingerprint(request())).not.toBe(second.fingerprint(request()));
    expect(first.fingerprint(request())).not.toBe(
      first.fingerprint(request({ tenant_id: "tenant-b" })),
    );
  });

  it("keeps NUL-shifted cross-field tuples distinct", () => {
    const fingerprinter = new HmacSubjectFingerprinter(key);

    expect(fingerprinter.fingerprint(request({ tenant_id: "a\0b", connector_id: "c" }))).not.toBe(
      fingerprinter.fingerprint(request({ tenant_id: "a", connector_id: "b\0c" })),
    );
    expect(fingerprinter.fingerprint(request({ connector_id: "a\0b", source_system: "c" }))).not.toBe(
      fingerprinter.fingerprint(request({ connector_id: "a", source_system: "b\0c" })),
    );
    expect(fingerprinter.fingerprint(request({ external_tenant_id: "a\0b", external_subject_id: "c" }))).not.toBe(
      fingerprinter.fingerprint(request({ external_tenant_id: "a", external_subject_id: "b\0c" })),
    );
  });

  it("clones its key and rejects undersized key material", () => {
    const mutable = new Uint8Array(32).fill(7);
    const fingerprinter = new HmacSubjectFingerprinter(mutable);
    const before = fingerprinter.fingerprint(request());
    mutable.fill(9);

    expect(fingerprinter.fingerprint(request())).toBe(before);
    expect(() => new HmacSubjectFingerprinter(new Uint8Array(31))).toThrow(TypeError);
  });
});
