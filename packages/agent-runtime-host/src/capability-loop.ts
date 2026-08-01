import {
  validateCapabilityInvocationRequest,
  validateRuntimeCapabilitySummaries,
  validateRuntimeCapabilityTranscript,
  validateRuntimeDriverTurn,
  type CapabilityAwareAgentRuntimeDriver,
  type CapabilityDisclosurePort,
  type CapabilityInvocationPort,
  type RuntimeCapabilityContinuation,
  type RuntimeDriverResult,
  type RuntimeProgress,
  type RuntimeTaskPackage,
} from "@work-fabric/agent-runtime-spi";

import { AgentRuntimeHostError } from "./errors.js";

export interface CapabilityLoopLimits {
  readonly max_invocations_per_handoff: number;
  readonly max_query_invocations_per_handoff: number;
  readonly max_query_result_bytes: number;
  readonly allowed_namespaces: readonly string[];
}

export interface CapabilityContinuationLoopInput {
  readonly task: RuntimeTaskPackage;
  readonly driver: CapabilityAwareAgentRuntimeDriver;
  readonly disclosure: CapabilityDisclosurePort;
  readonly invocations: CapabilityInvocationPort;
  readonly limits: CapabilityLoopLimits;
  readonly progress: (update: RuntimeProgress) => Promise<void>;
  readonly signal: AbortSignal;
  readonly now?: () => string;
}

function validateLimits(limits: CapabilityLoopLimits): void {
  if (
    !Number.isSafeInteger(limits.max_invocations_per_handoff) ||
    limits.max_invocations_per_handoff < 1 ||
    limits.max_invocations_per_handoff > 8
  ) {
    throw new AgentRuntimeHostError(
      "invalid_capability_limits",
      "max_invocations_per_handoff",
    );
  }
  if (
    !Number.isSafeInteger(limits.max_query_invocations_per_handoff) ||
    limits.max_query_invocations_per_handoff < 1 ||
    limits.max_query_invocations_per_handoff >
      limits.max_invocations_per_handoff
  ) {
    throw new AgentRuntimeHostError(
      "invalid_capability_limits",
      "max_query_invocations_per_handoff",
    );
  }
  if (
    !Number.isSafeInteger(limits.max_query_result_bytes) ||
    limits.max_query_result_bytes < 1_024 ||
    limits.max_query_result_bytes > 131_072
  ) {
    throw new AgentRuntimeHostError(
      "invalid_capability_limits",
      "max_query_result_bytes",
    );
  }
  if (
    !Array.isArray(limits.allowed_namespaces) ||
    limits.allowed_namespaces.length === 0 ||
    limits.allowed_namespaces.some((namespace) =>
      typeof namespace !== "string" ||
      namespace.length === 0 ||
      namespace.length > 128 ||
      namespace.trim() !== namespace
    )
  ) {
    throw new AgentRuntimeHostError(
      "invalid_capability_limits",
      "allowed_namespaces",
    );
  }
}

function namespaceAllowed(
  capabilityId: string,
  namespaces: readonly string[],
): boolean {
  return namespaces.some((namespace) => capabilityId.startsWith(namespace));
}

export async function runCapabilityContinuationLoop(
  input: CapabilityContinuationLoopInput,
): Promise<RuntimeDriverResult> {
  validateLimits(input.limits);
  const now = input.now ?? (() => new Date().toISOString());
  const invocationIds = new Set<string>();
  const transcriptEntries: RuntimeCapabilityContinuation[] = [];
  let queryInvocations = 0;
  let queryResultBytes = 0;
  let progressSequence = 0;
  const availableCapabilities = validateRuntimeCapabilitySummaries(
    await input.disclosure.list(
      input.limits.allowed_namespaces,
      input.signal,
    ),
  );

  for (;;) {
    if (input.signal.aborted) {
      throw new AgentRuntimeHostError(
        "capability_loop_cancelled",
        input.task.handoff_id,
      );
    }
    let turnProgressSequence = 0;
    const publishProgress = async (update: RuntimeProgress): Promise<void> => {
      if (
        !Number.isSafeInteger(update.sequence) ||
        update.sequence <= turnProgressSequence
      ) {
        throw new AgentRuntimeHostError(
          "invalid_turn_progress_sequence",
          input.task.handoff_id,
        );
      }
      turnProgressSequence = update.sequence;
      progressSequence += 1;
      await input.progress({
        ...update,
        sequence: progressSequence,
      });
    };
    const turn = validateRuntimeDriverTurn(await input.driver.executeTurn(
      input.task,
      availableCapabilities,
      transcriptEntries.length === 0
        ? null
        : validateRuntimeCapabilityTranscript({
            entries: transcriptEntries,
          }),
      publishProgress,
      input.signal,
    ));
    if (turn.kind === "final") return turn.response;
    if (
      invocationIds.size >=
      input.limits.max_invocations_per_handoff
    ) {
      throw new AgentRuntimeHostError(
        "maximum_capability_invocations_exceeded",
        input.task.handoff_id,
      );
    }
    if (invocationIds.has(turn.request.invocation_id)) {
      throw new AgentRuntimeHostError(
        "duplicate_invocation_id",
        turn.request.invocation_id,
      );
    }
    if (
      !namespaceAllowed(
        turn.request.capability_id,
        input.limits.allowed_namespaces,
      )
    ) {
      throw new AgentRuntimeHostError(
        "capability_namespace_denied",
        turn.request.capability_id,
      );
    }
    const operationKinds = new Set(
      availableCapabilities
        .filter((capability) =>
          capability.capability_id === turn.request.capability_id
        )
        .map((capability) => capability.operation_kind),
    );
    if (operationKinds.size !== 1) {
      throw new AgentRuntimeHostError(
        "ambiguous_capability_operation_kind",
        turn.request.capability_id,
      );
    }
    const operationKind = [...operationKinds][0]!;
    if (
      operationKind === "query" &&
      queryInvocations >= input.limits.max_query_invocations_per_handoff
    ) {
      throw new AgentRuntimeHostError(
        "maximum_query_invocations_exceeded",
        input.task.handoff_id,
      );
    }
    if (
      !Number.isFinite(Date.parse(input.task.result_due_at)) ||
      Date.parse(input.task.result_due_at) <= Date.parse(now())
    ) {
      throw new AgentRuntimeHostError(
        "capability_deadline_exceeded",
        input.task.handoff_id,
      );
    }
    invocationIds.add(turn.request.invocation_id);
    if (operationKind === "query") queryInvocations += 1;
    const request = validateCapabilityInvocationRequest({
      ...turn.request,
      original_handoff_id: input.task.handoff_id,
      thread_id: input.task.thread_id,
      deadline: input.task.result_due_at,
    });
    const result = await input.invocations.invoke(request, input.signal);
    if (operationKind === "query" && result.outcome === "succeeded") {
      queryResultBytes += new TextEncoder().encode(JSON.stringify({
        data: result.data,
        artifacts: result.artifacts,
      })).byteLength;
      if (queryResultBytes > input.limits.max_query_result_bytes) {
        throw new AgentRuntimeHostError(
          "maximum_query_result_bytes_exceeded",
          input.task.handoff_id,
        );
      }
    }
    const entry = {
      request: turn.request,
      result,
    };
    transcriptEntries.push(entry);
    validateRuntimeCapabilityTranscript({ entries: transcriptEntries });
  }
}
