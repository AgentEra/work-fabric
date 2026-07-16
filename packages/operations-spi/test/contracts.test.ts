import { describe, expect, it } from "vitest";

import {
  OPERATIONS_STORE_REQUIRED_CAPABILITIES,
  createOpaqueCursorCodec,
  normalizePageLimit,
  validateAuditRecord,
  validateSemanticObservation,
  type AuditRecord,
  type AuditStore,
  type CollaborationViewStore,
  type CursorAuthenticator,
  type ResponsibilityView,
  type SemanticObservation,
  type TimelineEntry,
} from "../src/index.js";

function testSignature(payload: string): string {
  let value = 0;
  for (const character of payload) value = (value * 31 + character.charCodeAt(0)) >>> 0;
  return `test-${value.toString(16)}`;
}

const authenticator: CursorAuthenticator = {
  async sign(payload) {
    return testSignature(payload);
  },
  async verify(payload, signature) {
    return signature === testSignature(payload);
  },
};

function responsibility(): ResponsibilityView {
  return {
    tenant_id: "tenant-1",
    partition_id: "partition-1",
    thread_id: "thread-1",
    handoff_id: "handoff-1",
    stream_version: 4,
    lifecycle_state: "accepted",
    initiator: { actor_id: "sales-1", actor_type: "human" },
    recipient: { actor_id: "delivery-1", actor_type: "human" },
    current_responsible_actor: {
      actor_id: "delivery-1",
      actor_type: "human",
    },
    verifier: { actor_id: "customer-1", actor_type: "human" },
    target_binding: null,
    work_reference: { uri: "urn:work:item:42" },
    priority: "high",
    accept_by: "2026-07-16T08:00:00.000Z",
    result_due_at: "2026-07-18T08:00:00.000Z",
    latest_status: { code: "in_progress" },
    parent_handoff_id: null,
    child_handoff_id: null,
    created_at: "2026-07-16T01:00:00.000Z",
    updated_at: "2026-07-16T02:00:00.000Z",
  };
}

function auditRecord(): AuditRecord {
  return {
    tenant_id: "tenant-1",
    audit_id: "audit-1",
    occurred_at: "2026-07-16T02:00:00.000Z",
    request_id: "request-1",
    trace_id: null,
    principal_id: "principal-1",
    represented_actor: { actor_id: "actor-1", actor_type: "human" },
    represented_endpoint_id: null,
    delegation_id: null,
    operation: "collaboration.responsibility.list",
    resource_kind: "tenant",
    resource_id: "tenant-1",
    authorization_decision: "allowed",
    outcome: "succeeded",
    reason_code: null,
    service_category: "http",
  };
}

describe("operations SPI contracts", () => {
  it("publishes technology-neutral required storage capabilities", () => {
    expect(OPERATIONS_STORE_REQUIRED_CAPABILITIES).toEqual([
      "tenant_isolation",
      "monotonic_projection",
      "partition_reset",
      "deterministic_cursor_pagination",
      "immutable_reads",
      "append_only_audit",
    ]);
    expect(JSON.stringify(OPERATIONS_STORE_REQUIRED_CAPABILITIES)).not.toMatch(
      /postgres|sqlite|http|otel/i,
    );
  });

  it("defines collaboration and audit stores without an execution port", () => {
    const compileOnly = <T>(_value?: T): true => true;
    expect(compileOnly<CollaborationViewStore>()).toBe(true);
    expect(compileOnly<AuditStore>()).toBe(true);
    expect(responsibility().current_responsible_actor?.actor_type).toBe("human");

    const timeline: TimelineEntry = {
      tenant_id: "tenant-1",
      partition_id: "partition-1",
      partition_position: 9,
      handoff_id: "handoff-1",
      thread_id: "thread-1",
      stream_version: 4,
      event_id: "event-9",
      event_type: "workfabric.handoff.accepted.v1",
      occurred_at: "2026-07-16T02:00:00.000Z",
      subject: "handoff-1",
      source: { actor_id: "delivery-1", actor_type: "human" },
      correlation_id: "project-42",
      causation_id: "event-8",
      change: { changed_fields: ["lifecycle_state"] },
    };
    expect(timeline.partition_position).toBe(9);
  });

  it("signs cursors and binds them to kind, sort, and normalized filters", async () => {
    const codec = createOpaqueCursorCodec(authenticator, { max_length: 2048 });
    const context = {
      kind: "responsibility" as const,
      sort: "updated_desc_handoff_asc",
      filters: {
        lifecycle_states: ["accepted"],
        responsible_actor_id: "delivery-1",
      },
    };
    const cursor = await codec.encode({
      ...context,
      position: {
        updated_at: "2026-07-16T02:00:00.000Z",
        handoff_id: "handoff-1",
      },
    });

    await expect(codec.decode(cursor, context)).resolves.toEqual({
      updated_at: "2026-07-16T02:00:00.000Z",
      handoff_id: "handoff-1",
    });
    await expect(
      codec.decode(cursor, {
        ...context,
        filters: { lifecycle_states: ["closed"] },
      }),
    ).rejects.toThrow(/context/i);

    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    await expect(codec.decode(tampered, context)).rejects.toThrow(/signature/i);
    await expect(codec.decode("x".repeat(2049), context)).rejects.toThrow(/length/i);
  });

  it("normalizes page limits within positive hard bounds", () => {
    expect(normalizePageLimit(undefined, { default_limit: 25, max_limit: 100 })).toBe(25);
    expect(normalizePageLimit(100, { default_limit: 25, max_limit: 100 })).toBe(100);
    expect(() => normalizePageLimit(0, { default_limit: 25, max_limit: 100 })).toThrow(/limit/i);
    expect(() => normalizePageLimit(101, { default_limit: 25, max_limit: 100 })).toThrow(/limit/i);
  });

  it("accepts bounded audit facts and rejects unsafe or unbounded fields", () => {
    expect(validateAuditRecord(auditRecord())).toEqual(auditRecord());
    expect(() =>
      validateAuditRecord({
        ...auditRecord(),
        reason_code: "x".repeat(129),
      }),
    ).toThrow(/reason_code/i);
    expect(() =>
      validateAuditRecord({
        ...auditRecord(),
        operation: "authorization: Bearer secret",
      }),
    ).toThrow(/operation/i);
  });

  it("restricts telemetry to enumerated low-cardinality semantics", () => {
    const observation: SemanticObservation = {
      operation: "collaboration_query",
      outcome: "succeeded",
      category: "http",
      duration_ms: 12.5,
      count: 1,
    };
    expect(validateSemanticObservation(observation)).toEqual(observation);
    expect(() =>
      validateSemanticObservation({
        ...observation,
        operation: "handoff-123" as SemanticObservation["operation"],
      }),
    ).toThrow(/operation/i);
    expect(() =>
      validateSemanticObservation({ ...observation, duration_ms: -1 }),
    ).toThrow(/duration/i);
  });
});
