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

const historyCapability: RuntimeCapabilitySummary = {
  citizen_id: "citizen-feishu-message",
  capability_id: "feishu.conversation.history.read",
  version: "1.0.0",
  name: "Read Feishu conversation history",
  description: "Read one bounded page of authorized conversation messages.",
  operation_kind: "query",
  input_schema: {
    type: "object",
    required: ["conversation", "maximum_messages"],
  },
};

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
            expected_version: 99,
            phase: "awaiting_confirmation",
            proposal: {
              version: 99,
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
  it("delegates an implicit contextual reference to the model Driver", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    stores.push(state);
    const underlying = new StubDriver();
    underlying.executeTurn.mockResolvedValueOnce({
      kind: "capability_request",
      request: {
        invocation_id: "model-history-1",
        capability_id: "feishu.conversation.history.read",
        version_constraint: "1.0.0",
        input: {
          conversation: { kind: "current_conversation" },
          maximum_messages: 8,
        },
        reason: "需要取得当前请求所指的报错详情",
      },
    });
    const driver = new DailyAssistantDriver(underlying, state);
    const current = task({
      text: "你把报错的详细信息记录到飞书文档里吧",
    });

    const turn = await driver.executeTurn(
      current,
      [historyCapability],
      null,
      async () => undefined,
      new AbortController().signal,
    );

    expect(turn).toMatchObject({
      kind: "capability_request",
      request: {
        capability_id: "feishu.conversation.history.read",
        version_constraint: "1.0.0",
        input: {
          conversation: { kind: "current_conversation" },
          maximum_messages: 8,
        },
      },
    });
    expect(underlying.executeTurn).toHaveBeenCalledOnce();
    expect(underlying.executeTurn.mock.calls[0]?.[0].intent).toEqual(
      current.intent,
    );
  });

  it("continues from model-selected history to a document command and semantic result", async () => {
    const state = new MemoryAgentRuntimeStateStore();
    stores.push(state);
    const underlying = new StubDriver();
    const driver = new DailyAssistantDriver(underlying, state);
    const currentTask = task({ text: "你把上面的事做一下" });
    underlying.executeTurn.mockResolvedValueOnce({
      kind: "capability_request",
      request: {
        invocation_id: "model-history-2",
        capability_id: "feishu.conversation.history.read",
        version_constraint: "1.0.0",
        input: {
          conversation: { kind: "current_conversation" },
          maximum_messages: 8,
        },
        reason: "模型判断当前任务缺少历史事实",
      },
    });
    const first = await driver.executeTurn(
      currentTask,
      [historyCapability],
      null,
      async () => undefined,
      new AbortController().signal,
    );
    if (first.kind !== "capability_request") {
      throw new Error("expected history request");
    }
    const historyTranscript: RuntimeCapabilityTranscript = {
      entries: [{
        request: first.request,
        result: {
          outcome: "succeeded",
          invocation_id: first.request.invocation_id,
          auxiliary_handoff_id: "handoff-history-result",
          candidate: {
            citizen_id: "citizen-feishu-message",
            endpoint_id: "endpoint-feishu-provider",
            capability_id: "feishu.conversation.history.read",
            capability_version: "1.0.0",
            contract_digest:
              `sha256:${"a".repeat(64)}` as `sha256:${string}`,
          },
          data: {
            messages: [{
              message_id: "om-offline-request",
              sender: {
                external_id: "ou-initiator",
                sender_type: "user",
              },
              created_at: "2026-07-31T06:52:57.980Z",
              content: {
                media_type: "text/plain",
                text: "帮我创建一份标题为办公网环境的文档",
              },
              provenance: {
                provider_family: "feishu",
                source: "im.message",
                updated: false,
              },
            }],
            has_more: false,
            coverage: {
              oldest_at: "2026-07-31T06:52:57.980Z",
              newest_at: "2026-07-31T06:52:57.980Z",
            },
            provenance: {
              provider_family: "feishu",
              source: "im.message",
              source_reference:
                "feishu://tenant-1/message/handoff-origin",
            },
          },
          artifacts: [],
        },
      }],
    };
    underlying.executeTurn.mockResolvedValueOnce({
      kind: "capability_request",
      request: {
        invocation_id: "invocation-document-create",
        capability_id: "feishu.document.create",
        version_constraint: "2.0.0",
        input: {
          document: { kind: "new_document" },
          title: "办公网环境",
          content: {
            media_type: "text/markdown",
            text: "# 办公网环境",
          },
        },
        reason: "当前同一发起人明确要求执行上面的文档任务",
      },
    });

    const documentTurn = await driver.executeTurn(
      currentTask,
      [historyCapability],
      historyTranscript,
      async () => undefined,
      new AbortController().signal,
    );
    expect(documentTurn).toMatchObject({
      kind: "capability_request",
      request: {
        capability_id: "feishu.document.create",
        input: { title: "办公网环境" },
      },
    });
    if (documentTurn.kind !== "capability_request") {
      throw new Error("expected document request");
    }
    const completeTranscript: RuntimeCapabilityTranscript = {
      entries: [
        ...historyTranscript.entries,
        {
          request: documentTurn.request,
          result: {
            outcome: "succeeded",
            invocation_id: documentTurn.request.invocation_id,
            auxiliary_handoff_id: "handoff-document-result",
            candidate: {
              citizen_id: "citizen-feishu-document",
              endpoint_id: "endpoint-feishu-provider",
              capability_id: "feishu.document.create",
              capability_version: "2.0.0",
              contract_digest:
                `sha256:${"b".repeat(64)}` as `sha256:${string}`,
            },
            data: {
              document: {
                resource_uri: "feishu://docx/doc-office-network",
                url: "https://example.feishu.cn/docx/doc-office-network",
                title: "办公网环境",
              },
            },
            artifacts: [],
          },
        },
      ],
    };
    underlying.executeTurn.mockResolvedValueOnce({
      kind: "final",
      response: {
        summary: [{
          kind: "text",
          media_type: "text/markdown",
          text:
            "已创建[办公网环境](https://example.feishu.cn/docx/doc-office-network)。",
        }],
        artifacts: [{
          uri: "feishu://docx/doc-office-network",
          media_type: "application/vnd.feishu.docx",
        }],
        evidence: [],
        extensions: {
          "workfabric.agent/request_summary": "创建办公网环境文档",
        },
      },
    });

    await expect(driver.executeTurn(
      currentTask,
      [historyCapability],
      completeTranscript,
      async () => undefined,
      new AbortController().signal,
    )).resolves.toMatchObject({
      kind: "final",
      response: {
        summary: [{
          text: expect.stringContaining(
            "https://example.feishu.cn/docx/doc-office-network",
          ),
        }],
      },
    });
    expect(underlying.executeTurn).toHaveBeenCalledTimes(3);
  });

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
          version_constraint: "1.1.0",
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

  it("persists proposal cancellation before returning the Agent-authored reply", async () => {
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
    underlying.executeTurn.mockResolvedValueOnce({
      kind: "final",
      response: {
        summary: [{
          kind: "text",
          media_type: "text/markdown",
          text: "已取消这份尚未创建的日程提案。",
        }],
        artifacts: [],
        evidence: [],
        extensions: {
          "workfabric.agent/request_summary": "取消待确认日程提案",
          "workfabric.agent/private_state": {
            namespace: "daily-assistant.scheduling/v1",
            expected_version: 1,
            phase: "cancelled",
            proposal: null,
            confirmed_proposal_digest: null,
            confirmation_handoff_id: null,
            calendar_result_uri: null,
            capability_result_handoff_ids: [],
          },
        },
      },
    });
    await expect(driver.executeTurn(
      task({
        handoff_id: "handoff-cancellation",
        text: "这个日程取消吧",
      }),
      [],
      null,
      async () => undefined,
      new AbortController().signal,
    )).resolves.toMatchObject({
      kind: "final",
      response: {
        summary: [{
          text: expect.stringContaining("已取消这份尚未创建的日程提案"),
        }],
      },
    });
    expect(await state.getPrivateState(
      "tenant-1",
      "daily-assistant.scheduling/v1",
      "feishu:conversation:feishu%3A%2F%2Fchat%2Foc-team",
    )).toMatchObject({
      version: 2,
      value: {
        phase: "cancelled",
      },
    });

    underlying.executeTurn.mockImplementationOnce(async (enriched) => {
      expect(enriched.agent_private_context).toMatchObject({
        state_version: 2,
        active_session: null,
      });
      return {
        kind: "final",
        response: {
          summary: [{
            kind: "text",
            media_type: "text/markdown",
            text: "接下来三天的日程需要查询飞书日历。",
          }],
          artifacts: [],
          evidence: [],
          extensions: {},
        },
      };
    });
    await driver.executeTurn(
      task({
        handoff_id: "handoff-next",
        text: "我未来三天还有其它日程吗",
      }),
      [],
      null,
      async () => undefined,
      new AbortController().signal,
    );
  });

  it("does not treat cancellation of another object as cancellation of the active calendar proposal", async () => {
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
    underlying.executeTurn.mockClear();
    underlying.executeTurn.mockResolvedValueOnce({
      kind: "final",
      response: {
        summary: [{
          kind: "text",
          media_type: "text/markdown",
          text: "已取消文档操作，当前日程提案保持不变。",
        }],
        artifacts: [],
        evidence: [],
        extensions: {},
      },
    });

    await driver.executeTurn(
      task({
        handoff_id: "handoff-unrelated-cancellation",
        text: "取消文档操作，不要动当前日程",
      }),
      [],
      null,
      async () => undefined,
      new AbortController().signal,
    );

    expect(underlying.executeTurn).toHaveBeenCalledOnce();
    expect(await state.getPrivateState(
      "tenant-1",
      "daily-assistant.scheduling/v1",
      "feishu:conversation:feishu%3A%2F%2Fchat%2Foc-team",
    )).toMatchObject({
      version: 1,
      value: { phase: "awaiting_confirmation" },
    });
  });
});
