import { strict as assert } from "node:assert";

import {
  RecoveryStoreError,
  type RecoveryRequestStore,
} from "@work-fabric/operations-spi";

export type RecoveryStoreProfileFactory = (
  tenantId: string,
) => RecoveryRequestStore | Promise<RecoveryRequestStore>;

export async function verifyRecoveryStoreProfile(
  factory: RecoveryStoreProfileFactory,
): Promise<void> {
  const tenant = "tenant_recovery_profile";
  const store = await factory(tenant);
  assert.equal(store.manifest.profile, "workfabric.recovery-request.v1");
  const request = {
    tenant_id: tenant,
    recovery_id: "recovery_profile_01",
    idempotency_key: "key_profile_01",
    requested_by: "principal_profile",
    requested_at: "2026-07-16T06:00:00.000Z",
    target: {
      kind: "projection_rebuild" as const,
      projector_id: "projector_profile",
      partition_id: "partition_profile",
    },
    expected_version: 3,
    reason: "operator_requested",
  };
  const accepted = await store.submit(request);
  assert.equal(accepted.kind, "accepted");
  assert.equal((await store.submit(structuredClone(request))).kind, "replayed");
  assert.deepEqual(await store.submit({
    ...request,
    recovery_id: "recovery_profile_02",
    target: { ...request.target, partition_id: "partition_other" },
  }), { kind: "conflict", recovery_id: request.recovery_id });
  const loaded = await store.get(tenant, request.recovery_id);
  assert.equal(loaded?.state, "pending");
  if (loaded !== null) (loaded.target as { partition_id: string }).partition_id = "mutated";
  assert.equal((await store.get(tenant, request.recovery_id))?.target.kind, "projection_rebuild");
  const other = await factory("tenant_recovery_other");
  assert.equal(await other.get("tenant_recovery_other", request.recovery_id), null);

  const first = (await store.claim({
    tenant_id: tenant, worker_id: "worker_profile_1",
    now: "2026-07-16T06:00:01.000Z", lease_seconds: 10, limit: 1,
  }))[0];
  assert.ok(first);
  const second = (await store.claim({
    tenant_id: tenant, worker_id: "worker_profile_2",
    now: "2026-07-16T06:00:20.000Z", lease_seconds: 10, limit: 1,
  }))[0];
  assert.ok(second);
  assert.ok(second.fencing_token > first.fencing_token);
  await assert.rejects(
    store.complete({
      tenant_id: tenant, recovery_id: request.recovery_id,
      claim_token: first.claim_token, fencing_token: first.fencing_token,
      completed_at: "2026-07-16T06:00:21.000Z", outcome_code: "completed",
    }),
    (error: unknown) => error instanceof RecoveryStoreError && error.code === "claim_lost",
  );
  const completed = await store.complete({
    tenant_id: tenant, recovery_id: request.recovery_id,
    claim_token: second.claim_token, fencing_token: second.fencing_token,
    completed_at: "2026-07-16T06:00:21.000Z", outcome_code: "completed",
  });
  assert.equal(completed.state, "completed");
  assert.deepEqual(await store.claim({
    tenant_id: tenant, worker_id: "worker_profile_3",
    now: "2026-07-16T06:01:00.000Z", lease_seconds: 10, limit: 1,
  }), []);
}
