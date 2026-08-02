import type {
  AgentPrivateStateStore,
  CapabilityAwareAgentRuntimeDriver,
  RuntimeCapabilitySummary,
  RuntimeCapabilityTranscript,
  RuntimeDriverResult,
  RuntimeDriverTurn,
  RuntimeProgress,
  RuntimeTaskPackage,
} from "@work-fabric/agent-runtime-spi";

import {
  SchedulingSessionRepository,
  type SchedulingSessionUpdate,
} from "./scheduling-session.js";

const PRIVATE_STATE_EXTENSION = "workfabric.agent/private_state";

function supportsSchedulingContext(task: RuntimeTaskPackage): boolean {
  const source = task.source_reference;
  if (
    source === null ||
    typeof source !== "object" ||
    Array.isArray(source)
  ) return false;
  const extensions = source.extensions;
  return (
    extensions !== null &&
    typeof extensions === "object" &&
    !Array.isArray(extensions) &&
    extensions["workfabric.dev/provider_family"] === "feishu" &&
    extensions["workfabric.dev/resource_kind"] === "conversation_message"
  );
}

function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("Agent private state output is invalid");
  }
  return value as Record<string, unknown>;
}

function update(value: unknown): SchedulingSessionUpdate | null {
  const item = record(value);
  if (Object.keys(item).length === 0) return null;
  const fields = [
    "namespace",
    "expected_version",
    "phase",
    "proposal",
    "confirmed_proposal_digest",
    "confirmation_handoff_id",
    "calendar_result_uri",
    "capability_result_handoff_ids",
  ];
  if (
    Object.keys(item).length !== fields.length ||
    Object.keys(item).some((key) => !fields.includes(key))
  ) {
    throw new TypeError("Agent private state output is invalid");
  }
  return item as unknown as SchedulingSessionUpdate;
}

function runtimeOwnedVersions(
  mutation: SchedulingSessionUpdate,
  privateContext: Record<string, unknown>,
): SchedulingSessionUpdate {
  const stateVersion = privateContext.state_version;
  if (
    !Number.isSafeInteger(stateVersion)
    || (stateVersion as number) < 0
  ) {
    throw new TypeError("Agent scheduling state version is invalid");
  }
  if (mutation.proposal === null) {
    return {
      ...mutation,
      expected_version: stateVersion as number,
    };
  }
  const activeSession = privateContext.active_session;
  let currentProposalVersion = 0;
  if (activeSession !== null) {
    const active = record(activeSession);
    const proposal = active.proposal;
    if (proposal !== null) {
      const currentProposal = record(proposal);
      if (
        !Number.isSafeInteger(currentProposal.version)
        || (currentProposal.version as number) < 1
      ) {
        throw new TypeError("Agent scheduling proposal version is invalid");
      }
      currentProposalVersion = currentProposal.version as number;
    }
  }
  return {
    ...mutation,
    expected_version: stateVersion as number,
    proposal: {
      ...mutation.proposal,
      version: currentProposalVersion + 1,
    },
  };
}

function withoutPrivateExtension(
  result: RuntimeDriverResult,
): RuntimeDriverResult {
  const extensions = { ...result.extensions };
  delete extensions[PRIVATE_STATE_EXTENSION];
  return {
    summary: result.summary.map((item) => structuredClone(item)),
    artifacts: result.artifacts.map((item) => structuredClone(item)),
    evidence: result.evidence.map((item) => structuredClone(item)),
    extensions,
  };
}

function withInitiatorMention(
  result: RuntimeDriverResult,
  resourceUri: string,
): RuntimeDriverResult {
  let attached = false;
  const summary = result.summary.map((item) => {
    if (attached || item.kind !== "text") return structuredClone(item);
    attached = true;
    return {
      ...structuredClone(item),
      extensions: {
        ...(
          item.extensions === undefined
            ? {}
            : structuredClone(item.extensions)
        ),
        "workfabric.dev/recipient_references": [{
          kind: "mention",
          resource_uri: resourceUri,
          display_text: "发起人",
        }],
      },
    };
  });
  if (!attached) {
    throw new TypeError("Agent proposal result has no text summary");
  }
  return { ...result, summary };
}

export class DailyAssistantDriver
  implements CapabilityAwareAgentRuntimeDriver {
  private readonly sessions: SchedulingSessionRepository;

  constructor(
    private readonly underlying: CapabilityAwareAgentRuntimeDriver,
    store: AgentPrivateStateStore,
    options: {
      readonly now?: () => string;
    } = {},
  ) {
    this.sessions = new SchedulingSessionRepository(store, options);
  }

  async executeTurn(
    task: RuntimeTaskPackage,
    availableCapabilities: readonly RuntimeCapabilitySummary[],
    transcript: RuntimeCapabilityTranscript | null,
    progress: (update: RuntimeProgress) => Promise<void>,
    signal: AbortSignal,
  ): Promise<RuntimeDriverTurn> {
    if (!supportsSchedulingContext(task)) {
      return this.underlying.executeTurn(
        task,
        availableCapabilities,
        transcript,
        progress,
        signal,
      );
    }
    const privateContext = await this.sessions.context(task);
    const enrichedTask: RuntimeTaskPackage = {
      ...task,
      agent_private_context: privateContext,
    };
    const turn = await this.underlying.executeTurn(
      enrichedTask,
      availableCapabilities,
      transcript,
      progress,
      signal,
    );
    if (turn.kind !== "final") return turn;
    const privateOutput = turn.response.extensions[PRIVATE_STATE_EXTENSION];
    if (privateOutput === undefined) return turn;
    const parsedMutation = update(privateOutput);
    let response = withoutPrivateExtension(turn.response);
    if (parsedMutation === null) return { kind: "final", response };
    const mutation = runtimeOwnedVersions(
      parsedMutation,
      privateContext,
    );
    const session = await this.sessions.apply(task, mutation);
    if (session.phase === "awaiting_confirmation") {
      response = withInitiatorMention(
        response,
        session.origin_sender_resource_uri,
      );
    }
    return {
      kind: "final",
      response,
    };
  }
}
