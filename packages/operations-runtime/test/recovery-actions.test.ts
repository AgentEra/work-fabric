import { describe, expect, it } from "vitest";

import { MemoryDiscrepancyStore } from "@work-fabric/adapter-operations-memory";
import {
  ConnectorRequeueRecoveryAction,
  DiscrepancyAcknowledgeRecoveryAction,
  ProjectionRebuildRecoveryAction,
} from "../src/index.js";

function claim(target: Parameters<ConnectorRequeueRecoveryAction["execute"]>[0]["target"], expectedVersion: number) {
  return {
    tenant_id: "tenant-1", recovery_id: "recovery-1", idempotency_key: "key-1",
    requested_by: "principal-1", requested_at: "2026-07-16T06:00:00.000Z",
    target, expected_version: expectedVersion, reason: "operator_requested",
    state: "processing" as const, version: 2, attempt: 1, outcome_code: null,
    completed_at: null, claim_owner: "worker-1", claim_token: "claim-1",
    fencing_token: 1, lease_expires_at: "2026-07-16T06:01:00.000Z",
  };
}

describe("public recovery action adapters", () => {
  it("checks Connector ingress attempt before calling the owning requeue method", async () => {
    const calls: unknown[] = [];
    const ingress = {
      manifest: { profile: "connector.ingress.v1", adapter: "test", capabilities: {} },
      async get() { return { ingress_id: "ingress-1", envelope: { tenant_id: "tenant-1", connector_id: "connector-1" }, state: "dead_letter", attempt: 2 }; },
      async requeue(input: unknown) { calls.push(input); return {}; },
    } as never;
    const action = new ConnectorRequeueRecoveryAction(ingress, {
      now: () => "2026-07-16T06:00:10.000Z",
    });
    const target = { kind: "connector_requeue" as const, connector_id: "connector-1", ingress_id: "ingress-1", available_at: "2026-07-16T06:02:00.000Z" };
    await expect(action.execute(claim(target, 1))).rejects.toThrow(/version/i);
    await expect(action.execute(claim(target, 2))).resolves.toEqual({ outcome_code: "connector_requeued" });
    expect(calls).toEqual([{
      tenant_id: "tenant-1", connector_id: "connector-1", ingress_id: "ingress-1",
      now: "2026-07-16T06:00:10.000Z", available_at: "2026-07-16T06:02:00.000Z",
      reason: "operator_requested",
    }]);
  });

  it("uses discrepancy optimistic acknowledgement without changing reconciliation facts", async () => {
    const store = new MemoryDiscrepancyStore();
    await store.put({
      discrepancy_id: "discrepancy-1", tenant_id: "tenant-1", connector_id: "connector-1",
      external_object_id: "external-1", resource_id: "handoff-1", expected_state: "accepted",
      expected_version: 3, observed_state: "declined", observed_at: "2026-07-16T05:00:00.000Z",
      metadata: {}, status: "open", version: 1, acknowledged_at: null,
      acknowledged_by: null, acknowledgement_reason: null,
    });
    const action = new DiscrepancyAcknowledgeRecoveryAction(store, {
      now: () => "2026-07-16T06:00:10.000Z",
    });
    const result = await action.execute(claim({
      kind: "discrepancy_acknowledge", discrepancy_id: "discrepancy-1",
    }, 1));
    expect(result).toEqual({ outcome_code: "discrepancy_acknowledged" });
    await expect(store.get("tenant-1", "discrepancy-1")).resolves.toMatchObject({
      expected_state: "accepted", observed_state: "declined", status: "acknowledged",
    });
  });

  it("checks projection checkpoint before invoking an explicit partition rebuild", async () => {
    const rebuilt: string[] = [];
    const action = new ProjectionRebuildRecoveryAction({
      async currentVersion() { return 4; },
      async rebuild(_tenant, _projector, partition) { rebuilt.push(partition); },
    });
    const target = { kind: "projection_rebuild" as const, projector_id: "projector-1", partition_id: "partition-1" };
    await expect(action.execute(claim(target, 3))).rejects.toThrow(/version/i);
    await expect(action.execute(claim(target, 4))).resolves.toEqual({ outcome_code: "projection_rebuilt" });
    expect(rebuilt).toEqual(["partition-1"]);
  });
});
