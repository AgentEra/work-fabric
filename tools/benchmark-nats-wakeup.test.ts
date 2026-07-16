import { describe, expect, it } from "vitest";

import { normalizeNatsWakeupBenchmarkOptions } from "./benchmark-nats-wakeup.js";

describe("NATS Wakeup benchmark bounds", () => {
  it("uses the reproducible reference defaults", () => {
    expect(normalizeNatsWakeupBenchmarkOptions({})).toEqual({
      messages: 1_000,
      publishers: 4,
      consumers: 4,
      samples: 3,
    });
  });

  it("rejects unbounded or internally inconsistent worker counts", () => {
    expect(() => normalizeNatsWakeupBenchmarkOptions({ messages: 100_001 }))
      .toThrow(/messages/);
    expect(() => normalizeNatsWakeupBenchmarkOptions({ publishers: 65 }))
      .toThrow(/publishers/);
    expect(() => normalizeNatsWakeupBenchmarkOptions({ consumers: 65 }))
      .toThrow(/consumers/);
    expect(() => normalizeNatsWakeupBenchmarkOptions({ samples: 21 }))
      .toThrow(/samples/);
    expect(() => normalizeNatsWakeupBenchmarkOptions({ messages: 1, publishers: 2 }))
      .toThrow(/cannot exceed/);
  });
});
