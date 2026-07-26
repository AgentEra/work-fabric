import { describe, expect, it } from "vitest";

import { parseAgentlyWorkerRecord, type AgentlyWorkerRequestV1 } from "../src/index.js";

const task = {
  tenant_id: "tenant-1", handoff_id: "handoff-1", thread_id: "thread-1", stream_version: 1,
  role: { role_id: "daily-assistant", version: 1, display_name: "Daily", description: "Daily", capability_ids: ["information.synthesis"] },
  capability_id: "information.synthesis", intent: [], context_reference: null, authority_scope: {}, acceptance_criteria: [], priority: "normal" as const,
  accept_by: "2026-01-01T00:00:00.000Z", result_due_at: "2026-01-01T01:00:00.000Z", workspace_path: "/tmp/workspace",
};

describe("Agently worker protocol", () => {
  it("defines a versioned request that excludes provider credentials", () => {
    const request: AgentlyWorkerRequestV1 = { protocol: "workfabric.agent-runtime/1", command_id: "command-1", task, provider: { type: "OpenAICompatible", base_url: "https://model.example.test/v1", model: "test-model" } };
    expect(JSON.stringify(request)).not.toContain("api_key");
  });

  it("accepts a strict completed record", () => {
    expect(parseAgentlyWorkerRecord({ protocol: "workfabric.agent-runtime/1", type: "completed", command_id: "command-1", result: { summary: [{ kind: "text", text: "done" }], artifacts: [], evidence: [], extensions: {} } }, "command-1")).toMatchObject({ type: "completed" });
  });

  it.each([
    [{ protocol: "other", type: "failed", command_id: "command-1", code: "no", message: "no", retryable: false }],
    [{ protocol: "workfabric.agent-runtime/1", type: "unknown", command_id: "command-1" }],
    [{ protocol: "workfabric.agent-runtime/1", type: "progress", command_id: "command-2", sequence: 1, progress: null, message: "x", observed_at: "2026-01-01T00:00:00.000Z" }],
    [{ protocol: "workfabric.agent-runtime/1", type: "completed", command_id: "command-1", result: { summary: [], artifacts: [], evidence: [], extensions: {}, extra: true } }],
  ])("rejects a record outside the exact protocol", (record) => {
    expect(() => parseAgentlyWorkerRecord(record, "command-1")).toThrow();
  });

  it.each(["summary", "artifacts", "evidence"] as const)("rejects non-object %s entries", (collection) => {
    for (const entry of [null, "text", [], new Date(), Object.create(null)]) {
      expect(() => parseAgentlyWorkerRecord({ protocol: "workfabric.agent-runtime/1", type: "completed", command_id: "command-1", result: { summary: collection === "summary" ? [entry] : [], artifacts: collection === "artifacts" ? [entry] : [], evidence: collection === "evidence" ? [entry] : [], extensions: {} } }, "command-1")).toThrow();
    }
  });

  it("does not invoke getters while rejecting a record", () => {
    let reads = 0;
    const entry = {};
    Object.defineProperty(entry, "secret", { enumerable: true, get() { reads += 1; return "unexpected"; } });
    expect(() => parseAgentlyWorkerRecord({ protocol: "workfabric.agent-runtime/1", type: "completed", command_id: "command-1", result: { summary: [entry], artifacts: [], evidence: [], extensions: {} } }, "command-1")).toThrow();
    expect(reads).toBe(0);
  });

  it("rejects records exceeding aggregate JSON node or string-byte bounds", () => {
    const nodes = Object.fromEntries(Array.from({ length: 10_000 }, (_item, index) => [`k${index}`, index]));
    const record = { protocol: "workfabric.agent-runtime/1", type: "completed", command_id: "command-1", result: { summary: [nodes], artifacts: [], evidence: [], extensions: {} } };
    expect(() => parseAgentlyWorkerRecord(record, "command-1")).toThrow();
    expect(() => parseAgentlyWorkerRecord({ protocol: "workfabric.agent-runtime/1", type: "completed", command_id: "command-1", result: { summary: [{ kind: "text", text: "x".repeat(131_073) }], artifacts: [], evidence: [], extensions: {} } }, "command-1")).toThrow();
  });
});
