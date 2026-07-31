import type {
  RuntimeCapabilitySummary,
  RuntimeJsonObject,
  RuntimeTaskPackage,
} from "@work-fabric/agent-runtime-spi";
import { describe, expect, it } from "vitest";

import {
  DefaultContextPreflightPolicy,
} from "../src/context-preflight-policy.js";

const historyCapability: RuntimeCapabilitySummary = {
  citizen_id: "citizen-feishu-message",
  capability_id: "feishu.conversation.history.read",
  version: "1.0.0",
  name: "Read Feishu conversation history",
  description: "Read one bounded page of authorized conversation messages.",
  operation_kind: "query",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["conversation", "maximum_messages"],
    properties: {
      conversation: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: { kind: { const: "current_conversation" } },
      },
      maximum_messages: { type: "integer", minimum: 1, maximum: 50 },
    },
  },
};

function task(input: {
  readonly handoff_id?: string;
  readonly text: string;
  readonly provider_family?: string;
}): RuntimeTaskPackage {
  const handoffId = input.handoff_id ?? "handoff-context-follow-up";
  return {
    tenant_id: "tenant-local",
    handoff_id: handoffId,
    thread_id: handoffId,
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
      uri: `feishu://tenant/message/${handoffId}`,
      extensions: {
        "workfabric.dev/provider_family":
          input.provider_family ?? "feishu",
        "workfabric.dev/resource_kind": "conversation_message",
      },
    },
    initiator: { actor_id: "actor-human", actor_type: "human" },
    agent_private_context: null,
    intent: [{
      kind: "text",
      media_type: "text/plain",
      text: input.text,
    }],
    context_reference: null,
    resolved_context: null,
    authority_scope: {},
    acceptance_criteria: [],
    priority: "normal",
    accept_by: "2026-08-01T00:00:00.000Z",
    result_due_at: "2026-08-02T00:00:00.000Z",
    workspace_path: "/tmp/work-fabric/context-follow-up",
  };
}

function decide(input: {
  readonly task: RuntimeTaskPackage;
  readonly available?: readonly RuntimeCapabilitySummary[];
  readonly transcript?: null | { readonly entries: readonly [] };
  readonly privateContext?: RuntimeJsonObject;
}) {
  return new DefaultContextPreflightPolicy().decide({
    task: input.task,
    available_capabilities: input.available ?? [historyCapability],
    transcript: input.transcript ?? null,
    agent_private_context: input.privateContext ?? {
      namespace: "daily-assistant.scheduling/v1",
      state_version: 0,
      active_session: null,
    },
  });
}

describe("DefaultContextPreflightPolicy", () => {
  it.each([
    "咋样了",
    "你把上面的事做一下",
    "按刚才说的继续",
    "How is that earlier task going?",
  ])("requests one bounded recent-history page for %s", (text) => {
    expect(decide({ task: task({ text }) })).toMatchObject({
      kind: "request",
      request: {
        capability_id: "feishu.conversation.history.read",
        version_constraint: "1.0.0",
        input: {
          conversation: { kind: "current_conversation" },
          maximum_messages: 20,
        },
      },
    });
  });

  it("derives a recovery-stable invocation identity per Handoff", () => {
    const first = decide({
      task: task({ handoff_id: "handoff-a", text: "上面的事继续" }),
    });
    const repeated = decide({
      task: task({ handoff_id: "handoff-a", text: "上面的事继续" }),
    });
    const other = decide({
      task: task({ handoff_id: "handoff-b", text: "上面的事继续" }),
    });
    if (
      first.kind !== "request" ||
      repeated.kind !== "request" ||
      other.kind !== "request"
    ) throw new Error("expected history requests");
    expect(first.request.invocation_id).toBe(
      repeated.request.invocation_id,
    );
    expect(first.request.invocation_id).not.toBe(
      other.request.invocation_id,
    );
  });

  it("does not fetch history for a self-contained document command", () => {
    expect(decide({
      task: task({
        text: "帮我创建一份标题为办公网环境、正文为测试内容的文档",
      }),
    })).toEqual({ kind: "continue" });
  });

  it("uses an active private session for a direct status follow-up", () => {
    expect(decide({
      task: task({ text: "这个排期咋样了" }),
      privateContext: {
        namespace: "daily-assistant.scheduling/v1",
        state_version: 2,
        active_session: {
          phase: "awaiting_confirmation",
          proposal: { title: "方案评审" },
        },
      },
    })).toEqual({ kind: "continue" });
  });

  it("fails closed when the trusted source or query declaration is absent", () => {
    expect(decide({
      task: task({ text: "上面的事继续", provider_family: "email" }),
    })).toEqual({ kind: "continue" });
    expect(decide({
      task: task({ text: "上面的事继续" }),
      available: [],
    })).toEqual({ kind: "continue" });
    expect(decide({
      task: task({ text: "上面的事继续" }),
      available: [{ ...historyCapability, operation_kind: "command" }],
    })).toEqual({ kind: "continue" });
  });

  it("never repeats automatic preflight after a capability transcript exists", () => {
    expect(decide({
      task: task({ text: "上面的事继续" }),
      transcript: { entries: [] },
    })).toEqual({ kind: "continue" });
  });
});
