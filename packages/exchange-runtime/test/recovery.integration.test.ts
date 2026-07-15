import { beforeAll, describe, expect, it } from "vitest";

import { InProcessSignalAdapter } from "@work-fabric/adapter-signal-in-process";
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import {
  handoffEventToJson,
  type Clock,
  type HandoffEvent,
  type HandoffPackage,
  type IdGenerator,
} from "@work-fabric/exchange-core";
import type {
  EventJournal,
  EventRecord,
  ProjectionCheckpointStore,
  RuntimeSubscription,
  SubscriptionFilter,
} from "@work-fabric/exchange-spi";
import {
  loadWfppSchemaValidator,
  type WfppSchemaValidator,
} from "@work-fabric/protocol-runtime";

import {
  CursorPullService,
  DefaultSubscriptionDeliveryPolicy,
  HANDOFF_PROJECTOR_ID,
  HandoffProjector,
  MemoryHandoffReadModelStore,
  MemorySubscriptionStore,
  OpaqueCursorCodec,
  SignalDispatcher,
  type DispatchObserver,
} from "../src/index.js";

const tenantId = "tenant_recovery";
const partitionId = "partition_recovery";
const handoffId = "handoff_recovery";
const subscriberActor = "actor_subscriber";
const subscriberEndpoint = "endpoint_subscriber";
const cursorSecret = new TextEncoder().encode(
  "0123456789abcdef0123456789abcdef",
);

const clock: Clock = {
  now: () => "2026-07-15T09:00:10Z",
};

class MutableClock implements Clock {
  constructor(public instant: string) {}

  now(): string {
    return this.instant;
  }
}

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

  async readPartition(
    requestedPartitionId: string,
    afterPosition: number,
    limit: number,
  ) {
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

class TestIds implements IdGenerator {
  private count = 0;

  nextId(kind: "handoff" | "event" | "commit" | "receipt" | "delivery") {
    this.count += 1;
    return `${kind}_recovery_${this.count}`;
  }
}

const handoffPackage: HandoffPackage = {
  work_reference: { uri: "urn:work:recovery", extensions: {} },
  target: { actor_id: subscriberActor },
  intent: [{ kind: "text", media_type: "text/plain", text: "Recover" }],
  context: null,
  authority_scope: {
    delegation_id: "delegation_recovery",
    scopes: ["work:read"],
    resource_refs: ["urn:work:recovery"],
    expires_at: "2026-07-16T09:00:00Z",
    may_redelegate: false,
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
  verifier: { actor_id: "actor_verifier", actor_type: "human" },
  priority: "normal",
  accept_by: "2026-07-15T10:00:00Z",
  result_due_at: "2026-07-16T09:00:00Z",
};

function offered(): HandoffEvent {
  return {
    event_type: "workfabric.handoff.offered.v1",
    handoff_id: handoffId,
    thread_id: handoffId,
    initiator: { actor_id: "actor_human", actor_type: "human" },
    package: handoffPackage,
    parent_handoff_id: null,
    occurred_at: "2026-07-15T09:00:00Z",
  };
}

function accepted(): HandoffEvent {
  return {
    event_type: "workfabric.handoff.accepted.v1",
    handoff_id: handoffId,
    recipient: { actor_id: subscriberActor, actor_type: "agent" },
    occurred_at: "2026-07-15T09:00:01Z",
  };
}

function projectionRecord(
  event: HandoffEvent,
  position: number,
  streamVersion: number,
  overrides: Partial<EventRecord> = {},
): EventRecord {
  return {
    ...signalRecord(position, event.event_type),
    handoff_id: event.handoff_id,
    thread_id: handoffId,
    occurred_at: event.occurred_at,
    domain_data: handoffEventToJson(event),
    protocol_data: { resource_version: streamVersion },
    stream_id: event.handoff_id,
    stream_version: streamVersion,
    ...overrides,
  };
}

function signalRecord(
  position: number,
  eventType = "workfabric.handoff.accepted.v1",
  overrides: Partial<EventRecord> = {},
): EventRecord {
  return {
    event_id: `event_recovery_${position}`,
    event_type: eventType,
    schema_version: "1.0",
    exchange_id: "exchange_recovery",
    request_message_id: `message_recovery_${position}`,
    idempotency_key: `key-recovery-${position}`,
    thread_id: handoffId,
    handoff_id: handoffId,
    actor_id: "actor_human",
    endpoint_id: "endpoint_human",
    visibility: "participants",
    visible_actor_ids: ["actor_human", subscriberActor],
    visible_endpoint_ids: ["endpoint_human", subscriberEndpoint],
    occurred_at: `2026-07-15T09:00:0${position}Z`,
    domain_data: { private: `domain-${position}` },
    protocol_data: {
      resource_version: position,
      change: {
        change_type: eventType.split(".").at(-2) ?? "changed",
        from_state: position === 1 ? null : "offered",
        to_state: eventType.includes("accepted") ? "accepted" : "offered",
        details: {
          work_reference_uri: "urn:work:recovery",
          capability_ids: [],
        },
      },
      receipt: null,
    },
    tenant_id: tenantId,
    partition_id: partitionId,
    partition_position: position,
    stream_id: handoffId,
    stream_version: position,
    commit_id: `commit_recovery_${position}`,
    commit_ordinal: 0,
    ...overrides,
  };
}

const emptyFilter = (): SubscriptionFilter => ({
  event_types: [],
  actor_ids: [],
  endpoint_ids: [],
  thread_ids: [],
  handoff_ids: [],
  work_reference_uris: [],
  capability_ids: [],
  lifecycle_states: [],
});

function subscription(
  mode: "webhook" | "cursor_pull" = "webhook",
  overrides: Partial<RuntimeSubscription> = {},
): RuntimeSubscription {
  return {
    subscription_id: "subscription_recovery",
    tenant_id: tenantId,
    owner: { actor_id: subscriberActor, actor_type: "agent" },
    endpoint_id: subscriberEndpoint,
    filter: emptyFilter(),
    destination: {
      destination_id: "destination_recovery",
      binding: "in-process",
      configuration: {},
    },
    delivery_mode: mode,
    state: "active",
    max_attempts: 3,
    created_at: "2026-07-15T08:00:00Z",
    updated_at: "2026-07-15T08:00:00Z",
    ...overrides,
  };
}

let schemas: WfppSchemaValidator;

beforeAll(async () => {
  schemas = await loadWfppSchemaValidator("protocol/schemas/v1");
});

describe("projection recovery", () => {
  it("rebuilds a cleared projection store to the same view", async () => {
    const records = [
      projectionRecord(offered(), 1, 1),
      projectionRecord(accepted(), 2, 2),
    ];
    const persistence = new MemoryExchangePersistence();
    const models = new MemoryHandoffReadModelStore();
    const projector = new HandoffProjector(
      new StaticJournal(records),
      persistence,
      persistence,
      models,
      clock,
    );
    await projector.runPartition(partitionId, 10);
    const original = await models.listHandoffs(partitionId);
    await models.clearPartition(partitionId);
    expect(await models.listHandoffs(partitionId)).toEqual([]);

    await projector.rebuildPartition(partitionId, 1);

    expect(await models.listHandoffs(partitionId)).toEqual(original);
    expect(
      await persistence.loadProjectionCheckpoint(
        HANDOFF_PROJECTOR_ID,
        partitionId,
      ),
    ).toBe(2);
  });

  it("idempotently replays when model write succeeds before checkpoint failure", async () => {
    const persistence = new MemoryExchangePersistence();
    const models = new MemoryHandoffReadModelStore();
    let failOnce = true;
    const checkpoints: ProjectionCheckpointStore = {
      loadProjectionCheckpoint: (...args) =>
        persistence.loadProjectionCheckpoint(...args),
      resetProjectionCheckpoint: (...args) =>
        persistence.resetProjectionCheckpoint(...args),
      async advanceProjectionCheckpoint(...args) {
        if (failOnce) {
          failOnce = false;
          return false;
        }
        return persistence.advanceProjectionCheckpoint(...args);
      },
    };
    const projector = new HandoffProjector(
      new StaticJournal([projectionRecord(offered(), 1, 1)]),
      checkpoints,
      persistence,
      models,
      clock,
    );

    await expect(projector.runPartition(partitionId, 10)).resolves.toMatchObject({
      kind: "blocked",
      position: 0,
    });
    expect((await models.getHandoff(handoffId))?.stream_version).toBe(1);
    await expect(projector.runPartition(partitionId, 10)).resolves.toEqual({
      kind: "advanced",
      position: 1,
      processed: 1,
    });
    expect((await models.getHandoff(handoffId))?.stream_version).toBe(1);
  });

  it("isolates poison domain_data and leaves its checkpoint unchanged", async () => {
    const poisonPartition = "partition_poison";
    const goodPartition = "partition_good";
    const poison = projectionRecord(offered(), 1, 1, {
      partition_id: poisonPartition,
      domain_data: { poison: true },
    });
    const good = projectionRecord(offered(), 1, 1, {
      event_id: "event_good_1",
      partition_id: goodPartition,
    });
    const persistence = new MemoryExchangePersistence();
    const models = new MemoryHandoffReadModelStore();
    const projector = new HandoffProjector(
      new StaticJournal([poison, good]),
      persistence,
      persistence,
      models,
      clock,
    );

    await expect(projector.runPartition(poisonPartition, 10)).resolves.toMatchObject({
      kind: "blocked",
      position: 0,
      event_id: poison.event_id,
    });
    await expect(projector.runPartition(goodPartition, 10)).resolves.toMatchObject({
      kind: "advanced",
      position: 1,
    });
    expect(
      await persistence.loadProjectionCheckpoint(
        HANDOFF_PROJECTOR_ID,
        poisonPartition,
      ),
    ).toBe(0);
    expect(
      await persistence.listProjectionFailures(
        HANDOFF_PROJECTOR_ID,
        poisonPartition,
      ),
    ).toHaveLength(1);
    expect(
      await persistence.loadProjectionCheckpoint(
        HANDOFF_PROJECTOR_ID,
        goodPartition,
      ),
    ).toBe(1);
  });
});

describe("Signal and Cursor recovery", () => {
  it("backs off an actual retryable Signal failure and later accepts it", async () => {
    const record = signalRecord(1);
    const persistence = new MemoryExchangePersistence();
    const subscriptions = new MemorySubscriptionStore();
    await subscriptions.putSubscription(subscription());
    const signal = new InProcessSignalAdapter();
    signal.setOutcome(record.event_id, {
      kind: "retryable_failure",
      detail: "temporarily offline",
    });
    const retryClock = new MutableClock("2026-07-15T09:00:10Z");
    const dispatcher = new SignalDispatcher(
      new StaticJournal([record]),
      persistence,
      subscriptions,
      new DefaultSubscriptionDeliveryPolicy(),
      signal,
      retryClock,
      { base_delay_seconds: 1, max_delay_seconds: 8 },
      schemas,
    );

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);
    expect(
      await persistence.listDeliveryAttempts(
        "subscription_recovery",
        record.event_id,
      ),
    ).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: "retryable_failure",
        next_attempt_at: "2026-07-15T09:00:11Z",
      }),
    ]);
    expect(
      await persistence.loadDeliveryPosition(
        "subscription_recovery",
        partitionId,
      ),
    ).toBe(0);

    signal.setOutcome(record.event_id, { kind: "accepted" });
    await dispatcher.dispatchPartition(partitionId, tenantId, 10);
    expect(signal.deliveries()).toHaveLength(1);

    retryClock.instant = "2026-07-15T09:00:11Z";
    await dispatcher.dispatchPartition(partitionId, tenantId, 10);

    expect(
      (
        await persistence.listDeliveryAttempts(
          "subscription_recovery",
          record.event_id,
        )
      ).map(({ outcome }) => outcome),
    ).toEqual(["retryable_failure", "accepted"]);
    expect(signal.deliveries()).toHaveLength(2);
    expect(
      await persistence.loadDeliveryPosition(
        "subscription_recovery",
        partitionId,
      ),
    ).toBe(1);
    expect(
      await persistence.listDeadLetters(
        "subscription_recovery",
        record.event_id,
      ),
    ).toEqual([]);
  });

  it("redelivers the same Event ID after acceptance and a crash before position", async () => {
    const record = signalRecord(1);
    const persistence = new MemoryExchangePersistence();
    const subscriptions = new MemorySubscriptionStore();
    await subscriptions.putSubscription(subscription());
    const signal = new InProcessSignalAdapter();
    let crash = true;
    const observer: DispatchObserver = {
      async afterDelivery() {
        if (crash) {
          crash = false;
          throw new Error("simulated post-send crash");
        }
      },
    };
    const first = new SignalDispatcher(
      new StaticJournal([record]),
      persistence,
      subscriptions,
      new DefaultSubscriptionDeliveryPolicy(),
      signal,
      clock,
      { base_delay_seconds: 1, max_delay_seconds: 8 },
      schemas,
      observer,
    );
    await first.dispatchPartition(partitionId, tenantId, 10);
    expect(
      await persistence.loadDeliveryPosition(
        "subscription_recovery",
        partitionId,
      ),
    ).toBe(0);

    const restarted = new SignalDispatcher(
      new StaticJournal([record]),
      persistence,
      subscriptions,
      new DefaultSubscriptionDeliveryPolicy(),
      signal,
      clock,
      { base_delay_seconds: 1, max_delay_seconds: 8 },
      schemas,
    );
    await restarted.dispatchPartition(partitionId, tenantId, 10);

    expect(signal.deliveries().map(({ event }) => event.id)).toEqual([
      record.event_id,
      record.event_id,
    ]);
    expect(
      await persistence.loadDeliveryPosition(
        "subscription_recovery",
        partitionId,
      ),
    ).toBe(1);
  });

  it("filters a non-participant Subscription without delivering", async () => {
    const persistence = new MemoryExchangePersistence();
    const subscriptions = new MemorySubscriptionStore();
    await subscriptions.putSubscription(
      subscription("webhook", {
        owner: { actor_id: "actor_outsider", actor_type: "agent" },
        endpoint_id: "endpoint_outsider",
      }),
    );
    const signal = new InProcessSignalAdapter();
    const dispatcher = new SignalDispatcher(
      new StaticJournal([signalRecord(1)]),
      persistence,
      subscriptions,
      new DefaultSubscriptionDeliveryPolicy(),
      signal,
      clock,
      { base_delay_seconds: 1, max_delay_seconds: 8 },
      schemas,
    );

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);

    expect(signal.deliveries()).toEqual([]);
    expect(
      await persistence.loadDeliveryPosition(
        "subscription_recovery",
        partitionId,
      ),
    ).toBe(1);
  });

  it("rejects a tampered Cursor without changing delivery state", async () => {
    const persistence = new MemoryExchangePersistence();
    const subscriptions = new MemorySubscriptionStore();
    await subscriptions.putSubscription(subscription("cursor_pull"));
    const cursors = new OpaqueCursorCodec(cursorSecret);
    const service = new CursorPullService(
      new StaticJournal([signalRecord(1)]),
      persistence,
      subscriptions,
      new DefaultSubscriptionDeliveryPolicy(),
      clock,
      new TestIds(),
      cursors,
      schemas,
      30,
    );
    const valid = cursors.encode({
      subscription_id: "subscription_recovery",
      partition_id: partitionId,
      position: 0,
      expires_at: "2026-07-15T10:00:00Z",
    });
    const tampered = `${valid.slice(0, -1)}${valid.endsWith("A") ? "B" : "A"}`;

    await expect(
      service.pull("subscription_recovery", partitionId, tampered, 10),
    ).resolves.toMatchObject({ kind: "error", code: "invalid_argument" });
    expect(
      await persistence.loadDeliveryPosition(
        "subscription_recovery",
        partitionId,
      ),
    ).toBe(0);
    expect(
      await persistence.getActiveDelivery(
        "subscription_recovery",
        partitionId,
      ),
    ).toBeNull();
  });

  it("advances delivery position only after Cursor Pull is acknowledged", async () => {
    const record = signalRecord(1);
    const persistence = new MemoryExchangePersistence();
    const subscriptions = new MemorySubscriptionStore();
    await subscriptions.putSubscription(subscription("cursor_pull"));
    const service = new CursorPullService(
      new StaticJournal([record]),
      persistence,
      subscriptions,
      new DefaultSubscriptionDeliveryPolicy(),
      clock,
      new TestIds(),
      new OpaqueCursorCodec(cursorSecret),
      schemas,
      30,
    );

    const pulled = await service.pull(
      "subscription_recovery",
      partitionId,
      null,
      10,
    );
    if (pulled.kind !== "delivery") throw new Error("Expected Cursor Delivery");
    expect(
      await persistence.loadDeliveryPosition(
        "subscription_recovery",
        partitionId,
      ),
    ).toBe(0);
    const acknowledged = await service.acknowledge({
      delivery_id: pulled.delivery.delivery_id,
      subscription_id: "subscription_recovery",
      outcome: "acknowledged",
      acknowledged_at: "2026-07-15T09:00:10Z",
      cursor: pulled.delivery.next_cursor,
      last_event_id: record.event_id,
    });

    expect(acknowledged.kind).toBe("acknowledged");
    expect(
      await persistence.loadDeliveryPosition(
        "subscription_recovery",
        partitionId,
      ),
    ).toBe(1);
  });
});
