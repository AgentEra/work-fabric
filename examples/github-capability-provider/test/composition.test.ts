import { describe, expect, it, vi } from "vitest";

import {
  ManagedGitHubProviderComposition,
  installationIdHash,
} from "../src/composition.js";

describe("ManagedGitHubProviderComposition", () => {
  it("uses a one-way installation identifier for capability evidence", () => {
    expect(installationIdHash("456")).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(installationIdHash("456")).not.toContain("456");
  });

  it("starts the leased Citizen before the Gateway Host and closes in reverse order", async () => {
    const calls: string[] = [];
    const composition = new ManagedGitHubProviderComposition({
      citizen_id: "citizen-github-read",
      citizen: {
        start: async () => { calls.push("citizen:start"); },
        health: async () => ({ status: "available" as const }),
        close: async () => { calls.push("citizen:close"); },
      },
      host: {
        start: async () => { calls.push("host:start"); },
        active: () => true,
        close: async () => { calls.push("host:close"); },
      },
    });

    await composition.start();
    await expect(composition.health()).resolves.toEqual({
      provider: "ready",
      citizen: "citizen-github-read",
    });
    await composition.close();
    await composition.close();

    expect(calls).toEqual([
      "citizen:start",
      "host:start",
      "host:close",
      "citizen:close",
    ]);
  });

  it("rolls back every allocated dependency when host startup fails", async () => {
    const calls: string[] = [];
    const citizenClose = vi.fn(async () => { calls.push("citizen:close"); });
    const composition = new ManagedGitHubProviderComposition({
      citizen_id: "citizen-github-read",
      citizen: {
        start: async () => { calls.push("citizen:start"); },
        health: async () => ({ status: "available" as const }),
        close: citizenClose,
      },
      host: {
        start: async () => { calls.push("host:start"); throw new Error("host failed"); },
        active: () => false,
        close: async () => { calls.push("host:close"); },
      },
    });

    await expect(composition.start()).rejects.toThrow("host failed");
    expect(calls).toEqual(["citizen:start", "host:start", "host:close", "citizen:close"]);
    expect(citizenClose).toHaveBeenCalledTimes(1);
    await expect(composition.health()).resolves.toMatchObject({ provider: "failed" });
  });

  it("reports failed when either the Citizen or Gateway stream is not live", async () => {
    const composition = new ManagedGitHubProviderComposition({
      citizen_id: "citizen-github-read",
      citizen: {
        start: async () => undefined,
        health: async () => ({ status: "unavailable" as const }),
        close: async () => undefined,
      },
      host: { start: async () => undefined, active: () => false, close: async () => undefined },
    });
    await composition.start();
    await expect(composition.health()).resolves.toEqual({
      provider: "failed",
      citizen: "citizen-github-read",
    });
  });
});
