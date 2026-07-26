import { describe, expect, it, vi } from "vitest";

import type { RuntimeProgress } from "@work-fabric/agent-runtime-spi";

import { ProgressCoalescer } from "../src/index.js";

const update = (sequence: number): RuntimeProgress => ({
  sequence,
  progress: sequence / 10,
  message: `progress ${sequence}`,
  observed_at: "2026-07-26T00:00:00.000Z",
});

describe("ProgressCoalescer", () => {
  it("keeps only the newest increasing update until it is flushed", async () => {
    const emitted: RuntimeProgress[] = [];
    const coalescer = new ProgressCoalescer(60_000, async (value) => {
      emitted.push(value);
    });

    await coalescer.push(update(1));
    await coalescer.push(update(2));
    await coalescer.flush();

    expect(emitted).toEqual([update(2)]);
  });

  it("rejects duplicate Driver progress and caps its message before emission", async () => {
    const emit = vi.fn(async () => undefined);
    const coalescer = new ProgressCoalescer(1, emit);
    await coalescer.push(update(1));

    await expect(coalescer.push(update(1))).rejects.toMatchObject({
      code: "invalid_progress",
    });
    await coalescer.push({ ...update(2), message: "x".repeat(4_097) });
    await coalescer.flush();
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({
      message: "x".repeat(4_096),
    }));
  });

  it("does not emit a pending update back-to-back while the prior async emit is completing", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const emitted: RuntimeProgress[] = [];
      const coalescer = new ProgressCoalescer(100, async (value) => {
        emitted.push(value);
        if (value.sequence === 1) await new Promise<void>((resolve) => { release = resolve; });
      });

      await coalescer.push(update(1));
      await vi.advanceTimersByTimeAsync(0);
      expect(emitted).toEqual([update(1)]);
      await coalescer.push(update(2));
      release();
      await vi.advanceTimersByTimeAsync(99);
      expect(emitted).toEqual([update(1)]);
      await vi.advanceTimersByTimeAsync(1);
      expect(emitted).toEqual([update(1), update(2)]);
    } finally {
      vi.useRealTimers();
    }
  });
});
