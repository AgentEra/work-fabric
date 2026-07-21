import { describe, expect, it } from "vitest";

import type {
  AdmissionDecisionRecord,
  AdmissionRequest,
} from "@work-fabric/admission-spi";
import {
  runAdmissionDecisionStoreProfile,
  runParticipantBindingStoreProfile,
} from "../../admission-conformance/src/index.js";
import {
  MemoryAdmissionDecisionStore,
  MemoryParticipantBindingStore,
} from "../src/index.js";

function request(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    tenant_id: "tenant-1",
    connector_id: "connector-1",
    source_system: "source-1",
    external_tenant_id: "external-tenant-1",
    external_subject_type: "human",
    external_subject_id: "subject-1",
    ingress_id: "ingress-1",
    idempotency_key: "command-1",
    ...overrides,
  };
}

function record(overrides: Partial<AdmissionDecisionRecord> = {}): AdmissionDecisionRecord {
  return {
    decision: {
      kind: "deny",
      reason_code: "default_deny",
      policy_id: "policy-1",
      policy_revision: "revision-1",
      decision_id: "decision-1",
    },
    scope: {
      tenant_id: "tenant-1",
      connector_id: "connector-1",
      source_system: "source-1",
      external_tenant_id: "external-tenant-1",
    },
    ingress_id: "ingress-1",
    idempotency_key: "command-1",
    external_subject_fingerprint: "fingerprint-1",
    recorded_at: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("Memory admission stores", () => {
  it("declares that atomicity is process-local", () => {
    expect(new MemoryParticipantBindingStore().manifest.capabilities.process_local_atomicity).toBe(true);
    expect(new MemoryAdmissionDecisionStore().manifest.capabilities.process_local_atomicity).toBe(true);
  });

  it("conforms to the participant binding store profile", async () => {
    await runParticipantBindingStoreProfile(() => new MemoryParticipantBindingStore());
  });

  it("conforms to the admission decision store profile", async () => {
    await runAdmissionDecisionStoreProfile(() => new MemoryAdmissionDecisionStore());
  });

  it("fails closed when one ingress is replayed with another command idempotency key", async () => {
    const store = new MemoryAdmissionDecisionStore();
    await expect(store.record(record())).resolves.toEqual(record());
    await expect(store.record(record({ idempotency_key: "command-2" }))).rejects.toMatchObject({
      code: "decision_store_unavailable",
      message: "admission_decision_conflict",
    });
  });

  it("keeps NUL-shifted binding tuple components distinct", async () => {
    const store = new MemoryParticipantBindingStore();
    const first = await store.getOrCreate({
      request: request({ tenant_id: "a\0b", connector_id: "c" }),
      external_subject_fingerprint: "fingerprint",
      actor_id: "actor-first",
      endpoint_id: "endpoint-first",
      created_at: "2026-07-20T00:00:00.000Z",
    });
    const second = await store.getOrCreate({
      request: request({ tenant_id: "a", connector_id: "b\0c" }),
      external_subject_fingerprint: "fingerprint",
      actor_id: "actor-second",
      endpoint_id: "endpoint-second",
      created_at: "2026-07-20T00:00:00.000Z",
    });

    expect(second).not.toEqual(first);
    expect(second.actor_id).toBe("actor-second");
  });

  it("keeps NUL-shifted decision tuple components distinct", async () => {
    const store = new MemoryAdmissionDecisionStore();
    const first = record({
      scope: { tenant_id: "a\0b", connector_id: "c", source_system: "source", external_tenant_id: "external" },
      ingress_id: "ingress",
      decision: { kind: "deny", reason_code: "default_deny", policy_id: "policy", policy_revision: "revision", decision_id: "first" },
    });
    const second = record({
      scope: { tenant_id: "a", connector_id: "b\0c", source_system: "source", external_tenant_id: "external" },
      ingress_id: "ingress",
      decision: { kind: "deny", reason_code: "default_deny", policy_id: "policy", policy_revision: "revision", decision_id: "second" },
    });

    await store.record(first);
    await store.record(second);

    await expect(store.findByIngress({ ...first.scope, ingress_id: first.ingress_id })).resolves.toEqual(first);
    await expect(store.findByIngress({ ...second.scope, ingress_id: second.ingress_id })).resolves.toEqual(second);
  });
});
