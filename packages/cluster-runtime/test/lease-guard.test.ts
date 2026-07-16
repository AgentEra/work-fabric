import { describe, expect, it, vi } from "vitest";

import { ClusterError, PartitionLeaseGuard } from "../src/index.js";
import { FakeLeaseStore, ManualRepeatingTimer } from "./lease-fixture.js";

const clock = { now: () => "2026-07-16T00:00:00.000Z" };

describe("PartitionLeaseGuard", () => {
  it("allows one owner and fences an expired owner", async () => {
    const store = new FakeLeaseStore();
    const first = new PartitionLeaseGuard({
      store,
      clock,
      timer: new ManualRepeatingTimer(),
      lease_key: "partition:outbox_wakeup:p1",
      owner: "worker-a",
      lease_seconds: 30,
    });
    const second = new PartitionLeaseGuard({
      store,
      clock,
      timer: new ManualRepeatingTimer(),
      lease_key: "partition:outbox_wakeup:p1",
      owner: "worker-b",
      lease_seconds: 30,
    });

    await expect(first.acquire()).resolves.toBe(true);
    await expect(second.acquire()).resolves.toBe(false);
    await expect(first.assertOwnership()).resolves.toBeUndefined();
    store.expireCurrent();
    await expect(second.acquire()).resolves.toBe(true);
    await expect(first.assertOwnership()).rejects.toMatchObject({
      code: "partition_lease_lost",
    });
    await expect(first.release()).resolves.toBe(false);
  });

  it("heartbeats at one third of the lease and reports loss once", async () => {
    const store = new FakeLeaseStore();
    const timer = new ManualRepeatingTimer();
    const onLost = vi.fn();
    const guard = new PartitionLeaseGuard({
      store,
      clock,
      timer,
      lease_key: "partition:signal_delivery:p1",
      owner: "worker-a",
      lease_seconds: 30,
      on_lost: onLost,
    });
    await guard.acquire();
    const heartbeat = guard.startHeartbeat(new AbortController().signal);
    expect(timer.interval).toBe(10_000);
    store.expireCurrent();
    await timer.tick();
    await timer.tick();
    expect(onLost).toHaveBeenCalledTimes(1);
    await heartbeat.stop();
    expect(timer.stopped).toBe(true);
  });

  it("uses stable errors without carrying a raw cause", () => {
    const error = new ClusterError("partition_turn_failed");
    expect(error).toMatchObject({
      name: "ClusterError",
      code: "partition_turn_failed",
      message: "partition_turn_failed",
    });
    expect(error.cause).toBeUndefined();
  });
});
