import { describe, expect, it } from "vitest";
import {
  ADMISSION_BINDING_STORE_REQUIRED_CAPABILITIES,
  ADMISSION_DECISION_STORE_REQUIRED_CAPABILITIES,
  ADMISSION_EVIDENCE_PROVIDER_REQUIRED_CAPABILITIES,
  ADMISSION_POLICY_PROVIDER_REQUIRED_CAPABILITIES,
  AdmissionAdapterError,
  type AdmissionDecision,
  type AdmissionRequest,
  validateAdmissionRequest,
} from "@work-fabric/admission-spi";

const request = (overrides: Partial<AdmissionRequest> = {}): AdmissionRequest => ({
  tenant_id: "tenant-1",
  connector_id: "connector-1",
  source_system: "source-1",
  external_tenant_id: "external-tenant-1",
  external_subject_type: "human",
  external_subject_id: "subject-1",
  ingress_id: "ingress-1",
  idempotency_key: "command-1",
  ...overrides,
} as AdmissionRequest);

describe("admission contracts", () => {
  it("constructs every admission decision member", () => {
    const decisions: readonly AdmissionDecision[] = [
      {
        kind: "allow",
        reason_code: "explicit_allow",
        policy_id: "policy-1",
        policy_revision: "revision-1",
        binding: {
          tenant_id: "tenant-1",
          connector_id: "connector-1",
          source_system: "source-1",
          external_tenant_id: "external-tenant-1",
          external_subject_type: "human",
          external_subject_fingerprint: "fingerprint-1",
          actor_id: "actor-1",
          actor_type: "human",
          endpoint_id: "endpoint-1",
          created_at: "2026-07-20T00:00:00.000Z",
        },
        decision_id: "decision-allow-1",
      },
      {
        kind: "deny",
        reason_code: "default_deny",
        policy_id: "policy-1",
        policy_revision: "revision-1",
        decision_id: "decision-deny-1",
      },
      {
        kind: "temporarily_unavailable",
        reason_code: "policy_unavailable",
        retry_after_seconds: 30,
      },
    ];

    expect(decisions.map((decision) => decision.kind)).toEqual([
      "allow",
      "deny",
      "temporarily_unavailable",
    ]);
  });

  it("publishes exact adapter capability requirements", () => {
    expect(ADMISSION_POLICY_PROVIDER_REQUIRED_CAPABILITIES).toEqual([
      "immutable_revision",
      "source_neutral",
    ]);
    expect(ADMISSION_EVIDENCE_PROVIDER_REQUIRED_CAPABILITIES).toEqual([
      "authenticated_subject_facts",
      "tenant_binding",
      "bounded_evidence",
    ]);
    expect(ADMISSION_BINDING_STORE_REQUIRED_CAPABILITIES).toEqual([
      "atomic_get_or_create",
      "tenant_isolation",
      "stable_binding",
    ]);
    expect(ADMISSION_DECISION_STORE_REQUIRED_CAPABILITIES).toEqual([
      "ingress_idempotency",
      "tenant_isolation",
      "bounded_audit",
    ]);
  });

  it.each([
    ["tenant_id", ""],
    ["connector_id", "  "],
    ["source_system", "x".repeat(256)],
    ["external_tenant_id", "x".repeat(256)],
    ["external_subject_id", "x".repeat(256)],
    ["ingress_id", "x".repeat(129)],
    ["idempotency_key", "x".repeat(257)],
  ] as const)("rejects an invalid %s", (field, value) => {
    expect(() => validateAdmissionRequest(request({ [field]: value }))).toThrow();
  });

  it("rejects wildcard external subject identifiers", () => {
    expect(() => validateAdmissionRequest(request({ external_subject_id: "*" }))).toThrow();
  });

  it.each([
    ["a number", 1],
    ["null", null],
    ["a string-like object", { length: 1, trim() { return this; } }],
  ])("rejects %s identifier values", (_name, value) => {
    expect(() => validateAdmissionRequest(request({ tenant_id: value as string }))).toThrow();
  });

  it("exposes only stable adapter error codes", () => {
    const errors = [
      new AdmissionAdapterError("policy_unavailable", "policy fetch failed"),
      new AdmissionAdapterError("evidence_unavailable", "evidence fetch failed"),
      new AdmissionAdapterError("binding_store_unavailable", "binding store failed"),
      new AdmissionAdapterError("decision_store_unavailable", "decision store failed"),
      new AdmissionAdapterError("grant_unavailable", "grant issue failed"),
    ];

    expect(errors.map((error) => error.code)).toEqual([
      "policy_unavailable",
      "evidence_unavailable",
      "binding_store_unavailable",
      "decision_store_unavailable",
      "grant_unavailable",
    ]);
  });
});
