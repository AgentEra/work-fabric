import { beforeAll, describe, expect, it } from "vitest";

import type {
  ContextReference,
  JsonObject,
  JsonValue,
  ProposedEvent,
} from "@work-fabric/exchange-spi";
import {
  loadWfppSchemaValidator,
  type WfppSchemaValidator,
} from "@work-fabric/protocol-runtime";

import {
  canonicalJson,
  decodeHandoffCommand,
  decodeHandoffTransfer,
  encodeHandoffEvents,
  evolveHandoff,
  handoffEventToJson,
  idempotencyDigest,
  idempotencyMaterial,
  type ActorRef,
  type CommandEnvelope,
  type EncodeHandoffEventsInput,
  type HandoffEvent,
  type HandoffLifecycleState,
  type HandoffState,
} from "../src/index.js";

const actor: ActorRef = {
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
const contextReference: ContextReference = {
  context_id: "context_01",
  version: 3,
  digest: "sha256:abc",
};

const offerPayload: JsonObject = {
  work_reference: {
    uri: "urn:work:item:42",
    extensions: {},
  },
  target: { actor_id: recipient.actor_id },
  intent: [
    {
      kind: "text",
      media_type: "text/plain",
      text: "Implement the approved change",
    },
  ],
  context_bundle: {
    context_id: "context_01",
    version: 3,
    created_at: "2026-07-14T00:30:00Z",
    items: [{ kind: "text", media_type: "text/plain", text: "Large context" }],
    visibility_scope: {
      actor_ids: [recipient.actor_id],
      endpoint_ids: ["endpoint_recipient"],
      expires_at: "2026-07-15T00:00:00Z",
    },
    digest: "sha256:abc",
    extensions: {},
  },
  authority_scope: {
    delegation_id: "delegation_01",
    scopes: ["work:read"],
    resource_refs: ["urn:work:item:42"],
    expires_at: "2026-07-15T00:00:00Z",
    may_redelegate: false,
    extensions: { policy: "default" },
  },
  acceptance_criteria: [
    {
      criterion_id: "tests-pass",
      description: "Tests pass",
      required: true,
      result_schema_ref: null,
      required_evidence_types: ["test_report"],
      extensions: { suite: "full" },
    },
  ],
  verifier: {
    actor_id: verifier.actor_id,
    actor_type: verifier.actor_type,
  },
  priority: "normal",
  accept_by: "2026-07-14T09:00:00Z",
  result_due_at: "2026-07-15T08:00:00Z",
};

function envelope(
  messageType = "workfabric.handoff.offer.v1",
  payload: JsonObject = offerPayload,
  overrides: Partial<CommandEnvelope> = {},
): CommandEnvelope {
  return {
    spec_version: "1.0",
    message_id: "message_01",
    message_type: messageType,
    sent_at: "2026-07-14T01:00:00Z",
    tenant_id: "tenant_01",
    exchange_id: "exchange_01",
    actor_id: actor.actor_id,
    endpoint_id: "endpoint_initiator",
    delegation_id: "delegation_01",
    correlation_id: "correlation_01",
    causation_id: "causation_01",
    idempotency_key: "command-01",
    expected_version: 1,
    payload,
    ...overrides,
  };
}

describe("canonical idempotency material", () => {
  it("recursively sorts object keys while preserving array order", () => {
    expect(
      canonicalJson({
        b: 2,
        list: [{ z: 1, y: 2 }, 0],
        a: { d: 4, c: 3 },
      }),
    ).toBe('{"a":{"c":3,"d":4},"b":2,"list":[{"y":2,"z":1},0]}');
  });

  it("excludes transport metadata from material and digest", () => {
    const first = envelope();
    const second = {
      ...first,
      message_id: "message_retry",
      sent_at: "2026-07-14T02:00:00Z",
      correlation_id: "correlation_retry",
      causation_id: "causation_retry",
      trace_context: { traceparent: "00-a-b-01" },
    };

    expect(idempotencyMaterial(first)).toEqual({
      tenant_id: "tenant_01",
      exchange_id: "exchange_01",
      actor_id: "actor_initiator",
      endpoint_id: "endpoint_initiator",
      delegation_id: "delegation_01",
      message_type: "workfabric.handoff.offer.v1",
      expected_version: 1,
      payload: offerPayload,
    });
    expect(idempotencyMaterial(second)).toEqual(idempotencyMaterial(first));
    expect(idempotencyDigest(second)).toBe(idempotencyDigest(first));
    expect(idempotencyDigest(first)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it.each([
    ["Actor", { actor_id: "actor_other" }],
    ["Endpoint", { endpoint_id: "endpoint_other" }],
    ["Delegation", { delegation_id: "delegation_other" }],
    ["expected version", { expected_version: 2 }],
    ["message type", { message_type: "workfabric.handoff.accept.v1" }],
    ["Payload", { payload: { ...offerPayload, priority: "high" } }],
  ] satisfies readonly [string, Partial<CommandEnvelope>][]) (
    "changes the digest when %s changes",
    (_label, overrides) => {
      expect(idempotencyDigest(envelope(undefined, undefined, overrides))).not.toBe(
        idempotencyDigest(envelope()),
      );
    },
  );

  it("uses explicit nulls for omitted Delegation and expected version", () => {
    const {
      delegation_id: _delegationId,
      expected_version: _expectedVersion,
      ...value
    } = envelope();
    expect(idempotencyMaterial(value)).toMatchObject({
      delegation_id: null,
      expected_version: null,
    });
  });

  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["bigint", 1n],
    ["function", () => undefined],
    ["symbol", Symbol("value")],
    ["Date", new Date("2026-07-14T01:00:00Z")],
  ])("rejects non-JSON %s values", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(/valid JSON value/);
  });

  it("rejects cycles, sparse arrays, symbol keys, and nested invalid values", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const sparse: unknown[] = [];
    sparse.length = 1;
    const symbolKey = { value: 1 };
    Reflect.set(symbolKey, Symbol("hidden"), 2);

    expect(() => canonicalJson(cycle)).toThrow(/cyclic/);
    expect(() => canonicalJson(sparse)).toThrow(/sparse/);
    expect(() => canonicalJson(symbolKey)).toThrow(/valid JSON value/);
    expect(() => canonicalJson({ nested: undefined })).toThrow(
      /valid JSON value/,
    );
  });

  it("rejects non-element own properties on arrays", () => {
    const value: unknown[] = [];
    Reflect.set(value, "4294967295", "not an array element");

    expect(() => canonicalJson(value)).toThrow(/valid JSON value/);
  });

  it("rejects array accessors without executing nondeterministic getters", () => {
    let arrayGetterCalls = 0;
    const values: JsonValue[] = [null];
    Object.defineProperty(values, "0", {
      enumerable: true,
      get: () => {
        arrayGetterCalls += 1;
        return arrayGetterCalls;
      },
    });
    const command = envelope(undefined, { values });

    expect(() => canonicalJson(values)).toThrow(/valid JSON value/);
    expect(() => idempotencyDigest(command)).toThrow(/valid JSON value/);
    expect(() => idempotencyDigest(command)).toThrow(/valid JSON value/);
    expect(arrayGetterCalls).toBe(0);

    let objectGetterCalls = 0;
    const objectAccessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        objectGetterCalls += 1;
        return objectGetterCalls;
      },
    });
    expect(() => canonicalJson(objectAccessor)).toThrow(/valid JSON value/);
    expect(objectGetterCalls).toBe(0);
  });
});

describe("Handoff Command decoding", () => {
  it("uses generated IDs and repository ContextReference for Offer", () => {
    const { expected_version: _expectedVersion, ...offerEnvelope } = envelope();
    expect(
      decodeHandoffCommand(
        offerEnvelope,
        actor,
        "handoff_generated",
        contextReference,
      ),
    ).toEqual({
      kind: "offer",
      handoff_id: "handoff_generated",
      thread_id: "handoff_generated",
      actor,
      package: {
        work_reference: offerPayload.work_reference,
        target: offerPayload.target,
        intent: offerPayload.intent,
        context: contextReference,
        authority_scope: offerPayload.authority_scope,
        acceptance_criteria: offerPayload.acceptance_criteria,
        verifier,
        priority: "normal",
        accept_by: "2026-07-14T09:00:00Z",
        result_due_at: "2026-07-15T08:00:00Z",
      },
      parent_handoff_id: null,
    });
  });

  it("honors an explicit Offer thread ID", () => {
    const payload = { ...offerPayload, thread_id: "thread_existing" };
    expect(
      decodeHandoffCommand(
        envelope("workfabric.handoff.offer.v1", payload),
        actor,
        "handoff_generated",
        null,
      ),
    ).toMatchObject({ thread_id: "thread_existing" });
  });

  it("decodes target resolution with resolver transport identity", () => {
    expect(
      decodeHandoffCommand(
        envelope(
          "workfabric.handoff.resolve_target.v1",
          {
            handoff_id: "handoff_01",
            resolved_target: { endpoint_id: "endpoint_worker" },
            evidence: [{ evidence_type: "capability_attestation" }],
          },
          { endpoint_id: "endpoint_resolver", delegation_id: "delegation_02" },
        ),
        actor,
        "handoff_generated",
        null,
      ),
    ).toEqual({
      kind: "resolve_target",
      handoff_id: "handoff_01",
      actor,
      resolver_endpoint_id: "endpoint_resolver",
      delegation_id: "delegation_02",
      resolved_target: { endpoint_id: "endpoint_worker" },
      evidence: [{ evidence_type: "capability_attestation" }],
    });
  });

  it("decodes a terminal target-unavailable report", () => {
    const withDelegation = envelope(
      "workfabric.handoff.report_target_unavailable.v1",
      {
        handoff_id: "handoff_01",
        reason_code: "no_eligible_target",
        reason: [{ kind: "text", text: "No eligible target" }],
        evidence: [],
      },
      { endpoint_id: "endpoint_resolver" },
    );
    const { delegation_id: _delegationId, ...withoutDelegation } = withDelegation;
    expect(
      decodeHandoffCommand(
        withoutDelegation,
        actor,
        "handoff_generated",
        null,
      ),
    ).toEqual({
      kind: "report_target_unavailable",
      handoff_id: "handoff_01",
      actor,
      resolver_endpoint_id: "endpoint_resolver",
      delegation_id: null,
      reason_code: "no_eligible_target",
      reason: [{ kind: "text", text: "No eligible target" }],
      evidence: [],
    });
  });

  it.each([
    ["accept", { handoff_id: "handoff_01" }, {}],
    ["decline", { handoff_id: "handoff_01" }, {}],
    ["expire", { handoff_id: "handoff_01" }, {}],
    ["cancel", { handoff_id: "handoff_01", reason: [] }, { reason: [] }],
    [
      "report_status",
      { handoff_id: "handoff_01", status: { execution_status: "in_progress" } },
      { status: { execution_status: "in_progress" } },
    ],
    [
      "return_result",
      { handoff_id: "handoff_01", result: { summary: [] } },
      { result: { summary: [] } },
    ],
    [
      "verify",
      {
        handoff_id: "handoff_01",
        satisfied_criterion_ids: ["tests-pass"],
        summary: [{ kind: "text", text: "Verified" }],
        evidence: [],
      },
      {
        satisfied_criterion_ids: ["tests-pass"],
        summary: [{ kind: "text", text: "Verified" }],
        evidence: [],
      },
    ],
    ["close", { handoff_id: "handoff_01" }, {}],
    [
      "request_rework",
      {
        handoff_id: "handoff_01",
        criterion_ids: ["tests-pass"],
        reason: [{ kind: "text", text: "Fix tests" }],
      },
      {
        criterion_ids: ["tests-pass"],
        reason: [{ kind: "text", text: "Fix tests" }],
      },
    ],
  ] satisfies readonly [string, JsonObject, Readonly<Record<string, unknown>>][]) (
    "decodes the existing-resource %s command using the Payload Handoff ID",
    (kind, payload, extra) => {
      const messageType = `workfabric.handoff.${kind}.v1`;
      expect(
        decodeHandoffCommand(
          envelope(messageType, payload),
          actor,
          "handoff_generated",
          null,
        ),
      ).toEqual({ kind, handoff_id: "handoff_01", actor, ...extra });
    },
  );

  it.each([
    "workfabric.handoff.transfer.v1",
    "workfabric.handoff.child_accepted.v1",
    "workfabric.handoff.unknown.v1",
  ])("rejects non-single-stream message type %s", (messageType) => {
    expect(() =>
      decodeHandoffCommand(
        envelope(messageType, { handoff_id: "handoff_01" }),
        actor,
        "handoff_generated",
        null,
      ),
    ).toThrow(/Unsupported single-stream Handoff message_type/);
  });
});

describe("Handoff Transfer decoding", () => {
  it("decodes only the validated public Transfer with generated child identity", () => {
    const transferActor: ActorRef = {
      actor_id: "actor_parent_recipient",
      actor_type: "agent",
    };
    const childOffer: JsonObject = {
      ...offerPayload,
      target: { actor_id: "actor_child_recipient" },
    };

    expect(
      decodeHandoffTransfer(
        envelope("workfabric.handoff.transfer.v1", {
          parent_handoff_id: "handoff_parent",
          child_offer: childOffer,
        }),
        transferActor,
        "handoff_generated_child",
        contextReference,
      ),
    ).toEqual({
      parent_handoff_id: "handoff_parent",
      child_handoff_id: "handoff_generated_child",
      actor: transferActor,
      child_package: {
        work_reference: childOffer.work_reference,
        target: childOffer.target,
        intent: childOffer.intent,
        context: contextReference,
        authority_scope: childOffer.authority_scope,
        acceptance_criteria: childOffer.acceptance_criteria,
        verifier,
        priority: "normal",
        accept_by: "2026-07-14T09:00:00Z",
        result_due_at: "2026-07-15T08:00:00Z",
      },
    });
  });

  it("rejects every non-Transfer message type", () => {
    expect(() =>
      decodeHandoffTransfer(
        envelope("workfabric.handoff.offer.v1", offerPayload),
        actor,
        "handoff_generated_child",
        null,
      ),
    ).toThrow(/Unsupported Handoff Transfer message_type/);
  });
});

function eventEnvelope(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return envelope(
    "workfabric.handoff.accept.v1",
    { handoff_id: "handoff_01" },
    {
      actor_id: recipient.actor_id,
      endpoint_id: "endpoint_recipient",
      idempotency_key: "accept-01",
      ...overrides,
    },
  );
}

function encodingInput(
  events: readonly HandoffEvent[],
  overrides: Partial<EncodeHandoffEventsInput> = {},
): EncodeHandoffEventsInput {
  const currentState = evolveHandoff(null, offeredEvent(), 1);
  return {
    current_state: currentState,
    events,
    current_stream_version: currentState.resource_version,
    envelope: eventEnvelope(),
    event_ids: events.map((_event, index) => `event_${index + 1}`),
    receipt_ids: events.map((event, index) =>
      [
        "workfabric.handoff.accepted.v1",
        "workfabric.handoff.result_returned.v1",
        "workfabric.handoff.verified.v1",
      ].includes(event.event_type)
        ? `receipt_${String(index + 1).padStart(2, "0")}`
        : null,
    ),
    authorized_endpoint_ids: [
      "endpoint_recipient",
      "endpoint_observer",
      "endpoint_observer",
    ],
    now: "2026-07-14T02:00:01Z",
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

function offeredEvent(): Extract<
  HandoffEvent,
  { readonly event_type: "workfabric.handoff.offered.v1" }
> {
  const command = decodeHandoffCommand(
    envelope(),
    actor,
    "handoff_01",
    contextReference,
  );
  if (command.kind !== "offer") throw new Error("Expected decoded Offer");
  return {
    event_type: "workfabric.handoff.offered.v1",
    handoff_id: command.handoff_id,
    thread_id: command.thread_id,
    initiator: command.actor,
    package: command.package,
    parent_handoff_id: null,
    occurred_at: "2026-07-14T01:00:00Z",
  };
}

function stateAfter(...events: readonly HandoffEvent[]): HandoffState {
  let state: HandoffState | null = null;
  for (const [index, event] of events.entries()) {
    state = evolveHandoff(state, event, index + 1);
  }
  if (state === null) throw new Error("Expected Handoff State");
  return state;
}

function resultReturnedEvent(): Extract<
  HandoffEvent,
  { readonly event_type: "workfabric.handoff.result_returned.v1" }
> {
  return {
    event_type: "workfabric.handoff.result_returned.v1",
    handoff_id: "handoff_01",
    result: {
      summary: [{ kind: "text", text: "Large result body" }],
      artifacts: [],
      evidence: [],
    },
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
    evidence: [],
    occurred_at: "2026-07-14T04:00:00Z",
  };
}

describe("Handoff Event encoding", () => {
  let schemas: WfppSchemaValidator;

  beforeAll(async () => {
    schemas = await loadWfppSchemaValidator("protocol/schemas/v1");
  });

  it("encodes Accepted at the next resource version with a Receipt summary", () => {
    const encoded = encodeHandoffEvents(encodingInput([acceptedEvent()]));

    expect(encoded.events).toHaveLength(1);
    expect(encoded.events[0]).toEqual({
      event_id: "event_1",
      event_type: "workfabric.handoff.accepted.v1",
      schema_version: "1.0",
      exchange_id: "exchange_01",
      request_message_id: "message_01",
      idempotency_key: "accept-01",
      correlation_id: "correlation_01",
      causation_id: "causation_01",
      thread_id: "handoff_01",
      handoff_id: "handoff_01",
      actor_id: recipient.actor_id,
      endpoint_id: "endpoint_recipient",
      visibility: "participants",
      visible_actor_ids: [
        actor.actor_id,
        recipient.actor_id,
        verifier.actor_id,
      ],
      visible_endpoint_ids: ["endpoint_recipient", "endpoint_observer"],
      occurred_at: "2026-07-14T02:00:00Z",
      domain_data: handoffEventToJson(acceptedEvent()),
      protocol_data: {
        resource_version: 2,
        change: {
          change_type: "accepted",
          from_state: "offered",
          to_state: "accepted",
          changed_fields: [
            "current_responsible_actor",
            "lifecycle_state",
            "recipient",
            "resource_version",
            "updated_at",
          ],
          details: {
            work_reference_uri: "urn:work:item:42",
            lifecycle_state: "accepted",
          },
        },
        receipt: {
          receipt_id: "receipt_01",
          receipt_type: "responsibility_accepted",
        },
      },
    } satisfies ProposedEvent);
    expect(encoded.receipt).toEqual({
      receipt_id: "receipt_01",
      receipt_type: "responsibility_accepted",
      handoff_id: "handoff_01",
      actor_id: recipient.actor_id,
      endpoint_id: "endpoint_recipient",
      resource_version: 2,
      recorded_at: "2026-07-14T02:00:01Z",
    });
    expect(
      schemas.validate(
        "urn:work-fabric:schema:v1:event-data",
        encoded.events[0]?.protocol_data,
      ),
    ).toEqual({ valid: true });
    expect(
      schemas.validate(
        "urn:work-fabric:schema:v1:operation-receipt",
        encoded.receipt,
      ),
    ).toEqual({ valid: true });
  });

  it("keeps Status Report in accepted state and produces no Receipt", () => {
    const status: HandoffEvent = {
      event_type: "workfabric.handoff.status_reported.v1",
      handoff_id: "handoff_01",
      status: {
        status_report_id: "status_01",
        execution_status: "in_progress",
        message: [],
        observed_at: "2026-07-14T02:30:00Z",
        blocked_on: [],
      },
      occurred_at: "2026-07-14T02:31:00Z",
    };
    const encoded = encodeHandoffEvents(
      encodingInput([status], {
        current_state: stateAfter(offeredEvent(), acceptedEvent()),
        current_stream_version: 2,
        receipt_ids: [null],
      }),
    );

    expect(encoded.receipt).toBeNull();
    expect(encoded.events[0]?.protocol_data).toEqual({
      resource_version: 3,
      change: {
        change_type: "status_reported",
        from_state: "accepted",
        to_state: "accepted",
        changed_fields: ["latest_status", "resource_version", "updated_at"],
        details: {
          work_reference_uri: "urn:work:item:42",
          lifecycle_state: "accepted",
        },
      },
      receipt: null,
    });
    expect(
      schemas.validate(
        "urn:work-fabric:schema:v1:event-data",
        encoded.events[0]?.protocol_data,
      ),
    ).toEqual({ valid: true });
  });

  it.each([
    [
      "workfabric.handoff.result_returned.v1",
      "accepted",
      "result_returned",
      "result_returned",
      "result_received",
      [
        "current_responsible_actor",
        "lifecycle_state",
        "result",
        "resource_version",
        "updated_at",
      ],
    ],
    [
      "workfabric.handoff.verified.v1",
      "result_returned",
      "verified",
      "verified",
      "result_verified",
      ["lifecycle_state", "resource_version", "updated_at"],
    ],
  ] satisfies readonly [
    HandoffEvent["event_type"],
    HandoffLifecycleState,
    HandoffLifecycleState,
    string,
    string,
    readonly string[],
  ][]) (
    "creates a schema-valid full Receipt for %s",
    (eventType, fromState, toState, changeType, receiptType, changedFields) => {
      const domainEvent: HandoffEvent =
        eventType === "workfabric.handoff.result_returned.v1"
          ? resultReturnedEvent()
          : verifiedEvent();
      const currentState =
        eventType === "workfabric.handoff.result_returned.v1"
          ? stateAfter(offeredEvent(), acceptedEvent())
          : stateAfter(
              offeredEvent(),
              acceptedEvent(),
              resultReturnedEvent(),
            );
      const encoded = encodeHandoffEvents(
        encodingInput([domainEvent], {
          current_state: currentState,
          current_stream_version: currentState.resource_version,
        }),
      );
      const protocolData = encoded.events[0]?.protocol_data;

      expect(protocolData).toMatchObject({
        change: {
          change_type: changeType,
          from_state: fromState,
          to_state: toState,
          changed_fields: changedFields,
          details: { lifecycle_state: toState },
        },
        receipt: {
          receipt_id: "receipt_01",
          receipt_type: receiptType,
        },
      });
      expect(protocolData).not.toHaveProperty("snapshot");
      expect(protocolData).not.toHaveProperty("change.details.result");
      expect(protocolData).not.toHaveProperty("visible_actor_ids");
      expect(protocolData).not.toHaveProperty("visible_endpoint_ids");
      expect(encoded.events[0]?.domain_data).toEqual(domainEvent);
      expect(
        schemas.validate("urn:work-fabric:schema:v1:event-data", protocolData),
      ).toEqual({ valid: true });
      expect(
        schemas.validate(
          "urn:work-fabric:schema:v1:operation-receipt",
          encoded.receipt,
        ),
      ).toEqual({ valid: true });
    },
  );

  it("maps every remaining Domain event to exact schema-valid Change metadata", () => {
    const cases: readonly {
      readonly event: HandoffEvent;
      readonly currentState: HandoffState | null;
      readonly from: HandoffLifecycleState | null;
      readonly to: HandoffLifecycleState;
      readonly change: string;
      readonly fields: readonly string[];
    }[] = [
      {
        event: offeredEvent(),
        currentState: null,
        from: null,
        to: "offered",
        change: "created",
        fields: [
          "current_responsible_actor",
          "lifecycle_state",
          "package",
          "resource_version",
          "updated_at",
        ],
      },
      {
        event: {
          event_type: "workfabric.handoff.declined.v1",
          handoff_id: "handoff_01",
          occurred_at: "2026-07-14T02:00:00Z",
        },
        currentState: stateAfter(offeredEvent()),
        from: "offered",
        to: "declined",
        change: "declined",
        fields: [
          "current_responsible_actor",
          "lifecycle_state",
          "resource_version",
          "updated_at",
        ],
      },
      {
        event: {
          event_type: "workfabric.handoff.expired.v1",
          handoff_id: "handoff_01",
          occurred_at: "2026-07-14T02:00:00Z",
        },
        currentState: stateAfter(offeredEvent()),
        from: "offered",
        to: "expired",
        change: "expired",
        fields: [
          "current_responsible_actor",
          "lifecycle_state",
          "resource_version",
          "updated_at",
        ],
      },
      {
        event: {
          event_type: "workfabric.handoff.cancelled.v1",
          handoff_id: "handoff_01",
          reason: [{ kind: "text", text: "Cancelled" }],
          occurred_at: "2026-07-14T03:00:00Z",
        },
        currentState: stateAfter(offeredEvent(), acceptedEvent()),
        from: "accepted",
        to: "cancelled",
        change: "cancelled",
        fields: [
          "current_responsible_actor",
          "lifecycle_state",
          "resource_version",
          "updated_at",
        ],
      },
      {
        event: {
          event_type: "workfabric.handoff.closed.v1",
          handoff_id: "handoff_01",
          occurred_at: "2026-07-14T05:00:00Z",
        },
        currentState: stateAfter(
          offeredEvent(),
          acceptedEvent(),
          resultReturnedEvent(),
          verifiedEvent(),
        ),
        from: "verified",
        to: "closed",
        change: "closed",
        fields: [
          "current_responsible_actor",
          "lifecycle_state",
          "resource_version",
          "updated_at",
        ],
      },
      {
        event: {
          event_type: "workfabric.handoff.rework_requested.v1",
          handoff_id: "handoff_01",
          criterion_ids: ["tests-pass"],
          reason: [{ kind: "text", text: "Fix tests" }],
          occurred_at: "2026-07-14T04:00:00Z",
        },
        currentState: stateAfter(
          offeredEvent(),
          acceptedEvent(),
          resultReturnedEvent(),
        ),
        from: "result_returned",
        to: "rework_requested",
        change: "rework_requested",
        fields: ["lifecycle_state", "resource_version", "updated_at"],
      },
      {
        event: {
          event_type: "workfabric.handoff.transferred.v1",
          handoff_id: "handoff_01",
          child_handoff_id: "handoff_child",
          occurred_at: "2026-07-14T05:00:00Z",
        },
        currentState: stateAfter(offeredEvent(), acceptedEvent()),
        from: "accepted",
        to: "transferred",
        change: "transferred",
        fields: [
          "child_handoff_id",
          "current_responsible_actor",
          "lifecycle_state",
          "resource_version",
          "updated_at",
        ],
      },
    ];

    for (const [index, candidate] of cases.entries()) {
      const encoded = encodeHandoffEvents(
        encodingInput([candidate.event], {
          current_state: candidate.currentState,
          current_stream_version:
            candidate.currentState?.resource_version ?? 0,
          receipt_ids: [null],
          event_ids: [`event_${index}`],
        }),
      );
      expect(encoded.events[0]?.protocol_data.change).toEqual({
        change_type: candidate.change,
        from_state: candidate.from,
        to_state: candidate.to,
        changed_fields: candidate.fields,
        details: {
          work_reference_uri: "urn:work:item:42",
          lifecycle_state: candidate.to,
        },
      });
      expect(encoded.events[0]?.protocol_data.receipt).toBeNull();
      expect(
        schemas.validate(
          "urn:work-fabric:schema:v1:event-data",
          encoded.events[0]?.protocol_data,
        ),
      ).toEqual({ valid: true });
    }
  });

  it("extracts only safe routing details and participants from an Offer event", () => {
    const offered = offeredEvent();
    const routedOffer: typeof offered = {
      ...offered,
      package: {
        ...offered.package,
        target: {
          capability_requirement: {
            capability_id: "software.implementation",
          },
        },
      },
    };
    const encoded = encodeHandoffEvents(
      encodingInput([routedOffer], {
        current_state: null,
        current_stream_version: 0,
        receipt_ids: [null],
      }),
    );

    expect(encoded.events[0]?.protocol_data.change).toMatchObject({
      details: {
        work_reference_uri: "urn:work:item:42",
        capability_ids: ["software.implementation"],
        lifecycle_state: "offered",
      },
    });
    expect(encoded.events[0]?.protocol_data).not.toHaveProperty("snapshot");
    expect(encoded.events[0]?.protocol_data).not.toHaveProperty("context_bundle");
    expect(encoded.events[0]?.domain_data).toEqual(handoffEventToJson(routedOffer));
    expect(encoded.events[0]?.visible_actor_ids).toEqual([
      actor.actor_id,
      verifier.actor_id,
    ]);
    expect(encoded.events[0]?.visible_endpoint_ids).toEqual([
      "endpoint_recipient",
      "endpoint_observer",
    ]);
  });

  it("publishes only safe target-resolution facts in Event change details", () => {
    const capabilityPackage: HandoffEvent & {
      event_type: "workfabric.handoff.target_resolution_requested.v1";
    } = {
      ...offeredEvent(),
      event_type: "workfabric.handoff.target_resolution_requested.v1",
      package: {
        ...offeredEvent().package,
        target: {
          capability_requirement: {
            capability_id: "software.implementation",
            private_policy_hint: "must-not-be-public",
          },
        },
      },
    };
    const pending = stateAfter(capabilityPackage);
    const resolved: HandoffEvent = {
      event_type: "workfabric.handoff.target_resolved.v1",
      handoff_id: "handoff_01",
      binding: {
        target: { endpoint_id: "endpoint_agent" },
        resolved_by: { actor_id: "actor_resolver", actor_type: "system" },
        resolver_endpoint_id: "endpoint_resolver",
        delegation_id: "delegation_resolver",
        resolved_at: "2026-07-14T02:00:00Z",
        evidence: [{ private_score: 0.99 }],
      },
      occurred_at: "2026-07-14T02:00:00Z",
    };
    const resolvedEncoding = encodeHandoffEvents(
      encodingInput([resolved], {
        current_state: pending,
        current_stream_version: 1,
        receipt_ids: [null],
      }),
    );

    expect(resolvedEncoding.events[0]?.protocol_data.change).toMatchObject({
      details: {
        work_reference_uri: "urn:work:item:42",
        capability_ids: ["software.implementation"],
        lifecycle_state: "offered",
        resolved_target: { endpoint_id: "endpoint_agent" },
        resolved_by_actor_id: "actor_resolver",
        resolver_endpoint_id: "endpoint_resolver",
        delegation_id: "delegation_resolver",
      },
    });
    expect(
      canonicalJson(resolvedEncoding.events[0]?.protocol_data),
    ).not.toMatch(/private_policy_hint|private_score|evidence/);
    expect(resolvedEncoding.events[0]?.visible_endpoint_ids).toContain(
      "endpoint_agent",
    );

    const actorResolved: HandoffEvent = {
      ...resolved,
      binding: {
        ...resolved.binding,
        target: { actor_id: "actor_agent" },
      },
    };
    const actorResolvedEncoding = encodeHandoffEvents(
      encodingInput([actorResolved], {
        current_state: pending,
        current_stream_version: 1,
        receipt_ids: [null],
      }),
    );
    expect(actorResolvedEncoding.events[0]?.visible_actor_ids).toContain(
      "actor_agent",
    );

    const unavailable: HandoffEvent = {
      event_type: "workfabric.handoff.target_unavailable.v1",
      handoff_id: "handoff_01",
      resolved_by: { actor_id: "actor_resolver", actor_type: "system" },
      resolver_endpoint_id: "endpoint_resolver",
      delegation_id: null,
      reason_code: "no_eligible_target",
      reason: [{ kind: "text", text: "private explanation" }],
      evidence: [{ private_candidates: ["agent-a", "agent-b"] }],
      occurred_at: "2026-07-14T02:00:00Z",
    };
    const unavailableEncoding = encodeHandoffEvents(
      encodingInput([unavailable], {
        current_state: pending,
        current_stream_version: 1,
        receipt_ids: [null],
      }),
    );

    expect(unavailableEncoding.events[0]?.protocol_data.change).toMatchObject({
      details: {
        capability_ids: ["software.implementation"],
        lifecycle_state: "target_unavailable",
        resolved_by_actor_id: "actor_resolver",
        resolver_endpoint_id: "endpoint_resolver",
        reason_code: "no_eligible_target",
      },
    });
    expect(
      canonicalJson(unavailableEncoding.events[0]?.protocol_data),
    ).not.toMatch(/private explanation|private_candidates|agent-a|evidence/);
  });

  it("rejects mismatched generated Event and event-aligned Receipt IDs", () => {
    expect(() =>
      encodeHandoffEvents(
        encodingInput([acceptedEvent()], { event_ids: [], receipt_ids: [null] }),
      ),
    ).toThrow(/event_ids/);
    expect(() =>
      encodeHandoffEvents(
        encodingInput([acceptedEvent()], {
          event_ids: ["event_01"],
          receipt_ids: [],
        }),
      ),
    ).toThrow(/receipt_ids/);
    expect(() =>
      encodeHandoffEvents(
        encodingInput([acceptedEvent()], { receipt_ids: [null] }),
      ),
    ).toThrow(/Receipt ID.*accepted/i);
    expect(() =>
      encodeHandoffEvents(
        encodingInput(
          [
            {
              event_type: "workfabric.handoff.declined.v1",
              handoff_id: "handoff_01",
              occurred_at: "2026-07-14T02:00:00Z",
            },
          ],
          { receipt_ids: ["receipt_unexpected"] },
        ),
      ),
    ).toThrow(/Receipt ID.*declined/i);
  });

  it("rejects a supplied stream version that does not match current State", () => {
    expect(() =>
      encodeHandoffEvents(
        encodingInput([acceptedEvent()], { current_stream_version: 0 }),
      ),
    ).toThrow(/current_stream_version.*current_state/i);
    expect(() =>
      encodeHandoffEvents(
        encodingInput([offeredEvent()], {
          current_state: null,
          current_stream_version: 1,
          receipt_ids: [null],
        }),
      ),
    ).toThrow(/current_stream_version.*current_state/i);
  });

  it("omits unchanged responsibility from rework changed fields", () => {
    const rework: HandoffEvent = {
      event_type: "workfabric.handoff.rework_requested.v1",
      handoff_id: "handoff_01",
      criterion_ids: ["tests-pass"],
      reason: [{ kind: "text", text: "Fix tests" }],
      occurred_at: "2026-07-14T04:00:00Z",
    };
    const currentState = stateAfter(
      offeredEvent(),
      acceptedEvent(),
      resultReturnedEvent(),
    );

    const encoded = encodeHandoffEvents(
      encodingInput([rework], {
        current_state: currentState,
        current_stream_version: 3,
        receipt_ids: [null],
      }),
    );

    expect(encoded.events[0]?.protocol_data.change).toMatchObject({
      from_state: "result_returned",
      to_state: "rework_requested",
      changed_fields: ["lifecycle_state", "resource_version", "updated_at"],
    });
    expect(
      schemas.validate(
        "urn:work-fabric:schema:v1:event-data",
        encoded.events[0]?.protocol_data,
      ),
    ).toEqual({ valid: true });
  });

  it("derives a repeated Accept transition from rework State", () => {
    const rework: HandoffEvent = {
      event_type: "workfabric.handoff.rework_requested.v1",
      handoff_id: "handoff_01",
      criterion_ids: ["tests-pass"],
      reason: [{ kind: "text", text: "Fix tests" }],
      occurred_at: "2026-07-14T04:00:00Z",
    };
    const currentState = stateAfter(
      offeredEvent(),
      acceptedEvent(),
      resultReturnedEvent(),
      rework,
    );
    const acceptedAgain: HandoffEvent = {
      ...acceptedEvent(),
      occurred_at: "2026-07-14T05:00:00Z",
    };

    const encoded = encodeHandoffEvents(
      encodingInput([acceptedAgain], {
        current_state: currentState,
        current_stream_version: 4,
      }),
    );

    expect(encoded.events[0]?.protocol_data).toMatchObject({
      resource_version: 5,
      change: {
        from_state: "rework_requested",
        to_state: "accepted",
        changed_fields: [
          "current_responsible_actor",
          "lifecycle_state",
          "resource_version",
          "updated_at",
        ],
        details: { lifecycle_state: "accepted" },
      },
    });
    expect(
      schemas.validate(
        "urn:work-fabric:schema:v1:event-data",
        encoded.events[0]?.protocol_data,
      ),
    ).toEqual({ valid: true });
  });

  it("evolves a multi-event batch in order and returns its final Receipt", () => {
    const currentState = stateAfter(offeredEvent(), acceptedEvent());
    const encoded = encodeHandoffEvents(
      encodingInput([resultReturnedEvent(), verifiedEvent()], {
        current_state: currentState,
        current_stream_version: 2,
        event_ids: ["event_result", "event_verified"],
        receipt_ids: ["receipt_result", "receipt_verified"],
      }),
    );

    expect(encoded.events.map(({ protocol_data: data }) => data.change)).toEqual([
      expect.objectContaining({
        from_state: "accepted",
        to_state: "result_returned",
      }),
      expect.objectContaining({
        from_state: "result_returned",
        to_state: "verified",
      }),
    ]);
    expect(encoded.receipt).toMatchObject({
      receipt_id: "receipt_verified",
      receipt_type: "result_verified",
      resource_version: 4,
    });
  });
});
