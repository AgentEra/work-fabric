import assert from "node:assert/strict";

import {
  ADMISSION_BINDING_STORE_REQUIRED_CAPABILITIES,
  type AdmissionRequest,
  type ParticipantBindingStore,
} from "@work-fabric/admission-spi";
import { assertCapabilities } from "@work-fabric/exchange-spi";

export type ParticipantBindingStoreFactory = () => ParticipantBindingStore;

function request(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    tenant_id: "tenant-profile",
    connector_id: "connector-profile",
    source_system: "source-profile",
    external_tenant_id: "external-tenant-profile",
    external_subject_type: "human",
    external_subject_id: "not-persisted",
    ingress_id: "ingress-profile",
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<ParticipantBindingStore["getOrCreate"]>[0]> = {}) {
  return {
    request: request(),
    external_subject_fingerprint: "fingerprint-profile",
    actor_id: "actor-profile",
    endpoint_id: "endpoint-profile",
    created_at: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

export async function runParticipantBindingStoreProfile(
  factory: ParticipantBindingStoreFactory,
): Promise<void> {
  const store = factory();
  assert.equal(store.manifest.profile, "admission.binding-store.v1");
  assertCapabilities(store.manifest, ADMISSION_BINDING_STORE_REQUIRED_CAPABILITIES);

  const firstInput = input();
  const first = await store.getOrCreate(firstInput);
  const repeated = await store.getOrCreate(input({
    actor_id: "actor-should-not-replace",
    endpoint_id: "endpoint-should-not-replace",
    created_at: "2026-07-21T00:00:00.000Z",
  }));
  assert.deepEqual(repeated, first, "repeated binding lookup must be stable");

  const concurrentStore = factory();
  const converged = await Promise.all(Array.from({ length: 16 }, (_, index) =>
    concurrentStore.getOrCreate(input({
      external_subject_fingerprint: "converged-fingerprint",
      actor_id: `actor-converged-${index}`,
      endpoint_id: `endpoint-converged-${index}`,
    })),
  ));
  for (const binding of converged) assert.deepEqual(binding, converged[0]);

  for (const [label, changedRequest, fingerprint] of [
    ["tenant_id", request({ tenant_id: "tenant-other" }), "fingerprint-profile"],
    ["connector_id", request({ connector_id: "connector-other" }), "fingerprint-profile"],
    ["source_system", request({ source_system: "source-other" }), "fingerprint-profile"],
    ["external_tenant_id", request({ external_tenant_id: "external-tenant-other" }), "fingerprint-profile"],
    ["external_subject_type", request({ external_subject_type: "agent" }), "fingerprint-profile"],
    ["external_subject_fingerprint", request(), "fingerprint-other"],
  ] as const) {
    const isolated = await store.getOrCreate(input({
      request: changedRequest,
      external_subject_fingerprint: fingerprint,
      actor_id: `actor-isolated-${label}`,
      endpoint_id: `endpoint-isolated-${label}`,
    }));
    assert.notEqual(isolated.actor_id, first.actor_id, `${label} must isolate Actor bindings`);
    assert.notEqual(isolated.endpoint_id, first.endpoint_id, `${label} must isolate Endpoint bindings`);
  }

  const mutable = input({
    request: request({ tenant_id: "tenant-clone" }),
    external_subject_fingerprint: "fingerprint-clone",
    actor_id: "actor-clone",
    endpoint_id: "endpoint-clone",
  });
  const cloned = await store.getOrCreate(mutable);
  (mutable.request as { tenant_id: string }).tenant_id = "tenant-mutated";
  (cloned as { actor_id: string }).actor_id = "actor-mutated";
  const reloaded = await store.getOrCreate(input({
    request: request({ tenant_id: "tenant-clone" }),
    external_subject_fingerprint: "fingerprint-clone",
    actor_id: "actor-reload",
    endpoint_id: "endpoint-reload",
  }));
  assert.equal(reloaded.actor_id, "actor-clone", "bindings must clone write inputs and returned values");
}
