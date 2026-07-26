import { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskPackage } from "@work-fabric/agent-runtime-spi";

import { AgentlyRuntimeDriverFactory, validateAgentlyRuntimeDriverConfig } from "../src/index.js";

const worker = fileURLToPath(new URL("./fixtures/fake-worker.mjs", import.meta.url));

const task = (scenario: string): RuntimeTaskPackage => ({
  tenant_id: "tenant-1", handoff_id: scenario, thread_id: "thread-1", stream_version: 1,
  role: { role_id: "daily-assistant", version: 1, display_name: "Daily", description: "Daily", capability_ids: ["information.synthesis"] },
  capability_id: "information.synthesis", intent: [], context_reference: null, authority_scope: {}, acceptance_criteria: [], priority: "normal",
  accept_by: "2026-01-01T00:00:00.000Z", result_due_at: "2026-01-01T01:00:00.000Z", workspace_path: "/tmp/workspace",
});

async function runFixture(scenario: string, options: { readonly timeout?: number; readonly grace?: number; readonly signal?: AbortSignal } = {}) {
  const config = validateAgentlyRuntimeDriverConfig({
    python: { executable: worker, module: "work_fabric_agently_runtime" }, workspace_root: process.cwd(),
    execution_timeout_seconds: options.timeout ?? 2, cancellation_grace_seconds: options.grace ?? 1,
    provider: { type: "OpenAICompatible", base_url: "https://model.example.test/v1", model: "test-model", api_key: "agently-test-secret" },
  }, "test", { config_directory: process.cwd() });
  const driver = await new AgentlyRuntimeDriverFactory().create(config);
  const progress: unknown[] = [];
  const result = await driver.execute(task(scenario), async (item) => { progress.push(item); }, options.signal ?? new AbortController().signal);
  return { result, progress };
}

describe("AgentlyProcessDriver", () => {
  it("accepts ordered progress followed by exactly one completed record", async () => {
    const { progress, result } = await runFixture("success");
    expect(progress).toMatchObject([{ sequence: 1 }, { sequence: 2 }]);
    expect(result.summary[0]).toMatchObject({ kind: "text" });
  });

  it.each(["malformed-json", "wrong-protocol", "duplicate-terminal", "progress-after-terminal", "non-monotonic-sequence", "oversized-line", "too-many-events", "deep-json", "silent-timeout", "non-zero-exit"])("fails closed for %s", async (scenario) => {
    await expect(runFixture(scenario, { timeout: scenario === "silent-timeout" ? 1 : 2 })).rejects.toMatchObject({ code: expect.stringMatching(/^agently_worker_/) });
  });

  it("passes only an allowlisted child environment", async () => {
    const { result } = await runFixture("print-env-keys");
    expect(result.extensions["workfabric.dev/child_env_keys"]).toEqual(["AGENTLY_MODEL_API_KEY", "LANG", "PATH", "PYTHONIOENCODING"]);
  });

  it("sends graceful termination then forced termination after cancellation grace", async () => {
    const kill = vi.spyOn(ChildProcess.prototype, "kill");
    const controller = new AbortController();
    const pending = runFixture("ignore-term", { grace: 1, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: "agently_worker_cancelled" });
    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(expect.arrayContaining(["SIGTERM", "SIGKILL"]));
    kill.mockRestore();
  });
});
