import { describe, expect, it, vi } from "vitest";

import { MemoryAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-memory";
import type { RuntimeDriverResult } from "@work-fabric/agent-runtime-spi";
import type { HandoffReadModel, OperationResult } from "@work-fabric/sdk-typescript";

import { AgentRuntimeHost, type AgentRuntimeHostConfig } from "../src/index.js";

const setupNow = "2026-07-26T00:00:00.000Z";
const recoveryNow = "2026-07-26T00:02:00.000Z";
const runtimeResult: RuntimeDriverResult = { summary: [{ kind: "text", media_type: "text/plain", text: "finished" }], artifacts: [], evidence: [], extensions: {} };
const operation = (version: number): OperationResult => ({ spec_version: "1.0", request_message_id: `message-${version}`, operation_status: "accepted", resource: { resource_type: "handoff", resource_id: "handoff-1", resource_version: version }, receipt: null, error: null });
const acceptedSnapshot = (): HandoffReadModel => ({ tenant_id: "tenant-1", partition_id: "handoff:handoff-1", handoff_id: "handoff-1", stream_version: 2, state: { lifecycle_state: "accepted", resource_version: 2, recipient: { actor_id: "actor-runtime" } }, latest_status: null } as unknown as HandoffReadModel);
const config: AgentRuntimeHostConfig = { runtime_id: "runtime-1", tenant_id: "tenant-1", actor_id: "actor-runtime", endpoint_id: "endpoint-runtime", max_active_runs: 1, queue_capacity: 2, run_lease_seconds: 60, progress_interval_ms: 100, workspace_root: "/tmp/runtime-workspaces" };

describe("AgentRuntimeHost recovery", () => {
  it("reuses a durably captured result without invoking the model after a restart", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    await state.createRunIfAbsent("tenant-1", "handoff-1", setupNow);
    const claim = await state.claimRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", now: setupNow, lease_seconds: 60, allowed_states: ["received"] });
    if (claim === null) throw new Error("claim setup failed");
    await state.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", fencing_token: claim.fencing_token, expected_state: "received", next_state: "accepted", now: setupNow });
    await state.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", fencing_token: claim.fencing_token, expected_state: "accepted", next_state: "running", now: setupNow });
    await state.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", fencing_token: claim.fencing_token, expected_state: "running", next_state: "result_ready", now: setupNow, result: runtimeResult, result_digest: "digest" });
    const returnResult = vi.fn(async () => operation(3));
    const execute = vi.fn(async () => runtimeResult);
    const host = new AgentRuntimeHost({
      config,
      session: { handoffs: { returnResult, accept: vi.fn(), decline: vi.fn(), reportStatus: vi.fn() } as never, incoming: async function* () {}, close: async () => undefined, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) },
      state,
      driver: { manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] }, execute },
      packageLoader: { load: vi.fn() } as never,
      policy: { decide: vi.fn() },
      queries: { getHandoff: vi.fn(async () => acceptedSnapshot()) },
      now: () => recoveryNow,
    });

    await host.start();

    expect(returnResult).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("succeeded");
    await host.close();
  });
});
