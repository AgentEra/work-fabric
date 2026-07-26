import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyAgentRuntimeStateStoreContract } from "@work-fabric/agent-runtime-conformance";
import type { RuntimeDeliveryRecord } from "@work-fabric/agent-runtime-spi";
import { describe, expect, it } from "vitest";

import { SqliteAgentRuntimeStateStore } from "../src/index.js";

const NOW = "2026-07-26T01:00:00.000Z";

function delivery(): RuntimeDeliveryRecord {
  return {
    tenant_id: "tenant-1",
    delivery_id: "delivery-1",
    handoff_id: "handoff-1",
    partition_id: "partition-1",
    event_id: "event-1",
    received_at: NOW,
    acknowledged_at: null,
  };
}

verifyAgentRuntimeStateStoreContract("SQLite Agent Runtime state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "work-fabric-agent-runtime-"));
  const location = join(directory, "runtime.db");
  const store = new SqliteAgentRuntimeStateStore({ location });
  return {
    store,
    async close() {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});

describe("SQLite Agent Runtime state durability", () => {
  it("rejects non-RFC3339 claim timestamps before changing fencing state", async () => {
    const store = new SqliteAgentRuntimeStateStore({ location: ":memory:" });
    const invalidTimestamps = [
      "2026-02-30T01:00:00Z",
      "2026-07-26",
      "2026-07-26T01:00:00",
      "July 26, 2026 01:00:00 UTC",
      "2026-07-26T01:00:00+24:00",
    ];
    try {
      for (const [index, now] of invalidTimestamps.entries()) {
        const handoffId = `handoff-invalid-${index}`;
        await store.createRunIfAbsent("tenant-1", handoffId, NOW);
        await expect(store.claimRun({ tenant_id: "tenant-1", handoff_id: handoffId, owner: "host-a", now, lease_seconds: 2, allowed_states: ["received"] })).rejects.toThrow("RFC3339");
        expect(await store.getRun("tenant-1", handoffId)).toMatchObject({ state: "received", owner: null, fencing_token: 0, attempt: 0 });
        expect((await store.claimRun({ tenant_id: "tenant-1", handoff_id: handoffId, owner: "host-a", now: NOW, lease_seconds: 2, allowed_states: ["received"] }))?.fencing_token).toBe(1);
      }
    } finally {
      await store.close();
    }
  });

  it("normalizes offset timestamps before applying lease fencing and recovery", async () => {
    const store = new SqliteAgentRuntimeStateStore({ location: ":memory:" });
    try {
      await store.createRunIfAbsent("tenant-1", "handoff-1", NOW);
      const claimed = await store.claimRun({
        tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", now: NOW,
        lease_seconds: 2, allowed_states: ["received"],
      });
      expect(claimed?.lease_expires_at).toBe("2026-07-26T01:00:02.000Z");

      const expiredAtOffset = "2026-07-26T00:00:03.000-01:00";
      expect((await store.listRecoverable("tenant-1", expiredAtOffset, 10)).map((run) => run.handoff_id)).toEqual(["handoff-1"]);
      expect(await store.renewRun("tenant-1", "handoff-1", "host-a", 1, expiredAtOffset, 2)).toBe(false);
      expect(await store.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, expected_state: "received", next_state: "accepted", now: expiredAtOffset })).toBe(false);
      expect(await store.checkpointProgress({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, sequence: 1, now: expiredAtOffset })).toBe(false);
      expect((await store.claimRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-b", now: expiredAtOffset, lease_seconds: 2, allowed_states: ["received"] }))?.fencing_token).toBe(2);
    } finally {
      await store.close();
    }
  });

  it("rejects a non-object RuntimeDriverResult extensions payload", async () => {
    const store = new SqliteAgentRuntimeStateStore({ location: ":memory:" });
    try {
      await store.createRunIfAbsent("tenant-1", "handoff-1", NOW);
      await store.claimRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", now: NOW, lease_seconds: 2, allowed_states: ["received"] });
      await store.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, expected_state: "received", next_state: "accepted", now: "2026-07-26T01:00:00.001Z" });
      await store.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, expected_state: "accepted", next_state: "running", now: "2026-07-26T01:00:00.002Z" });
      await expect(store.transitionRun({
        tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1,
        expected_state: "running", next_state: "result_ready", now: "2026-07-26T01:00:00.003Z",
        result: { summary: [], artifacts: [], evidence: [], extensions: [] as never },
      })).rejects.toThrow("extensions must be an object");
    } finally {
      await store.close();
    }
  });

  it("reopens durable Delivery and run state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "work-fabric-agent-runtime-"));
    const location = join(directory, "runtime.db");
    try {
      const first = new SqliteAgentRuntimeStateStore({ location });
      await first.recordDelivery(delivery());
      await first.createRunIfAbsent("tenant-1", "handoff-1", NOW);
      await first.close();

      const reopened = new SqliteAgentRuntimeStateStore({ location });
      expect(await reopened.getRun("tenant-1", "handoff-1")).toMatchObject({ state: "received" });
      expect((await reopened.recordDelivery(delivery())).created).toBe(false);
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
