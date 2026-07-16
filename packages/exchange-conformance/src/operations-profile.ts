import { strict as assert } from "node:assert";

import {
  AUDIT_STORE_REQUIRED_CAPABILITIES,
  COLLABORATION_VIEW_REQUIRED_CAPABILITIES,
  type AuditRecord,
  type AuditStore,
  type CollaborationViewStore,
  type ResponsibilityView,
  type TimelineEntry,
  type RelationshipView,
} from "@work-fabric/operations-spi";

export interface OperationsStoreProfileSubject {
  readonly collaboration: CollaborationViewStore;
  readonly audit: AuditStore;
}

export type OperationsStoreProfileFactory =
  () => OperationsStoreProfileSubject | Promise<OperationsStoreProfileSubject>;

function responsibility(
  handoffId: string,
  updatedAt: string,
  version = 1,
  overrides: Partial<ResponsibilityView> = {},
): ResponsibilityView {
  return {
    tenant_id: "tenant-profile",
    partition_id: "partition-profile",
    thread_id: "thread-profile",
    handoff_id: handoffId,
    stream_version: version,
    lifecycle_state: "accepted",
    initiator: { actor_id: "initiator-profile", actor_type: "human" },
    recipient: { actor_id: "agent-profile", actor_type: "agent" },
    current_responsible_actor: { actor_id: "agent-profile", actor_type: "agent" },
    verifier: { actor_id: "verifier-profile", actor_type: "human" },
    target_binding: null,
    work_reference: { uri: `urn:work:${handoffId}` },
    priority: "normal",
    accept_by: "2026-07-17T00:00:00.000Z",
    result_due_at: "2026-07-18T00:00:00.000Z",
    latest_status: null,
    parent_handoff_id: null,
    child_handoff_id: null,
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: updatedAt,
    ...overrides,
  };
}

function timeline(
  eventId: string,
  position: number,
  overrides: Partial<TimelineEntry> = {},
): TimelineEntry {
  return {
    tenant_id: "tenant-profile",
    partition_id: "partition-profile",
    partition_position: position,
    handoff_id: "handoff-1",
    thread_id: "thread-profile",
    stream_version: position,
    event_id: eventId,
    event_type: "workfabric.handoff.status_reported.v1",
    occurred_at: `2026-07-16T00:00:0${position}.000Z`,
    subject: "handoff-1",
    source: { actor_id: "agent-profile", actor_type: "agent" },
    correlation_id: null,
    causation_id: null,
    change: { position },
    ...overrides,
  };
}

function relationship(
  relationshipId: string,
  observedAt: string,
  overrides: Partial<RelationshipView> = {},
): RelationshipView {
  return {
    tenant_id: "tenant-profile",
    partition_id: "partition-profile",
    relationship_id: relationshipId,
    relationship_kind: "responsibility",
    source_id: "handoff-1",
    target_id: "agent-profile",
    handoff_id: "handoff-1",
    stream_version: 1,
    observed_at: observedAt,
    ...overrides,
  };
}

function audit(
  auditId: string,
  occurredAt: string,
  overrides: Partial<AuditRecord> = {},
): AuditRecord {
  return {
    tenant_id: "tenant-profile",
    audit_id: auditId,
    occurred_at: occurredAt,
    request_id: `request-${auditId}`,
    trace_id: null,
    principal_id: "principal-profile",
    represented_actor: { actor_id: "actor-profile", actor_type: "human" },
    represented_endpoint_id: null,
    delegation_id: null,
    operation: "collaboration.responsibility.list",
    resource_kind: "tenant",
    resource_id: "tenant-profile",
    authorization_decision: "allowed",
    outcome: "succeeded",
    reason_code: null,
    service_category: "http",
    ...overrides,
  };
}

function hasCapabilities(
  actual: Readonly<Record<string, boolean>>,
  required: readonly string[],
): void {
  for (const capability of required) assert.equal(actual[capability], true);
}

export async function verifyOperationsStoreProfile(
  factory: OperationsStoreProfileFactory,
): Promise<void> {
  const { collaboration, audit: auditStore } = await factory();
  hasCapabilities(
    collaboration.manifest.capabilities,
    COLLABORATION_VIEW_REQUIRED_CAPABILITIES,
  );
  hasCapabilities(auditStore.manifest.capabilities, AUDIT_STORE_REQUIRED_CAPABILITIES);

  const newest = responsibility("handoff-newest", "2026-07-16T03:00:00.000Z");
  const tied = responsibility("handoff-tied", "2026-07-16T02:00:00.000Z");
  const oldest = responsibility("handoff-oldest", "2026-07-16T02:00:00.000Z");
  await collaboration.putResponsibility(oldest);
  await collaboration.putResponsibility(newest);
  await collaboration.putResponsibility(tied);
  await collaboration.putResponsibility(structuredClone(newest));
  await assert.rejects(
    collaboration.putResponsibility({ ...newest, lifecycle_state: "closed" }),
    /same version|conflict/i,
  );
  await assert.rejects(
    collaboration.putResponsibility({ ...newest, stream_version: 0 }),
    /stale|version/i,
  );

  const firstPage = await collaboration.listResponsibilities({
    tenant_id: "tenant-profile",
    responsible_actor_id: "agent-profile",
    lifecycle_states: ["accepted"],
    limit: 2,
  });
  assert.deepEqual(firstPage.items.map((item) => item.handoff_id), [
    "handoff-newest",
    "handoff-oldest",
  ]);
  assert.ok(firstPage.next_cursor);
  await assert.rejects(
    collaboration.listResponsibilities({
      tenant_id: "tenant-profile",
      responsible_actor_id: "different-actor",
      lifecycle_states: ["accepted"],
      cursor: firstPage.next_cursor ?? undefined,
      limit: 2,
    }),
    /context/i,
  );
  const secondPage = await collaboration.listResponsibilities({
    tenant_id: "tenant-profile",
    responsible_actor_id: "agent-profile",
    lifecycle_states: ["accepted"],
    cursor: firstPage.next_cursor ?? undefined,
    limit: 2,
  });
  assert.deepEqual(secondPage.items.map((item) => item.handoff_id), ["handoff-tied"]);
  assert.equal(secondPage.next_cursor, null);
  (firstPage.items[0]?.work_reference as { uri?: string }).uri = "mutated";
  assert.equal(
    (await collaboration.getResponsibility("tenant-profile", "handoff-newest"))
      ?.work_reference.uri,
    "urn:work:handoff-newest",
  );
  assert.equal(
    await collaboration.getResponsibility("other-tenant", "handoff-newest"),
    null,
  );

  await collaboration.putTimeline(timeline("event-1", 1));
  await collaboration.putTimeline(timeline("event-2", 2));
  await collaboration.putTimeline(structuredClone(timeline("event-2", 2)));
  await assert.rejects(
    collaboration.putTimeline(timeline("event-2", 2, { event_type: "changed" })),
    /conflict/i,
  );
  const timelinePage = await collaboration.listTimeline({
    tenant_id: "tenant-profile",
    partition_id: "partition-profile",
    limit: 1,
  });
  assert.deepEqual(timelinePage.items.map((item) => item.event_id), ["event-1"]);
  assert.ok(timelinePage.next_cursor);

  await collaboration.putRelationship(
    relationship("relationship-2", "2026-07-16T02:00:00.000Z"),
  );
  await collaboration.putRelationship(
    relationship("relationship-1", "2026-07-16T02:00:00.000Z"),
  );
  const relationshipPage = await collaboration.listRelationships({
    tenant_id: "tenant-profile",
    partition_id: "partition-profile",
    limit: 10,
  });
  assert.deepEqual(
    relationshipPage.items.map((item) => item.relationship_id),
    ["relationship-1", "relationship-2"],
  );

  const firstAudit = audit("audit-1", "2026-07-16T01:00:00.000Z");
  const secondAudit = audit("audit-2", "2026-07-16T02:00:00.000Z");
  await auditStore.append(firstAudit);
  await auditStore.append(secondAudit);
  await auditStore.append(structuredClone(firstAudit));
  await assert.rejects(
    auditStore.append({ ...firstAudit, outcome: "failed" }),
    /immutable|conflict/i,
  );
  const auditPage = await auditStore.list({ tenant_id: "tenant-profile", limit: 1 });
  assert.deepEqual(auditPage.items.map((item) => item.audit_id), ["audit-2"]);
  assert.ok(auditPage.next_cursor);
  assert.equal(
    await auditStore.pruneBefore(
      "tenant-profile",
      "2026-07-16T01:30:00.000Z",
      1,
    ),
    1,
  );
  assert.deepEqual(
    (await auditStore.list({ tenant_id: "tenant-profile", limit: 10 })).items.map(
      (item) => item.audit_id,
    ),
    ["audit-2"],
  );

  await collaboration.clearPartition("tenant-profile", "partition-profile");
  assert.deepEqual(
    (
      await collaboration.listResponsibilities({
        tenant_id: "tenant-profile",
        partition_id: "partition-profile",
        limit: 10,
      })
    ).items,
    [],
  );
}
