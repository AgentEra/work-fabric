import { describe, expect, it, vi } from "vitest";
import { LocalMechanicalPump } from "../src/index.js";

describe("LocalMechanicalPump", () => {
  it("coalesces bounded work keys and never overlaps turns", async () => {
    vi.useFakeTimers();
    let active = 0; let maximum = 0; const calls: string[] = [];
    const pump = new LocalMechanicalPump({ poll_interval_ms: 10, max_work_keys: 2, turn_limit: 100, async turn(key) { active += 1; maximum = Math.max(maximum, active); calls.push(key); await Promise.resolve(); active -= 1; } });
    pump.wake("partition-a"); pump.wake("partition-a"); pump.wake("partition-b");
    expect(() => pump.wake("partition-c")).toThrow(/capacity/);
    pump.start(); await vi.advanceTimersByTimeAsync(11); await pump.stop();
    expect(new Set(calls)).toEqual(new Set(["partition-a", "partition-b"]));
    expect(maximum).toBe(1);
    vi.useRealTimers();
  });

  it("isolates a failing turn and leaves no timer activity after stop", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const pump = new LocalMechanicalPump({ poll_interval_ms: 10, max_work_keys: 2, turn_limit: 5, async turn(key, limit) { calls.push(`${key}:${limit}`); if (key === "partition-a") throw new Error("transient"); } });
    pump.wake("partition-a"); pump.wake("partition-b"); pump.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["partition-a:5", "partition-b:5"]);
    await pump.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(2);
    vi.useRealTimers();
  });
});
