import { describe, expect, it } from "vitest";

import { MemoryRecoveryStore } from "@work-fabric/adapter-operations-memory";
import { RecoveryService } from "../src/index.js";

describe("RecoveryService", () => {
  it("persists explicit intent idempotently without executing the target action", async () => {
    const store = new MemoryRecoveryStore();
    let tick = 0;
    const service = new RecoveryService(store, {
      now: () => `2026-07-16T05:00:0${tick++}.000Z`,
    });
    const input = {
      request_id: "request-1",
      trace_id: null,
      idempotency_key: "recovery-key-1",
      target: {
        kind: "projection_rebuild" as const,
        projector_id: "projector-1",
        partition_id: "partition-1",
      },
      expected_version: 5,
      reason: "operator_requested",
    };

    const accepted = await service.request("tenant-1", "principal-1", input);
    const replay = await service.request("tenant-1", "principal-1", structuredClone(input));
    const conflict = await service.request("tenant-1", "principal-1", {
      ...input,
      target: { ...input.target, partition_id: "partition-2" },
    });
    expect(accepted).toMatchObject({ kind: "accepted", recovery: { state: "pending" } });
    if (accepted.kind === "conflict" || replay.kind === "conflict") {
      throw new Error("expected accepted recovery results");
    }
    expect(replay).toMatchObject({ kind: "replayed", recovery: { recovery_id: accepted.recovery.recovery_id } });
    expect(replay.recovery.requested_at).toBe("2026-07-16T05:00:00.000Z");
    expect(conflict).toEqual({ kind: "conflict", recovery_id: accepted.recovery.recovery_id });
    expect(accepted.recovery.recovery_id).toMatch(/^recovery_[A-Za-z0-9_-]+$/);
  });
});
