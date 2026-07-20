import assert from "node:assert/strict";

import {
  ADMISSION_DECISION_STORE_REQUIRED_CAPABILITIES,
  AdmissionAdapterError,
  type AdmissionDecisionRecord,
  type AdmissionDecisionStore,
  type AdmissionScope,
} from "@work-fabric/admission-spi";
import { assertCapabilities } from "@work-fabric/exchange-spi";

export type AdmissionDecisionStoreFactory = () => AdmissionDecisionStore;

const forbiddenKeys = new Set([
  "external_subject_id",
  "representation_grant",
  "token",
  "secret",
  "message",
  "content",
]);

function scope(overrides: Partial<AdmissionScope> = {}): AdmissionScope {
  return {
    tenant_id: "tenant-profile",
    connector_id: "connector-profile",
    source_system: "source-profile",
    external_tenant_id: "external-tenant-profile",
    ...overrides,
  };
}

function record(overrides: Partial<AdmissionDecisionRecord> = {}): AdmissionDecisionRecord {
  return {
    decision: {
      kind: "allow",
      reason_code: "explicit_allow",
      policy_id: "policy-profile",
      policy_revision: "revision-profile",
      decision_id: "decision-profile",
      binding: {
        ...scope(),
        external_subject_type: "human",
        external_subject_fingerprint: "fingerprint-profile",
        actor_id: "actor-profile",
        actor_type: "human",
        endpoint_id: "endpoint-profile",
        created_at: "2026-07-20T00:00:00.000Z",
      },
    },
    scope: scope(),
    ingress_id: "ingress-profile",
    external_subject_fingerprint: "fingerprint-profile",
    evidence: {
      membership: "internal",
      active: true,
      observed_at: "2026-07-20T00:00:00.000Z",
      provider_revision: "provider-profile",
    },
    recorded_at: "2026-07-20T00:00:01.000Z",
    ...overrides,
  };
}

function assertNoPrivateData(value: unknown): void {
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== "object") return;
    for (const [key, child] of Object.entries(candidate)) {
      assert.equal(forbiddenKeys.has(key), false, `serialized decision contains forbidden key ${key}`);
      visit(child);
    }
  };
  visit(JSON.parse(JSON.stringify(value)) as unknown);
}

async function rejects(operation: () => Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(operation, () => true, message);
}

export async function runAdmissionDecisionStoreProfile(
  factory: AdmissionDecisionStoreFactory,
): Promise<void> {
  const store = factory();
  assert.equal(store.manifest.profile, "admission.decision-store.v1");
  assertCapabilities(store.manifest, ADMISSION_DECISION_STORE_REQUIRED_CAPABILITIES);

  const first = record();
  const recorded = await store.record(first);
  assertNoPrivateData(recorded);
  (first.decision as { binding: { actor_id: string } }).binding.actor_id = "actor-mutated-input";
  (recorded.decision as { binding: { actor_id: string } }).binding.actor_id = "actor-mutated-output";
  const found = await store.findByIngress({ ...scope(), ingress_id: "ingress-profile" });
  assert.equal(found?.decision.kind, "allow");
  assert.equal((found!.decision as { binding: { actor_id: string } }).binding.actor_id, "actor-profile");
  (found!.decision as { binding: { actor_id: string } }).binding.actor_id = "actor-mutated-read";
  const reread = await store.findByIngress({ ...scope(), ingress_id: "ingress-profile" });
  assert.equal((reread!.decision as { binding: { actor_id: string } }).binding.actor_id, "actor-profile");

  const repeated = await store.record(record());
  assert.deepEqual(repeated, record(), "identical ingress records must be idempotent");
  await assert.rejects(
    () => store.record(record({ decision: {
      kind: "deny", reason_code: "default_deny", policy_id: "policy-profile", policy_revision: "revision-profile", decision_id: "conflict",
    } })),
    (error: unknown) => error instanceof AdmissionAdapterError
      && error.code === "decision_store_unavailable"
      && error.message === "admission_decision_conflict",
    "conflicting ingress records must fail without exposing record data",
  );

  for (const [label, changedScope, ingressId] of [
    ["tenant_id", scope({ tenant_id: "tenant-other" }), "ingress-profile"],
    ["connector_id", scope({ connector_id: "connector-other" }), "ingress-profile"],
    ["source_system", scope({ source_system: "source-other" }), "ingress-profile"],
    ["external_tenant_id", scope({ external_tenant_id: "external-tenant-other" }), "ingress-profile"],
    ["ingress_id", scope(), "ingress-other"],
  ] as const) {
    assert.equal(await store.findByIngress({ ...changedScope, ingress_id: ingressId }), null, `${label} lookup must not leak another record`);
    const isolated = record({
      scope: changedScope,
      ingress_id: ingressId,
      decision: { kind: "deny", reason_code: "default_deny", policy_id: "policy-profile", policy_revision: "revision-profile", decision_id: `decision-${label}` },
    });
    assert.deepEqual(await store.record(isolated), isolated);
    assert.deepEqual(await store.findByIngress({ ...changedScope, ingress_id: ingressId }), isolated);
  }

  for (const forbidden of forbiddenKeys) {
    const unsafe = {
      ...record({
        scope: scope({ tenant_id: `tenant-private-${forbidden}` }),
        ingress_id: `ingress-private-${forbidden}`,
      }),
      [forbidden]: `raw-${forbidden}`,
    } as unknown as AdmissionDecisionRecord;
    await rejects(() => store.record(unsafe), `${forbidden} must not be retained in decision records`);
  }
  const nestedUnsafe = record({
    scope: scope({ tenant_id: "tenant-private-nested" }),
    ingress_id: "ingress-private-nested",
    decision: {
      ...record().decision,
      diagnostics: { token: "raw-token" },
    } as unknown as AdmissionDecisionRecord["decision"],
  });
  await rejects(() => store.record(nestedUnsafe), "privacy scanning must recurse through serialized decisions");
}
