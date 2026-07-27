import { describe, expect, it, vi } from "vitest";

import { MemoryAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-memory";
import type {
  AgentRuntimeDriver,
  CapabilityAwareAgentRuntimeDriver,
  CapabilityInvocationPort,
  RuntimeDriverResult,
  RuntimeTaskPackage,
} from "@work-fabric/agent-runtime-spi";
import type { IncomingHandoff } from "@work-fabric/agent-gateway";
import type { HandoffReadModel, OperationResult, ProtocolEvent } from "@work-fabric/sdk-typescript";

import { AgentRuntimeHost, type AgentRuntimeHostConfig } from "../src/index.js";

const now = () => "2026-07-26T00:00:00.000Z";
const result = (): RuntimeDriverResult => ({
  summary: [{ kind: "text", media_type: "text/plain", text: "finished" }],
  artifacts: [],
  evidence: [],
  extensions: {},
});
const operation = (version: number): OperationResult => ({
  spec_version: "1.0",
  request_message_id: `message-${version}`,
  operation_status: "accepted",
  resource: { resource_type: "handoff", resource_id: "handoff-1", resource_version: version },
  receipt: null,
  error: null,
});
const event = (): ProtocolEvent => ({
  specversion: "1.0", id: "event-1", source: "urn:test", type: "workfabric.handoff.offered.v1", subject: "handoff-1", time: now(), datacontenttype: "application/json", dataschema: "urn:test", wftenant: "tenant-1", wfexchange: "exchange-1", wfthread: "thread-1", wfhandoff: "handoff-1", wfactor: "actor-human", wfendpoint: "endpoint-human", wfsequence: 1, wfvisibility: "participants", data: {},
});
const snapshot = (): HandoffReadModel => ({
  tenant_id: "tenant-1", partition_id: "handoff:handoff-1", handoff_id: "handoff-1", stream_version: 1,
  state: { lifecycle_state: "offered", resource_version: 1 }, latest_status: null,
} as unknown as HandoffReadModel);
const config: AgentRuntimeHostConfig = {
  runtime_id: "runtime-1", tenant_id: "tenant-1", actor_id: "actor-runtime", endpoint_id: "endpoint-runtime", max_active_runs: 1, queue_capacity: 1, run_lease_seconds: 60, progress_interval_ms: 60_000, workspace_root: "/tmp/runtime-workspaces",
};

describe("AgentRuntimeHost", () => {
  it("keeps the original Handoff responsibility while an Agent uses an injected capability port", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    const legacyExecute = vi.fn(async () => result());
    const invoke = vi.fn(async (request) => ({
      outcome: "succeeded" as const,
      invocation_id: request.invocation_id,
      auxiliary_handoff_id: "handoff-auxiliary-1",
      candidate: {
        citizen_id: "citizen-feishu",
        endpoint_id: "endpoint-feishu",
        capability_id: request.capability_id,
        capability_version: "1.0.0",
        contract_digest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
      },
      data: { document_id: "doc-1" },
      artifacts: [],
    }));
    const invocations: CapabilityInvocationPort = {
      discover: async () => [],
      invoke,
    };
    let turn = 0;
    const turnDriver: CapabilityAwareAgentRuntimeDriver = {
      executeTurn: vi.fn(async () => {
        turn += 1;
        return turn === 1
          ? {
              kind: "capability_request" as const,
              request: {
                invocation_id: "invocation-1",
                capability_id: "feishu.document.create",
                version_constraint: "1.0.0",
                input: { title: "项目需求" },
                reason: "创建团队文档",
              },
            }
          : { kind: "final" as const, response: {
              summary: [{
                kind: "text",
                media_type: "text/plain",
                text: "已创建《项目需求》文档。",
              }],
              artifacts: [],
              evidence: [],
              extensions: {},
            } };
      }),
    };
    const returnResult = vi.fn(async (_payload: unknown) => operation(4));
    const handoffs = {
      accept: vi.fn(async () => operation(2)),
      decline: vi.fn(async () => operation(2)),
      reportStatus: vi.fn(async () => operation(3)),
      returnResult,
    };
    const loadedTask: RuntimeTaskPackage = {
      tenant_id: "tenant-1",
      handoff_id: "handoff-1",
      thread_id: "thread-1",
      stream_version: 1,
      role: {
        role_id: "daily-assistant",
        version: 1,
        display_name: "团队共享日常助理",
        description: "协助团队处理日常工作",
        capability_ids: ["collaboration.assistance"],
      },
      capability_id: "collaboration.assistance",
      intent: [],
      context_reference: null,
      authority_scope: {},
      acceptance_criteria: [],
      priority: "normal",
      accept_by: "2026-07-26T01:00:00.000Z",
      result_due_at: "2026-07-26T02:00:00.000Z",
      workspace_path: "/tmp/runtime-workspaces/handoff-1",
    };
    const host = new AgentRuntimeHost({
      config,
      session: {
        handoffs: handoffs as never,
        incoming: async function* () {},
        close: async () => undefined,
        session_id: "session-1",
        closed: Promise.resolve({ reason: "closed" as const }),
      },
      state,
      driver: {
        manifest: {
          driver_type: "legacy-test",
          protocol_version: "1",
          capability_ids: ["information.synthesis"],
        },
        execute: legacyExecute,
      },
      turn_driver: turnDriver,
      capability_disclosure: {
        async list() {
          return [{
            citizen_id: "citizen-feishu",
            capability_id: "feishu.document.create",
            version: "1.0.0",
            name: "Create document",
            description: "Create one simple Docx document.",
          }];
        },
      },
      capability_invocations: invocations,
      capability_limits: {
        max_invocations_per_handoff: 4,
        allowed_namespaces: ["feishu."],
      },
      packageLoader: {
        load: vi.fn(async () => ({
          snapshot: snapshot(),
          events: [event()],
          task: loadedTask,
        })),
      },
      policy: { decide: () => ({ kind: "accept" as const }) },
      queries: { getHandoff: vi.fn(async () => snapshot()) },
      now,
    });
    const incoming: IncomingHandoff = {
      partition_id: "handoff:handoff-1",
      delivery: {
        delivery_id: "delivery-capability",
        subscription_id: "subscription-1",
        attempt: 1,
        events: [event()],
        next_cursor: "cursor-1",
        delivered_at: now(),
        visibility_expires_at: "2026-07-26T00:01:00.000Z",
      },
      handoff: snapshot(),
      acknowledgeSignal: vi.fn(async () => ({
        kind: "acknowledged",
        cursor: "cursor-1",
      } as const)),
    };

    await host.handle(incoming);

    expect(legacyExecute).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(returnResult.mock.calls[0]?.[0]).toMatchObject({
      handoff_id: "handoff-1",
      result: {
        summary: [{
          text: "已创建《项目需求》文档。",
        }],
      },
    });
    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe(
      "succeeded",
    );
  });

  it("persists Delivery before acknowledging and accepts before execution", async () => {
    const order: string[] = [];
    const state = new MemoryAgentRuntimeStateStore();
    const recordDelivery = state.recordDelivery.bind(state);
    state.recordDelivery = async (input) => { order.push("persist"); return recordDelivery(input); };
    const handoffs = {
      accept: vi.fn(async () => { order.push("accept"); return operation(2); }),
      decline: vi.fn(async () => operation(2)),
      reportStatus: vi.fn(async () => operation(3)),
      returnResult: vi.fn(async () => operation(4)),
    };
    const driver: AgentRuntimeDriver = {
      manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] },
      execute: vi.fn(async () => { order.push("execute"); return result(); }),
    };
    const incoming: IncomingHandoff = {
      partition_id: "handoff:handoff-1",
      delivery: { delivery_id: "delivery-1", subscription_id: "subscription-1", attempt: 1, events: [event()], next_cursor: "cursor-1", delivered_at: now(), visibility_expires_at: "2026-07-26T00:01:00.000Z" },
      handoff: snapshot(),
      acknowledgeSignal: vi.fn(async () => { order.push("ack"); return { kind: "acknowledged", cursor: "cursor-1" } as const; }),
    };
    const host = new AgentRuntimeHost({
      config,
      session: { handoffs: handoffs as never, incoming: async function* () {}, close: async () => undefined, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) },
      state,
      driver,
      packageLoader: { load: vi.fn(async () => ({ snapshot: snapshot(), events: [event()], task: { tenant_id: "tenant-1", handoff_id: "handoff-1" } })) } as never,
      policy: { decide: () => ({ kind: "accept" as const }) },
      queries: { getHandoff: vi.fn(async () => snapshot()) },
      now,
    });

    await host.handle(incoming);

    expect(order.slice(0, 4)).toEqual(["persist", "ack", "accept", "execute"]);
    expect(driver.execute).toHaveBeenCalledTimes(1);
    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("succeeded");
  });

  it("acks duplicate and own-update Deliveries without another model execution", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    const execute = vi.fn(async () => result());
    const handoffs = { accept: vi.fn(async () => operation(2)), decline: vi.fn(async () => operation(2)), reportStatus: vi.fn(async () => operation(3)), returnResult: vi.fn(async () => operation(4)) };
    const host = new AgentRuntimeHost({
      config, session: { handoffs: handoffs as never, incoming: async function* () {}, close: async () => undefined, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) }, state,
      driver: { manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] }, execute },
      packageLoader: { load: vi.fn(async () => ({ snapshot: snapshot(), events: [event()], task: { tenant_id: "tenant-1", handoff_id: "handoff-1" } })) } as never,
      policy: { decide: (_snapshot: HandoffReadModel, delivered: ProtocolEvent) => delivered.wfactor === "actor-runtime" ? { kind: "ignore" as const, code: "own_update" as const } : { kind: "accept" as const } },
      queries: { getHandoff: vi.fn(async () => snapshot()) }, now,
    });
    const offer = (deliveryId: string, delivered = event()): IncomingHandoff => ({ partition_id: "handoff:handoff-1", delivery: { delivery_id: deliveryId, subscription_id: "subscription-1", attempt: 1, events: [delivered], next_cursor: "cursor-1", delivered_at: now(), visibility_expires_at: "2026-07-26T00:01:00.000Z" }, handoff: snapshot(), acknowledgeSignal: vi.fn(async () => ({ kind: "acknowledged", cursor: "cursor-1" } as const)) });

    const first = offer("delivery-1");
    const own = offer("delivery-2", { ...event(), id: "event-2", wfactor: "actor-runtime", type: "workfabric.handoff.status_reported.v1" });
    await host.handle(first);
    await host.handle(first);
    await host.handle(own);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(own.acknowledgeSignal).toHaveBeenCalledWith("acknowledged");
  });

  it("renews a one-second run lease before it expires", async () => {
    vi.useFakeTimers();
    try {
      const state = new MemoryAgentRuntimeStateStore();
      const renewRun = vi.spyOn(state, "renewRun");
      let begin!: () => void;
      const started = new Promise<void>((resolve) => { begin = resolve; });
      let finish!: () => void;
      const driver: AgentRuntimeDriver = {
        manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] },
        execute: async (_task, _progress, signal) => {
          begin();
          await new Promise<void>((resolve, reject) => {
            finish = resolve;
            signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          });
          return result();
        },
      };
      const handoffs = { accept: vi.fn(async () => operation(2)), decline: vi.fn(async () => operation(2)), reportStatus: vi.fn(async () => operation(3)), returnResult: vi.fn(async () => operation(4)) };
      const incoming: IncomingHandoff = { partition_id: "handoff:handoff-1", delivery: { delivery_id: "delivery-lease", subscription_id: "subscription-1", attempt: 1, events: [event()], next_cursor: "cursor-1", delivered_at: now(), visibility_expires_at: "2026-07-26T00:01:00.000Z" }, handoff: snapshot(), acknowledgeSignal: vi.fn(async () => ({ kind: "acknowledged", cursor: "cursor-1" } as const)) };
      const host = new AgentRuntimeHost({
        config: { ...config, run_lease_seconds: 1 },
        session: { handoffs: handoffs as never, incoming: async function* () {}, close: async () => undefined, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) }, state, driver,
        packageLoader: { load: vi.fn(async () => ({ snapshot: snapshot(), events: [event()], task: { tenant_id: "tenant-1", handoff_id: "handoff-1" } })) } as never,
        policy: { decide: () => ({ kind: "accept" as const }) }, queries: { getHandoff: vi.fn(async () => snapshot()) }, now,
      });

      const handling = host.handle(incoming);
      await started;
      await vi.advanceTimersByTimeAsync(500);
      expect(renewRun).toHaveBeenCalledTimes(1);
      finish();
      await handling;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["cancelled", "expired", "declined", "transferred", "target_unavailable"])("converges an idle local run to cancelled when an acknowledged %s Delivery arrives", async (terminalLifecycle) => {
    const state = new MemoryAgentRuntimeStateStore();
    await state.createRunIfAbsent("tenant-1", "handoff-1", now());
    const incoming: IncomingHandoff = { partition_id: "handoff:handoff-1", delivery: { delivery_id: `delivery-${terminalLifecycle}`, subscription_id: "subscription-1", attempt: 1, events: [event()], next_cursor: "cursor-1", delivered_at: now(), visibility_expires_at: "2026-07-26T00:01:00.000Z" }, handoff: { ...snapshot(), state: { lifecycle_state: terminalLifecycle, resource_version: 1 } } as HandoffReadModel, acknowledgeSignal: vi.fn(async () => ({ kind: "acknowledged", cursor: "cursor-1" } as const)) };
    const host = new AgentRuntimeHost({
      config, session: { handoffs: {} as never, incoming: async function* () {}, close: async () => undefined, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) }, state,
      driver: { manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] }, execute: vi.fn() }, packageLoader: { load: vi.fn() } as never,
      policy: { decide: vi.fn() }, queries: { getHandoff: vi.fn(async () => incoming.handoff) }, now,
    });

    await host.handle(incoming);

    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("cancelled");
  });

  it("declines deterministically without starting a Driver run and closes its local row", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    const decline = vi.fn(async () => operation(2));
    const execute = vi.fn(async () => result());
    const incoming: IncomingHandoff = { partition_id: "handoff:handoff-1", delivery: { delivery_id: "delivery-decline", subscription_id: "subscription-1", attempt: 1, events: [event()], next_cursor: "cursor-1", delivered_at: now(), visibility_expires_at: "2026-07-26T00:01:00.000Z" }, handoff: snapshot(), acknowledgeSignal: vi.fn(async () => ({ kind: "acknowledged", cursor: "cursor-1" } as const)) };
    const host = new AgentRuntimeHost({
      config, session: { handoffs: { decline, accept: vi.fn(), reportStatus: vi.fn(), returnResult: vi.fn() } as never, incoming: async function* () {}, close: async () => undefined, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) }, state,
      driver: { manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] }, execute }, packageLoader: { load: vi.fn() } as never,
      policy: { decide: () => ({ kind: "decline" as const, code: "not_targeted" as const }) }, queries: { getHandoff: vi.fn(async () => snapshot()) }, now,
    });

    await host.handle(incoming);

    expect(decline).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("cancelled");
  });

  it("leaves an Ack-retry receipt unacknowledged for a later Delivery", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    const incoming: IncomingHandoff = { partition_id: "handoff:handoff-1", delivery: { delivery_id: "delivery-retry", subscription_id: "subscription-1", attempt: 1, events: [event()], next_cursor: "cursor-1", delivered_at: now(), visibility_expires_at: "2026-07-26T00:01:00.000Z" }, handoff: snapshot(), acknowledgeSignal: vi.fn(async () => ({ kind: "retry", cursor: "cursor-1" } as const)) };
    const host = new AgentRuntimeHost({ config, session: { handoffs: {} as never, incoming: async function* () {}, close: async () => undefined, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) }, state, driver: { manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] }, execute: vi.fn() }, packageLoader: { load: vi.fn() } as never, policy: { decide: vi.fn() }, queries: { getHandoff: vi.fn() }, now });

    await expect(host.handle(incoming)).rejects.toMatchObject({ code: "delivery_ack_failed" });
    const replay = await state.recordDelivery({ tenant_id: "tenant-1", delivery_id: "delivery-retry", handoff_id: "handoff-1", partition_id: "handoff:handoff-1", event_id: "event-1", received_at: now(), acknowledged_at: null });
    expect(replay.record.acknowledged_at).toBeNull();
  });

  it("converges an accept conflict by re-reading the equivalent accepted Handoff", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    const accepted = { ...snapshot(), stream_version: 2, state: { lifecycle_state: "accepted", resource_version: 2, recipient: { actor_id: "actor-runtime" } } } as HandoffReadModel;
    const accept = vi.fn(async (): Promise<OperationResult> => ({ ...operation(2), operation_status: "conflict", resource: null }));
    const execute = vi.fn(async () => result());
    const host = new AgentRuntimeHost({
      config, session: { handoffs: { accept, decline: vi.fn(), reportStatus: vi.fn(async () => operation(3)), returnResult: vi.fn(async () => operation(4)) } as never, incoming: async function* () {}, close: async () => undefined, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) }, state,
      driver: { manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] }, execute }, packageLoader: { load: vi.fn(async () => ({ snapshot: snapshot(), events: [event()], task: { tenant_id: "tenant-1", handoff_id: "handoff-1" } })) } as never,
      policy: { decide: () => ({ kind: "accept" as const }) }, queries: { getHandoff: vi.fn(async () => accepted) }, now,
    });
    const incoming: IncomingHandoff = { partition_id: "handoff:handoff-1", delivery: { delivery_id: "delivery-conflict", subscription_id: "subscription-1", attempt: 1, events: [event()], next_cursor: "cursor-1", delivered_at: now(), visibility_expires_at: "2026-07-26T00:01:00.000Z" }, handoff: snapshot(), acknowledgeSignal: vi.fn(async () => ({ kind: "acknowledged", cursor: "cursor-1" } as const)) };

    await host.handle(incoming);
    expect(accept).toHaveBeenCalledWith({ handoff_id: "handoff-1" }, expect.objectContaining({ expectedVersion: 2 }));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(["driver failure", "invalid result"])('marks %s as failed after flushing safe lifecycle state', async (kind) => {
    const state = new MemoryAgentRuntimeStateStore();
    const execute = vi.fn(async () => {
      if (kind === "driver failure") throw new Error("model exit");
      return { ...result(), summary: [] };
    });
    const host = new AgentRuntimeHost({ config, session: { handoffs: { accept: vi.fn(async () => operation(2)), decline: vi.fn(), reportStatus: vi.fn(async () => operation(3)), returnResult: vi.fn() } as never, incoming: async function* () {}, close: async () => undefined, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) }, state, driver: { manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] }, execute }, packageLoader: { load: vi.fn(async () => ({ snapshot: snapshot(), events: [event()], task: { tenant_id: "tenant-1", handoff_id: "handoff-1" } })) } as never, policy: { decide: () => ({ kind: "accept" as const }) }, queries: { getHandoff: vi.fn(async () => snapshot()) }, now });
    const incoming: IncomingHandoff = { partition_id: "handoff:handoff-1", delivery: { delivery_id: `delivery-${kind}`, subscription_id: "subscription-1", attempt: 1, events: [event()], next_cursor: "cursor-1", delivered_at: now(), visibility_expires_at: "2026-07-26T00:01:00.000Z" }, handoff: snapshot(), acknowledgeSignal: vi.fn(async () => ({ kind: "acknowledged", cursor: "cursor-1" } as const)) };

    await host.handle(incoming);
    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("failed");
  });

  it("converges to cancelled when a progress command races an authoritative remote cancellation", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    const conflict: OperationResult = { ...operation(3), operation_status: "conflict" };
    const accepted = { ...snapshot(), stream_version: 2, state: { lifecycle_state: "accepted", resource_version: 2 } } as HandoffReadModel;
    const cancelled = { ...snapshot(), stream_version: 3, state: { lifecycle_state: "cancelled", resource_version: 3 } } as HandoffReadModel;
    const snapshots = [snapshot(), accepted, cancelled];
    const queries = { getHandoff: vi.fn(async () => snapshots.shift() ?? cancelled) };
    const host = new AgentRuntimeHost({
      config,
      session: { handoffs: { accept: vi.fn(async () => operation(2)), decline: vi.fn(), reportStatus: vi.fn(async () => conflict), returnResult: vi.fn() } as never, incoming: async function* () {}, close: async () => undefined, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) },
      state,
      driver: { manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] }, execute: vi.fn(async () => result()) },
      packageLoader: { load: vi.fn(async () => ({ snapshot: snapshot(), events: [event()], task: { tenant_id: "tenant-1", handoff_id: "handoff-1" } })) } as never,
      policy: { decide: () => ({ kind: "accept" as const }) },
      queries,
      now,
    });
    const incoming: IncomingHandoff = { partition_id: "handoff:handoff-1", delivery: { delivery_id: "delivery-racing-cancel", subscription_id: "subscription-1", attempt: 1, events: [event()], next_cursor: "cursor-1", delivered_at: now(), visibility_expires_at: "2026-07-26T00:01:00.000Z" }, handoff: snapshot(), acknowledgeSignal: vi.fn(async () => ({ kind: "acknowledged", cursor: "cursor-1" } as const)) };

    await host.handle(incoming);

    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("cancelled");
  });

  it("converges a submitted Result when its success Delivery aborts the lost command response", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    const order: string[] = [];
    const transitionRun = state.transitionRun.bind(state);
    state.transitionRun = async (input) => {
      if (input.next_state === "succeeded") order.push("succeeded");
      return transitionRun(input);
    };
    const offered = snapshot();
    const accepted = { ...snapshot(), stream_version: 2, state: { lifecycle_state: "accepted", resource_version: 2, recipient: { actor_id: "actor-runtime" } } } as HandoffReadModel;
    const returned = { ...snapshot(), stream_version: 3, state: { lifecycle_state: "result_returned", resource_version: 3, result: result() } } as unknown as HandoffReadModel;
    let remote = offered;
    let remoteReadUnavailable = false;
    let host!: AgentRuntimeHost;
    const returnedDelivery: IncomingHandoff = {
      partition_id: "handoff:handoff-1",
      delivery: { delivery_id: "delivery-result-returned", subscription_id: "subscription-1", attempt: 1, events: [{ ...event(), id: "event-result-returned", type: "workfabric.handoff.result_returned.v1" }], next_cursor: "cursor-2", delivered_at: now(), visibility_expires_at: "2026-07-26T00:01:00.000Z" },
      handoff: returned,
      acknowledgeSignal: vi.fn(async () => {
        order.push("ack");
        expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("succeeded");
        return { kind: "acknowledged", cursor: "cursor-2" } as const;
      }),
    };
    const returnResult = vi.fn(async () => {
      remote = returned;
      await host.handle(returnedDelivery);
      remoteReadUnavailable = true;
      throw new DOMException("response lost after service commit", "AbortError");
    });
    const execute = vi.fn(async () => result());
    host = new AgentRuntimeHost({
      config,
      session: { handoffs: { accept: vi.fn(async () => { remote = accepted; return operation(2); }), decline: vi.fn(), reportStatus: vi.fn(async () => operation(3)), returnResult } as never, incoming: async function* () {}, close: async () => undefined, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) },
      state,
      driver: { manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] }, execute },
      packageLoader: { load: vi.fn(async () => ({ snapshot: offered, events: [event()], task: { tenant_id: "tenant-1", handoff_id: "handoff-1" } })) } as never,
      policy: { decide: () => ({ kind: "accept" as const }) },
      queries: { getHandoff: vi.fn(async () => {
        if (remoteReadUnavailable) throw new Error("public Handoff query unavailable after commit");
        return remote;
      }) },
      now,
    });
    const incoming: IncomingHandoff = { partition_id: "handoff:handoff-1", delivery: { delivery_id: "delivery-offered", subscription_id: "subscription-1", attempt: 1, events: [event()], next_cursor: "cursor-1", delivered_at: now(), visibility_expires_at: "2026-07-26T00:01:00.000Z" }, handoff: offered, acknowledgeSignal: vi.fn(async () => ({ kind: "acknowledged", cursor: "cursor-1" } as const)) };

    await host.handle(incoming);

    expect(returnedDelivery.acknowledgeSignal).toHaveBeenCalledWith("acknowledged");
    expect(order).toEqual(["succeeded", "ack"]);
    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("succeeded");
    expect(returnResult).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("cancels an active Driver run on an acknowledged terminal Delivery", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const driver: AgentRuntimeDriver = { manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] }, execute: async (_task, _progress, signal) => { started(); await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })); return result(); } };
    const host = new AgentRuntimeHost({ config, session: { handoffs: { accept: vi.fn(async () => operation(2)), decline: vi.fn(), reportStatus: vi.fn(async () => operation(3)), returnResult: vi.fn() } as never, incoming: async function* () {}, close: async () => undefined, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) }, state, driver, packageLoader: { load: vi.fn(async () => ({ snapshot: snapshot(), events: [event()], task: { tenant_id: "tenant-1", handoff_id: "handoff-1" } })) } as never, policy: { decide: () => ({ kind: "accept" as const }) }, queries: { getHandoff: vi.fn(async () => snapshot()) }, now });
    const offered: IncomingHandoff = { partition_id: "handoff:handoff-1", delivery: { delivery_id: "delivery-running", subscription_id: "subscription-1", attempt: 1, events: [event()], next_cursor: "cursor-1", delivered_at: now(), visibility_expires_at: "2026-07-26T00:01:00.000Z" }, handoff: snapshot(), acknowledgeSignal: vi.fn(async () => ({ kind: "acknowledged", cursor: "cursor-1" } as const)) };
    const cancelled: IncomingHandoff = { ...offered, delivery: { ...offered.delivery, delivery_id: "delivery-cancel", events: [{ ...event(), id: "event-cancel", type: "workfabric.handoff.cancelled.v1" }] }, handoff: { ...snapshot(), state: { lifecycle_state: "cancelled", resource_version: 2 } } as HandoffReadModel, acknowledgeSignal: vi.fn(async () => ({ kind: "acknowledged", cursor: "cursor-1" } as const)) };

    const handling = host.handle(offered);
    await running;
    await host.handle(cancelled);
    await handling;
    expect((await state.getRun("tenant-1", "handoff-1"))?.state).toBe("cancelled");
  });

  it("prioritizes a terminal Delivery over a running Handoff so the active Driver is cancelled", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    let begin!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const driver: AgentRuntimeDriver = {
      manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] },
      execute: async (_task, _progress, signal) => {
        begin();
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
        return result();
      },
    };
    const offered: IncomingHandoff = { partition_id: "handoff:handoff-1", delivery: { delivery_id: "delivery-priority-offer", subscription_id: "subscription-1", attempt: 1, events: [event()], next_cursor: "cursor-1", delivered_at: now(), visibility_expires_at: "2026-07-26T00:01:00.000Z" }, handoff: snapshot(), acknowledgeSignal: vi.fn(async () => ({ kind: "acknowledged", cursor: "cursor-1" } as const)) };
    const cancelled: IncomingHandoff = { ...offered, delivery: { ...offered.delivery, delivery_id: "delivery-priority-cancel", events: [{ ...event(), id: "event-priority-cancel", type: "workfabric.handoff.cancelled.v1" }] }, handoff: { ...snapshot(), state: { lifecycle_state: "cancelled", resource_version: 2 } } as HandoffReadModel, acknowledgeSignal: vi.fn(async () => ({ kind: "acknowledged", cursor: "cursor-1" } as const)) };
    const host = new AgentRuntimeHost({
      config,
      session: { handoffs: { accept: vi.fn(async () => operation(2)), decline: vi.fn(), reportStatus: vi.fn(async () => operation(3)), returnResult: vi.fn() } as never, incoming: async function* () { yield offered; await started; yield cancelled; }, close: async () => undefined, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) },
      state,
      driver,
      packageLoader: { load: vi.fn(async () => ({ snapshot: snapshot(), events: [event()], task: { tenant_id: "tenant-1", handoff_id: "handoff-1" } })) } as never,
      policy: { decide: () => ({ kind: "accept" as const }) },
      queries: { getHandoff: vi.fn(async () => snapshot()) }, now,
    });
    try {
      await host.start();
      await started;
      await vi.waitFor(() => expect((state.getRun("tenant-1", "handoff-1"))).resolves.toMatchObject({ state: "cancelled" }));
      expect(cancelled.acknowledgeSignal).toHaveBeenCalledWith("acknowledged");
    } finally {
      await host.close();
    }
  });

  it("closes the Gateway session before the durable state provider", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    const order: string[] = [];
    const closeState = state.close.bind(state);
    state.close = async () => { order.push("state"); await closeState(); };
    const host = new AgentRuntimeHost({ config, session: { handoffs: {} as never, incoming: async function* () {}, close: async () => { order.push("session"); }, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) }, state, driver: { manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] }, execute: vi.fn() }, packageLoader: { load: vi.fn() } as never, policy: { decide: vi.fn() }, queries: { getHandoff: vi.fn() }, now });

    await host.close();

    expect(order).toEqual(["session", "state"]);
  });

  it("persists and explicitly retries a Delivery when the Host queue is full", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    let begin!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    let finish!: () => void;
    const driver: AgentRuntimeDriver = { manifest: { driver_type: "test", protocol_version: "1", capability_ids: ["information.synthesis"] }, execute: async () => { begin(); await new Promise<void>((resolve) => { finish = resolve; }); return result(); } };
    const received = ["one", "two", "three"].map((id): IncomingHandoff => ({ partition_id: "handoff:handoff-1", delivery: { delivery_id: `delivery-${id}`, subscription_id: "subscription-1", attempt: 1, events: [event()], next_cursor: "cursor-1", delivered_at: now(), visibility_expires_at: "2026-07-26T00:01:00.000Z" }, handoff: snapshot(), acknowledgeSignal: vi.fn(async () => ({ kind: "acknowledged", cursor: "cursor-1" } as const)) }));
    const host = new AgentRuntimeHost({ config: { ...config, queue_capacity: 1 }, session: { handoffs: { accept: vi.fn(async () => operation(2)), decline: vi.fn(), reportStatus: vi.fn(async () => operation(3)), returnResult: vi.fn(async () => operation(4)) } as never, incoming: async function* () { for (const incoming of received) yield incoming; }, close: async () => undefined, session_id: "session-1", closed: Promise.resolve({ reason: "closed" as const }) }, state, driver, packageLoader: { load: vi.fn(async () => ({ snapshot: snapshot(), events: [event()], task: { tenant_id: "tenant-1", handoff_id: "handoff-1" } })) } as never, policy: { decide: () => ({ kind: "accept" as const }) }, queries: { getHandoff: vi.fn(async () => snapshot()) }, now });

    await host.start();
    await vi.waitFor(() => expect(received[2]!.acknowledgeSignal).toHaveBeenCalledWith("retry"));
    await started;
    finish();
    await host.close();
  });
});
