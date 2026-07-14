import { describe, expect, it } from "vitest";

import type { JsonObject, JsonValue } from "@work-fabric/exchange-spi";

import {
  evolveHandoff,
  handoffEventFromJson,
  handoffEventToJson,
  handoffStateFromJson,
  handoffStateToJson,
  replayHandoff,
  type ActorRef,
  type HandoffEvent,
  type HandoffPackage,
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

const handoffPackage: HandoffPackage = {
  work_reference: {
    system: "github",
    resource_id: "issue_42",
  },
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
    extensions: { policy: "default" },
  },
  acceptance_criteria: [
    {
      criterion_id: "tests-pass",
      description: "All tests pass",
      required: true,
      result_schema_ref: null,
      required_evidence_types: ["test-report"],
      extensions: { suite: "full" },
    },
  ],
  verifier,
  priority: "high",
  accept_by: "2026-07-14T08:00:00Z",
  result_due_at: "2026-07-15T08:00:00Z",
};

const storedAuthorityScope: JsonObject = {
  delegation_id: "delegation_01",
  scopes: ["repo:write"],
  resource_refs: ["repo_01"],
  expires_at: "2026-07-15T00:00:00Z",
  may_redelegate: false,
  extensions: { policy: "default" },
};

const storedAcceptanceCriterion: JsonObject = {
  criterion_id: "tests-pass",
  description: "All tests pass",
  required: true,
  result_schema_ref: null,
  required_evidence_types: ["test-report"],
  extensions: { suite: "full" },
};

const storedHandoffPackage: JsonObject = {
  work_reference: { system: "github", resource_id: "issue_42" },
  target: { actor_id: recipient.actor_id },
  intent: [{ kind: "text", text: "Implement the accepted change" }],
  context: {
    context_id: "context_01",
    version: 3,
    digest: "sha256:abc",
  },
  authority_scope: storedAuthorityScope,
  acceptance_criteria: [storedAcceptanceCriterion],
  verifier: { actor_id: "actor_verifier", actor_type: "system" },
  priority: "high",
  accept_by: "2026-07-14T08:00:00Z",
  result_due_at: "2026-07-15T08:00:00Z",
};

const handoffPackageWithoutExtensions: HandoffPackage = {
  ...handoffPackage,
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
  ],
};

const storedAuthorityScopeWithoutExtensions: JsonObject = {
  delegation_id: "delegation_01",
  scopes: ["repo:write"],
  resource_refs: ["repo_01"],
  expires_at: "2026-07-15T00:00:00Z",
  may_redelegate: false,
};

const storedAcceptanceCriterionWithoutExtensions: JsonObject = {
  criterion_id: "tests-pass",
  description: "All tests pass",
  required: true,
  result_schema_ref: null,
  required_evidence_types: ["test-report"],
};

const storedHandoffPackageWithoutExtensions: JsonObject = {
  ...storedHandoffPackage,
  authority_scope: storedAuthorityScopeWithoutExtensions,
  acceptance_criteria: [storedAcceptanceCriterionWithoutExtensions],
};

function packageWithUndefinedAuthorityExtensions(): JsonObject {
  const authorityScope: JsonObject = {
    ...storedAuthorityScopeWithoutExtensions,
  };
  Reflect.set(authorityScope, "extensions", undefined);
  return {
    ...storedHandoffPackageWithoutExtensions,
    authority_scope: authorityScope,
  };
}

function packageWithUndefinedCriterionExtensions(): JsonObject {
  const criterion: JsonObject = {
    ...storedAcceptanceCriterionWithoutExtensions,
  };
  Reflect.set(criterion, "extensions", undefined);
  return {
    ...storedHandoffPackageWithoutExtensions,
    acceptance_criteria: [criterion],
  };
}

function offered(
  overrides: Partial<Extract<HandoffEvent, { event_type: "workfabric.handoff.offered.v1" }>> = {},
): Extract<HandoffEvent, { event_type: "workfabric.handoff.offered.v1" }> {
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

function accepted(
  overrides: Partial<Extract<HandoffEvent, { event_type: "workfabric.handoff.accepted.v1" }>> = {},
): Extract<HandoffEvent, { event_type: "workfabric.handoff.accepted.v1" }> {
  return {
    event_type: "workfabric.handoff.accepted.v1",
    handoff_id: "handoff_01",
    recipient,
    occurred_at: "2026-07-14T02:00:00Z",
    ...overrides,
  };
}

function resultReturned(
  overrides: Partial<Extract<HandoffEvent, { event_type: "workfabric.handoff.result_returned.v1" }>> = {},
): Extract<HandoffEvent, { event_type: "workfabric.handoff.result_returned.v1" }> {
  return {
    event_type: "workfabric.handoff.result_returned.v1",
    handoff_id: "handoff_01",
    result: { outcome: "implemented", artifact_refs: ["commit_01"] },
    occurred_at: "2026-07-14T03:00:00Z",
    ...overrides,
  };
}

function verified(
  overrides: Partial<Extract<HandoffEvent, { event_type: "workfabric.handoff.verified.v1" }>> = {},
): Extract<HandoffEvent, { event_type: "workfabric.handoff.verified.v1" }> {
  return {
    event_type: "workfabric.handoff.verified.v1",
    handoff_id: "handoff_01",
    satisfied_criterion_ids: ["tests-pass"],
    summary: [{ kind: "text", text: "Verified" }],
    evidence: [{ evidence_type: "test-report", ref: "report_01" }],
    occurred_at: "2026-07-14T04:00:00Z",
    ...overrides,
  };
}

function closed(
  overrides: Partial<Extract<HandoffEvent, { event_type: "workfabric.handoff.closed.v1" }>> = {},
): Extract<HandoffEvent, { event_type: "workfabric.handoff.closed.v1" }> {
  return {
    event_type: "workfabric.handoff.closed.v1",
    handoff_id: "handoff_01",
    occurred_at: "2026-07-14T05:00:00Z",
    ...overrides,
  };
}

function versioned(...events: readonly HandoffEvent[]) {
  return events.map((event, index) => ({
    stream_version: index + 1,
    event,
  }));
}

describe("Handoff event replay", () => {
  it("moves responsibility Initiator -> Recipient -> Verifier -> none on the normal path", () => {
    const offeredState = evolveHandoff(null, offered(), 1);
    expect(offeredState.lifecycle_state).toBe("offered");
    expect(offeredState.current_responsible_actor).toEqual(initiator);

    const acceptedState = evolveHandoff(offeredState, accepted(), 2);
    expect(acceptedState.lifecycle_state).toBe("accepted");
    expect(acceptedState.current_responsible_actor).toEqual(recipient);

    const returnedState = evolveHandoff(acceptedState, resultReturned(), 3);
    expect(returnedState.lifecycle_state).toBe("result_returned");
    expect(returnedState.current_responsible_actor).toEqual(verifier);

    const verifiedState = evolveHandoff(returnedState, verified(), 4);
    expect(verifiedState.lifecycle_state).toBe("verified");
    expect(verifiedState.current_responsible_actor).toEqual(verifier);

    const closedState = evolveHandoff(verifiedState, closed(), 5);
    expect(closedState.lifecycle_state).toBe("closed");
    expect(closedState.current_responsible_actor).toBeNull();
    expect(closedState.resource_version).toBe(5);
    expect(closedState.updated_at).toBe("2026-07-14T05:00:00Z");
  });

  it.each([
    [
      "declined",
      {
        event_type: "workfabric.handoff.declined.v1",
        handoff_id: "handoff_01",
        occurred_at: "2026-07-14T02:00:00Z",
      } satisfies HandoffEvent,
    ],
    [
      "expired",
      {
        event_type: "workfabric.handoff.expired.v1",
        handoff_id: "handoff_01",
        occurred_at: "2026-07-14T02:00:00Z",
      } satisfies HandoffEvent,
    ],
  ])("replays offered -> %s", (expected, terminalEvent) => {
    const state = replayHandoff(versioned(offered(), terminalEvent));
    expect(state?.lifecycle_state).toBe(expected);
    expect(state?.current_responsible_actor).toBeNull();
  });

  it("replays accepted -> cancelled", () => {
    const cancelled: HandoffEvent = {
      event_type: "workfabric.handoff.cancelled.v1",
      handoff_id: "handoff_01",
      reason: [{ kind: "text", text: "No longer required" }],
      occurred_at: "2026-07-14T03:00:00Z",
    };
    const state = replayHandoff(versioned(offered(), accepted(), cancelled));
    expect(state?.lifecycle_state).toBe("cancelled");
    expect(state?.current_responsible_actor).toBeNull();
  });

  it("replays result_returned -> rework_requested -> accepted", () => {
    const reworkRequested: HandoffEvent = {
      event_type: "workfabric.handoff.rework_requested.v1",
      handoff_id: "handoff_01",
      criterion_ids: ["tests-pass"],
      reason: [{ kind: "text", text: "Fix the failing test" }],
      occurred_at: "2026-07-14T04:00:00Z",
    };
    const reworkState = replayHandoff(
      versioned(offered(), accepted(), resultReturned(), reworkRequested),
    );
    expect(reworkState?.lifecycle_state).toBe("rework_requested");
    expect(reworkState?.current_responsible_actor).toEqual(verifier);

    const acceptedAgain = evolveHandoff(
      reworkState ?? null,
      accepted({ occurred_at: "2026-07-14T05:00:00Z" }),
      5,
    );
    expect(acceptedAgain.lifecycle_state).toBe("accepted");
    expect(acceptedAgain.current_responsible_actor).toEqual(recipient);
  });

  it("status_reported updates only version and updated_at", () => {
    const beforeStatus = replayHandoff(versioned(offered(), accepted()));
    const status: HandoffEvent = {
      event_type: "workfabric.handoff.status_reported.v1",
      handoff_id: "handoff_01",
      status: {
        execution_status: "in_progress",
        observed_at: "2026-07-14T02:30:00Z",
      },
      occurred_at: "2026-07-14T02:31:00Z",
    };
    const afterStatus = evolveHandoff(beforeStatus, status, 3);

    expect(afterStatus).toEqual({
      ...beforeStatus,
      resource_version: 3,
      updated_at: "2026-07-14T02:31:00Z",
    });
    expect(afterStatus.lifecycle_state).toBe("accepted");
    expect(afterStatus.current_responsible_actor).toEqual(recipient);
    expect("latest_status" in afterStatus).toBe(false);
  });

  it("replays the same events deterministically", () => {
    const events = versioned(
      offered(),
      accepted(),
      resultReturned(),
      verified(),
      closed(),
    );

    expect(replayHandoff(events)).toEqual(replayHandoff(events));
  });

  it("records a child relation only when accepted responsibility is transferred", () => {
    const transferred: HandoffEvent = {
      event_type: "workfabric.handoff.transferred.v1",
      handoff_id: "handoff_01",
      child_handoff_id: "handoff_child",
      occurred_at: "2026-07-14T03:00:00Z",
    };
    const state = replayHandoff(versioned(offered(), accepted(), transferred));

    expect(state?.lifecycle_state).toBe("transferred");
    expect(state?.child_handoff_id).toBe("handoff_child");
    expect(state?.current_responsible_actor).toBeNull();
  });
});

describe("Handoff replay guards", () => {
  it("returns null for an empty stream", () => {
    expect(replayHandoff([])).toBeNull();
  });

  it("rejects an event before offered", () => {
    expect(() => replayHandoff(versioned(accepted()))).toThrow();
  });

  it("rejects an event after a terminal state", () => {
    const declined: HandoffEvent = {
      event_type: "workfabric.handoff.declined.v1",
      handoff_id: "handoff_01",
      occurred_at: "2026-07-14T02:00:00Z",
    };
    expect(() =>
      replayHandoff(versioned(offered(), declined, accepted())),
    ).toThrow();
  });

  it("rejects a stream version gap", () => {
    expect(() =>
      replayHandoff([
        { stream_version: 1, event: offered() },
        { stream_version: 3, event: accepted() },
      ]),
    ).toThrow();
  });

  it.each([0, -1, 1.5])("rejects invalid stream version %s", (streamVersion) => {
    expect(() => evolveHandoff(null, offered(), streamVersion)).toThrow();
  });

  it("rejects a Handoff ID mismatch", () => {
    const state = evolveHandoff(null, offered(), 1);
    expect(() =>
      evolveHandoff(
        state,
        accepted({ handoff_id: "handoff_other" }),
        2,
      ),
    ).toThrow();
  });

  it.each([
    {
      event_type: "workfabric.handoff.closed.v1",
      handoff_id: "handoff_01",
      occurred_at: "2026-07-14T02:00:00Z",
    },
    {
      event_type: "workfabric.handoff.verified.v1",
      handoff_id: "handoff_01",
      satisfied_criterion_ids: ["tests-pass"],
      summary: [],
      evidence: [],
      occurred_at: "2026-07-14T02:00:00Z",
    },
    {
      event_type: "workfabric.handoff.result_returned.v1",
      handoff_id: "handoff_01",
      result: {},
      occurred_at: "2026-07-14T02:00:00Z",
    },
  ] satisfies readonly HandoffEvent[])(
    "rejects incompatible $event_type from offered",
    (event) => {
      const state = evolveHandoff(null, offered(), 1);
      expect(() => evolveHandoff(state, event, 2)).toThrow();
    },
  );
});

describe("Handoff stored JSON boundary", () => {
  const allEvents: readonly HandoffEvent[] = [
    offered(),
    accepted(),
    {
      event_type: "workfabric.handoff.declined.v1",
      handoff_id: "handoff_01",
      occurred_at: "2026-07-14T02:00:00Z",
    },
    {
      event_type: "workfabric.handoff.expired.v1",
      handoff_id: "handoff_01",
      occurred_at: "2026-07-14T02:00:00Z",
    },
    {
      event_type: "workfabric.handoff.cancelled.v1",
      handoff_id: "handoff_01",
      reason: [{ kind: "text", text: "Cancelled" }],
      occurred_at: "2026-07-14T03:00:00Z",
    },
    {
      event_type: "workfabric.handoff.status_reported.v1",
      handoff_id: "handoff_01",
      status: { execution_status: "waiting" },
      occurred_at: "2026-07-14T03:00:00Z",
    },
    resultReturned(),
    verified(),
    closed(),
    {
      event_type: "workfabric.handoff.rework_requested.v1",
      handoff_id: "handoff_01",
      criterion_ids: ["tests-pass"],
      reason: [{ kind: "text", text: "Rework" }],
      occurred_at: "2026-07-14T04:00:00Z",
    },
    {
      event_type: "workfabric.handoff.transferred.v1",
      handoff_id: "handoff_01",
      child_handoff_id: "handoff_child",
      occurred_at: "2026-07-14T03:00:00Z",
    },
  ];

  it("round-trips a Handoff state without treating stored JSON as domain state", () => {
    const state = replayHandoff(versioned(offered(), accepted()));
    expect(state).not.toBeNull();
    if (state === null) throw new Error("Expected replayed state");

    const stored: JsonObject = handoffStateToJson(state);
    const decoded = handoffStateFromJson(stored);

    expect(decoded).toEqual(state);
    expect(decoded).not.toBe(state);
    expect(decoded.package).not.toBe(state.package);
  });

  it.each(allEvents)("round-trips $event_type", (event) => {
    const stored: JsonObject = handoffEventToJson(event);
    const decoded = handoffEventFromJson(stored);

    expect(decoded).toEqual(event);
    expect(decoded).not.toBe(event);
  });

  it.each([
    ["handoff_id", null],
    ["thread_id", 7],
    ["resource_version", 0],
    ["resource_version", 1.5],
    ["lifecycle_state", "unknown"],
    ["initiator", { actor_id: "actor" }],
    ["recipient", "actor_recipient"],
    ["current_responsible_actor", {}],
    ["result", []],
    ["parent_handoff_id", 2],
    ["child_handoff_id", false],
    ["created_at", null],
    ["updated_at", []],
  ] satisfies readonly (readonly [string, JsonObject[string]])[])(
    "rejects corrupt stored state field %s",
    (field, corruptValue) => {
      const state = evolveHandoff(null, offered(), 1);
      const stored: JsonObject = {
        ...handoffStateToJson(state),
        [field]: corruptValue,
      };

      expect(() => handoffStateFromJson(stored)).toThrow(
        `Invalid stored Handoff state: ${field}`,
      );
    },
  );

  it.each([
    ["package.target", { ...storedHandoffPackage, target: {} }],
    [
      "package.context.version",
      {
        ...storedHandoffPackage,
        context: { context_id: "context_01", version: 0, digest: null },
      },
    ],
    [
      "package.authority_scope.scopes",
      {
        ...storedHandoffPackage,
        authority_scope: {
          ...storedAuthorityScope,
          scopes: [1],
        },
      },
    ],
    [
      "package.acceptance_criteria[0].required",
      {
        ...storedHandoffPackage,
        acceptance_criteria: [
          { ...storedAcceptanceCriterion, required: "yes" },
        ],
      },
    ],
    [
      "package.verifier.actor_type",
      {
        ...storedHandoffPackage,
        verifier: { actor_id: "actor_verifier", actor_type: "robot" },
      },
    ],
    ["package.priority", { ...storedHandoffPackage, priority: "urgent" }],
  ] satisfies readonly (readonly [string, JsonObject])[])(
    "rejects corrupt stored state nested field %s",
    (field, corruptPackage) => {
      const state = evolveHandoff(null, offered(), 1);
      const stored: JsonObject = {
        ...handoffStateToJson(state),
        package: corruptPackage,
      };

      expect(() => handoffStateFromJson(stored)).toThrow(
        `Invalid stored Handoff state: ${field}`,
      );
    },
  );

  it.each([
    ["event_type", { ...handoffEventToJson(offered()), event_type: "unknown" }],
    ["handoff_id", { ...handoffEventToJson(accepted()), handoff_id: null }],
    ["occurred_at", { ...handoffEventToJson(closed()), occurred_at: 7 }],
    ["recipient.actor_type", {
      ...handoffEventToJson(accepted()),
      recipient: { actor_id: "actor_recipient" },
    }],
    ["status", {
      event_type: "workfabric.handoff.status_reported.v1",
      handoff_id: "handoff_01",
      status: [],
      occurred_at: "2026-07-14T03:00:00Z",
    }],
    ["satisfied_criterion_ids", { ...handoffEventToJson(verified()), satisfied_criterion_ids: [1] }],
    ["child_handoff_id", {
      event_type: "workfabric.handoff.transferred.v1",
      handoff_id: "handoff_01",
      child_handoff_id: null,
      occurred_at: "2026-07-14T03:00:00Z",
    }],
  ] satisfies readonly (readonly [string, JsonObject])[])(
    "rejects corrupt stored event field %s",
    (field, stored) => {
      expect(() => handoffEventFromJson(stored)).toThrow(
        `Invalid stored Handoff event: ${field}`,
      );
    },
  );

  it("rejects a non-JSON object with the stored-event corruption prefix", () => {
    const stored = handoffEventToJson({
      event_type: "workfabric.handoff.status_reported.v1",
      handoff_id: "handoff_01",
      status: {},
      occurred_at: "2026-07-14T03:00:00Z",
    });
    Reflect.set(stored, "status", new Date("2026-07-14T03:00:00Z"));

    expect(() => handoffEventFromJson(stored)).toThrow(
      "Invalid stored Handoff event: status",
    );
  });

  it("rejects cyclic JSON with the stored-event corruption prefix", () => {
    const cyclicStatus: JsonObject = {};
    Reflect.set(cyclicStatus, "self", cyclicStatus);
    const stored = handoffEventToJson({
      event_type: "workfabric.handoff.status_reported.v1",
      handoff_id: "handoff_01",
      status: {},
      occurred_at: "2026-07-14T03:00:00Z",
    });
    Reflect.set(stored, "status", cyclicStatus);

    expect(() => handoffEventFromJson(stored)).toThrow(
      "Invalid stored Handoff event: status",
    );
  });

  it("rejects sparse status.values in deep JSON", () => {
    const sparseValues: JsonValue[] = [];
    sparseValues.length = 1;
    const stored = handoffEventToJson({
      event_type: "workfabric.handoff.status_reported.v1",
      handoff_id: "handoff_01",
      status: { values: sparseValues },
      occurred_at: "2026-07-14T03:00:00Z",
    });

    expect(() => handoffEventFromJson(stored)).toThrow(
      "Invalid stored Handoff event: status",
    );
  });

  it("rejects sparse satisfied_criterion_ids", () => {
    const sparseCriterionIds: string[] = [];
    sparseCriterionIds.length = 1;
    const stored: JsonObject = {
      ...handoffEventToJson(verified()),
      satisfied_criterion_ids: sparseCriterionIds,
    };

    expect(() => handoffEventFromJson(stored)).toThrow(
      "Invalid stored Handoff event: satisfied_criterion_ids[0]",
    );
  });

  it("rejects sparse evidence", () => {
    const sparseEvidence: JsonObject[] = [];
    sparseEvidence.length = 1;
    const stored: JsonObject = {
      ...handoffEventToJson(verified()),
      evidence: sparseEvidence,
    };

    expect(() => handoffEventFromJson(stored)).toThrow(
      "Invalid stored Handoff event: evidence[0]",
    );
  });

  it.each([
    [
      "AuthorityScope",
      packageWithUndefinedAuthorityExtensions(),
      "package.authority_scope.extensions",
    ],
    [
      "AcceptanceCriterion",
      packageWithUndefinedCriterionExtensions(),
      "package.acceptance_criteria[0].extensions",
    ],
  ] satisfies readonly (readonly [string, JsonObject, string])[])(
    "distinguishes absent from present-undefined %s extensions at the State boundary",
    (_label, corruptPackage, corruptField) => {
      const state = evolveHandoff(
        null,
        offered({ package: handoffPackageWithoutExtensions }),
        1,
      );
      expect(handoffStateFromJson(handoffStateToJson(state))).toEqual(state);

      const stored: JsonObject = {
        ...handoffStateToJson(state),
        package: corruptPackage,
      };
      expect(() => handoffStateFromJson(stored)).toThrow(
        `Invalid stored Handoff state: ${corruptField}`,
      );
    },
  );

  it.each([
    [
      "AuthorityScope",
      packageWithUndefinedAuthorityExtensions(),
      "package.authority_scope.extensions",
    ],
    [
      "AcceptanceCriterion",
      packageWithUndefinedCriterionExtensions(),
      "package.acceptance_criteria[0].extensions",
    ],
  ] satisfies readonly (readonly [string, JsonObject, string])[])(
    "distinguishes absent from present-undefined %s extensions at the Event Package boundary",
    (_label, corruptPackage, corruptField) => {
      const event = offered({ package: handoffPackageWithoutExtensions });
      expect(handoffEventFromJson(handoffEventToJson(event))).toEqual(event);

      const stored: JsonObject = {
        ...handoffEventToJson(event),
        package: corruptPackage,
      };
      expect(() => handoffEventFromJson(stored)).toThrow(
        `Invalid stored Handoff event: ${corruptField}`,
      );
    },
  );

  it.each([
    [
      "state",
      "Invalid stored Handoff state: unexpected",
      {
        ...handoffStateToJson(evolveHandoff(null, offered(), 1)),
        unexpected: true,
      },
    ],
    [
      "package",
      "Invalid stored Handoff state: package.unexpected",
      {
        ...handoffStateToJson(evolveHandoff(null, offered(), 1)),
        package: { ...storedHandoffPackage, unexpected: true },
      },
    ],
  ] satisfies readonly (readonly [string, string, JsonObject])[])(
    "rejects an unknown stored %s field",
    (_label, expectedError, stored) => {
      expect(() => handoffStateFromJson(stored)).toThrow(expectedError);
    },
  );

  it.each([
    [
      "event",
      "Invalid stored Handoff event: unexpected",
      { ...handoffEventToJson(accepted()), unexpected: true },
    ],
    [
      "Actor",
      "Invalid stored Handoff event: recipient.unexpected",
      {
        ...handoffEventToJson(accepted()),
        recipient: {
          actor_id: "actor_recipient",
          actor_type: "agent",
          unexpected: true,
        },
      },
    ],
  ] satisfies readonly (readonly [string, string, JsonObject])[])(
    "rejects an unknown stored %s field",
    (_label, expectedError, stored) => {
      expect(() => handoffEventFromJson(stored)).toThrow(expectedError);
    },
  );
});
