import { describe, expect, it } from "vitest";

import { DiscoveryExportCoordinator } from "../src/index.js";

describe("DiscoveryExportCoordinator", () => {
  it("coalesces refresh pressure into one bounded turn", async () => {
    const callbacks: Array<() => void> = [];
    let refreshes = 0;
    const coordinator = new DiscoveryExportCoordinator({
      coalescing_window_ms: 100,
      schedule(_delay, callback) { callbacks.push(callback); },
      async refresh() { refreshes += 1; },
    });

    coordinator.requestRefresh();
    coordinator.requestRefresh();
    coordinator.requestRefresh();
    expect(callbacks).toHaveLength(1);
    expect(refreshes).toBe(0);

    callbacks.shift()?.();
    await coordinator.idle();
    expect(refreshes).toBe(1);
  });
});
