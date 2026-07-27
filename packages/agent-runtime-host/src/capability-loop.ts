import {
  validateCapabilityInvocationRequest,
  validateRuntimeCapabilitySummaries,
  validateRuntimeCapabilityContinuation,
  validateRuntimeDriverTurn,
  type CapabilityAwareAgentRuntimeDriver,
  type CapabilityDisclosurePort,
  type CapabilityInvocationPort,
  type RuntimeDriverResult,
  type RuntimeProgress,
  type RuntimeTaskPackage,
} from "@work-fabric/agent-runtime-spi";

import { AgentRuntimeHostError } from "./errors.js";

export interface CapabilityLoopLimits {
  readonly max_invocations_per_handoff: number;
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
    limits.max_invocations_per_handoff > 4
  ) {
    throw new AgentRuntimeHostError(
      "invalid_capability_limits",
      "max_invocations_per_handoff",
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
  let continuation = null;
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
    const turn = validateRuntimeDriverTurn(await input.driver.executeTurn(
      input.task,
      availableCapabilities,
      continuation,
      input.progress,
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
    const request = validateCapabilityInvocationRequest({
      ...turn.request,
      original_handoff_id: input.task.handoff_id,
      thread_id: input.task.thread_id,
      deadline: input.task.result_due_at,
    });
    const result = await input.invocations.invoke(request, input.signal);
    continuation = validateRuntimeCapabilityContinuation({
      request: turn.request,
      result,
    });
  }
}
