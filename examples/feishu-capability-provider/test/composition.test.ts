import { describe, expect, it, vi } from "vitest";

import { ManagedFeishuProviderComposition } from "../src/composition.js";

describe("ManagedFeishuProviderComposition", () => {
  it("starts Citizens and Handoff Host without a configured document container", async () => {
    const calls: string[] = [];
    const composition = new ManagedFeishuProviderComposition({
      capability_citizen_id: "citizen-capability",
      context_citizen_id: "citizen-context",
      capability_citizen: {
        start: vi.fn(async () => { calls.push("capability:start"); }),
        health: vi.fn(async () => ({ status: "available" as const })),
        close: vi.fn(async () => { calls.push("capability:close"); }),
      },
      context_citizen: {
        start: vi.fn(async () => { calls.push("context:start"); }),
        health: vi.fn(async () => ({ status: "available" as const })),
        close: vi.fn(async () => { calls.push("context:close"); }),
      },
      host: {
        start: vi.fn(async () => { calls.push("host:start"); }),
        close: vi.fn(async () => { calls.push("host:close"); }),
      },
      close_provider_store: async () => { calls.push("provider-store:close"); },
    });
    await composition.start();
    expect(calls).toEqual([
      "capability:start",
      "context:start",
      "host:start",
    ]);
    await expect(composition.health()).resolves.toEqual({
      provider: "ready",
      capability_citizen: "citizen-capability",
      context_citizen: "citizen-context",
    });
    await composition.close();
    expect(calls.slice(3)).toEqual([
      "host:close",
      "context:close",
      "capability:close",
      "provider-store:close",
    ]);
  });

  it("rolls back partial startup in reverse order", async () => {
    const calls: string[] = [];
    const composition = new ManagedFeishuProviderComposition({
      capability_citizen_id: "citizen-capability",
      context_citizen_id: "citizen-context",
      capability_citizen: {
        start: async () => { calls.push("capability:start"); },
        health: async () => ({ status: "available" as const }),
        close: async () => { calls.push("capability:close"); },
      },
      context_citizen: {
        start: async () => {
          calls.push("context:start");
          throw new Error("context failed");
        },
        health: async () => ({ status: "unavailable" as const }),
        close: async () => { calls.push("context:close"); },
      },
      host: {
        start: async () => { calls.push("host:start"); },
        close: async () => { calls.push("host:close"); },
      },
      close_provider_store: async () => { calls.push("provider-store:close"); },
    });
    await expect(composition.start()).rejects.toThrow("context failed");
    expect(calls).toEqual([
      "capability:start",
      "context:start",
      "context:close",
      "capability:close",
      "provider-store:close",
    ]);
    await expect(composition.health()).resolves.toMatchObject({
      provider: "failed",
    });
  });
});
