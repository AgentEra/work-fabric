import { describe, expect, it } from "vitest";

import {
  MemoryAuditStore,
  MemoryRecoveryStore,
} from "@work-fabric/adapter-operations-memory";
import { OperationAuditRecorder, RecoveryWorker } from "../src/index.js";
import type { SemanticObservation } from "@work-fabric/operations-spi";

const requests = [
  { kind: "connector_requeue" as const, connector_id: "connector-1", ingress_id: "ingress-1", available_at: "2026-07-16T05:01:00.000Z" },
  { kind: "delivery_replay" as const, subscription_id: "subscription-1", partition_id: "partition-1", event_id: "event-1" },
  { kind: "projection_rebuild" as const, projector_id: "projector-1", partition_id: "partition-1" },
  { kind: "discrepancy_acknowledge" as const, discrepancy_id: "discrepancy-1" },
];

describe("RecoveryWorker", () => {
  it("routes each claimed request only to its owning public recovery port", async () => {
    const store = new MemoryRecoveryStore();
    for (const [index, target] of requests.entries()) {
      await store.submit({
        tenant_id: "tenant-1", recovery_id: `recovery-${index + 1}`,
        idempotency_key: `key-${index + 1}`, requested_by: "principal-1",
        requested_at: `2026-07-16T05:00:0${index}.000Z`, target,
        expected_version: 1, reason: "operator_requested",
      });
    }
    const calls: string[] = [];
    const observed: SemanticObservation[] = [];
    const worker = new RecoveryWorker(store, {
      connector_requeue: { async execute() { calls.push("connector"); return { outcome_code: "requeued" }; } },
      delivery_replay: { async execute() { calls.push("delivery"); return { outcome_code: "replayed" }; } },
      projection_rebuild: { async execute() { calls.push("projection"); return { outcome_code: "rebuilt" }; } },
      discrepancy_acknowledge: { async execute() { calls.push("discrepancy"); return { outcome_code: "acknowledged" }; } },
    }, {
      now: () => "2026-07-16T05:00:10.000Z",
      telemetry: { observe(value) { observed.push(value); } },
    });

    const result = await worker.runOnce({
      tenant_id: "tenant-1", worker_id: "worker-1", lease_seconds: 30, limit: 10,
    });
    expect(result).toEqual({ claimed: 4, completed: 4, failed: 0 });
    expect(calls).toEqual(["connector", "delivery", "projection", "discrepancy"]);
    expect(observed).toHaveLength(4);
    expect(observed.every((item) =>
      item.operation === "recovery_action" && item.outcome === "succeeded"
    )).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("recovery-1");
    for (let index = 0; index < 4; index += 1) {
      await expect(store.get("tenant-1", `recovery-${index + 1}`)).resolves.toMatchObject({
        state: "completed",
      });
    }
  });

  it("records bounded failure state and audit without propagating handler detail", async () => {
    const store = new MemoryRecoveryStore();
    const auditStore = new MemoryAuditStore();
    const audit = new OperationAuditRecorder(auditStore, {
      now: () => "2026-07-16T05:00:10.000Z",
    });
    await store.submit({
      tenant_id: "tenant-1", recovery_id: "recovery-1", idempotency_key: "key-1",
      requested_by: "principal-1", requested_at: "2026-07-16T05:00:00.000Z",
      target: requests[0]!, expected_version: 1, reason: "operator_requested",
    });
    const worker = new RecoveryWorker(store, {
      connector_requeue: { async execute() { throw new Error("Bearer secret detail"); } },
      delivery_replay: { async execute() { throw new Error("not used"); } },
      projection_rebuild: { async execute() { throw new Error("not used"); } },
      discrepancy_acknowledge: { async execute() { throw new Error("not used"); } },
    }, { now: () => "2026-07-16T05:00:10.000Z", audit });

    await expect(worker.runOnce({
      tenant_id: "tenant-1", worker_id: "worker-1", lease_seconds: 30, limit: 1,
    })).resolves.toEqual({ claimed: 1, completed: 0, failed: 1 });
    await expect(store.get("tenant-1", "recovery-1")).resolves.toMatchObject({
      state: "failed", outcome_code: "recovery_failed",
    });
    const records = (await auditStore.list({ tenant_id: "tenant-1", limit: 10 })).items;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "failed", reason_code: "recovery_failed" });
    expect(JSON.stringify(records)).not.toContain("secret detail");
  });
});
