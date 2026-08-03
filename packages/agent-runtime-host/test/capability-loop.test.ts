import { describe, expect, it, vi } from "vitest";

import type {
  CapabilityAwareAgentRuntimeDriver,
  CapabilityDisclosurePort,
  CapabilityInvocationPort,
  RuntimeCapabilitySummary,
  RuntimeDriverTurn,
  RuntimeTaskPackage,
} from "@work-fabric/agent-runtime-spi";

import { runCapabilityContinuationLoop } from "../src/index.js";

const task: RuntimeTaskPackage = {
  tenant_id: "tenant-1",
  handoff_id: "handoff-original-1",
  thread_id: "thread-1",
  stream_version: 3,
  role: {
    role_id: "daily-assistant",
    version: 1,
    display_name: "团队共享日常助理",
    description: "协助团队处理日常工作",
    capability_ids: ["collaboration.assistance"],
  },
  capability_id: "collaboration.assistance",
  source_reference: { uri: "urn:test:source", extensions: {} },
  initiator: { actor_id: "human-1", actor_type: "human" },
  agent_private_context: null,
  intent: [],
  context_reference: null,
  resolved_context: null,
  authority_scope: {},
  acceptance_criteria: [],
  priority: "normal",
  accept_by: "2026-07-27T10:30:00.000Z",
  result_due_at: "2026-07-27T12:00:00.000Z",
  workspace_path: "/tmp/work-fabric/handoff-original-1",
};

const finalResponse = {
  summary: [{ kind: "text", text: "已创建《客户项目需求》文档。" }],
  artifacts: [],
  evidence: [],
  extensions: {},
};

const availableCapabilities: readonly RuntimeCapabilitySummary[] = [{
  citizen_id: "citizen-feishu",
  capability_id: "feishu.document.create",
  version: "1.0.0",
  name: "Create document",
  description: "Create one simple Docx document.",
  operation_kind: "command",
  input_schema: null,
}];

function turnDriver(turns: readonly RuntimeDriverTurn[]) {
  let index = 0;
  return {
    executeTurn: vi.fn(async (
      _task: RuntimeTaskPackage,
      _availableCapabilities: Parameters<
        CapabilityAwareAgentRuntimeDriver["executeTurn"]
      >[1],
      _continuation: Parameters<
        CapabilityAwareAgentRuntimeDriver["executeTurn"]
      >[2],
      _progress: Parameters<
        CapabilityAwareAgentRuntimeDriver["executeTurn"]
      >[3],
      _signal: AbortSignal,
    ) => turns[index++]!),
  } satisfies CapabilityAwareAgentRuntimeDriver;
}

function disclosurePort() {
  return {
    list: vi.fn(async () => availableCapabilities),
  } satisfies CapabilityDisclosurePort;
}

function invocationPort() {
  return {
    discover: vi.fn(async () => []),
    invoke: vi.fn(async (request) => ({
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
    })),
  } satisfies CapabilityInvocationPort;
}

describe("runCapabilityContinuationLoop", () => {
  it("returns only the final Agent-authored response after an auxiliary invocation", async () => {
    const driver = turnDriver([
      {
        kind: "capability_request",
        request: {
          invocation_id: "invocation-1",
          capability_id: "feishu.document.create",
          version_constraint: "^1.0.0",
          input: { title: "客户项目需求" },
          reason: "为团队创建协作文档",
        },
      },
      { kind: "final", response: finalResponse },
    ]);
    const invocations = invocationPort();
    const disclosure = disclosurePort();

    const result = await runCapabilityContinuationLoop({
      task,
      driver,
      disclosure,
      invocations,
      limits: {
        max_invocations_per_handoff: 4,
        max_query_invocations_per_handoff: 3,
        max_query_result_bytes: 65_536,
        allowed_namespaces: ["feishu."],
      },
      progress: async () => undefined,
      signal: new AbortController().signal,
      now: () => "2026-07-27T10:00:00.000Z",
    });

    expect(result).toEqual(finalResponse);
    expect(disclosure.list).toHaveBeenCalledTimes(1);
    expect(driver.executeTurn.mock.calls[0]?.[1]).toEqual(availableCapabilities);
    expect(driver.executeTurn.mock.calls[1]?.[1]).toBe(
      driver.executeTurn.mock.calls[0]?.[1],
    );
    expect(invocations.invoke).toHaveBeenCalledWith({
      invocation_id: "invocation-1",
      original_handoff_id: task.handoff_id,
      thread_id: task.thread_id,
      capability_id: "feishu.document.create",
      version_constraint: "^1.0.0",
      input: { title: "客户项目需求" },
      reason: "为团队创建协作文档",
      deadline: task.result_due_at,
    }, expect.any(AbortSignal));
    expect(driver.executeTurn.mock.calls[1]?.[2]).toMatchObject({
      entries: [{
        request: { invocation_id: "invocation-1" },
        result: {
          outcome: "succeeded",
          data: { document_id: "doc-1" },
        },
        host_receipt: {
          operation_id: "invocation-1",
          original_handoff_id: task.handoff_id,
          auxiliary_handoff_id: "handoff-auxiliary-1",
          selected_candidate: {
            citizen_id: "citizen-feishu",
            endpoint_id: "endpoint-feishu",
          },
          started_at: "2026-07-27T10:00:00.000Z",
          received_at: "2026-07-27T10:00:00.000Z",
        },
      }],
    });
  });

  it("retains both pages of query evidence for the Agent's final turn", async () => {
    const queryCapability: RuntimeCapabilitySummary = {
      citizen_id: "citizen-feishu-message",
      capability_id: "feishu.conversation.history.read",
      version: "1.0.0",
      name: "Read conversation history",
      description: "Read one bounded page.",
      operation_kind: "query",
      input_schema: null,
    };
    const driver = turnDriver([
      {
        kind: "capability_request",
        request: {
          invocation_id: "history-1",
          capability_id: queryCapability.capability_id,
          version_constraint: "1.0.0",
          input: {
            conversation: { kind: "current_conversation" },
            maximum_messages: 20,
          },
          reason: "Need recent evidence.",
        },
      },
      {
        kind: "capability_request",
        request: {
          invocation_id: "history-2",
          capability_id: queryCapability.capability_id,
          version_constraint: "1.0.0",
          input: {
            conversation: { kind: "current_conversation" },
            maximum_messages: 20,
            cursor: "opaque-next",
          },
          reason: "Material details may be on the next page.",
        },
      },
      { kind: "final", response: finalResponse },
    ]);
    let page = 0;
    const invocations: CapabilityInvocationPort = {
      discover: async () => [],
      invoke: vi.fn(async (request) => {
        page += 1;
        return {
          outcome: "succeeded" as const,
          invocation_id: request.invocation_id,
          auxiliary_handoff_id: `handoff-history-${page}`,
          candidate: {
            citizen_id: queryCapability.citizen_id,
            endpoint_id: "endpoint-feishu",
            capability_id: queryCapability.capability_id,
            capability_version: "1.0.0",
            contract_digest:
              `sha256:${"a".repeat(64)}` as `sha256:${string}`,
          },
          data: page === 1
            ? { messages: [{ text: "page one" }], has_more: true }
            : { messages: [{ text: "page two" }], has_more: false },
          artifacts: [],
        };
      }),
    };

    await runCapabilityContinuationLoop({
      task,
      driver,
      disclosure: { list: async () => [queryCapability] },
      invocations,
      limits: {
        max_invocations_per_handoff: 4,
        max_query_invocations_per_handoff: 3,
        max_query_result_bytes: 65_536,
        allowed_namespaces: ["feishu."],
      },
      progress: async () => undefined,
      signal: new AbortController().signal,
      now: () => "2026-07-27T10:00:00.000Z",
    });

    expect(driver.executeTurn.mock.calls[2]?.[2]).toMatchObject({
      entries: [
        {
          request: { invocation_id: "history-1" },
          result: { data: { has_more: true } },
        },
        {
          request: { invocation_id: "history-2" },
          result: { data: { has_more: false } },
        },
      ],
    });
  });

  it("normalizes turn-local progress into one monotonic Handoff stream", async () => {
    const driver = turnDriver([
      {
        kind: "capability_request",
        request: {
          invocation_id: "invocation-1",
          capability_id: "feishu.document.create",
          version_constraint: "^1.0.0",
          input: { title: "客户项目需求" },
          reason: "为团队创建协作文档",
        },
      },
      { kind: "final", response: finalResponse },
    ]);
    driver.executeTurn
      .mockImplementationOnce(async (
        _task,
        _capabilities,
        _continuation,
        progress,
      ) => {
        await progress({
          sequence: 1,
          progress: 0.25,
          message: "first turn",
          observed_at: "2026-07-27T10:00:01.000Z",
        });
        return {
          kind: "capability_request",
          request: {
            invocation_id: "invocation-1",
            capability_id: "feishu.document.create",
            version_constraint: "^1.0.0",
            input: { title: "客户项目需求" },
            reason: "为团队创建协作文档",
          },
        };
      })
      .mockImplementationOnce(async (
        _task,
        _capabilities,
        _continuation,
        progress,
      ) => {
        await progress({
          sequence: 1,
          progress: 0.75,
          message: "second turn",
          observed_at: "2026-07-27T10:00:02.000Z",
        });
        return { kind: "final", response: finalResponse };
      });
    const published: Array<{
      sequence: number;
      message: string;
    }> = [];

    await runCapabilityContinuationLoop({
      task,
      driver,
      disclosure: disclosurePort(),
      invocations: invocationPort(),
      limits: {
        max_invocations_per_handoff: 4,
        max_query_invocations_per_handoff: 3,
        max_query_result_bytes: 65_536,
        allowed_namespaces: ["feishu."],
      },
      progress: async (update) => {
        published.push({
          sequence: update.sequence,
          message: update.message,
        });
      },
      signal: new AbortController().signal,
      now: () => "2026-07-27T10:00:00.000Z",
    });

    expect(published).toEqual([
      { sequence: 1, message: "first turn" },
      { sequence: 2, message: "second turn" },
    ]);
  });

  it("rejects a fifth sequential capability invocation", async () => {
    const driver = turnDriver([
      ...Array.from({ length: 5 }, (_, index): RuntimeDriverTurn => ({
        kind: "capability_request",
        request: {
          invocation_id: `invocation-${index + 1}`,
          capability_id: "feishu.document.create",
          version_constraint: "1.0.0",
          input: { title: `${index + 1}` },
          reason: "create",
        },
      })),
      { kind: "final", response: finalResponse },
    ]);
    const invocations = invocationPort();

    await expect(runCapabilityContinuationLoop({
      task,
      driver,
      disclosure: disclosurePort(),
      invocations,
      limits: {
        max_invocations_per_handoff: 4,
        max_query_invocations_per_handoff: 3,
        max_query_result_bytes: 65_536,
        allowed_namespaces: ["feishu."],
      },
      progress: async () => undefined,
      signal: new AbortController().signal,
      now: () => "2026-07-27T10:00:00.000Z",
    })).rejects.toThrow(/maximum_capability_invocations/i);
    expect(invocations.invoke).toHaveBeenCalledTimes(4);
  });

  it("rejects duplicate invocation IDs and disallowed namespaces before external work", async () => {
    const duplicate = {
      kind: "capability_request" as const,
      request: {
        invocation_id: "same-invocation",
        capability_id: "feishu.document.create",
        version_constraint: "1.0.0",
        input: {},
        reason: "create",
      },
    };
    const duplicateDriver = turnDriver([duplicate, duplicate]);
    const duplicatePort = invocationPort();
    await expect(runCapabilityContinuationLoop({
      task,
      driver: duplicateDriver,
      disclosure: disclosurePort(),
      invocations: duplicatePort,
      limits: {
        max_invocations_per_handoff: 4,
        max_query_invocations_per_handoff: 3,
        max_query_result_bytes: 65_536,
        allowed_namespaces: ["feishu."],
      },
      progress: async () => undefined,
      signal: new AbortController().signal,
      now: () => "2026-07-27T10:00:00.000Z",
    })).rejects.toThrow(/duplicate_invocation_id/i);
    expect(duplicatePort.invoke).toHaveBeenCalledTimes(1);

    const disallowedPort = invocationPort();
    await expect(runCapabilityContinuationLoop({
      task,
      driver: turnDriver([{
        ...duplicate,
        request: {
          ...duplicate.request,
          invocation_id: "invocation-email",
          capability_id: "email.message.send",
        },
      }]),
      disclosure: disclosurePort(),
      invocations: disallowedPort,
      limits: {
        max_invocations_per_handoff: 4,
        max_query_invocations_per_handoff: 3,
        max_query_result_bytes: 65_536,
        allowed_namespaces: ["feishu."],
      },
      progress: async () => undefined,
      signal: new AbortController().signal,
      now: () => "2026-07-27T10:00:00.000Z",
    })).rejects.toThrow(/namespace/i);
    expect(disallowedPort.invoke).not.toHaveBeenCalled();
  });

  it("rejects a repeated successful side effect even when the Agent changes the invocation ID", async () => {
    const driver = turnDriver([
      {
        kind: "capability_request",
        request: {
          invocation_id: "invocation-create-1",
          capability_id: "feishu.document.create",
          version_constraint: "1.0.0",
          input: { title: "客户项目需求" },
          reason: "创建协作文档",
        },
      },
      {
        kind: "capability_request",
        request: {
          invocation_id: "invocation-create-2",
          capability_id: "feishu.document.create",
          version_constraint: "1.0.0",
          input: { title: "客户项目需求" },
          reason: "再次创建协作文档",
        },
      },
    ]);
    const invocations = invocationPort();

    await expect(runCapabilityContinuationLoop({
      task,
      driver,
      disclosure: disclosurePort(),
      invocations,
      limits: {
        max_invocations_per_handoff: 4,
        max_query_invocations_per_handoff: 3,
        max_query_result_bytes: 65_536,
        allowed_namespaces: ["feishu."],
      },
      progress: async () => undefined,
      signal: new AbortController().signal,
      now: () => "2026-07-27T10:00:00.000Z",
    })).rejects.toThrow(/duplicate_successful_side_effect/i);
    expect(invocations.invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects execution after the original Handoff deadline", async () => {
    const invocations = invocationPort();
    await expect(runCapabilityContinuationLoop({
      task,
      driver: turnDriver([{
        kind: "capability_request",
        request: {
          invocation_id: "invocation-late",
          capability_id: "feishu.document.create",
          version_constraint: "1.0.0",
          input: {},
          reason: "create",
        },
      }]),
      disclosure: disclosurePort(),
      invocations,
      limits: {
        max_invocations_per_handoff: 4,
        max_query_invocations_per_handoff: 3,
        max_query_result_bytes: 65_536,
        allowed_namespaces: ["feishu."],
      },
      progress: async () => undefined,
      signal: new AbortController().signal,
      now: () => "2026-07-27T12:00:00.000Z",
    })).rejects.toThrow(/deadline/i);
    expect(invocations.invoke).not.toHaveBeenCalled();
  });

  it("fails before the first model turn when capability disclosure fails", async () => {
    const driver = turnDriver([{ kind: "final", response: finalResponse }]);
    const catalogFailure = new Error("catalog unavailable");

    await expect(runCapabilityContinuationLoop({
      task,
      driver,
      disclosure: {
        async list() {
          throw catalogFailure;
        },
      },
      invocations: invocationPort(),
      limits: {
        max_invocations_per_handoff: 4,
        max_query_invocations_per_handoff: 3,
        max_query_result_bytes: 65_536,
        allowed_namespaces: ["feishu."],
      },
      progress: async () => undefined,
      signal: new AbortController().signal,
      now: () => "2026-07-27T10:00:00.000Z",
    })).rejects.toBe(catalogFailure);
    expect(driver.executeTurn).not.toHaveBeenCalled();
  });
});
