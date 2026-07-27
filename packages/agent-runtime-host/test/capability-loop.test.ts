import { describe, expect, it, vi } from "vitest";

import type {
  CapabilityAwareAgentRuntimeDriver,
  CapabilityInvocationPort,
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
  intent: [],
  context_reference: null,
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

function turnDriver(turns: readonly RuntimeDriverTurn[]) {
  let index = 0;
  return {
    executeTurn: vi.fn(async (
      _task: RuntimeTaskPackage,
      _continuation: Parameters<
        CapabilityAwareAgentRuntimeDriver["executeTurn"]
      >[1],
      _progress: Parameters<
        CapabilityAwareAgentRuntimeDriver["executeTurn"]
      >[2],
      _signal: AbortSignal,
    ) => turns[index++]!),
  } satisfies CapabilityAwareAgentRuntimeDriver;
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

    const result = await runCapabilityContinuationLoop({
      task,
      driver,
      invocations,
      limits: {
        max_invocations_per_handoff: 4,
        allowed_namespaces: ["feishu."],
      },
      progress: async () => undefined,
      signal: new AbortController().signal,
      now: () => "2026-07-27T10:00:00.000Z",
    });

    expect(result).toEqual(finalResponse);
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
    expect(driver.executeTurn.mock.calls[1]?.[1]).toMatchObject({
      request: { invocation_id: "invocation-1" },
      result: {
        outcome: "succeeded",
        data: { document_id: "doc-1" },
      },
    });
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
      invocations,
      limits: {
        max_invocations_per_handoff: 4,
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
      invocations: duplicatePort,
      limits: {
        max_invocations_per_handoff: 4,
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
      invocations: disallowedPort,
      limits: {
        max_invocations_per_handoff: 4,
        allowed_namespaces: ["feishu."],
      },
      progress: async () => undefined,
      signal: new AbortController().signal,
      now: () => "2026-07-27T10:00:00.000Z",
    })).rejects.toThrow(/namespace/i);
    expect(disallowedPort.invoke).not.toHaveBeenCalled();
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
      invocations,
      limits: {
        max_invocations_per_handoff: 4,
        allowed_namespaces: ["feishu."],
      },
      progress: async () => undefined,
      signal: new AbortController().signal,
      now: () => "2026-07-27T12:00:00.000Z",
    })).rejects.toThrow(/deadline/i);
    expect(invocations.invoke).not.toHaveBeenCalled();
  });
});
