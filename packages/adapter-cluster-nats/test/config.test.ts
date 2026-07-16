import { describe, expect, it } from "vitest";

import { normalizeNatsWakeupRuntimeConfig } from "../src/config.js";

describe("normalizeNatsWakeupRuntimeConfig", () => {
  it("applies bounded runtime defaults", () => {
    expect(normalizeNatsWakeupRuntimeConfig({})).toEqual({
      pull_expires_ms: 1_000,
      retry_delay_ms: 1_000,
      max_poison_per_pull: 10,
    });
  });

  it("rejects every value outside the global bounds", () => {
    expect(() => normalizeNatsWakeupRuntimeConfig({ pull_expires_ms: 999 }))
      .toThrow(/pull_expires_ms/);
    expect(() => normalizeNatsWakeupRuntimeConfig({ retry_delay_ms: 60_001 }))
      .toThrow(/retry_delay_ms/);
    expect(() => normalizeNatsWakeupRuntimeConfig({ max_poison_per_pull: 0 }))
      .toThrow(/max_poison_per_pull/);
  });
});
