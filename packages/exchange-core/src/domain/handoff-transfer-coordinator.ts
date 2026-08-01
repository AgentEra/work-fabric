import type { DomainError } from "./domain-error.js";
import type {
  HandoffCommand,
  HandoffDecisionContext,
} from "./handoff-commands.js";
import { decideHandoff } from "./handoff-decider.js";
import type { HandoffEvent } from "./handoff-events.js";
import type { ActorRef, HandoffPackage, HandoffState } from "./handoff-types.js";

export type TransferDecision =
  | {
      readonly kind: "accepted";
      readonly parent_events: readonly HandoffEvent[];
      readonly child_events: readonly HandoffEvent[];
    }
  | { readonly kind: "rejected"; readonly error: DomainError };

function reject(
  code: DomainError["code"],
  message: string,
): TransferDecision {
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

export function offerChildHandoff(
  parent: HandoffState,
  childId: string,
  childPackage: HandoffPackage,
  actor: ActorRef,
  now: string,
): TransferDecision {
  if (parent.lifecycle_state !== "accepted") {
    return reject(
      "invalid_state_transition",
      `transfer is not allowed from ${parent.lifecycle_state}`,
    );
  }
  if (!actorEquals(parent.recipient, actor)) {
    return reject(
      "permission_denied",
      "Only the current Handoff Recipient can transfer responsibility",
    );
  }
  if (!parent.package.authority_scope.may_redelegate) {
    return reject(
      "permission_denied",
      "The Handoff Authority Scope does not allow redelegation",
    );
  }

  const childDecision = decideHandoff(
    null,
    {
      kind: "offer",
      handoff_id: childId,
      thread_id: parent.thread_id,
      actor,
      package: childPackage,
      parent_handoff_id: parent.handoff_id,
    },
    {
      now,
      recipient_authorized: true,
      verifier_authorized: true,
      policy_allows_cancel: true,
      context_available: true,
      authority_valid: true,
    },
  );
  return childDecision.kind === "rejected"
    ? childDecision
    : {
        kind: "accepted",
        parent_events: [],
        child_events: childDecision.events,
      };
}

export function acceptChildAndTransferParent(
  parent: HandoffState,
  child: HandoffState,
  command: Extract<HandoffCommand, { readonly kind: "accept" }>,
  context: HandoffDecisionContext,
): TransferDecision {
  if (parent.lifecycle_state !== "accepted") {
    return reject(
      "invalid_state_transition",
      `transfer is not allowed from ${parent.lifecycle_state}`,
    );
  }
  if (!parent.package.authority_scope.may_redelegate) {
    return reject(
      "permission_denied",
      "The parent Handoff Authority Scope no longer allows redelegation",
    );
  }
  if (child.parent_handoff_id !== parent.handoff_id) {
    return reject(
      "precondition_failed",
      "Child Handoff does not belong to the supplied parent",
    );
  }
  if (child.thread_id !== parent.thread_id) {
    return reject(
      "precondition_failed",
      "Child Handoff thread does not match its parent",
    );
  }
  if (!actorEquals(parent.recipient, child.initiator)) {
    return reject(
      "precondition_failed",
      "Child Handoff was not offered by the parent Recipient",
    );
  }

  const childDecision = decideHandoff(
    child,
    command,
    context,
  );
  if (childDecision.kind === "rejected") {
    return childDecision;
  }

  return {
    kind: "accepted",
    parent_events: [
      {
        event_type: "workfabric.handoff.transferred.v1",
        handoff_id: parent.handoff_id,
        child_handoff_id: child.handoff_id,
        occurred_at: context.now,
      },
    ],
    child_events: childDecision.events,
  };
}
