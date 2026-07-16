import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveRefresh, consumeInvalidations } from "../src/live-refresh.js";

afterEach(() => vi.useRealTimers());

describe("LiveRefresh", () => {
  it("runs one request at a time and immediately follows invalidation", async () => {
    vi.useFakeTimers();
    const resolvers: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const refresh = new LiveRefresh({ minimum_interval_ms: 1_000, jitter_ratio: 0 });
    refresh.start(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => resolvers.push(resolve));
      active -= 1;
    });
    await vi.advanceTimersByTimeAsync(0);
    refresh.invalidate();
    refresh.invalidate();
    expect(resolvers).toHaveLength(1);
    resolvers.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolvers).toHaveLength(1);
    expect(maximum).toBe(1);
    refresh.stop();
  });

  it("uses bounded jitter, aborts on stop and rejects unsafe bounds", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const refresh = new LiveRefresh({ minimum_interval_ms: 2_000, jitter_ratio: 0.25, random: () => 1 });
    refresh.start(async (signal) => {
      signals.push(signal);
      await new Promise<void>(() => undefined);
    });
    await vi.advanceTimersByTimeAsync(0);
    refresh.stop();
    expect(signals[0]?.aborted).toBe(true);
    expect(() => new LiveRefresh({ minimum_interval_ms: 999 })).toThrow();
    expect(() => new LiveRefresh({ jitter_ratio: 0.51 })).toThrow();
  });

  it("treats an authenticated stream only as query invalidation", async () => {
    const refresh = { invalidate: vi.fn() };
    async function* stream() { yield { id: 1 }; yield { id: 2 }; }
    await consumeInvalidations(stream(), refresh);
    expect(refresh.invalidate).toHaveBeenCalledTimes(2);
  });
});
