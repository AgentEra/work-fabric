import { describe, expect, it } from "vitest";

import {
  decideHandoff,
  evolveHandoff,
  type ActorRef,
  type DomainDecision,
  type HandoffCommand,
  type HandoffDecisionContext,
  type HandoffEvent,
  type HandoffLifecycleState,
  type HandoffPackage,
  type HandoffState,
} from "../src/index.js";

const initiator: ActorRef = {
  actor_id: "actor_initiator",
  actor_type: "human",
};
const recipient: ActorRef = {
  actor_id: "actor_recipient",
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

const handoffPackage: HandoffPackage = {
  work_reference: { system: "github", resource_id: "issue_42" },
  target: { actor_id: recipient.actor_id },
  intent: [{ kind: "text", text: "Implement the accepted change" }],
  context: {
    context_id: "context_01",
    version: 3,
    digest: "sha256:abc",
  },
  authority_scope: {
    delegation_id: "delegation_01",
    scopes: ["repo:write"],
    resource_refs: ["repo_01"],
    expires_at: "2026-07-15T00:00:00Z",
    may_redelegate: false,
  },
  acceptance_criteria: [
    {
      criterion_id: "tests-pass",
      description: "All tests pass",
      required: true,
      result_schema_ref: null,
      required_evidence_types: ["test-report"],
    },
    {
      criterion_id: "reviewed",
      description: "The change was reviewed",
      required: false,
      result_schema_ref: null,
      required_evidence_types: [],
    },
  ],
  verifier,
  priority: "high",
  accept_by: "2026-07-14T08:00:00Z",
  result_due_at: "2026-07-15T08:00:00Z",
};

const allowedContext: HandoffDecisionContext = {
  now: "2026-07-14T07:00:00Z",
  recipient_authorized: true,
  verifier_authorized: true,
  policy_allows_cancel: true,
  context_available: true,
  authority_valid: true,
};

function offeredEvent(
  overrides: Partial<
    Extract<
      HandoffEvent,
      { readonly event_type: "workfabric.handoff.offered.v1" }
    >
  > = {},
): Extract<
  HandoffEvent,
  { readonly event_type: "workfabric.handoff.offered.v1" }
> {
  return {
    event_type: "workfabric.handoff.offered.v1",
    handoff_id: "handoff_01",
    thread_id: "thread_01",
    initiator,
    package: handoffPackage,
    parent_handoff_id: null,
    occurred_at: "2026-07-14T01:00:00Z",
    ...overrides,
  };
}

function acceptedEvent(): Extract<
  HandoffEvent,
  { readonly event_type: "workfabric.handoff.accepted.v1" }
> {
  return {
    event_type: "workfabric.handoff.accepted.v1",
    handoff_id: "handoff_01",
    recipient,
    occurred_at: "2026-07-14T02:00:00Z",
  };
}

function resultReturnedEvent(): Extract<
  HandoffEvent,
  { readonly event_type: "workfabric.handoff.result_returned.v1" }
> {
  return {
    event_type: "workfabric.handoff.result_returned.v1",
    handoff_id: "handoff_01",
    result: { outcome: "implemented" },
    occurred_at: "2026-07-14T03:00:00Z",
  };
}

function verifiedEvent(): Extract<
  HandoffEvent,
  { readonly event_type: "workfabric.handoff.verified.v1" }
> {
  return {
    event_type: "workfabric.handoff.verified.v1",
    handoff_id: "handoff_01",
    satisfied_criterion_ids: ["tests-pass"],
    summary: [{ kind: "text", text: "Verified" }],
    evidence: [{ evidence_type: "test-report", ref: "report_01" }],
    occurred_at: "2026-07-14T04:00:00Z",
  };
}

const offeredState = evolveHandoff(null, offeredEvent(), 1);
const acceptedState = evolveHandoff(offeredState, acceptedEvent(), 2);
const resultReturnedState = evolveHandoff(
  acceptedState,
  resultReturnedEvent(),
  3,
);
const verifiedState = evolveHandoff(resultReturnedState, verifiedEvent(), 4);
const reworkRequestedState = evolveHandoff(
  resultReturnedState,
  {
    event_type: "workfabric.handoff.rework_requested.v1",
    handoff_id: "handoff_01",
    criterion_ids: ["tests-pass"],
    reason: [{ kind: "text", text: "Fix the failing test" }],
    occurred_at: "2026-07-14T04:00:00Z",
  },
  4,
);

function requireAccepted(decision: DomainDecision): HandoffEvent {
  expect(decision).toMatchObject({ kind: "accepted" });
  if (decision.kind !== "accepted") {
    throw new Error(`Expected accepted decision, received ${decision.error.code}`);
  }

  expect(decision.events).toHaveLength(1);
  return decision.events[0]!;
}

function expectRejected(
  decision: DomainDecision,
  code: Extract<DomainDecision, { readonly kind: "rejected" }>[
    "error"
  ]["code"],
): void {
  expect(decision).toMatchObject({
    kind: "rejected",
    error: { code, retryable: false },
  });
}

const acceptCommand: HandoffCommand = {
  kind: "accept",
  handoff_id: "handoff_01",
  actor: recipient,
};
const declineCommand: HandoffCommand = {
  kind: "decline",
  handoff_id: "handoff_01",
  actor: recipient,
};
const cancelCommand: HandoffCommand = {
  kind: "cancel",
  handoff_id: "handoff_01",
  actor: initiator,
  reason: [{ kind: "text", text: "No longer required" }],
};
const statusCommand: HandoffCommand = {
  kind: "report_status",
  handoff_id: "handoff_01",
  actor: recipient,
  status: { execution_status: "completed" },
};
const resultCommand: HandoffCommand = {
  kind: "return_result",
  handoff_id: "handoff_01",
  actor: recipient,
  result: { outcome: "implemented" },
};
const verifyCommand: HandoffCommand = {
  kind: "verify",
  handoff_id: "handoff_01",
  actor: verifier,
  satisfied_criterion_ids: ["tests-pass"],
  summary: [{ kind: "text", text: "Verified" }],
  evidence: [{ evidence_type: "test-report", ref: "report_01" }],
};
const closeCommand: HandoffCommand = {
  kind: "close",
  handoff_id: "handoff_01",
  actor: verifier,
};
const reworkCommand: HandoffCommand = {
  kind: "request_rework",
  handoff_id: "handoff_01",
  actor: verifier,
  criterion_ids: ["tests-pass"],
  reason: [{ kind: "text", text: "Fix the failing test" }],
};

describe("Handoff lifecycle decisions", () => {
  const transitionCases: readonly {
    readonly label: string;
    readonly state: HandoffState | null;
    readonly command: HandoffCommand;
    readonly context: HandoffDecisionContext;
    readonly eventType: HandoffEvent["event_type"];
    readonly eventPayload: Readonly<Record<string, unknown>>;
    readonly nextState: HandoffLifecycleState;
  }[] = [
    {
      label: "offer: missing -> offered",
      state: null,
      command: {
        kind: "offer",
        handoff_id: "handoff_01",
        thread_id: "thread_01",
        actor: initiator,
        package: handoffPackage,
        parent_handoff_id: null,
      },
      context: allowedContext,
      eventType: "workfabric.handoff.offered.v1",
      eventPayload: {
        thread_id: "thread_01",
        initiator,
        package: handoffPackage,
        parent_handoff_id: null,
      },
      nextState: "offered",
    },
    {
      label: "accept: offered -> accepted",
      state: offeredState,
      command: acceptCommand,
      context: allowedContext,
      eventType: "workfabric.handoff.accepted.v1",
      eventPayload: { recipient },
      nextState: "accepted",
    },
    {
      label: "accept: rework_requested -> accepted",
      state: reworkRequestedState,
      command: acceptCommand,
      context: allowedContext,
      eventType: "workfabric.handoff.accepted.v1",
      eventPayload: { recipient },
      nextState: "accepted",
    },
    {
      label: "decline: offered -> declined",
      state: offeredState,
      command: declineCommand,
      context: allowedContext,
      eventType: "workfabric.handoff.declined.v1",
      eventPayload: {},
      nextState: "declined",
    },
    {
      label: "expire: offered -> expired",
      state: offeredState,
      command: {
        kind: "expire",
        handoff_id: "handoff_01",
        actor: initiator,
      },
      context: { ...allowedContext, now: handoffPackage.accept_by },
      eventType: "workfabric.handoff.expired.v1",
      eventPayload: {},
      nextState: "expired",
    },
    {
      label: "cancel: offered -> cancelled",
      state: offeredState,
      command: cancelCommand,
      context: allowedContext,
      eventType: "workfabric.handoff.cancelled.v1",
      eventPayload: { reason: cancelCommand.reason },
      nextState: "cancelled",
    },
    {
      label: "cancel: accepted -> cancelled",
      state: acceptedState,
      command: cancelCommand,
      context: allowedContext,
      eventType: "workfabric.handoff.cancelled.v1",
      eventPayload: { reason: cancelCommand.reason },
      nextState: "cancelled",
    },
    {
      label: "report_status: accepted -> accepted",
      state: acceptedState,
      command: statusCommand,
      context: allowedContext,
      eventType: "workfabric.handoff.status_reported.v1",
      eventPayload: { status: statusCommand.status },
      nextState: "accepted",
    },
    {
      label: "return_result: accepted -> result_returned",
      state: acceptedState,
      command: resultCommand,
      context: allowedContext,
      eventType: "workfabric.handoff.result_returned.v1",
      eventPayload: { result: resultCommand.result },
      nextState: "result_returned",
    },
    {
      label: "verify: result_returned -> verified",
      state: resultReturnedState,
      command: verifyCommand,
      context: allowedContext,
      eventType: "workfabric.handoff.verified.v1",
      eventPayload: {
        satisfied_criterion_ids: verifyCommand.satisfied_criterion_ids,
        summary: verifyCommand.summary,
        evidence: verifyCommand.evidence,
      },
      nextState: "verified",
    },
    {
      label: "close: verified -> closed",
      state: verifiedState,
      command: closeCommand,
      context: allowedContext,
      eventType: "workfabric.handoff.closed.v1",
      eventPayload: {},
      nextState: "closed",
    },
    {
      label: "request_rework: result_returned -> rework_requested",
      state: resultReturnedState,
      command: reworkCommand,
      context: allowedContext,
      eventType: "workfabric.handoff.rework_requested.v1",
      eventPayload: {
        criterion_ids: reworkCommand.criterion_ids,
        reason: reworkCommand.reason,
      },
      nextState: "rework_requested",
    },
  ];

  it.each(transitionCases)(
    "$label emits exactly one metadata-free event",
    ({ state, command, context, eventType, eventPayload, nextState }) => {
      const decision = decideHandoff(state, command, context);
      const event = requireAccepted(decision);

      expect(event).toEqual({
        event_type: eventType,
        handoff_id: command.handoff_id,
        occurred_at: context.now,
        ...eventPayload,
      });
      expect(event).not.toHaveProperty("id");
      expect(event).not.toHaveProperty("receipt");
      expect(event).not.toHaveProperty("resource_version");
      expect(event).not.toHaveProperty("partition_id");
      expect(event).not.toHaveProperty("wfsequence");

      const next = evolveHandoff(
        state,
        event,
        state === null ? 1 : state.resource_version + 1,
      );
      expect(next.lifecycle_state).toBe(nextState);
    },
  );

  it("uses the offer Actor as the Initiator", () => {
    const decision = decideHandoff(
      null,
      {
        kind: "offer",
        handoff_id: "handoff_01",
        thread_id: "thread_01",
        actor: initiator,
        package: handoffPackage,
        parent_handoff_id: null,
      },
      allowedContext,
    );

    expect(requireAccepted(decision)).toMatchObject({ initiator });
  });

  it("keeps lifecycle and responsibility unchanged for external status", () => {
    const decision = decideHandoff(acceptedState, statusCommand, allowedContext);

    expect(decision).toMatchObject({ kind: "accepted" });
    expect(
      decision.kind === "accepted"
        ? decision.events[0]?.event_type
        : null,
    ).toBe("workfabric.handoff.status_reported.v1");
    const evolved =
      decision.kind === "accepted"
        ? evolveHandoff(acceptedState, decision.events[0]!, 3)
        : null;
    expect(evolved?.lifecycle_state).toBe("accepted");
    expect(evolved?.current_responsible_actor).toEqual(
      acceptedState.current_responsible_actor,
    );
  });
});

describe("Handoff decision rejections", () => {
  it("rejects a command when the Handoff does not exist", () => {
    expectRejected(
      decideHandoff(null, acceptCommand, allowedContext),
      "not_found",
    );
  });

  it("rejects a command whose Handoff ID does not match loaded state", () => {
    expectRejected(
      decideHandoff(
        offeredState,
        { ...acceptCommand, handoff_id: "handoff_other" },
        allowedContext,
      ),
      "not_found",
    );
  });

  it("rejects a lifecycle command from the wrong state", () => {
    expectRejected(
      decideHandoff(acceptedState, declineCommand, allowedContext),
      "invalid_state_transition",
    );
  });

  it.each([
    [
      "accept",
      offeredState,
      acceptCommand,
      { ...allowedContext, recipient_authorized: false },
    ],
    [
      "decline",
      offeredState,
      declineCommand,
      { ...allowedContext, recipient_authorized: false },
    ],
    [
      "status report",
      acceptedState,
      statusCommand,
      { ...allowedContext, recipient_authorized: false },
    ],
    [
      "verify",
      resultReturnedState,
      verifyCommand,
      { ...allowedContext, verifier_authorized: false },
    ],
    [
      "close",
      verifiedState,
      closeCommand,
      { ...allowedContext, verifier_authorized: false },
    ],
    [
      "rework",
      resultReturnedState,
      reworkCommand,
      { ...allowedContext, verifier_authorized: false },
    ],
  ] satisfies readonly (readonly [
    string,
    HandoffState,
    HandoffCommand,
    HandoffDecisionContext,
  ])[])("rejects unauthorized %s", (_label, state, command, context) => {
    expectRejected(decideHandoff(state, command, context), "permission_denied");
  });

  it.each([
    [offeredState, { ...acceptCommand, actor: otherActor }],
    [offeredState, { ...declineCommand, actor: otherActor }],
    [acceptedState, { ...statusCommand, actor: otherActor }],
    [acceptedState, { ...resultCommand, actor: otherActor }],
    [offeredState, { ...cancelCommand, actor: recipient }],
    [resultReturnedState, { ...verifyCommand, actor: recipient }],
    [verifiedState, { ...closeCommand, actor: recipient }],
    [resultReturnedState, { ...reworkCommand, actor: recipient }],
  ] satisfies readonly (readonly [HandoffState, HandoffCommand])[])(
    "rejects a command from the wrong Actor",
    (state, command) => {
      expectRejected(
        decideHandoff(state, command, allowedContext),
        "permission_denied",
      );
    },
  );

  it("compares both Actor ID and type", () => {
    expectRejected(
      decideHandoff(
        acceptedState,
        {
          ...statusCommand,
          actor: { ...recipient, actor_type: "human" },
        },
        allowedContext,
      ),
      "permission_denied",
    );
  });

  it("rejects acceptance when referenced Context is unavailable", () => {
    expectRejected(
      decideHandoff(offeredState, acceptCommand, {
        ...allowedContext,
        context_available: false,
      }),
      "context_unavailable",
    );
  });

  it("accepts without Context even when no Context can be loaded", () => {
    const state = evolveHandoff(
      null,
      offeredEvent({ package: { ...handoffPackage, context: null } }),
      1,
    );

    requireAccepted(
      decideHandoff(state, acceptCommand, {
        ...allowedContext,
        context_available: false,
      }),
    );
  });

  it("rejects expiry before accept_by", () => {
    expectRejected(
      decideHandoff(
        offeredState,
        {
          kind: "expire",
          handoff_id: "handoff_01",
          actor: initiator,
        },
        { ...allowedContext, now: "2026-07-14T07:59:59Z" },
      ),
      "precondition_failed",
    );
  });

  it.each([
    ["timezone-less", "2026-07-14T07:00:00"],
    ["non-Z offset", "2026-07-14T07:00:00+08:00"],
    ["unparseable", "not-a-timestamp"],
  ])("throws for programmer-invalid %s decision time", (_label, now) => {
    expect(() =>
      decideHandoff(offeredState, acceptCommand, {
        ...allowedContext,
        now,
      }),
    ).toThrow("Invalid decision now timestamp");
  });

  it("throws for a timezone-less accept_by", () => {
    const state = evolveHandoff(
      null,
      offeredEvent({
        package: { ...handoffPackage, accept_by: "2026-07-14T08:00:00" },
      }),
      1,
    );

    expect(() =>
      decideHandoff(
        state,
        {
          kind: "expire",
          handoff_id: "handoff_01",
          actor: initiator,
        },
        allowedContext,
      ),
    ).toThrow("Invalid accept_by timestamp");
  });

  it("throws for a timezone-less Authority Scope expires_at", () => {
    const state = evolveHandoff(
      evolveHandoff(
        null,
        offeredEvent({
          package: {
            ...handoffPackage,
            authority_scope: {
              ...handoffPackage.authority_scope,
              expires_at: "2026-07-15T00:00:00",
            },
          },
        }),
        1,
      ),
      acceptedEvent(),
      2,
    );

    expect(() => decideHandoff(state, resultCommand, allowedContext)).toThrow(
      "Invalid Authority Scope expires_at timestamp",
    );
  });

  it("compares millisecond expiry boundaries exactly", () => {
    const packageWithMillisecondDeadline: HandoffPackage = {
      ...handoffPackage,
      accept_by: "2026-07-14T08:00:00.123Z",
    };
    const state = evolveHandoff(
      null,
      offeredEvent({ package: packageWithMillisecondDeadline }),
      1,
    );
    const command: HandoffCommand = {
      kind: "expire",
      handoff_id: "handoff_01",
      actor: initiator,
    };

    expectRejected(
      decideHandoff(state, command, {
        ...allowedContext,
        now: "2026-07-14T08:00:00.122Z",
      }),
      "precondition_failed",
    );
    requireAccepted(
      decideHandoff(state, command, {
        ...allowedContext,
        now: "2026-07-14T08:00:00.123Z",
      }),
    );
  });

  it("rejects cancellation by policy", () => {
    expectRejected(
      decideHandoff(offeredState, cancelCommand, {
        ...allowedContext,
        policy_allows_cancel: false,
      }),
      "permission_denied",
    );
  });

  it("rejects verification missing any required criterion", () => {
    expectRejected(
      decideHandoff(
        resultReturnedState,
        { ...verifyCommand, satisfied_criterion_ids: ["reviewed"] },
        allowedContext,
      ),
      "precondition_failed",
    );
  });

  it.each([
    ["empty", []],
    ["duplicate", ["tests-pass", "tests-pass"]],
    ["unknown", ["tests-pass", "unknown"]],
  ] satisfies readonly (readonly [string, readonly string[]])[])(
    "rejects %s verification criterion IDs",
    (_label, satisfiedCriterionIds) => {
      expectRejected(
        decideHandoff(
          resultReturnedState,
          {
            ...verifyCommand,
            satisfied_criterion_ids: satisfiedCriterionIds,
          },
          allowedContext,
        ),
        "invalid_argument",
      );
    },
  );

  it.each([
    ["omitted", ["tests-pass"]],
    ["included", ["tests-pass", "reviewed"]],
  ] satisfies readonly (readonly [string, readonly string[]])[])(
    "accepts verification with a known optional criterion %s",
    (_label, satisfiedCriterionIds) => {
      const command: HandoffCommand = {
        ...verifyCommand,
        satisfied_criterion_ids: satisfiedCriterionIds,
      };
      expect(
        requireAccepted(
          decideHandoff(resultReturnedState, command, allowedContext),
        ),
      ).toEqual({
        event_type: "workfabric.handoff.verified.v1",
        handoff_id: "handoff_01",
        satisfied_criterion_ids: satisfiedCriterionIds,
        summary: verifyCommand.summary,
        evidence: verifyCommand.evidence,
        occurred_at: allowedContext.now,
      });
    },
  );

  it("rejects a rework request containing an unknown criterion", () => {
    expectRejected(
      decideHandoff(
        resultReturnedState,
        { ...reworkCommand, criterion_ids: ["unknown"] },
        allowedContext,
      ),
      "invalid_argument",
    );
  });

  it.each([
    ["empty", []],
    ["duplicate", ["tests-pass", "tests-pass"]],
  ] satisfies readonly (readonly [string, readonly string[]])[])(
    "rejects %s rework criterion IDs",
    (_label, criterionIds) => {
      expectRejected(
        decideHandoff(
          resultReturnedState,
          { ...reworkCommand, criterion_ids: criterionIds },
          allowedContext,
        ),
        "invalid_argument",
      );
    },
  );

  it("accepts rework for a known optional criterion and preserves values", () => {
    const command: HandoffCommand = {
      ...reworkCommand,
      criterion_ids: ["reviewed"],
    };

    expect(
      requireAccepted(
        decideHandoff(resultReturnedState, command, allowedContext),
      ),
    ).toEqual({
      event_type: "workfabric.handoff.rework_requested.v1",
      handoff_id: "handoff_01",
      criterion_ids: ["reviewed"],
      reason: reworkCommand.reason,
      occurred_at: allowedContext.now,
    });
  });

  it("rejects a rework request without a reason", () => {
    expectRejected(
      decideHandoff(
        resultReturnedState,
        { ...reworkCommand, reason: [] },
        allowedContext,
      ),
      "precondition_failed",
    );
  });

  it.each([
    [
      "policy result",
      { ...allowedContext, authority_valid: false },
    ],
    [
      "Authority Scope expiry",
      { ...allowedContext, now: handoffPackage.authority_scope.expires_at },
    ],
  ] satisfies readonly (readonly [string, HandoffDecisionContext])[])(
    "rejects return_result for invalid %s",
    (_label, context) => {
      expectRejected(
        decideHandoff(acceptedState, resultCommand, context),
        "expired",
      );
    },
  );

  it.each([
    [
      "closed",
      evolveHandoff(
        verifiedState,
        {
          event_type: "workfabric.handoff.closed.v1",
          handoff_id: "handoff_01",
          occurred_at: "2026-07-14T05:00:00Z",
        },
        5,
      ),
    ],
    [
      "declined",
      evolveHandoff(
        offeredState,
        {
          event_type: "workfabric.handoff.declined.v1",
          handoff_id: "handoff_01",
          occurred_at: "2026-07-14T02:00:00Z",
        },
        2,
      ),
    ],
    [
      "expired",
      evolveHandoff(
        offeredState,
        {
          event_type: "workfabric.handoff.expired.v1",
          handoff_id: "handoff_01",
          occurred_at: "2026-07-14T08:00:00Z",
        },
        2,
      ),
    ],
    [
      "cancelled",
      evolveHandoff(
        offeredState,
        {
          event_type: "workfabric.handoff.cancelled.v1",
          handoff_id: "handoff_01",
          reason: [],
          occurred_at: "2026-07-14T02:00:00Z",
        },
        2,
      ),
    ],
    [
      "transferred",
      evolveHandoff(
        acceptedState,
        {
          event_type: "workfabric.handoff.transferred.v1",
          handoff_id: "handoff_01",
          child_handoff_id: "handoff_child",
          occurred_at: "2026-07-14T03:00:00Z",
        },
        3,
      ),
    ],
  ] satisfies readonly (readonly [string, HandoffState])[])(
    "rejects mutation of terminal state %s",
    (_label, terminalState) => {
      expectRejected(
        decideHandoff(terminalState, closeCommand, allowedContext),
        "invalid_state_transition",
      );
    },
  );

  it("rejects a second offer", () => {
    expectRejected(
      decideHandoff(
        offeredState,
        {
          kind: "offer",
          handoff_id: "handoff_01",
          thread_id: "thread_01",
          actor: initiator,
          package: handoffPackage,
          parent_handoff_id: null,
        },
        allowedContext,
      ),
      "invalid_state_transition",
    );
  });
});
