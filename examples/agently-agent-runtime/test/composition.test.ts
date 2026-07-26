import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { MemoryAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-memory";
import { loadAgentRuntimeConfiguration, type LoadedAgentRuntimeConfiguration } from "@work-fabric/agent-runtime-host";
import type { AgentRuntimeDriver } from "@work-fabric/agent-runtime-spi";
import { describe, expect, it, vi } from "vitest";

import { composeAgentRuntime, ensureTrustedWorkspaceRoot, startComposedRuntime } from "../src/main.js";

const fixture = {
  api_version: "workfabric.config/v1",
  service: {
    runtime_id: "daily-assistant-local", development_mode: true,
    work_fabric: {
      base_url: "http://127.0.0.1:8787", tenant_id: "tenant-local", exchange_id: "exchange-local",
      actor_id: "actor-intake-agent", endpoint_id: "endpoint-intake-agent", subscription_id: "subscription-intake-agent",
      access_token: "${INTAKE_AGENT_ACCESS_TOKEN}",
    },
    acceptance: { mode: "accept_all_targeted", require_explicit_target: true, reject_expired_handoffs: true, require_authority_scope: true, allowed_capability_ids: ["collaboration.request.intake", "information.synthesis", "collaboration.handoff.draft"] },
    concurrency: { max_active_runs: 2, queue_capacity: 32 },
    state: { provider: "sqlite", location: "./var/daily-assistant-runtime.db", busy_timeout_ms: 5_000 },
  },
  role: { role_id: "daily-assistant", version: 1, display_name: "Daily Assistant", description: "Tenant shared assistant" },
  participant: { actor_id: "actor-intake-agent", actor_type: "agent", endpoint_id: "endpoint-intake-agent" },
  capabilities: ["collaboration.request.intake", "information.synthesis", "collaboration.handoff.draft"],
  plugins: { instances: { "agently-primary": { type: "agent-runtime.agently", enabled: true, config: {
    python: { executable: "/usr/bin/python3", module: "work_fabric_agently_runtime" }, workspace_root: "./var/agently-workspaces",
    execution_timeout_seconds: 900, cancellation_grace_seconds: 10,
    provider: { type: "OpenAICompatible", base_url: "https://provider.example/v1", model: "configured-model", api_key: "${AGENTLY_MODEL_API_KEY}" },
  } } } },
};

async function loadedFixture(): Promise<LoadedAgentRuntimeConfiguration> {
  return loadAgentRuntimeConfiguration({
    document: { revision: "test", value: fixture },
    environment: { INTAKE_AGENT_ACCESS_TOKEN: "runtime-token", AGENTLY_MODEL_API_KEY: "model-token" },
  });
}

const fakeDriver: AgentRuntimeDriver = {
  manifest: { driver_type: "fake", protocol_version: "1", capability_ids: ["collaboration.request.intake", "information.synthesis", "collaboration.handoff.draft"] },
  async execute() { return { summary: [], artifacts: [], evidence: [], extensions: {} }; },
};

describe("Daily Assistant Runtime composition", () => {
  it("builds a Daily Assistant Runtime without importing service-node", async () => {
    const composition = await composeAgentRuntime(await loadedFixture(), {
      fetch: async () => new Response(null, { status: 204 }),
      driver: fakeDriver,
      state: new MemoryAgentRuntimeStateStore(),
    });

    expect(composition.role.role_id).toBe("daily-assistant");
    expect(composition.gatewayConfig.open_session.capabilities.map((item) => item.capability_id)).toEqual([
      "collaboration.request.intake", "information.synthesis", "collaboration.handoff.draft",
    ]);
    await composition.host.close();
  });

  it("does not expose a Work Fabric database setting to the Runtime", async () => {
    const loaded = await loadedFixture();
    expect(loaded.service.work_fabric).not.toHaveProperty("database");
    expect(loaded.service.state.location).toBe("./var/daily-assistant-runtime.db");
  });

  it("uses the configured acceptance capability subset", async () => {
    const loaded = await loadAgentRuntimeConfiguration({
      document: { revision: "test", value: { ...structuredClone(fixture), service: { ...structuredClone(fixture.service), acceptance: { ...structuredClone(fixture.service.acceptance), allowed_capability_ids: ["information.synthesis"] } } } },
      environment: { INTAKE_AGENT_ACCESS_TOKEN: "runtime-token", AGENTLY_MODEL_API_KEY: "model-token" },
    });
    const composition = await composeAgentRuntime(loaded, { driver: fakeDriver, state: new MemoryAgentRuntimeStateStore() });

    expect(composition.acceptanceCapabilityIds).toEqual(["information.synthesis"]);
    await composition.host.close();
  });

  it("closes the Host and Runtime State once when subscription startup fails", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    const close = state.close.bind(state);
    let closes = 0;
    state.close = async () => { closes += 1; await close(); };
    const composition = await composeAgentRuntime(await loadedFixture(), {
      fetch: async () => new Response(JSON.stringify({ code: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } }),
      driver: fakeDriver, state,
    });

    await expect(startComposedRuntime(composition)).rejects.toThrow();
    expect(closes).toBe(1);
  });

  it("rejects a symlink in a workspace-root ancestor", async () => {
    const root = await mkdtemp("/private/tmp/daily-runtime-workspace-");
    try {
      await mkdir(join(root, "target"));
      await symlink("target", join(root, "linked"));
      await expect(ensureTrustedWorkspaceRoot(join(root, "linked", "runtime"))).rejects.toThrow("symlink");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a group-writable workspace root", async () => {
    const root = await mkdtemp("/private/tmp/daily-runtime-workspace-");
    try {
      await chmod(root, 0o770);
      await expect(ensureTrustedWorkspaceRoot(root)).rejects.toThrow("writable");
    } finally {
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });

  const wrongOwner = typeof process.getuid === "function" ? it : it.skip;
  wrongOwner("rejects a workspace root owned by another user", async () => {
    const root = await mkdtemp("/private/tmp/daily-runtime-workspace-");
    const expectedOwner = process.getuid!();
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(expectedOwner + 1);
    try {
      await expect(ensureTrustedWorkspaceRoot(root)).rejects.toThrow("owned");
    } finally {
      getuid.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps model execution adapters out of service packages", async () => {
    const roots = ["packages/service-node", "packages/exchange-core", "packages/agent-gateway"];
    const files = (await Promise.all(roots.map((root) => sourceFiles(root)))).flat();
    const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
    expect(sources.some((source) => /adapter-agent-runtime-agently|from\s+["']agently["']/.test(source))).toBe(false);
  });
});

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.(?:ts|mts|cts)$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}
