import { describe, expect, it } from "vitest";

import { RecoveryStoreError } from "@work-fabric/operations-spi";
import { MemoryRecoveryStore } from "../src/index.js";

const request = {
  tenant_id: "tenant-1",
  recovery_id: "recovery-1",
  idempotency_key: "recovery-key-1",
  requested_by: "principal-1",
  requested_at: "2026-07-16T04:00:00.000Z",
  target: {
    kind: "connector_requeue" as const,
    connector_id: "connector-1",
    ingress_id: "ingress-1",
    available_at: "2026-07-16T04:01:00.000Z",
  },
  expected_version: 2,
  reason: "operator_requested",
};

describe("MemoryRecoveryStore", () => {
  it("submits idempotently and rejects a reused key with different intent", async () => {
    const store = new MemoryRecoveryStore();
    const accepted = await store.submit(request);
    expect(accepted).toMatchObject({
      kind: "accepted",
      recovery: { state: "pending", version: 1, attempt: 0 },
    });
    await expect(store.submit(structuredClone(request))).resolves.toMatchObject({ kind: "replayed" });
    await expect(store.submit({
      ...request,
      recovery_id: "recovery-2",
      target: { ...request.target, ingress_id: "ingress-2" },
    })).resolves.toEqual({ kind: "conflict", recovery_id: "recovery-1" });
    await expect(store.get("tenant-2", "recovery-1")).resolves.toBeNull();
  });

  it("claims with fencing and prevents a stale worker from completing", async () => {
    const store = new MemoryRecoveryStore();
    await store.submit(request);
    const [first] = await store.claim({
      tenant_id: "tenant-1", worker_id: "worker-1",
      now: "2026-07-16T04:00:00.000Z", lease_seconds: 30, limit: 1,
    });
    expect(first).toMatchObject({ state: "processing", attempt: 1, fencing_token: 1 });
    const [second] = await store.claim({
      tenant_id: "tenant-1", worker_id: "worker-2",
      now: "2026-07-16T04:01:00.000Z", lease_seconds: 30, limit: 1,
    });
    expect(second).toMatchObject({ attempt: 2, fencing_token: 2 });
    await expect(store.complete({
      tenant_id: "tenant-1", recovery_id: "recovery-1",
      claim_token: first?.claim_token ?? "", fencing_token: first?.fencing_token ?? 0,
      completed_at: "2026-07-16T04:01:01.000Z", outcome_code: "completed",
    })).rejects.toMatchObject({ code: "claim_lost" } satisfies Partial<RecoveryStoreError>);
    await expect(store.complete({
      tenant_id: "tenant-1", recovery_id: "recovery-1",
      claim_token: second?.claim_token ?? "", fencing_token: second?.fencing_token ?? 0,
      completed_at: "2026-07-16T04:01:01.000Z", outcome_code: "completed",
    })).resolves.toMatchObject({ state: "completed", outcome_code: "completed" });
  });

  it("validates bounded reasons and immutable target intent", async () => {
    const store = new MemoryRecoveryStore();
    await expect(store.submit({ ...request, reason: "Bearer secret" })).rejects.toThrow(/reason/i);
    await store.submit(request);
    const loaded = await store.get("tenant-1", "recovery-1");
    if (loaded?.target.kind === "connector_requeue") {
      (loaded.target as { ingress_id: string }).ingress_id = "mutated";
    }
    await expect(store.get("tenant-1", "recovery-1")).resolves.toMatchObject({
      target: { ingress_id: "ingress-1" },
    });
  });
});
