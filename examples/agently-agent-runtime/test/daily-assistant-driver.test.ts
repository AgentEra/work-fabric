import { MemoryAgentRuntimeStateStore } from "@work-fabric/adapter-agent-runtime-memory";
import type {
  CapabilityAwareAgentRuntimeDriver,
  RuntimeCapabilitySummary,
  RuntimeCapabilityTranscript,
  RuntimeDriverResult,
  RuntimeDriverTurn,
  RuntimeProgress,
  RuntimeTaskPackage,
} from "@work-fabric/agent-runtime-spi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DailyAssistantDriver } from "../src/daily-assistant-driver.js";

const stores: MemoryAgentRuntimeStateStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

function task(input: {
  readonly handoff_id?: string;
  readonly text?: string;
} = {}): RuntimeTaskPackage {
  const handoffId = input.handoff_id ?? "handoff-origin";
  return {
    tenant_id: "tenant-1",
    handoff_id: handoffId,
    thread_id: "thread-1",
    stream_version: 1,
    role: {
      role_id: "daily-assistant",
      version: 1,
      display_name: "日常助理",
      description: "团队共享日常助理",
      capability_ids: ["collaboration.request.intake"],
    },
    capability_id: "collaboration.request.intake",
    source_reference: {
      uri: `feishu://tenant-1/message/${handoffId}`,
      extensions: {
        "workfabric.dev/provider_family": "feishu",
        "workfabric.dev/resource_kind": "conversation_message",
        "workfabric.dev/conversation_resource_uri": "feishu://chat/oc-team",
        "workfabric.dev/sender_resource_uri":
          "feishu://user/open-id/ou-initiator",
      },
    },
    initiator: {
      actor_id: "actor-initiator",
      actor_type: "human",
    },
    agent_private_context: null,
    intent: [{
      kind: "text",
      media_type: "text/plain",
      text: input.text ?? "安排 EDA 方案评审",
    }],
    context_reference: null,
    resolved_context: null,
    authority_scope: {},
    acceptance_criteria: [],
    priority: "normal",
    accept_by: "2026-07-30T01:30:00.000Z",
    result_due_at: "2026-07-30T02:00:00.000Z",
    workspace_path: "/tmp/work-fabric/handoff-origin",
  };
}

class StubDriver implements CapabilityAwareAgentRuntimeDriver {
  readonly executeTurn = vi.fn(async (
    _task: RuntimeTaskPackage,
    _available: readonly RuntimeCapabilitySummary[],
    _transcript: RuntimeCapabilityTranscript | null,
    _progress: (update: RuntimeProgress) => Promise<void>,
    _signal: AbortSignal,
  ): Promise<RuntimeDriverTurn> => ({
    kind: "final",
    response: {
      summary: [{
        kind: "text",
        media_type: "text/markdown",
        text: "请确认 EDA 方案评审排期。",
      }],
      artifacts: [],
      evidence: [],
      extensions: {
        "workfabric.agent/private_state": {
          namespace: "daily-assistant.scheduling/v1",
          expected_version: 0,
          phase: "awaiting_confirmation",
          proposal: {
            version: 1,
            title: "EDA 方案评审",
            participant_resource_uris: [
              "feishu://user/open-id/ou-initiator",
            ],
            start_at: "2026-07-31T06:00:00.000Z",
            end_at: "2026-07-31T07:00:00.000Z",
            timezone: "Asia/Shanghai",
            summary_markdown: "请确认 EDA 方案评审排期。",
          },
          confirmed_proposal_digest: null,
          confirmation_handoff_id: null,
          calendar_result_uri: null,
          capability_result_handoff_ids: ["handoff-members-result-1"],
        },
        "workfabric.agent/request_summary": "排期提案",
      },
    },
  }));

  async execute(
    _task: RuntimeTaskPackage,
    _progress: (update: RuntimeProgress) => Promise<void>,
    _signal: AbortSignal,
  ): Promise<RuntimeDriverResult> {
    return {
      summary: [],
      artifacts: [],
      evidence: [],
      extensions: {},
    };
  }
}

describe("DailyAssistantDriver", () => {
  it("injects private context, persists a proposal, mentions the initiator and strips private output", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    stores.push(state);
    const underlying = new StubDriver();
    const driver = new DailyAssistantDriver(underlying, state, {
      now: () => "2026-07-30T01:00:00.000Z",
    });

    const turn = await driver.executeTurn(
      task(),
      [],
      null,
      async () => undefined,
      new AbortController().signal,
    );

    expect(underlying.executeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_private_context: expect.objectContaining({
          namespace: "daily-assistant.scheduling/v1",
          active_session: null,
          original_initiator: {
            actor_id: "actor-initiator",
            sender_resource_uri:
              "feishu://user/open-id/ou-initiator",
          },
        }),
      }),
      [],
      null,
      expect.any(Function),
      expect.any(AbortSignal),
    );
    expect(turn).toMatchObject({
      kind: "final",
      response: {
        summary: [{
          extensions: {
            "workfabric.dev/recipient_references": [{
              kind: "mention",
              resource_uri: "feishu://user/open-id/ou-initiator",
              display_text: "发起人",
            }],
          },
        }],
        extensions: {
          "workfabric.agent/request_summary": "排期提案",
        },
      },
    });
    if (turn.kind !== "final") throw new Error("expected final");
    expect(turn.response.extensions).not.toHaveProperty(
      "workfabric.agent/private_state",
    );
    expect(await state.getPrivateState(
      "tenant-1",
      "daily-assistant.scheduling/v1",
      "feishu:conversation:feishu%3A%2F%2Fchat%2Foc-team",
    )).toMatchObject({
      version: 1,
      value: {
        phase: "awaiting_confirmation",
        proposal: {
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("passes capability requests through without mutating private state", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    stores.push(state);
    const underlying = new StubDriver();
    underlying.executeTurn.mockResolvedValueOnce({
      kind: "capability_request",
      request: {
        invocation_id: "invocation-members",
        capability_id: "feishu.conversation.members.list",
        version_constraint: "1.0.0",
        input: {
          conversation: { kind: "current_conversation" },
          maximum_members: 50,
        },
        reason: "获取可信群成员事实",
      },
    });
    const driver = new DailyAssistantDriver(underlying, state);

    await expect(driver.executeTurn(
      task(),
      [],
      null,
      async () => undefined,
      new AbortController().signal,
    )).resolves.toMatchObject({
      kind: "capability_request",
      request: { invocation_id: "invocation-members" },
    });
    expect(await state.getPrivateState(
      "tenant-1",
      "daily-assistant.scheduling/v1",
      "feishu:conversation:feishu%3A%2F%2Fchat%2Foc-team",
    )).toBeNull();
  });

  it("fails closed for a model-invented namespace", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    stores.push(state);
    const underlying = new StubDriver();
    const original = await underlying.executeTurn(
      task(),
      [],
      null,
      async () => undefined,
      new AbortController().signal,
    );
    if (original.kind !== "final") throw new Error("expected final");
    underlying.executeTurn.mockResolvedValueOnce({
      ...original,
      response: {
        ...original.response,
        extensions: {
          ...original.response.extensions,
          "workfabric.agent/private_state": {
            namespace: "fabric.scheduler/v1",
          },
        },
      },
    });
    const driver = new DailyAssistantDriver(underlying, state);

    await expect(driver.executeTurn(
      task(),
      [],
      null,
      async () => undefined,
      new AbortController().signal,
    )).rejects.toThrow(/private state/i);
  });

  it("resumes a later Human confirmation and persists completion after Calendar returns", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    stores.push(state);
    const underlying = new StubDriver();
    const driver = new DailyAssistantDriver(underlying, state, {
      now: () => "2026-07-30T01:00:00.000Z",
    });
    await driver.executeTurn(
      task(),
      [],
      null,
      async () => undefined,
      new AbortController().signal,
    );
    const proposed = await state.getPrivateState(
      "tenant-1",
      "daily-assistant.scheduling/v1",
      "feishu:conversation:feishu%3A%2F%2Fchat%2Foc-team",
    );
    const savedProposal = proposed?.value.proposal as
      | Record<string, unknown>
      | undefined;
    const digest = savedProposal?.digest;
    if (typeof digest !== "string") throw new Error("missing digest");

    underlying.executeTurn.mockImplementationOnce(async (enriched) => {
      expect(enriched).toMatchObject({
        handoff_id: "handoff-confirmation",
        agent_private_context: {
          active_session: {
            phase: "awaiting_confirmation",
            proposal: { digest },
          },
          current_source: {
            actor_id: "actor-initiator",
            sender_resource_uri:
              "feishu://user/open-id/ou-initiator",
          },
        },
      });
      return {
        kind: "capability_request",
        request: {
          invocation_id: "invocation-calendar-create",
          capability_id: "feishu.calendar.event.create",
          version_constraint: "1.0.0",
          input: {
            calendar: { kind: "default_calendar" },
            title: "EDA 方案评审",
            start_at: "2026-07-31T06:00:00.000Z",
            end_at: "2026-07-31T07:00:00.000Z",
            time_zone: "Asia/Shanghai",
            attendees: [
              "feishu://user/open-id/ou-initiator",
            ],
            authority_evidence: {
              session_origin_handoff_id: "handoff-origin",
              confirmation_handoff_id: "handoff-confirmation",
              proposal_digest: digest,
              capability_result_handoff_ids: [
                "handoff-members-result-1",
              ],
            },
          },
          reason: "原始发起人已确认当前提案",
        },
      };
    });
    const confirmationTask = task({
      handoff_id: "handoff-confirmation",
      text: "可以，就这么安排",
    });
    await expect(driver.executeTurn(
      confirmationTask,
      [],
      null,
      async () => undefined,
      new AbortController().signal,
    )).resolves.toMatchObject({
      kind: "capability_request",
      request: {
        capability_id: "feishu.calendar.event.create",
      },
    });

    underlying.executeTurn.mockResolvedValueOnce({
      kind: "final",
      response: {
        summary: [{
          kind: "text",
          media_type: "text/markdown",
          text: "已创建日程《EDA 方案评审》。",
        }],
        artifacts: [{
          uri: "feishu://calendar/cal-team/events/event-1",
          media_type: "application/vnd.feishu.calendar.event",
        }],
        evidence: [],
        extensions: {
          "workfabric.agent/private_state": {
            namespace: "daily-assistant.scheduling/v1",
            expected_version: 1,
            phase: "completed",
            proposal: null,
            confirmed_proposal_digest: digest,
            confirmation_handoff_id: "handoff-confirmation",
            calendar_result_uri:
              "feishu://calendar/cal-team/events/event-1",
            capability_result_handoff_ids: [
              "handoff-members-result-1",
            ],
          },
        },
      },
    });
    await expect(driver.executeTurn(
      confirmationTask,
      [],
      { entries: [] },
      async () => undefined,
      new AbortController().signal,
    )).resolves.toMatchObject({
      kind: "final",
      response: {
        summary: [{ text: "已创建日程《EDA 方案评审》。" }],
      },
    });
    expect(await state.getPrivateState(
      "tenant-1",
      "daily-assistant.scheduling/v1",
      "feishu:conversation:feishu%3A%2F%2Fchat%2Foc-team",
    )).toMatchObject({
      version: 2,
      value: {
        phase: "completed",
        confirmed_proposal_digest: digest,
        confirmation_handoff_id: "handoff-confirmation",
        calendar_result_uri:
          "feishu://calendar/cal-team/events/event-1",
      },
    });
  });
});
