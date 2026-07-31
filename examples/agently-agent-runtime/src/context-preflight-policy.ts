import { createHash } from "node:crypto";

import type {
  RuntimeCapabilityRequest,
  RuntimeCapabilitySummary,
  RuntimeCapabilityTranscript,
  RuntimeJsonObject,
  RuntimeTaskPackage,
} from "@work-fabric/agent-runtime-spi";

const HISTORY_CAPABILITY_ID = "feishu.conversation.history.read";
const RECENT_MESSAGE_LIMIT = 20;

export type ContextPreflightDecision =
  | { readonly kind: "continue" }
  | {
      readonly kind: "request";
      readonly request: RuntimeCapabilityRequest;
    };

export interface ContextPreflightInput {
  readonly task: RuntimeTaskPackage;
  readonly available_capabilities: readonly RuntimeCapabilitySummary[];
  readonly transcript: RuntimeCapabilityTranscript | null;
  readonly agent_private_context: RuntimeJsonObject;
}

export interface ContextPreflightPolicy {
  decide(input: ContextPreflightInput): ContextPreflightDecision;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function intentText(task: RuntimeTaskPackage): string {
  return task.intent.flatMap((item) => {
    const value = record(item);
    return value?.kind === "text" && typeof value.text === "string"
      ? [value.text]
      : [];
  }).join("\n").replace(/\s+/gu, " ").trim();
}

function isFeishuConversation(task: RuntimeTaskPackage): boolean {
  const source = record(task.source_reference);
  const extensions = record(source?.extensions);
  return (
    extensions?.["workfabric.dev/provider_family"] === "feishu" &&
    extensions["workfabric.dev/resource_kind"] === "conversation_message"
  );
}

function explicitlyDependsOnEarlierContext(value: string): boolean {
  if (value.length === 0 || value.length > 8_192) return false;
  return (
    /(?:上面|上述|前面|刚才|之前|上文|照这个|照着|这件事|那件事|上面的事|刚才说的|咋样了|怎么样了|进展呢|做完了吗)/u
      .test(value) ||
    /\b(?:above|earlier|previous|as discussed|that task|how is it going)\b/iu
      .test(value)
  );
}

function activeSessionResolvesStatus(
  value: string,
  privateContext: RuntimeJsonObject,
): boolean {
  const activeSession = record(privateContext.active_session);
  if (activeSession === null) return false;
  return (
    /(?:排期|日程|提案|安排).{0,12}(?:咋样|怎么样|进展|状态|做完)/u
      .test(value) ||
    /(?:咋样|怎么样|进展|状态|做完).{0,12}(?:排期|日程|提案|安排)/u
      .test(value)
  );
}

function disclosedHistoryCapability(
  capabilities: readonly RuntimeCapabilitySummary[],
): RuntimeCapabilitySummary | null {
  return capabilities.find((capability) =>
    capability.capability_id === HISTORY_CAPABILITY_ID &&
    capability.operation_kind === "query" &&
    capability.input_schema !== null
  ) ?? null;
}

function invocationId(task: RuntimeTaskPackage): string {
  const digest = createHash("sha256")
    .update([
      task.tenant_id,
      task.handoff_id,
      "daily-assistant.recent-history-preflight/v1",
    ].join("\u0000"))
    .digest("hex")
    .slice(0, 32);
  return `context-preflight-${digest}`;
}

export class DefaultContextPreflightPolicy
  implements ContextPreflightPolicy {
  decide(input: ContextPreflightInput): ContextPreflightDecision {
    if (input.transcript !== null || !isFeishuConversation(input.task)) {
      return { kind: "continue" };
    }
    const text = intentText(input.task);
    if (
      !explicitlyDependsOnEarlierContext(text) ||
      activeSessionResolvesStatus(text, input.agent_private_context)
    ) {
      return { kind: "continue" };
    }
    const capability = disclosedHistoryCapability(
      input.available_capabilities,
    );
    if (capability === null) return { kind: "continue" };
    return {
      kind: "request",
      request: {
        invocation_id: invocationId(input.task),
        capability_id: HISTORY_CAPABILITY_ID,
        version_constraint: capability.version,
        input: {
          conversation: { kind: "current_conversation" },
          maximum_messages: RECENT_MESSAGE_LIMIT,
        },
        reason:
          "当前请求明确依赖此前对话，先读取一页受权的最近消息作为判断依据",
      },
    };
  }
}
