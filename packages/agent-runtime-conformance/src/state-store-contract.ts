import type {
  AgentRuntimeStateStore,
  RuntimeCommandRecord,
  RuntimeDeliveryRecord,
  RuntimeDriverResult,
  RuntimeRunState,
} from "@work-fabric/agent-runtime-spi";
import { describe, expect, it } from "vitest";

export interface RuntimeStateStoreFixture {
  readonly store: AgentRuntimeStateStore;
  close(): Promise<void>;
}

const NOW = "2026-07-26T01:00:00.000Z";

function delivery(overrides: Partial<RuntimeDeliveryRecord> = {}): RuntimeDeliveryRecord {
  return {
    tenant_id: "tenant-1",
    delivery_id: "delivery-1",
    handoff_id: "handoff-1",
    partition_id: "partition-1",
    event_id: "event-1",
    received_at: NOW,
    acknowledged_at: null,
    ...overrides,
  };
}

function commandRecord(overrides: Partial<RuntimeCommandRecord> = {}): RuntimeCommandRecord {
  return {
    tenant_id: "tenant-1",
    handoff_id: "handoff-1",
    command: "accept",
    idempotency_key: "command-1",
    resource_version: 1,
    recorded_at: NOW,
    ...overrides,
  };
}

function claim(owner: string, now: string, allowedStates: readonly RuntimeRunState[] = ["received"]) {
  return {
    tenant_id: "tenant-1",
    handoff_id: "handoff-1",
    owner,
    now,
    lease_seconds: 2,
    allowed_states: allowedStates,
  };
}

function result(): RuntimeDriverResult {
  return { summary: [{ message: "complete" }], artifacts: [], evidence: [], extensions: {} };
}

export function verifyAgentRuntimeStateStoreContract(
  name: string,
  create: () => Promise<RuntimeStateStoreFixture>,
): void {
  describe(name, () => {
    it("deduplicates Delivery and command records", async () => {
      const fixture = await create();
      try {
        const first = await fixture.store.recordDelivery(delivery());
        const duplicate = await fixture.store.recordDelivery(delivery());
        expect(first.created).toBe(true);
        expect(duplicate).toEqual({ created: false, record: first.record });

        const command = await fixture.store.recordCommand(commandRecord());
        const replay = await fixture.store.recordCommand(commandRecord());
        expect(command.created).toBe(true);
        expect(replay).toEqual({ created: false, record: command.record });
      } finally {
        await fixture.close();
      }
    });

    it("creates one logical run and fences stale owners", async () => {
      const fixture = await create();
      try {
        await fixture.store.createRunIfAbsent("tenant-1", "handoff-1", NOW);
        const first = await fixture.store.claimRun(claim("host-a", NOW));
        expect(first?.fencing_token).toBe(1);
        const second = await fixture.store.claimRun(claim("host-b", "2026-07-26T01:01:01.000Z"));
        expect(second?.fencing_token).toBe(2);
        expect(await fixture.store.transitionRun({
          tenant_id: "tenant-1",
          handoff_id: "handoff-1",
          owner: "host-a",
          fencing_token: 1,
          expected_state: "received",
          next_state: "accepted",
          now: "2026-07-26T01:01:02.000Z",
        })).toBe(false);
      } finally {
        await fixture.close();
      }
    });

    it("lists expired or unowned non-terminal runs for recovery", async () => {
      const fixture = await create();
      try {
        await fixture.store.createRunIfAbsent("tenant-1", "handoff-1", NOW);
        await fixture.store.createRunIfAbsent("tenant-1", "handoff-2", NOW);
        await fixture.store.claimRun({
          ...claim("host-a", NOW),
          handoff_id: "handoff-2",
        });
        const recoverable = await fixture.store.listRecoverable("tenant-1", "2026-07-26T01:05:00.000Z", 10);
        expect(recoverable.map((run) => run.handoff_id)).toEqual(["handoff-1", "handoff-2"]);
      } finally {
        await fixture.close();
      }
    });

    it("writes a delivery acknowledgement timestamp once", async () => {
      const fixture = await create();
      try {
        await fixture.store.recordDelivery(delivery());
        expect(await fixture.store.markDeliveryAcknowledged("tenant-1", "delivery-1", "2026-07-26T01:00:01.000Z")).toBe(true);
        expect(await fixture.store.markDeliveryAcknowledged("tenant-1", "delivery-1", "2026-07-26T01:00:02.000Z")).toBe(false);
        expect((await fixture.store.recordDelivery(delivery())).record.acknowledged_at).toBe("2026-07-26T01:00:01.000Z");
      } finally {
        await fixture.close();
      }
    });

    it("requires progress sequences to strictly increase", async () => {
      const fixture = await create();
      try {
        await fixture.store.createRunIfAbsent("tenant-1", "handoff-1", NOW);
        const run = await fixture.store.claimRun(claim("host-a", NOW));
        expect(run?.fencing_token).toBe(1);
        expect(await fixture.store.checkpointProgress({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, sequence: 1, now: "2026-07-26T01:00:01.000Z" })).toBe(true);
        expect(await fixture.store.checkpointProgress({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, sequence: 1, now: "2026-07-26T01:00:02.000Z" })).toBe(false);
        expect(await fixture.store.checkpointProgress({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, sequence: 2, now: "2026-07-26T01:00:01.500Z" })).toBe(true);
      } finally {
        await fixture.close();
      }
    });

    it("fails closed for invalid state transitions", async () => {
      const fixture = await create();
      try {
        await fixture.store.createRunIfAbsent("tenant-1", "handoff-1", NOW);
        await fixture.store.claimRun(claim("host-a", NOW));
        expect(await fixture.store.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, expected_state: "received", next_state: "succeeded", now: "2026-07-26T01:00:01.000Z" })).toBe(false);
      } finally {
        await fixture.close();
      }
    });

    it("never recovers terminal runs", async () => {
      const fixture = await create();
      try {
        await fixture.store.createRunIfAbsent("tenant-1", "handoff-1", NOW);
        await fixture.store.claimRun(claim("host-a", NOW));
        for (const [expected_state, next_state] of [["received", "accepted"], ["accepted", "running"], ["running", "result_ready"], ["result_ready", "succeeded"]] as const) {
          expect(await fixture.store.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, expected_state, next_state, now: "2026-07-26T01:00:01.000Z", ...(next_state === "result_ready" ? { result: result() } : {}) })).toBe(true);
        }
        expect(await fixture.store.listRecoverable("tenant-1", "2026-07-26T01:05:00.000Z", 10)).toEqual([]);
      } finally {
        await fixture.close();
      }
    });

    it("requires a result only when entering result_ready", async () => {
      const fixture = await create();
      try {
        await fixture.store.createRunIfAbsent("tenant-1", "handoff-1", NOW);
        await fixture.store.claimRun(claim("host-a", NOW));
        expect(await fixture.store.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, expected_state: "received", next_state: "accepted", now: "2026-07-26T01:00:01.000Z", result: result() })).toBe(false);
        expect(await fixture.store.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, expected_state: "received", next_state: "accepted", now: "2026-07-26T01:00:01.000Z" })).toBe(true);
        expect(await fixture.store.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, expected_state: "accepted", next_state: "running", now: "2026-07-26T01:00:01.100Z" })).toBe(true);
        expect(await fixture.store.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, expected_state: "running", next_state: "result_ready", now: "2026-07-26T01:00:01.200Z" })).toBe(false);
        expect(await fixture.store.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, expected_state: "running", next_state: "result_ready", now: "2026-07-26T01:00:01.200Z", result: result() })).toBe(true);
      } finally {
        await fixture.close();
      }
    });

    it("records distinct status idempotency keys for increasing progress", async () => {
      const fixture = await create();
      try {
        await fixture.store.recordCommand(commandRecord({ command: "status", idempotency_key: "status-1", resource_version: 1 }));
        await fixture.store.recordCommand(commandRecord({ command: "status", idempotency_key: "status-2", resource_version: 2 }));
        expect((await fixture.store.listCommands("tenant-1", "handoff-1")).map((record) => record.idempotency_key)).toEqual(["status-1", "status-2"]);
      } finally {
        await fixture.close();
      }
    });

    it("rejects conflicting command replays while accepting distinct status keys", async () => {
      const fixture = await create();
      try {
        await fixture.store.recordCommand(commandRecord());
        await expect(fixture.store.recordCommand(commandRecord({ command: "decline" }))).rejects.toThrow();
        await expect(fixture.store.recordCommand(commandRecord({ resource_version: 2 }))).rejects.toThrow();
        await expect(fixture.store.recordCommand(commandRecord({ command: "status", idempotency_key: "status-1", resource_version: 1 }))).resolves.toMatchObject({ created: true });
      } finally {
        await fixture.close();
      }
    });

    it("isolates identical identities between tenants", async () => {
      const fixture = await create();
      try {
        expect((await fixture.store.recordDelivery(delivery())).created).toBe(true);
        expect((await fixture.store.recordDelivery(delivery({ tenant_id: "tenant-2" }))).created).toBe(true);
        expect(await fixture.store.markDeliveryAcknowledged("tenant-1", "delivery-1", "2026-07-26T01:00:01.000Z")).toBe(true);
        expect((await fixture.store.recordDelivery(delivery({ tenant_id: "tenant-2" }))).record.acknowledged_at).toBe(null);

        expect((await fixture.store.createRunIfAbsent("tenant-1", "handoff-1", NOW)).created).toBe(true);
        expect((await fixture.store.createRunIfAbsent("tenant-2", "handoff-1", NOW)).created).toBe(true);
        expect((await fixture.store.claimRun({ ...claim("host-a", NOW), tenant_id: "tenant-1" }))?.fencing_token).toBe(1);
        expect((await fixture.store.getRun("tenant-2", "handoff-1"))?.owner).toBe(null);

        expect((await fixture.store.recordCommand(commandRecord())).created).toBe(true);
        expect((await fixture.store.recordCommand(commandRecord({ tenant_id: "tenant-2" }))).created).toBe(true);
        expect(await fixture.store.listCommands("tenant-1", "handoff-1")).toHaveLength(1);
        expect(await fixture.store.listCommands("tenant-2", "handoff-1")).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    });

    it("clones inputs and returned delivery, run, and command records", async () => {
      const fixture = await create();
      try {
        const deliveryInput = delivery();
        const deliveryRecorded = await fixture.store.recordDelivery(deliveryInput);
        (deliveryInput as { received_at: string }).received_at = "changed-input";
        (deliveryRecorded.record as { received_at: string }).received_at = "changed-output";
        expect((await fixture.store.recordDelivery(delivery())).record.received_at).toBe(NOW);

        const created = await fixture.store.createRunIfAbsent("tenant-1", "handoff-1", NOW);
        (created.run as { owner: string | null }).owner = "changed-output";
        expect((await fixture.store.getRun("tenant-1", "handoff-1"))?.owner).toBe(null);
        await fixture.store.claimRun(claim("host-a", NOW));
        await fixture.store.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, expected_state: "received", next_state: "accepted", now: "2026-07-26T01:00:00.001Z" });
        await fixture.store.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, expected_state: "accepted", next_state: "running", now: "2026-07-26T01:00:00.002Z" });
        const result = { summary: [{ message: "original" }], artifacts: [], evidence: [], extensions: {} };
        await fixture.store.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, expected_state: "running", next_state: "result_ready", now: "2026-07-26T01:00:00.003Z", result });
        result.summary[0]!.message = "changed-input";
        const storedRun = await fixture.store.getRun("tenant-1", "handoff-1");
        expect(storedRun?.result?.summary).toEqual([{ message: "original" }]);
        (storedRun?.result?.summary[0] as { message: string }).message = "changed-output";
        expect((await fixture.store.getRun("tenant-1", "handoff-1"))?.result?.summary).toEqual([{ message: "original" }]);

        const commandInput = commandRecord();
        const commandRecorded = await fixture.store.recordCommand(commandInput);
        (commandInput as { recorded_at: string }).recorded_at = "changed-input";
        (commandRecorded.record as { recorded_at: string }).recorded_at = "changed-output";
        expect((await fixture.store.listCommands("tenant-1", "handoff-1"))[0]?.recorded_at).toBe(NOW);
      } finally {
        await fixture.close();
      }
    });

    it("rejects owner mutations after lease expiry while allowing timely renewal", async () => {
      const fixture = await create();
      try {
        await fixture.store.createRunIfAbsent("tenant-1", "handoff-1", NOW);
        await fixture.store.claimRun(claim("host-a", NOW));
        expect(await fixture.store.renewRun("tenant-1", "handoff-1", "host-a", 1, "2026-07-26T01:00:01.000Z", 2)).toBe(true);
        expect(await fixture.store.renewRun("tenant-1", "handoff-1", "host-a", 1, "2026-07-26T01:00:03.000Z", 2)).toBe(false);
        expect(await fixture.store.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, expected_state: "received", next_state: "accepted", now: "2026-07-26T01:00:03.000Z" })).toBe(false);
        expect(await fixture.store.checkpointProgress({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "host-a", fencing_token: 1, sequence: 1, now: "2026-07-26T01:00:03.000Z" })).toBe(false);
      } finally {
        await fixture.close();
      }
    });
  });
}
