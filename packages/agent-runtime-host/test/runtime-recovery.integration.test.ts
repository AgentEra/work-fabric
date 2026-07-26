import { describe, expect, it, vi } from "vitest";

import { MemoryAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-memory";
import type { AgentRuntimeDriver, RuntimeDriverResult } from "@work-fabric/agent-runtime-spi";
import type { IncomingHandoff } from "@work-fabric/agent-gateway";
import type { HandoffReadModel, OperationResult } from "@work-fabric/sdk-typescript";

import { AgentRuntimeHost, type AgentRuntimeHostConfig } from "../src/index.js";

const setupNow = "2026-07-26T00:00:00.000Z";
const recoveryNow = "2026-07-26T00:02:00.000Z";
const runtimeResult: RuntimeDriverResult = { summary: [{ kind: "text", media_type: "text/plain", text: "finished" }], artifacts: [], evidence: [], extensions: {} };
const operation = (version: number): OperationResult => ({ spec_version: "1.0", request_message_id: `message-${version}`, operation_status: "accepted", resource: { resource_type: "handoff", resource_id: "handoff-1", resource_version: version }, receipt: null, error: null });
const acceptedSnapshot = (): HandoffReadModel => ({ tenant_id: "tenant-1", partition_id: "handoff:handoff-1", handoff_id: "handoff-1", stream_version: 2, state: { lifecycle_state: "accepted", resource_version: 2, recipient: { actor_id: "actor-runtime" } }, latest_status: null } as unknown as HandoffReadModel);
const config: AgentRuntimeHostConfig = { runtime_id: "runtime-1", tenant_id: "tenant-1", actor_id: "actor-runtime", endpoint_id: "endpoint-runtime", max_active_runs: 1, queue_capacity: 2, run_lease_seconds: 60, progress_interval_ms: 100, workspace_root: "/tmp/runtime-workspaces" };

describe("AgentRuntimeHost recovery", () => {
  it("recovers a Run durably captured before an acknowledged Delivery can crash", async () => {
    class CrashAfterAcknowledgementStateStore extends MemoryAgentRuntimeStateStore {
      private crashOnce = true;

      override async markDeliveryAcknowledged(tenantId: string, deliveryId: string, acknowledgedAt: string): Promise<boolean> {
        const marked = await super.markDeliveryAcknowledged(tenantId, deliveryId, acknowledgedAt);
        if (this.crashOnce) {
          this.crashOnce = false;
          throw new Error("simulated process crash after Delivery Ack");
        }
        return marked;
      }
    }

    const state = new CrashAfterAcknowledgementStateStore();
    const execute = vi.fn(async () => runtimeResult);
    const delivered: IncomingHandoff = {
      partition_id: "handoff:handoff-1",
      delivery: {
        delivery_id: "delivery-before-crash", subscription_id: "subscription-1", attempt: 1,
        events: [{ specversion: "1.0", id: "event-offered", source: "urn:test", type: "workfabric.handoff.offered.v1", subject: "handoff-1", time: setupNow, datacontenttype: "application/json", dataschema: "urn:test", wftenant: "tenant-1", wfexchange: "exchange-1", wfthread: "thread-1", wfhandoff: "handoff-1", wfactor: "actor-sender", wfendpoint: "endpoint-sender", wfsequence: 1, wfvisibility: "participants", data: {} }],
        next_cursor: "cursor-1", delivered_at: setupNow, visibility_expires_at: "2026-07-26T00:01:00.000Z",
      },
      handoff: { ...acceptedSnapshot(), state: { lifecycle_state: "offered", resource_version: 1 }, stream_version: 1 },
      acknowledgeSignal: vi.fn(async () => ({ kind: "acknowledged", cursor: "cursor-1" } as const)),
    };
    const crashedHost = recoveryHost(state, { lifecycle: "offered", execute });

    await expect(crashedHost.handle(delivered)).rejects.toThrow("simulated process crash");
    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("received");

    const recoveredHost = recoveryHost(state, { lifecycle: "offered", execute });
    await recoveredHost.start();

    expect(execute).toHaveBeenCalledTimes(1);
    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("succeeded");
    await recoveredHost.close();
  });

  it("opens a lazily created Gateway Session before recovering a received Run", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    await state.createRunIfAbsent("tenant-1", "handoff-1", setupNow);
    const accept = vi.fn(async () => operation(2));
    const reportStatus = vi.fn(async () => operation(3));
    const returnResult = vi.fn(async () => operation(4));
    const execute = vi.fn(async () => runtimeResult);
    const session = {
      handoffs: { accept, reportStatus, returnResult, decline: vi.fn() } as never,
      incoming: async function* () {},
      close: vi.fn(async () => undefined),
      session_id: "session-lazy",
      closed: Promise.resolve({ reason: "closed" as const }),
    };
    const startSession = vi.fn(async () => session);
    const host = new AgentRuntimeHost({
      config,
      startSession,
      state,
      driver: { manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] }, execute },
      packageLoader: { load: vi.fn(async () => ({ snapshot: acceptedSnapshot(), events: [], task: { tenant_id: "tenant-1", handoff_id: "handoff-1" } })) } as never,
      policy: { decide: vi.fn() },
      queries: { getHandoff: vi.fn(async () => acceptedSnapshot()) },
      now: () => recoveryNow,
    });

    await host.start();

    expect(startSession).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(returnResult).toHaveBeenCalledTimes(1);
    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("succeeded");
    await host.close();
    expect(session.close).toHaveBeenCalledTimes(1);
  });

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

  it("retains result_ready after an ambiguous Result submission so restart retries the same Result", async () => {
    const state = await readyState();
    const host = recoveryHost(state, { returnResult: vi.fn(async () => { throw new Error("timeout"); }) });

    await host.start();

    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("result_ready");
    await host.close();
  });

  it("converges a recovered received run after an equivalent remote decline", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    await state.createRunIfAbsent("tenant-1", "handoff-1", setupNow);
    const host = recoveryHost(state, { lifecycle: "offered", decision: { kind: "decline", code: "not_targeted" } });

    await host.start();

    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("cancelled");
    await host.close();
  });

  it("converges a recovered running run to succeeded from an authoritative remote Result without executing", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    await state.createRunIfAbsent("tenant-1", "handoff-1", setupNow);
    const claim = await state.claimRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", now: setupNow, lease_seconds: 60, allowed_states: ["received"] });
    if (claim === null) throw new Error("claim setup failed");
    await state.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", fencing_token: claim.fencing_token, expected_state: "received", next_state: "accepted", now: setupNow });
    await state.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", fencing_token: claim.fencing_token, expected_state: "accepted", next_state: "running", now: setupNow });
    const execute = vi.fn(async () => runtimeResult);
    const host = recoveryHost(state, { lifecycle: "result_returned", result: runtimeResult, execute });

    await host.start();

    expect(execute).not.toHaveBeenCalled();
    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("succeeded");
    await host.close();
  });

  it.each(["accepted", "running"] as const)("resumes an accepted remote Handoff from local %s state exactly once", async (stateBeforeRestart) => {
    const state = new MemoryAgentRuntimeStateStore();
    await state.createRunIfAbsent("tenant-1", "handoff-1", setupNow);
    const claim = await state.claimRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", now: setupNow, lease_seconds: 60, allowed_states: ["received"] });
    if (claim === null) throw new Error("claim setup failed");
    await state.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", fencing_token: claim.fencing_token, expected_state: "received", next_state: "accepted", now: setupNow });
    if (stateBeforeRestart === "running") {
      await state.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", fencing_token: claim.fencing_token, expected_state: "accepted", next_state: "running", now: setupNow });
    }
    const execute = vi.fn(async () => runtimeResult);
    const host = recoveryHost(state, { lifecycle: "accepted", execute });

    await host.start();

    expect(execute).toHaveBeenCalledTimes(1);
    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("succeeded");
    await host.close();
  });

  it("drains a recovered running run to cancelled from an authoritative terminal Handoff without executing", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    await state.createRunIfAbsent("tenant-1", "handoff-1", setupNow);
    const claim = await state.claimRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", now: setupNow, lease_seconds: 60, allowed_states: ["received"] });
    if (claim === null) throw new Error("claim setup failed");
    await state.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", fencing_token: claim.fencing_token, expected_state: "received", next_state: "accepted", now: setupNow });
    await state.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", fencing_token: claim.fencing_token, expected_state: "accepted", next_state: "running", now: setupNow });
    const execute = vi.fn(async () => runtimeResult);
    const host = recoveryHost(state, { lifecycle: "cancelled", execute });

    await host.start();

    expect(execute).not.toHaveBeenCalled();
    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("cancelled");
    await host.close();
  });
});

async function readyState(): Promise<MemoryAgentRuntimeStateStore> {
  const state = new MemoryAgentRuntimeStateStore();
  await state.createRunIfAbsent("tenant-1", "handoff-1", setupNow);
  const claim = await state.claimRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", now: setupNow, lease_seconds: 60, allowed_states: ["received"] });
  if (claim === null) throw new Error("claim setup failed");
  await state.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", fencing_token: claim.fencing_token, expected_state: "received", next_state: "accepted", now: setupNow });
  await state.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", fencing_token: claim.fencing_token, expected_state: "accepted", next_state: "running", now: setupNow });
  await state.transitionRun({ tenant_id: "tenant-1", handoff_id: "handoff-1", owner: "runtime-1", fencing_token: claim.fencing_token, expected_state: "running", next_state: "result_ready", now: setupNow, result: runtimeResult, result_digest: "digest" });
  return state;
}

function recoveryHost(state: MemoryAgentRuntimeStateStore, options: { readonly lifecycle?: string; readonly result?: RuntimeDriverResult; readonly returnResult?: ReturnType<typeof vi.fn>; readonly decision?: { readonly kind: "decline"; readonly code: "not_targeted" }; readonly execute?: AgentRuntimeDriver["execute"] } = {}) {
  const lifecycle = options.lifecycle ?? "accepted";
  const snapshot = (): HandoffReadModel => ({ tenant_id: "tenant-1", partition_id: "handoff:handoff-1", handoff_id: "handoff-1", stream_version: 2, state: { lifecycle_state: lifecycle, resource_version: 2, recipient: { actor_id: "actor-runtime" }, result: options.result ?? null }, latest_status: null } as unknown as HandoffReadModel);
  return new AgentRuntimeHost({ config, session: { handoffs: { returnResult: options.returnResult ?? vi.fn(async () => operation(3)), accept: vi.fn(async () => operation(2)), decline: vi.fn(async () => operation(2)), reportStatus: vi.fn(async () => operation(3)) } as never, incoming: async function* () {}, close: async () => undefined, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) }, state, driver: { manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] }, execute: options.execute ?? vi.fn(async () => runtimeResult) }, packageLoader: { load: vi.fn(async () => ({ snapshot: snapshot(), events: [], task: { tenant_id: "tenant-1", handoff_id: "handoff-1" } })) } as never, policy: { decide: () => options.decision ?? ({ kind: "accept" as const }) }, queries: { getHandoff: vi.fn(async () => snapshot()) }, now: () => recoveryNow });
}
