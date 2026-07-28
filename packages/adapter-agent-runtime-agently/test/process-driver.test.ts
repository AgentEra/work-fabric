import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  CapabilityAwareAgentRuntimeDriver,
  RuntimeTaskPackage,
} from "@work-fabric/agent-runtime-spi";

import { AgentlyProcessDriver, AgentlyRuntimeDriverFactory, validateAgentlyRuntimeDriverConfig } from "../src/index.js";

const worker = fileURLToPath(new URL("./fixtures/fake-worker.mjs", import.meta.url));

const task = (scenario: string): RuntimeTaskPackage => ({
  tenant_id: "tenant-1", handoff_id: scenario, thread_id: "thread-1", stream_version: 1,
  role: { role_id: "daily-assistant", version: 1, display_name: "Daily", description: "Daily", capability_ids: ["information.synthesis"] },
  capability_id: "information.synthesis", intent: [], context_reference: null, resolved_context: null, authority_scope: {}, acceptance_criteria: [], priority: "normal",
  accept_by: "2026-01-01T00:00:00.000Z", result_due_at: "2026-01-01T01:00:00.000Z", workspace_path: "/tmp/workspace",
});

async function runFixture(scenario: string, options: { readonly timeout?: number; readonly grace?: number; readonly signal?: AbortSignal; readonly onProgress?: (item: unknown) => Promise<void>; readonly onObservation?: (item: unknown) => void } = {}) {
  const config = validateAgentlyRuntimeDriverConfig({
    python: { executable: worker, module: "work_fabric_agently_runtime" }, workspace_root: process.cwd(),
    execution_timeout_seconds: options.timeout ?? 2, cancellation_grace_seconds: options.grace ?? 1,
    provider: { type: "OpenAICompatible", base_url: "https://model.example.test/v1", model: "test-model", api_key: "agently-test-secret" },
  }, "test", { config_directory: process.cwd() });
  const driver = options.onObservation === undefined
    ? await new AgentlyRuntimeDriverFactory().create(config)
    : new AgentlyProcessDriver(config, { observer: options.onObservation });
  const progress: unknown[] = [];
  const result = await driver.execute(task(scenario), async (item) => { progress.push(item); await options.onProgress?.(item); }, options.signal ?? new AbortController().signal);
  return { result, progress };
}

describe("AgentlyProcessDriver", () => {
  it("executes v3 capability and final turns without changing the v1 driver path", async () => {
    const config = validateAgentlyRuntimeDriverConfig({
      python: {
        executable: worker,
        module: "work_fabric_agently_runtime",
      },
      workspace_root: process.cwd(),
      execution_timeout_seconds: 2,
      cancellation_grace_seconds: 1,
      provider: {
        type: "OpenAICompatible",
        base_url: "https://model.example.test/v1",
        model: "test-model",
        api_key: "agently-test-secret",
      },
    }, "test", { config_directory: process.cwd() });
    const driver = new AgentlyProcessDriver(config);
    const capabilityDriver: CapabilityAwareAgentRuntimeDriver = driver;
    const signal = new AbortController().signal;

    const requested = await capabilityDriver.executeTurn(
      task("turn-capability"),
      [{
        citizen_id: "citizen-feishu",
        capability_id: "feishu.document.create",
        version: "1.0.0",
        name: "Create document",
        description: "Create one simple Docx document.",
        input_schema: null,
      }],
      null,
      async () => undefined,
      signal,
    );
    expect(requested).toEqual({
      kind: "capability_request",
      request: {
        invocation_id: "invocation-fixture-1",
        capability_id: "feishu.document.create",
        version_constraint: "1.0.0",
        input: { title: "项目需求" },
        reason: "创建团队文档",
      },
    });
    if (requested.kind !== "capability_request") {
      throw new Error("fixture did not request a capability");
    }
    const completed = await capabilityDriver.executeTurn(
      task("turn-capability"),
      [{
        citizen_id: "citizen-feishu",
        capability_id: "feishu.document.create",
        version: "1.0.0",
        name: "Create document",
        description: "Create one simple Docx document.",
        input_schema: null,
      }],
      {
        request: requested.request,
        result: {
          outcome: "failed",
          invocation_id: requested.request.invocation_id,
          auxiliary_handoff_id: null,
          code: "provider_unavailable",
          message: "Provider unavailable",
          retryable: true,
        },
      },
      async () => undefined,
      signal,
    );
    expect(completed).toMatchObject({
      kind: "final",
      response: {
        summary: [{ text: "Agent handled provider facts" }],
      },
    });

    const legacy = await driver.execute(
      task("success"),
      async () => undefined,
      signal,
    );
    expect(legacy.summary[0]).toMatchObject({ text: "done" });
  });

  it("accepts ordered progress followed by exactly one completed record", async () => {
    const { progress, result } = await runFixture("success");
    expect(progress).toMatchObject([{ sequence: 1 }, { sequence: 2 }]);
    expect(result.summary[0]).toMatchObject({ kind: "text" });
  });

  it("emits a bounded observer record for the actual task JSON and worker streams", async () => {
    const observations: unknown[] = [];
    await runFixture("success", { onObservation: (item) => observations.push(item) });

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      task_json: expect.stringContaining('"handoff_id":"success"'),
      stdout: expect.stringContaining('"type":"completed"'),
      stderr: "",
      runtime_log: expect.stringContaining("worker_completed"),
    });
  });

  it.each(["malformed-json", "wrong-protocol", "duplicate-terminal", "progress-after-terminal", "non-monotonic-sequence", "oversized-line", "too-many-events", "deep-json", "silent-timeout", "non-zero-exit"])("fails closed for %s", async (scenario) => {
    await expect(runFixture(scenario, { timeout: scenario === "silent-timeout" ? 1 : 2 })).rejects.toMatchObject({ code: expect.stringMatching(/^agently_worker_/) });
  });

  it("passes only an allowlisted child environment", async () => {
    const { result } = await runFixture("print-env-keys");
    expect(result.extensions["workfabric.dev/child_env_keys"]).toEqual(["AGENTLY_MODEL_API_KEY", "LANG", "PATH", "PYTHONIOENCODING"]);
  });

  it("sends graceful termination then forced termination after cancellation grace", async () => {
    const kill = vi.spyOn(process, "kill");
    const controller = new AbortController();
    let workerReady!: () => void;
    const ready = new Promise<void>((resolve) => { workerReady = resolve; });
    const pending = runFixture("ignore-term", {
      grace: 1,
      signal: controller.signal,
      onProgress: async () => workerReady(),
    });
    await ready;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "agently_worker_cancelled" });
    expect(kill.mock.calls.map(([_pid, signal]) => signal)).toEqual(expect.arrayContaining(["SIGTERM", "SIGKILL"]));
    kill.mockRestore();
  });

  it("rejects promptly when the child closes while a delayed progress sink has buffered invalid output", async () => {
    const start = Date.now();
    const outcome = await Promise.race([
      runFixture("delayed-invalid", { timeout: 3, onProgress: async () => { await new Promise((resolve) => setTimeout(resolve, 1_500)); } }).then(() => "resolved", (failure: { readonly code: string }) => failure.code),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 2_800)),
    ]);
    expect(outcome).toBe("agently_worker_protocol");
    expect(Date.now() - start).toBeLessThan(2_800);
  });

  it("terminates the entire worker process group, including an API-key-bearing descendant", async () => {
    const controller = new AbortController();
    let descendantPid = 0;
    let progressed!: () => void;
    const progress = new Promise<void>((resolve) => { progressed = resolve; });
    const pending = runFixture("spawn-descendant", {
      grace: 1,
      signal: controller.signal,
      onProgress: async (item) => {
        const message = (item as { readonly message: string }).message;
        descendantPid = Number(message.slice("descendant:".length));
        progressed();
      },
    });
    await progress;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "agently_worker_cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  it("keeps the grace-period group kill after the parent exits while an API-key-bearing descendant ignores SIGTERM", async () => {
    const controller = new AbortController();
    let descendantPid = 0;
    let progressed!: () => void;
    const progress = new Promise<void>((resolve) => { progressed = resolve; });
    const pending = runFixture("parent-exits-descendant", {
      grace: 1,
      signal: controller.signal,
      onProgress: async (item) => {
        descendantPid = Number((item as { readonly message: string }).message.slice("descendant:".length));
        progressed();
      },
    });
    await progress;
    const started = Date.now();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "agently_worker_cancelled" });
    expect(Date.now() - started).toBeLessThan(500);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    let alive = false;
    try { process.kill(descendantPid, 0); alive = true; } catch { /* process group cleanup succeeded */ }
    finally { if (alive) { try { process.kill(descendantPid, "SIGKILL"); } catch { /* already exited */ } } }
    expect(alive).toBe(false);
  });
});
