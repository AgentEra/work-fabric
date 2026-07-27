import { describe, expect, it } from "vitest";

import {
  acceptChildAndTransferParent,
  decideHandoff,
  evolveHandoff,
  offerChildHandoff,
  type ActorRef,
  type HandoffDecisionContext,
  type HandoffEvent,
  type HandoffPackage,
  type HandoffState,
  type TransferDecision,
} from "../src/index.js";

const initiator: ActorRef = {
  actor_id: "actor_initiator",
  actor_type: "human",
};
const parentRecipient: ActorRef = {
  actor_id: "actor_parent_recipient",
  actor_type: "agent",
};
const childRecipient: ActorRef = {
  actor_id: "actor_child_recipient",
  actor_type: "agent",
};
const verifier: ActorRef = {
  actor_id: "actor_verifier",
  actor_type: "system",
};
const otherActor: ActorRef = {
  actor_id: "actor_other",
  actor_type: "agent",
};

function packageFor(
  target: ActorRef,
  mayRedelegate: boolean,
): HandoffPackage {
  return {
    work_reference: { uri: "urn:work:item:42" },
    target: { actor_id: target.actor_id },
    intent: [{ kind: "text", text: "Complete the delegated work" }],
    context: null,
    authority_scope: {
      delegation_id: "delegation_01",
      scopes: ["work:read"],
      resource_refs: ["urn:work:item:42"],
      expires_at: "2026-07-16T00:00:00Z",
      may_redelegate: mayRedelegate,
    },
    acceptance_criteria: [
      {
        criterion_id: "tests-pass",
        description: "Tests pass",
        required: true,
        result_schema_ref: null,
        required_evidence_types: [],
      },
    ],
    verifier,
    priority: "normal",
    accept_by: "2026-07-15T08:00:00Z",
    result_due_at: "2026-07-15T10:00:00Z",
  };
}

function offeredState(
  handoffId: string,
  handoffPackage: HandoffPackage,
  parentHandoffId: string | null,
  actor = initiator,
): HandoffState {
  return evolveHandoff(
    null,
    {
      event_type: "workfabric.handoff.offered.v1",
      handoff_id: handoffId,
      thread_id: "thread_01",
      initiator: actor,
      package: handoffPackage,
      parent_handoff_id: parentHandoffId,
      occurred_at: "2026-07-15T01:00:00Z",
    },
    1,
  );
}

function acceptedParent(): HandoffState {
  const offered = offeredState(
    "handoff_parent",
    packageFor(parentRecipient, true),
    null,
  );
  return evolveHandoff(
    offered,
    {
      event_type: "workfabric.handoff.accepted.v1",
      handoff_id: offered.handoff_id,
      recipient: parentRecipient,
      occurred_at: "2026-07-15T02:00:00Z",
    },
    2,
  );
}

const decisionContext: HandoffDecisionContext = {
  now: "2026-07-15T03:00:00Z",
  recipient_authorized: true,
  verifier_authorized: true,
  policy_allows_cancel: true,
  context_available: true,
  authority_valid: true,
};

function accepted(decision: TransferDecision): {
  readonly parent_events: readonly HandoffEvent[];
  readonly child_events: readonly HandoffEvent[];
} {
  expect(decision.kind).toBe("accepted");
  if (decision.kind !== "accepted") {
    throw new Error(`Expected accepted, received ${decision.error.code}`);
  }
  return decision;
}

function acceptCommand(
  overrides: Partial<{
    endpoint_id: string;
    claim_id: string;
    fencing_token: number;
  }> = {},
) {
  return {
    kind: "accept" as const,
    handoff_id: "handoff_child",
    actor: childRecipient,
    ...overrides,
  };
}

function expectRejected(
  decision: TransferDecision,
  code: Extract<TransferDecision, { readonly kind: "rejected" }>["error"]["code"],
): void {
  expect(decision).toMatchObject({
    kind: "rejected",
    error: { code, retryable: false },
  });
}

describe("Handoff Transfer coordinator", () => {
  it("offers a child from the accepted parent without changing parent responsibility", () => {
    const parent = acceptedParent();
    const decision = accepted(
      offerChildHandoff(
        parent,
        "handoff_child",
        packageFor(childRecipient, false),
        parentRecipient,
        "2026-07-15T02:30:00Z",
      ),
    );

    expect(decision.parent_events).toEqual([]);
    expect(decision.child_events).toEqual([
      {
        event_type: "workfabric.handoff.offered.v1",
        handoff_id: "handoff_child",
        thread_id: parent.thread_id,
        initiator: parentRecipient,
        package: packageFor(childRecipient, false),
        parent_handoff_id: parent.handoff_id,
        occurred_at: "2026-07-15T02:30:00Z",
      },
    ]);
    expect(parent.lifecycle_state).toBe("accepted");
    expect(parent.current_responsible_actor).toEqual(parentRecipient);
  });

  it("uses the root assignment semantics for capability-target children", () => {
    const parent = acceptedParent();
    const capabilityPackage = {
      ...packageFor(childRecipient, false),
      target: {
        capability_requirement: {
          capability_id: "software.implementation",
          assignment_mode: "eligible_pool_claim" as const,
        },
      },
    };

    const pool = accepted(
      offerChildHandoff(
        parent,
        "handoff_child",
        capabilityPackage,
        parentRecipient,
        "2026-07-15T02:30:00Z",
      ),
    );
    expect(pool.child_events[0]).toMatchObject({
      event_type: "workfabric.handoff.claim_pool_opened.v1",
      parent_handoff_id: parent.handoff_id,
    });

    const external = accepted(
      offerChildHandoff(
        parent,
        "handoff_external",
        {
          ...capabilityPackage,
          target: {
            capability_requirement: {
              capability_id: "software.implementation",
              assignment_mode: "external_resolution" as const,
            },
          },
        },
        parentRecipient,
        "2026-07-15T02:30:00Z",
      ),
    );
    expect(external.child_events[0]).toMatchObject({
      event_type: "workfabric.handoff.target_resolution_requested.v1",
      parent_handoff_id: parent.handoff_id,
    });
  });

  it("transfers atomically when a capability-target child is accepted by its fenced Claim holder", () => {
    const parent = acceptedParent();
    const childPackage = {
      ...packageFor(childRecipient, false),
      target: {
        capability_requirement: {
          capability_id: "software.implementation",
          assignment_mode: "eligible_pool_claim" as const,
        },
      },
    };
    const offered = accepted(
      offerChildHandoff(
        parent,
        "handoff_child",
        childPackage,
        parentRecipient,
        "2026-07-15T02:30:00Z",
      ),
    ).child_events[0]!;
    const claimable = evolveHandoff(null, offered, 1);
    const claim = decideHandoff(
      claimable,
      {
        kind: "claim",
        handoff_id: "handoff_child",
        actor: childRecipient,
        endpoint_id: "endpoint_child",
        claim_id: "claim_child",
      },
      {
        ...decisionContext,
        claimant_eligible: true,
        claim_lease: {
          accepted_lease_seconds: 60,
          expires_at: "2026-07-15T03:01:00Z",
          renew_after: "2026-07-15T03:00:30Z",
        },
      },
    );
    if (claim.kind !== "accepted") throw new Error("Claim fixture failed");
    const claimed = evolveHandoff(claimable, claim.events[0]!, 2);

    const transfer = accepted(
      acceptChildAndTransferParent(
        parent,
        claimed,
        acceptCommand({
          endpoint_id: "endpoint_child",
          claim_id: "claim_child",
          fencing_token: 1,
        }),
        decisionContext,
      ),
    );
    expect(transfer.child_events[0]).toMatchObject({
      event_type: "workfabric.handoff.accepted.v1",
      binding: {
        target: { endpoint_id: "endpoint_child" },
        resolver_endpoint_id: "endpoint_child",
      },
    });
    expect(transfer.parent_events[0]).toMatchObject({
      event_type: "workfabric.handoff.transferred.v1",
      child_handoff_id: "handoff_child",
    });
  });

  it("allows only the current Recipient to initiate Transfer", () => {
    expectRejected(
      offerChildHandoff(
        acceptedParent(),
        "handoff_child",
        packageFor(childRecipient, false),
        otherActor,
        "2026-07-15T02:30:00Z",
      ),
      "permission_denied",
    );
  });

  it("requires an accepted parent and redelegation authority", () => {
    const offered = offeredState(
      "handoff_parent",
      packageFor(parentRecipient, true),
      null,
    );
    const noRedelegation = evolveHandoff(
      offeredState(
        "handoff_parent",
        packageFor(parentRecipient, false),
        null,
      ),
      {
        event_type: "workfabric.handoff.accepted.v1",
        handoff_id: "handoff_parent",
        recipient: parentRecipient,
        occurred_at: "2026-07-15T02:00:00Z",
      },
      2,
    );

    expectRejected(
      offerChildHandoff(
        offered,
        "handoff_child",
        packageFor(childRecipient, false),
        parentRecipient,
        "2026-07-15T02:30:00Z",
      ),
      "invalid_state_transition",
    );
    expectRejected(
      offerChildHandoff(
        noRedelegation,
        "handoff_child",
        packageFor(childRecipient, false),
        parentRecipient,
        "2026-07-15T02:30:00Z",
      ),
      "permission_denied",
    );
  });

  it("accepts the offered child and transfers the parent in one decision", () => {
    const parent = acceptedParent();
    const child = offeredState(
      "handoff_child",
      packageFor(childRecipient, false),
      parent.handoff_id,
      parentRecipient,
    );
    const decision = accepted(
      acceptChildAndTransferParent(
        parent,
        child,
        acceptCommand(),
        decisionContext,
      ),
    );

    expect(decision.child_events).toEqual([
      {
        event_type: "workfabric.handoff.accepted.v1",
        handoff_id: child.handoff_id,
        recipient: childRecipient,
        occurred_at: decisionContext.now,
      },
    ]);
    expect(decision.parent_events).toEqual([
      {
        event_type: "workfabric.handoff.transferred.v1",
        handoff_id: parent.handoff_id,
        child_handoff_id: child.handoff_id,
        occurred_at: decisionContext.now,
      },
    ]);
  });

  it("rejects a child with the wrong parent lineage", () => {
    const parent = acceptedParent();
    const child = offeredState(
      "handoff_child",
      packageFor(childRecipient, false),
      "handoff_other_parent",
      parentRecipient,
    );

    expectRejected(
      acceptChildAndTransferParent(
        parent,
        child,
        acceptCommand(),
        decisionContext,
      ),
      "precondition_failed",
    );
  });

  it("rejects a child whose thread differs from the parent thread", () => {
    const parent = acceptedParent();
    const child = {
      ...offeredState(
        "handoff_child",
        packageFor(childRecipient, false),
        parent.handoff_id,
        parentRecipient,
      ),
      thread_id: "thread_unrelated",
    };

    expectRejected(
      acceptChildAndTransferParent(
        parent,
        child,
        acceptCommand(),
        decisionContext,
      ),
      "precondition_failed",
    );
  });

  it("rechecks parent redelegation authority when the child is accepted", () => {
    const offered = offeredState(
      "handoff_parent",
      packageFor(parentRecipient, false),
      null,
    );
    const parent = evolveHandoff(
      offered,
      {
        event_type: "workfabric.handoff.accepted.v1",
        handoff_id: offered.handoff_id,
        recipient: parentRecipient,
        occurred_at: "2026-07-15T02:00:00Z",
      },
      2,
    );
    const child = offeredState(
      "handoff_child",
      packageFor(childRecipient, false),
      parent.handoff_id,
      parentRecipient,
    );

    expectRejected(
      acceptChildAndTransferParent(
        parent,
        child,
        acceptCommand(),
        decisionContext,
      ),
      "permission_denied",
    );
  });

  it("rejects a child that was not offered by the parent Recipient", () => {
    const parent = acceptedParent();
    const child = offeredState(
      "handoff_child",
      packageFor(childRecipient, false),
      parent.handoff_id,
      otherActor,
    );

    expectRejected(
      acceptChildAndTransferParent(
        parent,
        child,
        acceptCommand(),
        decisionContext,
      ),
      "precondition_failed",
    );
  });

  it("rejects a second transfer after the parent is already transferred", () => {
    const parent = acceptedParent();
    const transferred = evolveHandoff(
      parent,
      {
        event_type: "workfabric.handoff.transferred.v1",
        handoff_id: parent.handoff_id,
        child_handoff_id: "handoff_existing_child",
        occurred_at: "2026-07-15T02:30:00Z",
      },
      3,
    );
    const child = offeredState(
      "handoff_child",
      packageFor(childRecipient, false),
      parent.handoff_id,
      parentRecipient,
    );

    expectRejected(
      acceptChildAndTransferParent(
        transferred,
        child,
        acceptCommand(),
        decisionContext,
      ),
      "invalid_state_transition",
    );
  });
});
