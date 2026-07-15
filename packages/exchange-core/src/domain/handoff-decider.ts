import { parseUtcTimestamp } from "@work-fabric/exchange-spi";

import type { DomainDecision, DomainError } from "./domain-error.js";
import type {
  HandoffCommand,
  HandoffDecisionContext,
} from "./handoff-commands.js";
import type { HandoffEvent } from "./handoff-events.js";
import { effectiveHandoffTarget } from "./handoff-types.js";
import type {
  ActorRef,
  HandoffLifecycleState,
  HandoffState,
} from "./handoff-types.js";

function accept(event: HandoffEvent): DomainDecision {
  return { kind: "accepted", events: [event] };
}

function reject(code: DomainError["code"], message: string): DomainDecision {
  return {
    kind: "rejected",
    error: { code, message, retryable: false },
  };
}

function actorEquals(left: ActorRef | null, right: ActorRef): boolean {
  return (
    left !== null &&
    left.actor_id === right.actor_id &&
    left.actor_type === right.actor_type
  );
}

function isDirectRecipient(state: HandoffState, actor: ActorRef): boolean {
  const target = effectiveHandoffTarget(state);
  if (target === null) return false;
  return !("actor_id" in target) || target.actor_id === actor.actor_id;
}

function isCapabilityTarget(state: HandoffState): boolean {
  return "capability_requirement" in state.package.target;
}

function isAuthorizedRecipient(
  state: HandoffState,
  actor: ActorRef,
  context: HandoffDecisionContext,
): boolean {
  if (!context.recipient_authorized || !isDirectRecipient(state, actor)) {
    return false;
  }

  return (
    state.lifecycle_state !== "rework_requested" ||
    actorEquals(state.recipient, actor)
  );
}

function isAllowedState(
  state: HandoffState,
  command: HandoffCommand["kind"],
  allowed: readonly HandoffLifecycleState[],
): DomainDecision | null {
  if (allowed.includes(state.lifecycle_state)) {
    return null;
  }
  return reject(
    "invalid_state_transition",
    `${command} is not allowed from ${state.lifecycle_state}`,
  );
}

function timestamp(value: string, field: string): bigint {
  try {
    const parsed = parseUtcTimestamp(value, field);
    return parsed.epoch_seconds * 1_000_000_000n + BigInt(parsed.nanoseconds);
  } catch {
    throw new Error(`Invalid ${field} timestamp: ${value}`);
  }
}

function validateCriterionIds(
  state: HandoffState,
  criterionIds: readonly string[],
  field: string,
): DomainDecision | null {
  if (criterionIds.length === 0) {
    return reject("invalid_argument", `${field} must not be empty`);
  }

  const uniqueCriterionIds = new Set(criterionIds);
  if (uniqueCriterionIds.size !== criterionIds.length) {
    return reject("invalid_argument", `${field} must be unique`);
  }

  const packageCriterionIds = new Set(
    state.package.acceptance_criteria.map((criterion) => criterion.criterion_id),
  );
  if (
    criterionIds.some((criterionId) => !packageCriterionIds.has(criterionId))
  ) {
    return reject(
      "invalid_argument",
      `${field} must belong to the Handoff Package`,
    );
  }
  return null;
}

function rejectUnauthorized(action: string): DomainDecision {
  return reject("permission_denied", `Actor is not authorized to ${action}`);
}

function decideAccept(
  state: HandoffState,
  command: Extract<HandoffCommand, { readonly kind: "accept" }>,
  context: HandoffDecisionContext,
): DomainDecision {
  const invalidState = isAllowedState(state, command.kind, [
    "offered",
    "rework_requested",
  ]);
  if (invalidState !== null) return invalidState;
  if (!isAuthorizedRecipient(state, command.actor, context)) {
    return rejectUnauthorized("accept Handoff responsibility");
  }
  if (state.package.context !== null && !context.context_available) {
    return reject(
      "context_unavailable",
      "Referenced Handoff Context is unavailable",
    );
  }
  return accept({
    event_type: "workfabric.handoff.accepted.v1",
    handoff_id: command.handoff_id,
    recipient: command.actor,
    occurred_at: context.now,
  });
}

function decideDecline(
  state: HandoffState,
  command: Extract<HandoffCommand, { readonly kind: "decline" }>,
  context: HandoffDecisionContext,
): DomainDecision {
  const invalidState = isAllowedState(state, command.kind, ["offered"]);
  if (invalidState !== null) return invalidState;
  if (!isAuthorizedRecipient(state, command.actor, context)) {
    return rejectUnauthorized("decline the Handoff");
  }
  return accept({
    event_type: "workfabric.handoff.declined.v1",
    handoff_id: command.handoff_id,
    occurred_at: context.now,
  });
}

function decideExpire(
  state: HandoffState,
  command: Extract<HandoffCommand, { readonly kind: "expire" }>,
  context: HandoffDecisionContext,
): DomainDecision {
  const invalidState = isAllowedState(state, command.kind, [
    "target_resolution_pending",
    "offered",
  ]);
  if (invalidState !== null) return invalidState;
  if (
    timestamp(context.now, "decision now") <
    timestamp(state.package.accept_by, "accept_by")
  ) {
    return reject(
      "precondition_failed",
      "Handoff cannot expire before accept_by",
    );
  }
  return accept({
    event_type: "workfabric.handoff.expired.v1",
    handoff_id: command.handoff_id,
    occurred_at: context.now,
  });
}

function decideCancel(
  state: HandoffState,
  command: Extract<HandoffCommand, { readonly kind: "cancel" }>,
  context: HandoffDecisionContext,
): DomainDecision {
  const invalidState = isAllowedState(state, command.kind, [
    "target_resolution_pending",
    "offered",
    "accepted",
  ]);
  if (invalidState !== null) return invalidState;
  if (!actorEquals(state.initiator, command.actor)) {
    return rejectUnauthorized("cancel the Handoff");
  }
  if (!context.policy_allows_cancel) {
    return reject("permission_denied", "Handoff cancellation is not allowed");
  }
  return accept({
    event_type: "workfabric.handoff.cancelled.v1",
    handoff_id: command.handoff_id,
    reason: command.reason,
    occurred_at: context.now,
  });
}

function decideResolveTarget(
  state: HandoffState,
  command: Extract<HandoffCommand, { readonly kind: "resolve_target" }>,
  context: HandoffDecisionContext,
): DomainDecision {
  const invalidState = isAllowedState(state, command.kind, [
    "target_resolution_pending",
  ]);
  if (invalidState !== null) return invalidState;
  if (!isCapabilityTarget(state)) {
    return reject("invalid_argument", "Handoff does not have a Capability target");
  }
  if (!context.resolver_authorized) {
    return rejectUnauthorized("resolve the Handoff target");
  }
  if (!context.target_eligible) {
    return reject("precondition_failed", "Resolved target is not eligible");
  }
  return accept({
    event_type: "workfabric.handoff.target_resolved.v1",
    handoff_id: command.handoff_id,
    binding: {
      target: command.resolved_target,
      resolved_by: command.actor,
      resolver_endpoint_id: command.resolver_endpoint_id,
      delegation_id: command.delegation_id,
      resolved_at: context.now,
      evidence: command.evidence,
    },
    occurred_at: context.now,
  });
}

function decideTargetUnavailable(
  state: HandoffState,
  command: Extract<
    HandoffCommand,
    { readonly kind: "report_target_unavailable" }
  >,
  context: HandoffDecisionContext,
): DomainDecision {
  const invalidState = isAllowedState(state, command.kind, [
    "target_resolution_pending",
  ]);
  if (invalidState !== null) return invalidState;
  if (!isCapabilityTarget(state)) {
    return reject("invalid_argument", "Handoff does not have a Capability target");
  }
  if (!context.resolver_authorized) {
    return rejectUnauthorized("report the Handoff target unavailable");
  }
  return accept({
    event_type: "workfabric.handoff.target_unavailable.v1",
    handoff_id: command.handoff_id,
    resolved_by: command.actor,
    resolver_endpoint_id: command.resolver_endpoint_id,
    delegation_id: command.delegation_id,
    reason_code: command.reason_code,
    reason: command.reason,
    evidence: command.evidence,
    occurred_at: context.now,
  });
}

function decideStatus(
  state: HandoffState,
  command: Extract<HandoffCommand, { readonly kind: "report_status" }>,
  context: HandoffDecisionContext,
): DomainDecision {
  const invalidState = isAllowedState(state, command.kind, ["accepted"]);
  if (invalidState !== null) return invalidState;
  if (
    !context.recipient_authorized ||
    !actorEquals(state.recipient, command.actor)
  ) {
    return rejectUnauthorized("report Handoff status");
  }
  return accept({
    event_type: "workfabric.handoff.status_reported.v1",
    handoff_id: command.handoff_id,
    status: command.status,
    occurred_at: context.now,
  });
}

function decideResult(
  state: HandoffState,
  command: Extract<HandoffCommand, { readonly kind: "return_result" }>,
  context: HandoffDecisionContext,
): DomainDecision {
  const invalidState = isAllowedState(state, command.kind, ["accepted"]);
  if (invalidState !== null) return invalidState;
  if (!actorEquals(state.recipient, command.actor)) {
    return rejectUnauthorized("return the Handoff result");
  }
  if (
    !context.authority_valid ||
    timestamp(context.now, "decision now") >=
      timestamp(
        state.package.authority_scope.expires_at,
        "Authority Scope expires_at",
      )
  ) {
    return reject("expired", "Handoff Authority Scope is not valid");
  }
  return accept({
    event_type: "workfabric.handoff.result_returned.v1",
    handoff_id: command.handoff_id,
    result: command.result,
    occurred_at: context.now,
  });
}

function requireVerifier(
  state: HandoffState,
  actor: ActorRef,
  context: HandoffDecisionContext,
  action: string,
): DomainDecision | null {
  if (context.verifier_authorized && actorEquals(state.verifier, actor)) {
    return null;
  }
  return rejectUnauthorized(action);
}

function decideVerify(
  state: HandoffState,
  command: Extract<HandoffCommand, { readonly kind: "verify" }>,
  context: HandoffDecisionContext,
): DomainDecision {
  const invalidState = isAllowedState(state, command.kind, [
    "result_returned",
  ]);
  if (invalidState !== null) return invalidState;
  const unauthorized = requireVerifier(
    state,
    command.actor,
    context,
    "verify the Handoff result",
  );
  if (unauthorized !== null) return unauthorized;

  const invalidCriterionIds = validateCriterionIds(
    state,
    command.satisfied_criterion_ids,
    "Verification criterion IDs",
  );
  if (invalidCriterionIds !== null) return invalidCriterionIds;

  const satisfied = new Set(command.satisfied_criterion_ids);
  const missingRequired = state.package.acceptance_criteria.some(
    (criterion) => criterion.required && !satisfied.has(criterion.criterion_id),
  );
  if (missingRequired) {
    return reject(
      "precondition_failed",
      "Not all required acceptance criteria are satisfied",
    );
  }
  return accept({
    event_type: "workfabric.handoff.verified.v1",
    handoff_id: command.handoff_id,
    satisfied_criterion_ids: command.satisfied_criterion_ids,
    summary: command.summary,
    evidence: command.evidence,
    occurred_at: context.now,
  });
}

function decideClose(
  state: HandoffState,
  command: Extract<HandoffCommand, { readonly kind: "close" }>,
  context: HandoffDecisionContext,
): DomainDecision {
  const invalidState = isAllowedState(state, command.kind, ["verified"]);
  if (invalidState !== null) return invalidState;
  const unauthorized = requireVerifier(
    state,
    command.actor,
    context,
    "close the Handoff",
  );
  if (unauthorized !== null) return unauthorized;
  return accept({
    event_type: "workfabric.handoff.closed.v1",
    handoff_id: command.handoff_id,
    occurred_at: context.now,
  });
}

function decideRework(
  state: HandoffState,
  command: Extract<HandoffCommand, { readonly kind: "request_rework" }>,
  context: HandoffDecisionContext,
): DomainDecision {
  const invalidState = isAllowedState(state, command.kind, [
    "result_returned",
  ]);
  if (invalidState !== null) return invalidState;
  const unauthorized = requireVerifier(
    state,
    command.actor,
    context,
    "request Handoff rework",
  );
  if (unauthorized !== null) return unauthorized;
  if (command.reason.length === 0) {
    return reject("precondition_failed", "A rework reason is required");
  }

  const invalidCriterionIds = validateCriterionIds(
    state,
    command.criterion_ids,
    "Rework criterion IDs",
  );
  if (invalidCriterionIds !== null) return invalidCriterionIds;
  return accept({
    event_type: "workfabric.handoff.rework_requested.v1",
    handoff_id: command.handoff_id,
    criterion_ids: command.criterion_ids,
    reason: command.reason,
    occurred_at: context.now,
  });
}

function assertNever(_value: never): never {
  throw new Error("Unsupported Handoff command");
}

export function decideHandoff(
  state: HandoffState | null,
  command: HandoffCommand,
  context: HandoffDecisionContext,
): DomainDecision {
  timestamp(context.now, "decision now");

  if (command.kind === "offer") {
    if (state !== null) {
      return reject(
        "invalid_state_transition",
        `offer is not allowed from ${state.lifecycle_state}`,
      );
    }
    return accept({
      event_type:
        "capability_requirement" in command.package.target
          ? "workfabric.handoff.target_resolution_requested.v1"
          : "workfabric.handoff.offered.v1",
      handoff_id: command.handoff_id,
      thread_id: command.thread_id,
      initiator: command.actor,
      package: command.package,
      parent_handoff_id: command.parent_handoff_id,
      occurred_at: context.now,
    });
  }

  if (state === null) {
    return reject("not_found", `Handoff ${command.handoff_id} was not found`);
  }
  if (state.handoff_id !== command.handoff_id) {
    return reject("not_found", `Handoff ${command.handoff_id} was not found`);
  }

  switch (command.kind) {
    case "resolve_target":
      return decideResolveTarget(state, command, context);
    case "report_target_unavailable":
      return decideTargetUnavailable(state, command, context);
    case "accept":
      return decideAccept(state, command, context);
    case "decline":
      return decideDecline(state, command, context);
    case "expire":
      return decideExpire(state, command, context);
    case "cancel":
      return decideCancel(state, command, context);
    case "report_status":
      return decideStatus(state, command, context);
    case "return_result":
      return decideResult(state, command, context);
    case "verify":
      return decideVerify(state, command, context);
    case "close":
      return decideClose(state, command, context);
    case "request_rework":
      return decideRework(state, command, context);
    default:
      return assertNever(command);
  }
}
