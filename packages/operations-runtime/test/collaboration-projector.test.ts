import { describe, expect, it } from "vitest";

import {
  MemoryCollaborationViewStore,
  MemoryOperationsFixture,
} from "@work-fabric/adapter-operations-memory";
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import {
  handoffEventToJson,
  type Clock,
  type HandoffEvent,
  type HandoffPackage,
} from "@work-fabric/exchange-core";
import {
  HandoffProjector,
  MemoryHandoffReadModelStore,
} from "@work-fabric/exchange-runtime";
import type { EventJournal, EventRecord } from "@work-fabric/exchange-spi";
import type { SemanticObservation } from "@work-fabric/operations-spi";

import {
  COLLABORATION_PROJECTOR_ID,
  CollaborationProjector,
} from "../src/index.js";

const tenantId = "tenant-operations";
const partitionId = "partition-operations";
const handoffId = "handoff-operations";
const threadId = "thread-operations";
const initiator = { actor_id: "sales-1", actor_type: "human" } as const;
const recipient = { actor_id: "agent-1", actor_type: "agent" } as const;
const verifier = { actor_id: "customer-1", actor_type: "human" } as const;

const handoffPackage: HandoffPackage = {
  work_reference: { uri: "urn:work:project-42" },
  target: { actor_id: recipient.actor_id },
  intent: [{ kind: "text", text: "Implement externally" }],
  context: null,
  authority_scope: {
    delegation_id: "delegation-1",
    scopes: ["work:read"],
    resource_refs: ["urn:work:project-42"],
    expires_at: "2026-07-31T00:00:00.000Z",
    may_redelegate: false,
  },
  acceptance_criteria: [],
  verifier,
  priority: "high",
  accept_by: "2026-07-17T00:00:00.000Z",
  result_due_at: "2026-07-18T00:00:00.000Z",
};

const clock: Clock = { now: () => "2026-07-16T04:00:00.000Z" };

class StaticJournal implements EventJournal {
  constructor(private readonly records: readonly EventRecord[]) {}

  async readStream(streamId: string, fromVersion = 0) {
    return structuredClone(
      this.records.filter(
        (record) =>
          record.stream_id === streamId && record.stream_version >= fromVersion,
      ),
    );
  }

  async readPartition(requested: string, after: number, limit: number) {
    return structuredClone(
      this.records
        .filter(
          (record) =>
            record.partition_id === requested && record.partition_position > after,
        )
        .slice(0, limit),
    );
  }
}

function events(): readonly HandoffEvent[] {
  return [
    {
      event_type: "workfabric.handoff.offered.v1",
      handoff_id: handoffId,
      thread_id: threadId,
      initiator,
      package: handoffPackage,
      parent_handoff_id: null,
      occurred_at: "2026-07-16T01:00:00.000Z",
    },
    {
      event_type: "workfabric.handoff.accepted.v1",
      handoff_id: handoffId,
      recipient,
      occurred_at: "2026-07-16T02:00:00.000Z",
    },
    {
      event_type: "workfabric.handoff.status_reported.v1",
      handoff_id: handoffId,
      status: { state: "in_progress", progress: 50 },
      occurred_at: "2026-07-16T03:00:00.000Z",
    },
    {
      event_type: "workfabric.handoff.result_returned.v1",
      handoff_id: handoffId,
      result: { summary: "private result must not enter responsibility view" },
      occurred_at: "2026-07-16T04:00:00.000Z",
    },
  ];
}

function records(): readonly EventRecord[] {
  return events().map((event, index) => {
    const position = index + 1;
    return {
      event_id: `event-${position}`,
      event_type: event.event_type,
      schema_version: "1.0",
      exchange_id: "exchange-1",
      request_message_id: `message-${position}`,
      idempotency_key: `key-${position}`,
      correlation_id: "project-42",
      ...(position === 1 ? {} : { causation_id: `event-${position - 1}` }),
      thread_id: threadId,
      handoff_id: handoffId,
      actor_id: position === 1 ? initiator.actor_id : recipient.actor_id,
      endpoint_id: position === 1 ? "endpoint-sales" : "endpoint-agent",
      visibility: "participants",
      visible_actor_ids: [initiator.actor_id, recipient.actor_id, verifier.actor_id],
      visible_endpoint_ids: ["endpoint-sales", "endpoint-agent"],
      occurred_at: event.occurred_at,
      domain_data: handoffEventToJson(event),
      protocol_data: {
        change_type: event.event_type,
        changed_fields: ["lifecycle_state"],
      },
      tenant_id: tenantId,
      partition_id: partitionId,
      partition_position: position,
      stream_id: handoffId,
      stream_version: position,
      commit_id: `commit-${position}`,
      commit_ordinal: 0,
    } satisfies EventRecord;
  });
}

function fixture(
  inputRecords = records(),
  observed: SemanticObservation[] = [],
) {
  const journal = new StaticJournal(inputRecords);
  const persistence = new MemoryExchangePersistence();
  const models = new MemoryHandoffReadModelStore();
  const operations = new MemoryOperationsFixture();
  const handoffProjector = new HandoffProjector(
    journal,
    persistence,
    persistence,
    models,
    clock,
  );
  const projector = new CollaborationProjector(
    journal,
    persistence,
    persistence,
    models,
    operations.collaboration,
    clock,
    { observe(value) { observed.push(value); } },
  );
  return { persistence, models, operations, handoffProjector, projector, observed };
}

describe("CollaborationProjector", () => {
  it("emits bounded batch and lag semantics without projection content", async () => {
    const { handoffProjector, projector, observed } = fixture();
    await handoffProjector.runPartition(partitionId, 10);
    await projector.runPartition(partitionId, 10);

    expect(observed.map(({ operation, outcome, category, count }) => ({
      operation, outcome, category, count,
    }))).toEqual([
      { operation: "projection_lag", outcome: "succeeded", category: "projector", count: 4 },
      { operation: "projection_batch", outcome: "succeeded", category: "projector", count: 4 },
    ]);
    expect(JSON.stringify(observed)).not.toMatch(/private result|tenant-operations|handoff-operations/);
  });

  it("waits without poisoning when the prerequisite Handoff view is behind", async () => {
    const { projector, persistence } = fixture();

    await expect(projector.runPartition(partitionId, 10)).resolves.toEqual({
      kind: "waiting",
      position: 0,
      handoff_id: handoffId,
      required_stream_version: 1,
    });
    expect(
      await persistence.loadProjectionCheckpoint(
        COLLABORATION_PROJECTOR_ID,
        partitionId,
      ),
    ).toBe(0);
    expect(
      await persistence.listProjectionFailures(
        COLLABORATION_PROJECTOR_ID,
        partitionId,
      ),
    ).toEqual([]);
  });

  it("checks ownership before every view write and checkpoint advancement", async () => {
    const { persistence, handoffProjector, projector } = fixture();
    await handoffProjector.runPartition(partitionId, 10);
    let calls = 0;
    const fence = {
      async assertOwnership() {
        calls += 1;
        if (calls >= 2) throw new Error("partition_lease_lost");
      },
    };

    await expect(projector.runPartition(partitionId, 10, fence)).rejects.toThrow(
      /partition_lease_lost/,
    );
    expect(await persistence.loadProjectionCheckpoint(
      COLLABORATION_PROJECTOR_ID,
      partitionId,
    )).toBe(0);
  });

  it("projects safe responsibility, public timeline, and only current relations", async () => {
    const { persistence, operations, handoffProjector, projector } = fixture();
    await handoffProjector.runPartition(partitionId, 10);

    await expect(projector.runPartition(partitionId, 10)).resolves.toEqual({
      kind: "advanced",
      position: 4,
      processed: 4,
    });
    const responsibility = await operations.collaboration.getResponsibility(
      tenantId,
      handoffId,
    );
    expect(responsibility).toMatchObject({
      lifecycle_state: "result_returned",
      current_responsible_actor: verifier,
      latest_status: { state: "in_progress", progress: 50 },
      work_reference: { uri: "urn:work:project-42" },
      stream_version: 4,
    });
    expect(JSON.stringify(responsibility)).not.toContain("private result");

    const timeline = await operations.collaboration.listTimeline({
      tenant_id: tenantId,
      partition_id: partitionId,
      limit: 10,
    });
    expect(timeline.items).toHaveLength(4);
    expect(timeline.items[1]).toMatchObject({
      event_id: "event-2",
      event_source: "urn:work-fabric:exchange:exchange-1",
      actor_id: recipient.actor_id,
      endpoint_id: "endpoint-agent",
      correlation_id: "project-42",
      causation_id: "event-1",
    });

    const relations = await operations.collaboration.listRelationships({
      tenant_id: tenantId,
      partition_id: partitionId,
      handoff_id: handoffId,
      limit: 10,
    });
    expect(relations.items.map((item) => [item.relationship_kind, item.target_id])).toEqual([
      ["responsibility", `actor:${verifier.actor_id}`],
      ["target", `actor:${recipient.actor_id}`],
      ["thread_membership", `thread:${threadId}`],
    ]);
    expect(
      await persistence.loadProjectionCheckpoint(
        COLLABORATION_PROJECTOR_ID,
        partitionId,
      ),
    ).toBe(4);
  });

  it("rebuilds one partition to an identical collaboration view", async () => {
    const { operations, handoffProjector, projector } = fixture();
    await handoffProjector.runPartition(partitionId, 10);
    await projector.runPartition(partitionId, 10);
    const before = {
      responsibilities: await operations.collaboration.listResponsibilities({
        tenant_id: tenantId,
        partition_id: partitionId,
        limit: 10,
      }),
      timeline: await operations.collaboration.listTimeline({
        tenant_id: tenantId,
        partition_id: partitionId,
        limit: 10,
      }),
      relationships: await operations.collaboration.listRelationships({
        tenant_id: tenantId,
        partition_id: partitionId,
        limit: 10,
      }),
    };

    await expect(projector.rebuildPartition(tenantId, partitionId, 2)).resolves.toBe(4);
    const after = {
      responsibilities: await operations.collaboration.listResponsibilities({
        tenant_id: tenantId,
        partition_id: partitionId,
        limit: 10,
      }),
      timeline: await operations.collaboration.listTimeline({
        tenant_id: tenantId,
        partition_id: partitionId,
        limit: 10,
      }),
      relationships: await operations.collaboration.listRelationships({
        tenant_id: tenantId,
        partition_id: partitionId,
        limit: 10,
      }),
    };
    expect(after).toEqual(before);
  });

  it("records a bounded safe failure when a view adapter rejects an event", async () => {
    class FailingTimelineStore extends MemoryCollaborationViewStore {
      override async putTimeline(): Promise<void> {
        throw new Error("password=hunter2\nprivate database diagnostics");
      }
    }
    const inputRecords = records();
    const journal = new StaticJournal(inputRecords);
    const persistence = new MemoryExchangePersistence();
    const models = new MemoryHandoffReadModelStore();
    const handoffProjector = new HandoffProjector(
      journal,
      persistence,
      persistence,
      models,
      clock,
    );
    await handoffProjector.runPartition(partitionId, 10);
    const projector = new CollaborationProjector(
      journal,
      persistence,
      persistence,
      models,
      new FailingTimelineStore(),
      clock,
    );

    const result = await projector.runPartition(partitionId, 10);
    expect(result).toEqual({
      kind: "blocked",
      position: 0,
      event_id: "event-1",
      reason: "view write: adapter operation failed",
    });
    const failures = await persistence.listProjectionFailures(
      COLLABORATION_PROJECTOR_ID,
      partitionId,
    );
    expect(failures[0]?.reason).toBe("view write: adapter operation failed");
    expect(JSON.stringify(failures)).not.toMatch(/hunter2|database diagnostics/i);
  });
});
