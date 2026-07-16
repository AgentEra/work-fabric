import { describe, expect, it, vi } from "vitest";

import type {
  PartitionTurnContext,
  PartitionWorkKind,
} from "@work-fabric/cluster-spi";
import type { EventRecord, OutboxRecord, OutboxStore } from "@work-fabric/exchange-spi";
import {
  CollaborationProjectionHandler,
  HandoffProjectionHandler,
  OutboxWakeupHandler,
  SignalDeliveryHandler,
} from "../src/index.js";

function context(
  kind: PartitionWorkKind,
  assertOwnership = vi.fn(async () => {}),
): PartitionTurnContext {
  return {
    item: {
      tenant_id: "tenant-a",
      partition_id: "partition-a",
      kind,
      observed_position: 7,
      available_at: "2026-07-16T00:00:00.000Z",
    },
    owner: "worker-a",
    fencing_token: 3,
    signal: new AbortController().signal,
    assertOwnership,
  };
}

function event(): EventRecord {
  return {
    event_id: "event-a",
    event_type: "workfabric.handoff.accepted.v1",
    schema_version: "1.0",
    exchange_id: "exchange-a",
    request_message_id: "message-a",
    idempotency_key: "key-a",
    thread_id: "thread-a",
    handoff_id: "handoff-a",
    actor_id: "actor-a",
    endpoint_id: "endpoint-a",
    visibility: "participants",
    visible_actor_ids: ["actor-a"],
    visible_endpoint_ids: ["endpoint-a"],
    occurred_at: "2026-07-16T00:00:00.000Z",
    domain_data: { private_result: "must-not-publish" },
    protocol_data: { private_context: "must-not-publish" },
    tenant_id: "tenant-a",
    partition_id: "partition-a",
    partition_position: 7,
    stream_id: "handoff-a",
    stream_version: 1,
    commit_id: "commit-a",
    commit_ordinal: 0,
  };
}

function outboxRecord(): OutboxRecord {
  return {
    outbox_id: "outbox-a",
    tenant_id: "tenant-a",
    partition_id: "partition-a",
    position: 7,
    event: event(),
    attempt: 1,
    next_attempt_at: null,
    lease_owner: "worker-a",
    lease_expires_at: "2026-07-16T00:00:30.000Z",
    fencing_token: 11,
  };
}

function outboxStore(record: OutboxRecord) {
  const store: OutboxStore = {
    claim: vi.fn(async () => [structuredClone(record)]),
    markPublished: vi.fn(async () => true),
    recordFailure: vi.fn(async () => true),
    listPending: vi.fn(async () => [structuredClone(record)]),
  };
  return store;
}

describe("cluster owner handlers", () => {
  it("publishes only three metadata wakeups before fencing settlement", async () => {
    const values: unknown[] = [];
    const store = outboxStore(outboxRecord());
    const assertOwnership = vi.fn(async () => {});
    const handler = new OutboxWakeupHandler({
      store_for_tenant: () => store,
      publisher: {
        manifest: {
          profile: "workfabric.cluster.v1",
          adapter: "handler-test",
          capabilities: {},
        },
        async publish(value) {
          values.push(structuredClone(value));
          return "accepted";
        },
      },
      clock: { now: () => "2026-07-16T00:00:00.000Z" },
      retry_policy: {
        nextAttemptAt: () => "2026-07-16T00:00:05.000Z",
      },
      row_lease_seconds: 30,
    });

    await expect(handler.run(
      context("outbox_wakeup", assertOwnership),
      10,
    )).resolves.toEqual({ outcome: "advanced", processed: 1 });
    expect(values.map((value) => (value as { kind: string }).kind)).toEqual([
      "handoff_projection",
      "collaboration_projection",
      "signal_delivery",
    ]);
    expect(JSON.stringify(values)).not.toMatch(
      /domain_data|protocol_data|context|result|actor_id|handoff_id/i,
    );
    expect(store.markPublished).toHaveBeenCalledWith("outbox-a", "worker-a", 11);
    expect(assertOwnership.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("records a bounded retry when one metadata wakeup is unavailable", async () => {
    const store = outboxStore(outboxRecord());
    let publications = 0;
    const handler = new OutboxWakeupHandler({
      store_for_tenant: () => store,
      publisher: {
        manifest: {
          profile: "workfabric.cluster.v1",
          adapter: "handler-test",
          capabilities: {},
        },
        async publish() {
          publications += 1;
          return publications === 2 ? "retryable_failure" : "accepted";
        },
      },
      clock: { now: () => "2026-07-16T00:00:00.000Z" },
      retry_policy: {
        nextAttemptAt: () => "2026-07-16T00:00:05.000Z",
      },
      row_lease_seconds: 30,
    });

    await expect(handler.run(context("outbox_wakeup"), 10)).resolves.toEqual({
      outcome: "waiting",
      processed: 1,
    });
    expect(store.recordFailure).toHaveBeenCalledWith(
      "outbox-a",
      "worker-a",
      11,
      "2026-07-16T00:00:05.000Z",
    );
    expect(store.markPublished).not.toHaveBeenCalled();
  });

  it("maps the three existing owner ports without adding owner logic", async () => {
    const fence = vi.fn(async () => {});
    const handoff = new HandoffProjectionHandler({
      runPartition: vi.fn(async () => ({
        kind: "advanced" as const,
        position: 2,
        processed: 2,
      })),
    });
    const collaboration = new CollaborationProjectionHandler({
      runPartition: vi.fn(async () => ({
        kind: "waiting" as const,
        position: 1,
        handoff_id: "handoff-a",
        required_stream_version: 2,
      })),
    });
    const signal = new SignalDeliveryHandler({
      dispatchPartitionTurn: vi.fn(async () => ({ processed: 1 })),
    });

    await expect(handoff.run(context("handoff_projection", fence), 10))
      .resolves.toEqual({ outcome: "advanced", processed: 2 });
    await expect(collaboration.run(
      context("collaboration_projection", fence),
      10,
    )).resolves.toEqual({ outcome: "waiting", processed: 0 });
    await expect(signal.run(context("signal_delivery", fence), 10))
      .resolves.toEqual({ outcome: "advanced", processed: 1 });
  });
});
