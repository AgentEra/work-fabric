import { describe, expect, it } from "vitest";

import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import {
  handoffEventToJson,
  type ActorRef,
  type Clock,
  type HandoffEvent,
  type HandoffPackage,
} from "@work-fabric/exchange-core";
import type {
  EventJournal,
  EventRecord,
  HandoffReadModel,
  HandoffReadModelStore,
  ProjectionCheckpointStore,
} from "@work-fabric/exchange-spi";

import {
  HANDOFF_PROJECTOR_ID,
  HandoffProjector,
  MemoryHandoffReadModelStore,
  assignmentFromHandoff,
} from "../src/index.js";

const partitionId = "partition_projection";
const tenantId = "tenant_projection";
const parentId = "handoff_parent";
const childId = "handoff_child";
const initiator = { actor_id: "human_01", actor_type: "human" } as const;
const recipient = { actor_id: "agent_01", actor_type: "agent" } as const;
const verifier = { actor_id: "system_01", actor_type: "system" } as const;

const handoffPackage: HandoffPackage = {
  work_reference: { system: "feishu", document_id: "doc_01" },
  target: { actor_id: recipient.actor_id },
  intent: [{ type: "implement" }],
  context: null,
  authority_scope: {
    delegation_id: "delegation_01",
    scopes: ["work:read", "result:write"],
    resource_refs: ["feishu:doc_01"],
    expires_at: "2026-07-31T00:00:00.000Z",
    may_redelegate: true,
  },
  acceptance_criteria: [
    {
      criterion_id: "criterion_01",
      description: "Implementation is verified",
      required: true,
      result_schema_ref: null,
      required_evidence_types: ["test-report"],
    },
  ],
  verifier,
  priority: "normal",
  accept_by: "2026-07-16T00:00:00.000Z",
  result_due_at: "2026-07-20T00:00:00.000Z",
};

const clock: Clock = {
  now: () => "2026-07-15T08:00:00.000Z",
};

class StaticJournal implements EventJournal {
  constructor(private readonly records: readonly EventRecord[]) {}

  async readStream(
    streamId: string,
    fromVersion = 0,
  ): Promise<readonly EventRecord[]> {
    return structuredClone(
      this.records.filter(
        (record) =>
          record.stream_id === streamId && record.stream_version >= fromVersion,
      ),
    );
  }

  async readPartition(
    requestedPartitionId: string,
    afterPosition: number,
    limit: number,
  ): Promise<readonly EventRecord[]> {
    return structuredClone(
      this.records
        .filter(
          (record) =>
            record.partition_id === requestedPartitionId &&
            record.partition_position > afterPosition,
        )
        .slice(0, limit),
    );
  }
}

function offered(
  handoffId = parentId,
  parentHandoffId: string | null = null,
  actor: ActorRef = initiator,
): HandoffEvent {
  return {
    event_type: "workfabric.handoff.offered.v1",
    handoff_id: handoffId,
    thread_id: parentId,
    initiator: actor,
    package: handoffPackage,
    parent_handoff_id: parentHandoffId,
    occurred_at: "2026-07-15T01:00:00.000Z",
  };
}

function accepted(handoffId = parentId): HandoffEvent {
  return {
    event_type: "workfabric.handoff.accepted.v1",
    handoff_id: handoffId,
    recipient,
    occurred_at: "2026-07-15T02:00:00.000Z",
  };
}

function statusReported(handoffId = parentId): HandoffEvent {
  return {
    event_type: "workfabric.handoff.status_reported.v1",
    handoff_id: handoffId,
    status: { state: "in_progress", progress: 40 },
    occurred_at: "2026-07-15T03:00:00.000Z",
  };
}

function resultReturned(handoffId = parentId): HandoffEvent {
  return {
    event_type: "workfabric.handoff.result_returned.v1",
    handoff_id: handoffId,
    result: { summary: "done", artifact_ids: ["artifact_01"] },
    occurred_at: "2026-07-15T04:00:00.000Z",
  };
}

function verified(handoffId = parentId): HandoffEvent {
  return {
    event_type: "workfabric.handoff.verified.v1",
    handoff_id: handoffId,
    satisfied_criterion_ids: ["criterion_01"],
    summary: [{ text: "verified" }],
    evidence: [{ artifact_id: "artifact_01" }],
    occurred_at: "2026-07-15T05:00:00.000Z",
  };
}

function closed(handoffId = parentId): HandoffEvent {
  return {
    event_type: "workfabric.handoff.closed.v1",
    handoff_id: handoffId,
    occurred_at: "2026-07-15T06:00:00.000Z",
  };
}

function transferred(handoffId = parentId): HandoffEvent {
  return {
    event_type: "workfabric.handoff.transferred.v1",
    handoff_id: handoffId,
    child_handoff_id: childId,
    occurred_at: "2026-07-15T05:30:00.000Z",
  };
}

function record(
  event: HandoffEvent,
  position: number,
  streamVersion: number,
  overrides: Partial<EventRecord> = {},
): EventRecord {
  return {
    event_id: `event_${position}`,
    event_type: event.event_type,
    schema_version: "1.0",
    exchange_id: "exchange_01",
    request_message_id: `message_${position}`,
    idempotency_key: `key_${position}`,
    thread_id: parentId,
    handoff_id: event.handoff_id,
    actor_id: initiator.actor_id,
    endpoint_id: "endpoint_01",
    visibility: "participants",
    visible_actor_ids: [initiator.actor_id, recipient.actor_id],
    visible_endpoint_ids: ["endpoint_01"],
    occurred_at: event.occurred_at,
    domain_data: handoffEventToJson(event),
    protocol_data: { resource_version: streamVersion },
    tenant_id: tenantId,
    partition_id: partitionId,
    partition_position: position,
    stream_id: event.handoff_id,
    stream_version: streamVersion,
    commit_id: `commit_${position}`,
    commit_ordinal: 0,
    ...overrides,
  };
}

function lifecycleRecords(): readonly EventRecord[] {
  return [
    record(offered(), 1, 1),
    record(accepted(), 2, 2),
    record(statusReported(), 3, 3),
    record(resultReturned(), 4, 4),
    record(verified(), 5, 5),
    record(closed(), 6, 6),
  ];
}

function fixture(records: readonly EventRecord[]) {
  const persistence = new MemoryExchangePersistence();
  const models = new MemoryHandoffReadModelStore();
  const projector = new HandoffProjector(
    new StaticJournal(records),
    persistence,
    persistence,
    models,
    clock,
  );
  return { persistence, models, projector };
}

describe("HandoffProjector", () => {
  it("rejects an invalid loaded checkpoint before Journal or model access", async () => {
    const invalidCheckpoints = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const invalidCheckpoint of invalidCheckpoints) {
      let journalReads = 0;
      let modelReads = 0;
      const journal: EventJournal = {
        async readStream() {
          journalReads += 1;
          return [];
        },
        async readPartition() {
          journalReads += 1;
          return [];
        },
      };
      const delegate = new MemoryHandoffReadModelStore();
      const models: HandoffReadModelStore = {
        get manifest() {
          return delegate.manifest;
        },
        async getHandoff(...args) {
          modelReads += 1;
          return delegate.getHandoff(...args);
        },
        putHandoff: (...args) => delegate.putHandoff(...args),
        listHandoffs: (...args) => delegate.listHandoffs(...args),
        clearPartition: (...args) => delegate.clearPartition(...args),
      };
      const checkpoints: ProjectionCheckpointStore = {
        async loadProjectionCheckpoint() {
          return invalidCheckpoint;
        },
        async advanceProjectionCheckpoint() {
          throw new Error("advance must not be called");
        },
        async resetProjectionCheckpoint() {},
      };
      const persistence = new MemoryExchangePersistence();
      const projector = new HandoffProjector(
        journal,
        checkpoints,
        persistence,
        models,
        clock,
      );

      await expect(projector.runPartition(partitionId, 10)).rejects.toThrow(
        /checkpoint.*non-negative safe integer/i,
      );
      expect(journalReads).toBe(0);
      expect(modelReads).toBe(0);
      expect(await models.listHandoffs(partitionId)).toEqual([]);
      expect(
        await persistence.listProjectionFailures(
          HANDOFF_PROJECTOR_ID,
          partitionId,
        ),
      ).toEqual([]);
    }
  });

  it("returns idle without changing an empty Partition", async () => {
    const { persistence, models, projector } = fixture([]);

    await expect(projector.runPartition(partitionId, 10)).resolves.toEqual({
      kind: "idle",
      position: 0,
    });
    expect(await models.listHandoffs(partitionId)).toEqual([]);
    expect(
      await persistence.loadProjectionCheckpoint(
        HANDOFF_PROJECTOR_ID,
        partitionId,
      ),
    ).toBe(0);
  });

  it("projects Offer and derives only the Initiator Assignment", async () => {
    const { models, projector } = fixture([record(offered(), 1, 1)]);

    await expect(projector.runPartition(partitionId, 10)).resolves.toEqual({
      kind: "advanced",
      position: 1,
      processed: 1,
    });
    const model = await models.getHandoff(parentId);
    expect(model).toMatchObject({
      tenant_id: tenantId,
      partition_id: partitionId,
      handoff_id: parentId,
      stream_version: 1,
      latest_status: null,
      state: { lifecycle_state: "offered", resource_version: 1 },
    });
    expect(model === null ? null : assignmentFromHandoff(model)).toEqual({
      tenant_id: tenantId,
      handoff_id: parentId,
      work_reference: handoffPackage.work_reference,
      responsible_actor: initiator,
      lifecycle_state: "offered",
      accept_by: handoffPackage.accept_by,
      result_due_at: handoffPackage.result_due_at,
      latest_status: null,
    });
  });

  it("moves responsibility across Accept, Result, Verify, and Close", async () => {
    const records = lifecycleRecords();
    const { models, projector } = fixture(records);

    await projector.runPartition(partitionId, 2);
    let model = await models.getHandoff(parentId);
    expect(model === null ? null : assignmentFromHandoff(model)).toMatchObject({
      responsible_actor: recipient,
      lifecycle_state: "accepted",
    });

    await projector.runPartition(partitionId, 1);
    model = await models.getHandoff(parentId);
    expect(model).toMatchObject({
      stream_version: 3,
      latest_status: { state: "in_progress", progress: 40 },
      state: { lifecycle_state: "accepted" },
    });

    await projector.runPartition(partitionId, 2);
    model = await models.getHandoff(parentId);
    expect(model === null ? null : assignmentFromHandoff(model)).toMatchObject({
      responsible_actor: verifier,
      lifecycle_state: "verified",
      latest_status: { state: "in_progress", progress: 40 },
    });

    await projector.runPartition(partitionId, 1);
    model = await models.getHandoff(parentId);
    expect(model?.state.lifecycle_state).toBe("closed");
    expect(model === null ? null : assignmentFromHandoff(model)).toBeNull();
  });

  it("projects Transfer parent and child streams without a second Assignment truth", async () => {
    const records = [
      record(offered(), 1, 1),
      record(accepted(), 2, 2),
      record(offered(childId, parentId, recipient), 3, 1),
      record(accepted(childId), 4, 2),
      record(transferred(), 5, 3),
    ];
    const { models, projector } = fixture(records);

    await expect(projector.runPartition(partitionId, 10)).resolves.toEqual({
      kind: "advanced",
      position: 5,
      processed: 5,
    });
    const parent = await models.getHandoff(parentId);
    const child = await models.getHandoff(childId);
    expect(parent).toMatchObject({
      stream_version: 3,
      state: { lifecycle_state: "transferred", child_handoff_id: childId },
    });
    expect(parent === null ? null : assignmentFromHandoff(parent)).toBeNull();
    expect(child).toMatchObject({
      stream_version: 2,
      state: {
        lifecycle_state: "accepted",
        parent_handoff_id: parentId,
      },
    });
    expect(child === null ? null : assignmentFromHandoff(child)).toMatchObject({
      responsible_actor: recipient,
      lifecycle_state: "accepted",
    });
  });

  it("continues from a non-zero checkpoint and does not require positions to start at one", async () => {
    const persistence = new MemoryExchangePersistence();
    await persistence.advanceProjectionCheckpoint(
      HANDOFF_PROJECTOR_ID,
      partitionId,
      0,
      40,
    );
    const models = new MemoryHandoffReadModelStore();
    const projector = new HandoffProjector(
      new StaticJournal([record(offered(), 41, 1)]),
      persistence,
      persistence,
      models,
      clock,
    );

    await expect(projector.runPartition(partitionId, 10)).resolves.toEqual({
      kind: "advanced",
      position: 41,
      processed: 1,
    });
  });

  it("safely replays a model write after checkpoint CAS failure", async () => {
    const persistence = new MemoryExchangePersistence();
    const models = new MemoryHandoffReadModelStore();
    let failOnce = true;
    const checkpoints: ProjectionCheckpointStore = {
      loadProjectionCheckpoint: (...args) =>
        persistence.loadProjectionCheckpoint(...args),
      resetProjectionCheckpoint: (...args) =>
        persistence.resetProjectionCheckpoint(...args),
      async advanceProjectionCheckpoint(...args): Promise<boolean> {
        if (failOnce) {
          failOnce = false;
          return false;
        }
        return persistence.advanceProjectionCheckpoint(...args);
      },
    };
    const projector = new HandoffProjector(
      new StaticJournal([record(offered(), 1, 1)]),
      checkpoints,
      persistence,
      models,
      clock,
    );

    await expect(projector.runPartition(partitionId, 10)).resolves.toMatchObject({
      kind: "blocked",
      position: 0,
      event_id: "event_1",
    });
    expect((await models.getHandoff(parentId))?.stream_version).toBe(1);
    await expect(projector.runPartition(partitionId, 10)).resolves.toEqual({
      kind: "advanced",
      position: 1,
      processed: 1,
    });
    expect((await models.getHandoff(parentId))?.stream_version).toBe(1);
  });

  it("safely replays after checkpoint advancement throws", async () => {
    const persistence = new MemoryExchangePersistence();
    const models = new MemoryHandoffReadModelStore();
    let throwOnce = true;
    const checkpoints: ProjectionCheckpointStore = {
      loadProjectionCheckpoint: (...args) =>
        persistence.loadProjectionCheckpoint(...args),
      resetProjectionCheckpoint: (...args) =>
        persistence.resetProjectionCheckpoint(...args),
      async advanceProjectionCheckpoint(...args): Promise<boolean> {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("injected checkpoint outage");
        }
        return persistence.advanceProjectionCheckpoint(...args);
      },
    };
    const projector = new HandoffProjector(
      new StaticJournal([record(offered(), 1, 1)]),
      checkpoints,
      persistence,
      models,
      clock,
    );

    await expect(projector.runPartition(partitionId, 10)).resolves.toMatchObject({
      kind: "blocked",
      position: 0,
      reason: expect.stringMatching(/checkpoint.*outage/i),
    });
    expect((await models.getHandoff(parentId))?.stream_version).toBe(1);
    await expect(projector.runPartition(partitionId, 10)).resolves.toEqual({
      kind: "advanced",
      position: 1,
      processed: 1,
    });
  });

  it("does not advance when a model write fails and can retry", async () => {
    const persistence = new MemoryExchangePersistence();
    const delegate = new MemoryHandoffReadModelStore();
    let failOnce = true;
    const models: HandoffReadModelStore = {
      get manifest() {
        return delegate.manifest;
      },
      getHandoff: (...args) => delegate.getHandoff(...args),
      listHandoffs: (...args) => delegate.listHandoffs(...args),
      clearPartition: (...args) => delegate.clearPartition(...args),
      async putHandoff(model): Promise<void> {
        if (failOnce) {
          failOnce = false;
          throw new Error("injected model outage");
        }
        await delegate.putHandoff(model);
      },
    };
    const projector = new HandoffProjector(
      new StaticJournal([record(offered(), 1, 1)]),
      persistence,
      persistence,
      models,
      clock,
    );

    await expect(projector.runPartition(partitionId, 10)).resolves.toMatchObject({
      kind: "blocked",
      position: 0,
      reason: expect.stringMatching(/model write.*outage/i),
    });
    expect(await delegate.getHandoff(parentId)).toBeNull();
    expect(
      await persistence.loadProjectionCheckpoint(
        HANDOFF_PROJECTOR_ID,
        partitionId,
      ),
    ).toBe(0);
    await expect(projector.runPartition(partitionId, 10)).resolves.toEqual({
      kind: "advanced",
      position: 1,
      processed: 1,
    });
  });

  it("blocks a per-stream version gap, records a bounded failure, and does not advance", async () => {
    const gap = record(offered(), 1, 2);
    const { persistence, models, projector } = fixture([gap]);

    const result = await projector.runPartition(partitionId, 10);

    expect(result).toMatchObject({
      kind: "blocked",
      position: 0,
      event_id: gap.event_id,
      reason: expect.stringMatching(/stream version gap/i),
    });
    expect(await models.getHandoff(parentId)).toBeNull();
    expect(
      await persistence.loadProjectionCheckpoint(
        HANDOFF_PROJECTOR_ID,
        partitionId,
      ),
    ).toBe(0);
    const failures = await persistence.listProjectionFailures(
      HANDOFF_PROJECTOR_ID,
      partitionId,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      event_id: gap.event_id,
      position: 1,
      recorded_at: clock.now(),
    });
    expect(failures[0]?.reason.length).toBeLessThanOrEqual(512);
  });

  it("blocks poison domain data without leaking an object or stack", async () => {
    const poison = record(offered(), 1, 1, {
      domain_data: { event_type: "not-a-handoff-event", secret: "do-not-copy" },
    });
    const { persistence, projector } = fixture([poison]);

    const result = await projector.runPartition(partitionId, 10);

    expect(result).toMatchObject({ kind: "blocked", event_id: poison.event_id });
    const [failure] = await persistence.listProjectionFailures(
      HANDOFF_PROJECTOR_ID,
      partitionId,
    );
    expect(failure?.reason).toMatch(/decode/i);
    expect(failure?.reason).not.toContain("do-not-copy");
    expect(failure?.reason).not.toContain("\n    at ");
  });

  it("stops on a Partition position gap instead of skipping a fact", async () => {
    const skipped = record(offered(), 2, 1);
    const { persistence, projector } = fixture([skipped]);

    await expect(projector.runPartition(partitionId, 10)).resolves.toMatchObject({
      kind: "blocked",
      position: 0,
      event_id: skipped.event_id,
      reason: expect.stringMatching(/partition position gap/i),
    });
    expect(
      await persistence.loadProjectionCheckpoint(
        HANDOFF_PROJECTOR_ID,
        partitionId,
      ),
    ).toBe(0);
  });

  it("attributes a wrong-Partition Journal record to the requested Partition", async () => {
    const wrongPartition = record(offered(), 1, 1, {
      partition_id: "partition_untrusted",
    });
    const persistence = new MemoryExchangePersistence();
    const journal: EventJournal = {
      async readStream() {
        return [];
      },
      async readPartition() {
        return [wrongPartition];
      },
    };
    const projector = new HandoffProjector(
      journal,
      persistence,
      persistence,
      new MemoryHandoffReadModelStore(),
      clock,
    );

    await expect(projector.runPartition(partitionId, 10)).resolves.toMatchObject({
      kind: "blocked",
      position: 0,
      event_id: wrongPartition.event_id,
      reason: expect.stringMatching(/partition_id/i),
    });
    expect(
      await persistence.listProjectionFailures(
        HANDOFF_PROJECTOR_ID,
        partitionId,
      ),
    ).toHaveLength(1);
    expect(
      await persistence.listProjectionFailures(
        HANDOFF_PROJECTOR_ID,
        wrongPartition.partition_id,
      ),
    ).toEqual([]);
  });

  it("rejects untrusted Event identity and cursor positions before mutation", async () => {
    const invalidRecords = [
      record(offered(), 1, 1, { event_id: "" }),
      record(offered(), 1, 1, {
        event_id: 42 as unknown as string,
      }),
      ...[
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ].map((invalidPosition) =>
        record(offered(), invalidPosition, 1),
      ),
    ];
    for (const invalidRecord of invalidRecords) {
      let modelReads = 0;
      let modelWrites = 0;
      let checkpointAdvances = 0;
      const persistence = new MemoryExchangePersistence();
      const delegate = new MemoryHandoffReadModelStore();
      const models: HandoffReadModelStore = {
        get manifest() {
          return delegate.manifest;
        },
        async getHandoff(...args) {
          modelReads += 1;
          return delegate.getHandoff(...args);
        },
        async putHandoff(...args) {
          modelWrites += 1;
          await delegate.putHandoff(...args);
        },
        listHandoffs: (...args) => delegate.listHandoffs(...args),
        clearPartition: (...args) => delegate.clearPartition(...args),
      };
      const checkpoints: ProjectionCheckpointStore = {
        loadProjectionCheckpoint: (...args) =>
          persistence.loadProjectionCheckpoint(...args),
        resetProjectionCheckpoint: (...args) =>
          persistence.resetProjectionCheckpoint(...args),
        async advanceProjectionCheckpoint(...args) {
          checkpointAdvances += 1;
          return persistence.advanceProjectionCheckpoint(...args);
        },
      };
      const journal: EventJournal = {
        async readStream() {
          return [];
        },
        async readPartition() {
          return [invalidRecord];
        },
      };
      const projector = new HandoffProjector(
        journal,
        checkpoints,
        persistence,
        models,
        clock,
      );

      await expect(projector.runPartition(partitionId, 10)).rejects.toThrow(
        /Journal record.*(event_id|partition_position)/i,
      );
      expect(modelReads).toBe(0);
      expect(modelWrites).toBe(0);
      expect(checkpointAdvances).toBe(0);
      expect(await delegate.getHandoff(parentId)).toBeNull();
      expect(
        await persistence.loadProjectionCheckpoint(
          HANDOFF_PROJECTOR_ID,
          partitionId,
        ),
      ).toBe(0);
      expect(
        await persistence.listProjectionFailures(
          HANDOFF_PROJECTOR_ID,
          partitionId,
        ),
      ).toEqual([]);
    }
  });

  it("rejects an unsupported Journal schema version before evolving state", async () => {
    const unsupported = record(offered(), 1, 1, {
      schema_version: "2.0" as "1.0",
    });
    const { models, projector } = fixture([unsupported]);

    await expect(projector.runPartition(partitionId, 10)).resolves.toMatchObject({
      kind: "blocked",
      reason: expect.stringMatching(/schema_version/i),
    });
    expect(await models.getHandoff(parentId)).toBeNull();
  });

  it("blocks unsafe stream versions and empty Tenant metadata during decode", async () => {
    for (const invalid of [
      record(offered(), 1, Number.MAX_SAFE_INTEGER + 1),
      record(offered(), 1, 1, { tenant_id: "" }),
    ]) {
      const { models, projector } = fixture([invalid]);
      const result = await projector.runPartition(partitionId, 10);
      expect(result).toMatchObject({
        kind: "blocked",
        position: 0,
        reason: expect.stringMatching(/decode.*(safe|tenant_id)/i),
      });
      expect(await models.getHandoff(parentId)).toBeNull();
    }
  });

  it("clears and rebuilds only the target Partition to a deeply equal view", async () => {
    const records = lifecycleRecords();
    const { persistence, models, projector } = fixture(records);
    await projector.runPartition(partitionId, 10);
    const incremental = await models.listHandoffs(partitionId);
    await models.putHandoff({
      tenant_id: "tenant_other",
      partition_id: "partition_other",
      handoff_id: "handoff_other",
      stream_version: 1,
      state: { opaque: true },
      latest_status: null,
    });

    await projector.rebuildPartition(partitionId, 2);

    expect(await models.listHandoffs(partitionId)).toEqual(incremental);
    expect(await models.getHandoff("handoff_other")).not.toBeNull();
    expect(
      await persistence.loadProjectionCheckpoint(
        HANDOFF_PROJECTOR_ID,
        partitionId,
      ),
    ).toBe(6);
  });

  it("fails rebuild immediately when a poison Event blocks progress", async () => {
    const poison = record(offered(), 1, 2);
    const { projector } = fixture([poison]);

    await expect(projector.rebuildPartition(partitionId, 1)).rejects.toThrow(
      /blocked.*event_1/i,
    );
  });
});

describe("Memory ProjectionFailureStore", () => {
  it("clones values, isolates projector/Partition, and deduplicates an exact failure", async () => {
    const store = new MemoryExchangePersistence();
    const failure = {
      projector_id: HANDOFF_PROJECTOR_ID,
      partition_id: partitionId,
      event_id: "event_failure",
      position: 7,
      reason: "decode failed",
      recorded_at: clock.now(),
    };

    await store.putProjectionFailure(failure);
    await store.putProjectionFailure({
      ...failure,
      reason: "later retry must not replace the first reason",
      recorded_at: "2026-07-15T09:00:00.000Z",
    });
    (failure as { reason: string }).reason = "mutated input";
    const first = await store.listProjectionFailures(
      HANDOFF_PROJECTOR_ID,
      partitionId,
    );
    expect(first).toHaveLength(1);
    expect(first[0]?.reason).toBe("decode failed");
    (first[0] as { reason: string }).reason = "mutated output";
    expect(
      await store.listProjectionFailures(HANDOFF_PROJECTOR_ID, partitionId),
    ).toEqual([{ ...failure, reason: "decode failed" }]);
    expect(
      await store.listProjectionFailures("projector_other", partitionId),
    ).toEqual([]);
    expect(
      await store.listProjectionFailures(
        HANDOFF_PROJECTOR_ID,
        "partition_other",
      ),
    ).toEqual([]);
  });

  it("rejects unsafe positions and empty identity fields", async () => {
    const store = new MemoryExchangePersistence();
    const valid = {
      projector_id: HANDOFF_PROJECTOR_ID,
      partition_id: partitionId,
      event_id: "event_failure",
      position: 1,
      reason: "decode failed",
      recorded_at: clock.now(),
    };

    await expect(
      store.putProjectionFailure({
        ...valid,
        position: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow(/safe|position/i);
    for (const field of [
      "projector_id",
      "partition_id",
      "event_id",
      "reason",
      "recorded_at",
    ] as const) {
      await expect(
        store.putProjectionFailure({ ...valid, [field]: "" }),
      ).rejects.toThrow(new RegExp(field));
    }
    await expect(
      store.listProjectionFailures("", partitionId),
    ).rejects.toThrow(/projector_id/);
    await expect(
      store.listProjectionFailures(
        HANDOFF_PROJECTOR_ID,
        42 as unknown as string,
      ),
    ).rejects.toThrow(/partition_id/);
  });
});

describe("MemoryHandoffReadModelStore", () => {
  it("rejects an unsafe stream version at the Adapter boundary", async () => {
    const store = new MemoryHandoffReadModelStore();

    await expect(
      store.putHandoff({
        tenant_id: tenantId,
        partition_id: partitionId,
        handoff_id: parentId,
        stream_version: Number.MAX_SAFE_INTEGER + 1,
        state: { opaque: true },
        latest_status: null,
      }),
    ).rejects.toThrow(/safe|stream_version/i);
  });

  it("rejects non-string model identity and empty lookup/Partition keys", async () => {
    const store = new MemoryHandoffReadModelStore();
    const valid: HandoffReadModel = {
      tenant_id: tenantId,
      partition_id: partitionId,
      handoff_id: parentId,
      stream_version: 1,
      state: { opaque: true },
      latest_status: null,
    };

    for (const field of [
      "tenant_id",
      "partition_id",
      "handoff_id",
    ] as const) {
      await expect(
        store.putHandoff({ ...valid, [field]: 42 as unknown as string }),
      ).rejects.toThrow(new RegExp(field));
    }
    await expect(store.getHandoff(42 as unknown as string)).rejects.toThrow(
      /handoff_id/,
    );
    await expect(store.listHandoffs(42 as unknown as string)).rejects.toThrow(
      /partition_id/,
    );
    await expect(store.clearPartition("")).rejects.toThrow(/partition_id/);
  });
});
