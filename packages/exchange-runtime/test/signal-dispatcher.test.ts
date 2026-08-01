import { beforeAll, describe, expect, it } from "vitest";

import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import type { Clock } from "@work-fabric/exchange-core";
import type {
  EventJournal,
  EventRecord,
  ProtocolEvent,
  RuntimeSubscription,
  SignalAdapter,
  SignalDeliveryResult,
  SignalDestination,
  SubscriptionFilter,
  SubscriptionStore,
} from "@work-fabric/exchange-spi";
import type { SemanticObservation, SemanticTelemetryObserver } from "@work-fabric/operations-spi";
import {
  loadWfppSchemaValidator,
  type WfppSchemaValidator,
} from "@work-fabric/protocol-runtime";

import {
  DefaultSubscriptionDeliveryPolicy,
  MemorySubscriptionStore,
  SignalDispatcher,
  type DispatchObserver,
} from "../src/index.js";

const tenantId = "tenant_01";
const partitionId = "partition_push_01";
let schemas: WfppSchemaValidator;

beforeAll(async () => {
  schemas = await loadWfppSchemaValidator("protocol/schemas/v1");
});

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

function event(
  position: number,
  eventType = "workfabric.handoff.accepted.v1",
  overrides: Partial<EventRecord> = {},
): EventRecord {
  return {
    event_id: `event_${position}`,
    event_type: eventType,
    schema_version: "1.0",
    exchange_id: "exchange_01",
    request_message_id: `message_${position}`,
    idempotency_key: `key_${position}`,
    thread_id: "thread_01",
    handoff_id: "handoff_01",
    actor_id: "actor_01",
    endpoint_id: "endpoint_01",
    visibility: "participants",
    visible_actor_ids: ["actor_01", "subscriber_actor"],
    visible_endpoint_ids: ["endpoint_01", "subscriber_endpoint"],
    occurred_at: `2026-07-15T08:00:0${position}.000Z`,
    domain_data: { secret: `domain_${position}` },
    protocol_data: {
      resource_version: position,
      change: {
        change_type: eventType.split(".").at(-2) ?? "changed",
        from_state: position === 1 ? null : "offered",
        to_state: eventType.includes("accepted") ? "accepted" : "offered",
        details: {
          work_reference_uri: "urn:work:item:42",
          capability_ids: ["software.implementation"],
        },
      },
      receipt: null,
    },
    tenant_id: tenantId,
    partition_id: partitionId,
    partition_position: position,
    stream_id: "handoff_01",
    stream_version: position,
    commit_id: `commit_${position}`,
    commit_ordinal: 0,
    ...overrides,
  };
}

class StaticJournal implements EventJournal {
  constructor(private readonly events: readonly EventRecord[]) {}

  async readStream(
    streamId: string,
    fromVersion = 0,
  ): Promise<readonly EventRecord[]> {
    return structuredClone(
      this.events.filter(
        (item) =>
          item.stream_id === streamId && item.stream_version >= fromVersion,
      ),
    );
  }

  async readPartition(
    requestedPartitionId: string,
    afterPosition: number,
    limit: number,
  ): Promise<readonly EventRecord[]> {
    return structuredClone(
      this.events
        .filter(
          (item) =>
            item.partition_id === requestedPartitionId &&
            item.partition_position > afterPosition,
        )
        .slice(0, limit),
    );
  }
}

class MutableClock implements Clock {
  constructor(public instant = "2026-07-15T08:00:10.000Z") {}

  now(): string {
    return this.instant;
  }
}

interface ObservedDelivery {
  readonly event: ProtocolEvent;
  readonly destination: SignalDestination;
}

class ControlledSignal implements SignalAdapter {
  readonly manifest = {
    profile: "exchange.signal.v1",
    adapter: "controlled-test",
    capabilities: {
      event_id_preservation: true,
      outcome_classification: true,
      payload_isolation: true,
    },
  } as const;

  readonly observed: ObservedDelivery[] = [];
  private readonly outcomes = new Map<string, SignalDeliveryResult | Error>();

  setOutcome(destinationId: string, outcome: SignalDeliveryResult | Error): void {
    this.outcomes.set(destinationId, outcome);
  }

  async deliver(
    deliveredEvent: ProtocolEvent,
    destination: SignalDestination,
  ): Promise<SignalDeliveryResult> {
    this.observed.push({
      event: structuredClone(deliveredEvent),
      destination: structuredClone(destination),
    });
    const outcome = this.outcomes.get(destination.destination_id) ?? {
      kind: "accepted",
    };
    if (outcome instanceof Error) throw outcome;
    return structuredClone(outcome);
  }
}

function subscription(
  id: string,
  overrides: Partial<RuntimeSubscription> = {},
): RuntimeSubscription {
  return {
    subscription_id: id,
    tenant_id: tenantId,
    owner: { actor_id: "subscriber_actor", actor_type: "agent" },
    endpoint_id: "subscriber_endpoint",
    filter: emptyFilter(),
    destination: {
      destination_id: `destination_${id}`,
      binding: "in-process",
      configuration: {},
    },
    delivery_mode: "webhook",
    state: "active",
    max_attempts: 3,
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

async function fixture(
  events: readonly EventRecord[],
  subscriptionsToPut: readonly RuntimeSubscription[] = [
    subscription("subscription_01"),
  ],
  state = new MemoryExchangePersistence(),
  observer?: DispatchObserver,
  telemetry?: SemanticTelemetryObserver,
) {
  const subscriptions = new MemorySubscriptionStore();
  for (const value of subscriptionsToPut) {
    await subscriptions.putSubscription(value);
  }
  const signal = new ControlledSignal();
  const clock = new MutableClock();
  const dispatcher = new SignalDispatcher(
    new StaticJournal(events),
    state,
    subscriptions,
    new DefaultSubscriptionDeliveryPolicy(),
    signal,
    clock,
    { base_delay_seconds: 2, max_delay_seconds: 30 },
    schemas,
    observer,
    telemetry,
  );
  return { state, subscriptions, signal, clock, dispatcher };
}

describe("SignalDispatcher", () => {
  it("leaves SSE subscriptions for Cursor Pull delivery", async () => {
    const { dispatcher, state, signal } = await fixture(
      [event(1)],
      [subscription("subscription_sse", { delivery_mode: "sse" })],
    );

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);

    expect(signal.observed).toEqual([]);
    expect(await state.loadDeliveryPosition("subscription_sse", partitionId)).toBe(0);
  });

  it("emits bounded delivery outcome semantics", async () => {
    const observed: SemanticObservation[] = [];
    const { dispatcher } = await fixture(
      [event(1)],
      undefined,
      undefined,
      undefined,
      { observe(value) { observed.push(value); } },
    );

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);

    expect(observed).toMatchObject([{
      operation: "delivery_attempt",
      outcome: "succeeded",
      category: "delivery",
      count: 1,
    }]);
    expect(JSON.stringify(observed)).not.toMatch(/tenant_01|subscription_01/);
  });

  it("checks ownership before Signal side effects and position advance", async () => {
    const { dispatcher, state, signal } = await fixture([event(1)]);
    let calls = 0;
    const fence = {
      async assertOwnership() {
        calls += 1;
        if (calls >= 2) throw new Error("partition_lease_lost");
      },
    };

    await expect(dispatcher.dispatchPartition(
      partitionId,
      tenantId,
      10,
      fence,
    )).rejects.toThrow(/partition_lease_lost/);
    expect(signal.observed).toHaveLength(1);
    expect(await state.loadDeliveryPosition("subscription_01", partitionId)).toBe(0);
  });

  it.each([
    [
      "event_type",
      event(1, "workfabric.handoff.unknown.v1"),
    ],
    [
      "protocol_data",
      event(1, "workfabric.handoff.accepted.v1", {
        protocol_data: {
          resource_version: 0,
          change: null,
          receipt: null,
        } as unknown as EventRecord["protocol_data"],
      }),
    ],
  ])("does not deliver or advance a schema-invalid %s", async (_field, invalid) => {
    const { dispatcher, state, signal } = await fixture([invalid]);

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);

    expect(signal.observed).toEqual([]);
    expect(
      await state.loadDeliveryPosition("subscription_01", partitionId),
    ).toBe(0);
  });

  it("does not send an unsupported delivery mode even from an unvalidated Store", async () => {
    const malformed = subscription("subscription_typo", {
      delivery_mode:
        "cursor-pul" as unknown as RuntimeSubscription["delivery_mode"],
    });
    const store: SubscriptionStore = {
      manifest: {
        profile: "exchange.subscription.v1",
        adapter: "malformed-test",
        capabilities: {
          tenant_isolation: true,
          state_filtering: true,
          immutable_reads: true,
        },
      },
      async getSubscription() {
        return structuredClone(malformed);
      },
      async listActiveSubscriptions() {
        return [structuredClone(malformed)];
      },
      async putSubscription() {},
    };
    const signal = new ControlledSignal();
    const dispatcher = new SignalDispatcher(
      new StaticJournal([event(1)]),
      new MemoryExchangePersistence(),
      store,
      new DefaultSubscriptionDeliveryPolicy(),
      signal,
      new MutableClock(),
      { base_delay_seconds: 2, max_delay_seconds: 30 },
      schemas,
    );

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);

    expect(signal.observed).toEqual([]);
  });

  it("does not deliver or advance across a Journal position gap", async () => {
    const { dispatcher, state, signal } = await fixture([event(2)]);

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);

    expect(signal.observed).toEqual([]);
    expect(
      await state.loadDeliveryPosition("subscription_01", partitionId),
    ).toBe(0);
  });

  it("stops at a later Journal gap after committing only the contiguous prefix", async () => {
    const { dispatcher, state, signal } = await fixture([event(1), event(3)]);

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);

    expect(signal.observed.map(({ event: item }) => item.id)).toEqual(["event_1"]);
    expect(
      await state.loadDeliveryPosition("subscription_01", partitionId),
    ).toBe(1);
  });

  it("advances unmatched Events only for that Subscription and delivers matching Events", async () => {
    const first = subscription("only_accepted", {
      filter: {
        ...emptyFilter(),
        event_types: ["workfabric.handoff.accepted.v1"],
      },
    });
    const second = subscription("only_offered", {
      filter: {
        ...emptyFilter(),
        event_types: ["workfabric.handoff.offered.v1"],
      },
    });
    const { dispatcher, state, signal } = await fixture(
      [
        event(1, "workfabric.handoff.offered.v1"),
        event(2, "workfabric.handoff.accepted.v1"),
      ],
      [first, second],
    );

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);

    expect(await state.loadDeliveryPosition(first.subscription_id, partitionId)).toBe(
      2,
    );
    expect(
      await state.loadDeliveryPosition(second.subscription_id, partitionId),
    ).toBe(2);
    expect(signal.observed.map(({ event: item, destination }) => [
      item.id,
      destination.destination_id,
    ])).toEqual([
      ["event_2", "destination_only_accepted"],
      ["event_1", "destination_only_offered"],
    ]);
  });

  it("records a retryable attempt, suppresses early retry, and dead-letters at max attempts", async () => {
    const configured = subscription("subscription_01", { max_attempts: 2 });
    const { dispatcher, state, signal, clock } = await fixture(
      [event(1)],
      [configured],
    );
    signal.setOutcome(configured.destination.destination_id, {
      kind: "retryable_failure",
      detail: "offline",
    });

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);
    expect(await state.loadDeliveryPosition(configured.subscription_id, partitionId)).toBe(
      0,
    );
    expect(
      await state.listDeliveryAttempts(configured.subscription_id, "event_1"),
    ).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: "retryable_failure",
        next_attempt_at: "2026-07-15T08:00:12.000Z",
      }),
    ]);

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);
    expect(signal.observed).toHaveLength(1);

    clock.instant = "2026-07-15T08:00:12.000Z";
    await dispatcher.dispatchPartition(partitionId, tenantId, 10);
    expect(signal.observed).toHaveLength(2);
    expect(await state.loadDeliveryPosition(configured.subscription_id, partitionId)).toBe(
      1,
    );
    expect(
      await state.listDeliveryAttempts(configured.subscription_id, "event_1"),
    ).toHaveLength(2);
    expect(await state.listDeadLetters(configured.subscription_id, "event_1")).toHaveLength(
      1,
    );
  });

  it("preserves nanoseconds in retry timestamps and waits until the exact instant", async () => {
    const configured = subscription("subscription_01", { max_attempts: 2 });
    const { dispatcher, state, signal, clock } = await fixture(
      [event(1)],
      [configured],
    );
    signal.setOutcome(configured.destination.destination_id, {
      kind: "retryable_failure",
      detail: "offline",
    });
    clock.instant = "2026-07-15T08:00:10.123456789Z";

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);
    expect(
      await state.listDeliveryAttempts(configured.subscription_id, "event_1"),
    ).toEqual([
      expect.objectContaining({
        next_attempt_at: "2026-07-15T08:00:12.123456789Z",
      }),
    ]);

    clock.instant = "2026-07-15T08:00:12.123456788Z";
    await dispatcher.dispatchPartition(partitionId, tenantId, 10);
    expect(signal.observed).toHaveLength(1);

    clock.instant = "2026-07-15T08:00:12.123456789Z";
    await dispatcher.dispatchPartition(partitionId, tenantId, 10);
    expect(signal.observed).toHaveLength(2);
  });

  it("dead-letters a permanent failure once and advances the position", async () => {
    const { dispatcher, state, signal } = await fixture([event(1)]);
    signal.setOutcome("destination_subscription_01", {
      kind: "permanent_failure",
      detail: "invalid target",
    });

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);
    await dispatcher.dispatchPartition(partitionId, tenantId, 10);

    expect(await state.loadDeliveryPosition("subscription_01", partitionId)).toBe(
      1,
    );
    expect(signal.observed).toHaveLength(1);
    expect(await state.listDeadLetters("subscription_01", "event_1")).toHaveLength(
      1,
    );
  });

  it("isolates one Subscription adapter error from another Subscription", async () => {
    const failing = subscription("failing");
    const healthy = subscription("healthy");
    const { dispatcher, state, signal } = await fixture(
      [event(1)],
      [failing, healthy],
    );
    signal.setOutcome(failing.destination.destination_id, new Error("secret failure"));

    await expect(
      dispatcher.dispatchPartition(partitionId, tenantId, 10),
    ).resolves.toBeUndefined();
    expect(await state.loadDeliveryPosition(failing.subscription_id, partitionId)).toBe(
      0,
    );
    expect(await state.loadDeliveryPosition(healthy.subscription_id, partitionId)).toBe(
      1,
    );
  });

  it("redelivers after a post-send crash with the same CloudEvent ID", async () => {
    let crash = true;
    const observer: DispatchObserver = {
      async afterDelivery(): Promise<void> {
        if (crash) {
          crash = false;
          throw new Error("simulated crash after delivery");
        }
      },
    };
    const { dispatcher, state, signal, subscriptions, clock } = await fixture(
      [event(1)],
      [subscription("subscription_01")],
      new MemoryExchangePersistence(),
      observer,
    );

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);
    expect(await state.loadDeliveryPosition("subscription_01", partitionId)).toBe(
      0,
    );

    const restarted = new SignalDispatcher(
      new StaticJournal([event(1)]),
      state,
      subscriptions,
      new DefaultSubscriptionDeliveryPolicy(),
      signal,
      clock,
      { base_delay_seconds: 2, max_delay_seconds: 30 },
      schemas,
    );
    await restarted.dispatchPartition(partitionId, tenantId, 10);

    expect(signal.observed.map(({ event: item }) => item.id)).toEqual([
      "event_1",
      "event_1",
    ]);
    expect(await state.loadDeliveryPosition("subscription_01", partitionId)).toBe(
      1,
    );
  });

  it("never exposes Journal-only metadata to the Signal Adapter", async () => {
    const { dispatcher, signal } = await fixture([event(1)]);

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);

    const delivered = signal.observed[0]?.event;
    expect(delivered).toBeDefined();
    expect(delivered).not.toHaveProperty("domain_data");
    expect(delivered).not.toHaveProperty("partition_id");
    expect(delivered).not.toHaveProperty("partition_position");
    expect(delivered).not.toHaveProperty("commit_id");
    expect(delivered).not.toHaveProperty("idempotency_key");
    expect(delivered).not.toHaveProperty("visible_actor_ids");
    expect(delivered).not.toHaveProperty("visible_endpoint_ids");
  });

  it("converges after dead-letter succeeds but a position CAS transiently fails", async () => {
    class FailFirstAdvance extends MemoryExchangePersistence {
      private fail = true;

      override async advanceDeliveryPosition(
        subscriptionId: string,
        requestedPartitionId: string,
        expectedPosition: number,
        newPosition: number,
      ): Promise<boolean> {
        if (this.fail) {
          this.fail = false;
          return false;
        }
        return super.advanceDeliveryPosition(
          subscriptionId,
          requestedPartitionId,
          expectedPosition,
          newPosition,
        );
      }
    }
    const state = new FailFirstAdvance();
    const { dispatcher, signal } = await fixture(
      [event(1)],
      [subscription("subscription_01")],
      state,
    );
    signal.setOutcome("destination_subscription_01", {
      kind: "permanent_failure",
      detail: "bad target",
    });

    await dispatcher.dispatchPartition(partitionId, tenantId, 10);
    await dispatcher.dispatchPartition(partitionId, tenantId, 10);

    expect(await state.loadDeliveryPosition("subscription_01", partitionId)).toBe(
      1,
    );
    expect(await state.listDeadLetters("subscription_01", "event_1")).toHaveLength(
      1,
    );
    expect(signal.observed.map(({ event: item }) => item.id)).toEqual([
      "event_1",
      "event_1",
    ]);
  });
});
