import { describe, expect, it, vi } from "vitest";

import type {
  PartitionTurnHandler,
  PartitionWorkItem,
} from "@work-fabric/cluster-spi";
import { PartitionWorker } from "../src/index.js";
import { FakeLeaseStore, ManualRepeatingTimer } from "./lease-fixture.js";

const work: PartitionWorkItem = {
  tenant_id: "tenant-a",
  partition_id: "partition-a",
  kind: "outbox_wakeup",
  observed_position: 1,
  available_at: "2026-07-16T00:00:00.000Z",
};

function worker(
  owner: string,
  store: FakeLeaseStore,
  handler: PartitionTurnHandler,
) {
  return new PartitionWorker({
    owner,
    clock: { now: () => "2026-07-16T00:00:00.000Z" },
    lease_store_for_tenant: () => store,
    handlers: [handler],
    timer: new ManualRepeatingTimer(),
    lease_seconds: 30,
    turn_item_limit: 17,
  });
}

describe("PartitionWorker", () => {
  it("runs exactly one bounded handler for the one lease winner", async () => {
    const store = new FakeLeaseStore();
    let releaseHandler = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const run = vi.fn<PartitionTurnHandler["run"]>(async (context, limit) => {
      expect(context.owner).toBe("worker-a");
      expect(context.fencing_token).toBe(1);
      expect(limit).toBe(17);
      await context.assertOwnership();
      await barrier;
      return { outcome: "advanced", processed: 2 };
    });
    const handler = { kind: "outbox_wakeup", run } as const;
    const first = worker("worker-a", store, handler);
    const second = worker("worker-b", store, handler);

    const firstResult = first.run(work, new AbortController().signal);
    await Promise.resolve();
    const secondResult = second.run(work, new AbortController().signal);
    releaseHandler();

    await expect(firstResult).resolves.toMatchObject({
      kind: "ran",
      fencing_token: 1,
      outcome: { outcome: "advanced", processed: 2 },
    });
    await expect(secondResult).resolves.toEqual({ kind: "lease_unavailable" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns a stable fenced outcome when ownership is lost", async () => {
    const store = new FakeLeaseStore();
    const handler: PartitionTurnHandler = {
      kind: "outbox_wakeup",
      async run(context) {
        store.expireCurrent();
        await context.assertOwnership();
        return { outcome: "idle", processed: 0 };
      },
    };
    await expect(worker("worker-a", store, handler).run(
      work,
      new AbortController().signal,
    )).resolves.toEqual({
      kind: "failed",
      code: "partition_lease_lost",
    });
  });

  it("does not expose unexpected exception text", async () => {
    const handler: PartitionTurnHandler = {
      kind: "outbox_wakeup",
      async run() {
        throw new Error("credential=do-not-return");
      },
    };
    await expect(worker("worker-a", new FakeLeaseStore(), handler).run(
      work,
      new AbortController().signal,
    )).resolves.toEqual({
      kind: "failed",
      code: "partition_turn_failed",
    });
  });

  it("fails closed when no handler owns the mechanical work kind", async () => {
    const handler: PartitionTurnHandler = {
      kind: "signal_delivery",
      async run() {
        return { outcome: "idle", processed: 0 };
      },
    };
    await expect(worker("worker-a", new FakeLeaseStore(), handler).run(
      work,
      new AbortController().signal,
    )).resolves.toEqual({
      kind: "failed",
      code: "partition_turn_failed",
    });
  });
});
