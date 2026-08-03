import { describe, expect, it, vi } from "vitest";

import {
  ManagedGitHubProviderComposition,
  installationIdHash,
} from "../src/composition.js";
import { GITHUB_REST_API_VERSION } from "@work-fabric/provider-github";

describe("ManagedGitHubProviderComposition", () => {
  it("uses a deployment-secret, domain-separated installation identifier for capability evidence", () => {
    const first = installationIdHash("456", Buffer.alloc(32, 1));
    const second = installationIdHash("456", Buffer.alloc(32, 2));
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("456");
    expect(GITHUB_REST_API_VERSION).toBe("2022-11-28");
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

  it("serializes close with an in-flight start and closes each started dependency once", async () => {
    let releaseCitizen!: () => void;
    const citizenGate = new Promise<void>((resolve) => { releaseCitizen = resolve; });
    const citizenClose = vi.fn(async () => undefined);
    const hostClose = vi.fn(async () => undefined);
    const hostStart = vi.fn(async () => undefined);
    const composition = new ManagedGitHubProviderComposition({
      citizen_id: "citizen-github-read",
      citizen: {
        start: async () => citizenGate,
        health: async () => ({ status: "available" as const }),
        close: citizenClose,
      },
      host: { start: hostStart, active: () => true, close: hostClose },
    });

    const firstStart = composition.start();
    const concurrentStart = composition.start();
    const closing = composition.close();
    releaseCitizen();
    await firstStart;
    await concurrentStart;
    await closing;

    expect(hostStart).toHaveBeenCalledTimes(1);
    expect(hostClose).toHaveBeenCalledTimes(1);
    expect(citizenClose).toHaveBeenCalledTimes(1);
    await expect(composition.health()).resolves.toEqual({
      provider: "failed",
      citizen: "citizen-github-read",
    });
  });

  it("does not double-close when startup fails while close is waiting", async () => {
    let releaseCitizen!: () => void;
    const citizenGate = new Promise<void>((resolve) => { releaseCitizen = resolve; });
    const citizenClose = vi.fn(async () => undefined);
    const composition = new ManagedGitHubProviderComposition({
      citizen_id: "citizen-github-read",
      citizen: {
        start: async () => citizenGate,
        health: async () => ({ status: "available" as const }),
        close: citizenClose,
      },
      host: {
        start: async () => { throw new Error("host failed"); },
        active: () => false,
        close: vi.fn(async () => undefined),
      },
    });

    const starting = composition.start();
    const closing = composition.close();
    releaseCitizen();
    await expect(starting).rejects.toThrow("host failed");
    await closing;
    expect(citizenClose).toHaveBeenCalledTimes(1);
    await expect(composition.health()).resolves.toMatchObject({ provider: "failed" });
  });
});
