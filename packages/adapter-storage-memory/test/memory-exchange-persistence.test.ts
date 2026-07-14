import { describe, expect, it } from "vitest";

import { verifyPersistenceProfile } from "@work-fabric/exchange-conformance";
import {
  PERSISTENCE_REQUIRED_CAPABILITIES,
  type AtomicCommitRequest,
  type DeadLetterRecord,
  type DeliveryAttempt,
  type EventRecord,
  type NormalizedOperationOutcome,
  type ProposedEvent,
} from "@work-fabric/exchange-spi";

import { MemoryExchangePersistence } from "../src/index.js";

const acceptedOutcome: NormalizedOperationOutcome = {
  operation_status: "accepted",
  resource: { handoff_id: "handoff_01", state: "accepted" },
  receipt: { receipt_id: "receipt_01" },
  error: null,
};

function proposedEvent(eventId: string, eventType = "workfabric.test.v1"): ProposedEvent {
  return {
    event_id: eventId,
    event_type: eventType,
    schema_version: "1.0",
    exchange_id: "exchange_01",
    request_message_id: "message_01",
    idempotency_key: "command-01",
    thread_id: "thread_01",
    handoff_id: "handoff_01",
    actor_id: "actor_01",
    endpoint_id: "endpoint_01",
    visibility: "participants",
    visible_actor_ids: ["actor_01"],
    visible_endpoint_ids: ["endpoint_01"],
    occurred_at: "2026-07-14T00:00:00.000Z",
    domain_data: { state: "accepted" },
    protocol_data: { state: "accepted" },
  };
}

function oneEventCommit(
  eventId: string,
  overrides: Partial<AtomicCommitRequest> = {},
): AtomicCommitRequest {
  return {
    tenant_id: "tenant_01",
    partition_id: "partition_01",
    commit_id: `commit_${eventId}`,
    idempotency_key: `key_${eventId}`,
    payload_digest: `sha256:${eventId}`,
    request_message_id: `message_${eventId}`,
    outcome: acceptedOutcome,
    version_checks: [],
    appends: [
      {
        stream_id: `stream_${eventId}`,
        expected_version: 0,
        events: [proposedEvent(eventId)],
      },
    ],
    ...overrides,
  };
}

async function committedRecord(
  store: MemoryExchangePersistence,
  eventId = "event_01",
): Promise<EventRecord> {
  const result = await store.commitAtomically(oneEventCommit(eventId));
  expect(result.kind).toBe("committed");
  if (result.kind !== "committed") {
    throw new Error("expected committed test fixture");
  }
  const [record] = result.events;
  if (record === undefined) {
    throw new Error("expected committed event fixture");
  }
  return record;
}

describe("MemoryExchangePersistence", () => {
  it("declares the complete exchange.persistence.v1 profile", () => {
    const store = new MemoryExchangePersistence();

    expect(store.manifest.profile).toBe("exchange.persistence.v1");
    expect(store.manifest.adapter).toBe("memory");
    for (const capability of PERSISTENCE_REQUIRED_CAPABILITIES) {
      expect(store.manifest.capabilities[capability]).toBe(true);
    }
  });

  it("commits one event and assigns stable one-based positions", async () => {
    const store = new MemoryExchangePersistence();

    const result = await store.commitAtomically(oneEventCommit("event_01"));

    expect(result).toMatchObject({
      kind: "committed",
      events: [
        {
          event_id: "event_01",
          tenant_id: "tenant_01",
          partition_id: "partition_01",
          partition_position: 1,
          stream_id: "stream_event_01",
          stream_version: 1,
          commit_id: "commit_event_01",
          commit_ordinal: 0,
        },
      ],
    });
    expect(await store.readStream("stream_event_01")).toHaveLength(1);
    expect(await store.findCommand("tenant_01", "key_event_01")).toMatchObject({
      payload_digest: "sha256:event_01",
      first_request_message_id: "message_event_01",
      outcome: acceptedOutcome,
    });
  });

  it("atomically appends multiple streams and rolls back every stream on conflict", async () => {
    const store = new MemoryExchangePersistence();
    const parentCreated = proposedEvent("parent-created");
    const childCreated = proposedEvent("child-created");
    const parentTransferred = proposedEvent("parent-transferred");
    const childAccepted = proposedEvent("child-accepted");

    await store.commitAtomically({
      tenant_id: "tenant_01",
      partition_id: "partition_01",
      commit_id: "commit_seed",
      idempotency_key: "seed-01",
      payload_digest: "sha256:seed",
      request_message_id: "message_seed",
      outcome: acceptedOutcome,
      version_checks: [],
      appends: [
        { stream_id: "parent", expected_version: 0, events: [parentCreated] },
        { stream_id: "child", expected_version: 0, events: [childCreated] },
      ],
    });

    const result = await store.commitAtomically({
      tenant_id: "tenant_01",
      partition_id: "partition_01",
      commit_id: "commit_01",
      idempotency_key: "transfer-01",
      payload_digest: "sha256:transfer",
      request_message_id: "message_01",
      outcome: acceptedOutcome,
      version_checks: [],
      appends: [
        { stream_id: "parent", expected_version: 1, events: [parentTransferred] },
        { stream_id: "child", expected_version: 1, events: [childAccepted] },
      ],
    });

    expect(result.kind).toBe("committed");
    expect(await store.readStream("parent")).toHaveLength(2);
    expect(await store.readStream("child")).toHaveLength(2);
    if (result.kind === "committed") {
      expect(result.events.map((event) => event.commit_ordinal)).toEqual([0, 1]);
    }

    const conflict = await store.commitAtomically({
      tenant_id: "tenant_01",
      partition_id: "partition_01",
      commit_id: "commit_02",
      idempotency_key: "transfer-02",
      payload_digest: "sha256:transfer-02",
      request_message_id: "message_02",
      outcome: acceptedOutcome,
      version_checks: [],
      appends: [
        { stream_id: "parent", expected_version: 2, events: [proposedEvent("parent-2")] },
        { stream_id: "child", expected_version: 1, events: [proposedEvent("child-2")] },
      ],
    });

    expect(conflict).toEqual({
      kind: "version_conflict",
      current_versions: { parent: 2, child: 2 },
    });
    expect(await store.readStream("parent")).toHaveLength(2);
    expect(await store.readStream("child")).toHaveLength(2);
    expect(await store.findCommand("tenant_01", "transfer-02")).toBeNull();
  });

  it("atomically evaluates read-only stream version checks with appends", async () => {
    const store = new MemoryExchangePersistence();
    await store.commitAtomically({
      ...oneEventCommit("parent-created"),
      appends: [
        {
          stream_id: "parent",
          expected_version: 0,
          events: [proposedEvent("parent-created")],
        },
      ],
      version_checks: [],
    });

    const createdChild = await store.commitAtomically({
      ...oneEventCommit("child-created"),
      version_checks: [{ stream_id: "parent", expected_version: 1 }],
      appends: [
        {
          stream_id: "child",
          expected_version: 0,
          events: [proposedEvent("child-created")],
        },
      ],
    });
    expect(createdChild.kind).toBe("committed");
    expect(await store.readStream("parent")).toHaveLength(1);
    expect(await store.readStream("child")).toHaveLength(1);

    await store.commitAtomically({
      ...oneEventCommit("parent-advanced"),
      version_checks: [],
      appends: [
        {
          stream_id: "parent",
          expected_version: 1,
          events: [proposedEvent("parent-advanced")],
        },
      ],
    });
    const conflict = await store.commitAtomically({
      ...oneEventCommit("stale-child"),
      version_checks: [{ stream_id: "parent", expected_version: 1 }],
      appends: [
        {
          stream_id: "stale-child",
          expected_version: 0,
          events: [proposedEvent("stale-child")],
        },
      ],
    });

    expect(conflict).toEqual({
      kind: "version_conflict",
      current_versions: { parent: 2, "stale-child": 0 },
    });
    expect(await store.readStream("stale-child")).toEqual([]);
    expect(await store.findCommand("tenant_01", "key_stale-child")).toBeNull();

    await expect(
      store.commitAtomically({
        ...oneEventCommit("cross-partition-child"),
        partition_id: "partition_02",
        version_checks: [{ stream_id: "parent", expected_version: 2 }],
        appends: [
          {
            stream_id: "cross-partition-child",
            expected_version: 0,
            events: [proposedEvent("cross-partition-child")],
          },
        ],
      }),
    ).rejects.toThrow(/partition/i);
    expect(await store.readStream("cross-partition-child")).toEqual([]);
  });

  it("rejects duplicate version checks and check/append overlap", async () => {
    const store = new MemoryExchangePersistence();

    await expect(
      store.commitAtomically({
        ...oneEventCommit("duplicate-check"),
        version_checks: [
          { stream_id: "parent", expected_version: 0 },
          { stream_id: "parent", expected_version: 0 },
        ],
      }),
    ).rejects.toThrow(/duplicate.*version check/i);
    await expect(
      store.commitAtomically({
        ...oneEventCommit("overlap"),
        version_checks: [
          { stream_id: "stream_overlap", expected_version: 0 },
        ],
      }),
    ).rejects.toThrow(/version check.*append/i);
    await expect(
      store.commitAtomically({
        ...oneEventCommit("negative-check"),
        version_checks: [{ stream_id: "parent", expected_version: -1 }],
      }),
    ).rejects.toThrow(/version/i);
  });

  it("replays equal tenant-scoped keys and rejects key reuse with a different digest", async () => {
    const store = new MemoryExchangePersistence();
    const request = oneEventCommit("event_01");

    await store.commitAtomically(request);
    const replay = await store.commitAtomically({
      ...request,
      commit_id: "ignored_on_replay",
      appends: [{ ...request.appends[0]!, expected_version: 99 }],
    });
    const reused = await store.commitAtomically({
      ...request,
      payload_digest: "sha256:different",
    });
    const otherTenant = await store.commitAtomically({
      ...oneEventCommit("event_02"),
      tenant_id: "tenant_02",
      idempotency_key: request.idempotency_key,
    });

    expect(replay).toEqual({ kind: "replayed", outcome: acceptedOutcome });
    expect(reused).toEqual({ kind: "idempotency_key_reused" });
    expect(otherTenant.kind).toBe("committed");
  });

  it("returns all conflicting current versions without writing a command", async () => {
    const store = new MemoryExchangePersistence();
    await committedRecord(store);

    const result = await store.commitAtomically({
      ...oneEventCommit("event_02"),
      idempotency_key: "conflicting-command",
      appends: [
        { stream_id: "stream_event_01", expected_version: 0, events: [proposedEvent("event_02")] },
        { stream_id: "new-stream", expected_version: 1, events: [proposedEvent("event_03")] },
      ],
    });

    expect(result).toEqual({
      kind: "version_conflict",
      current_versions: { stream_event_01: 1, "new-stream": 0 },
    });
    expect(await store.findCommand("tenant_01", "conflicting-command")).toBeNull();
  });

  it("reports a conflict for stream IDs that match object prototype keys", async () => {
    const store = new MemoryExchangePersistence();

    const result = await store.commitAtomically({
      ...oneEventCommit("event_01"),
      appends: [
        {
          stream_id: "__proto__",
          expected_version: 1,
          events: [proposedEvent("event_01")],
        },
      ],
    });

    expect(result.kind).toBe("version_conflict");
    if (result.kind === "version_conflict") {
      expect(Object.hasOwn(result.current_versions, "__proto__")).toBe(true);
      expect(result.current_versions["__proto__"]).toBe(0);
    }
  });

  it("reads partitions and streams in stable order with inclusive stream versions", async () => {
    const store = new MemoryExchangePersistence();
    await store.commitAtomically({
      ...oneEventCommit("event_01"),
      appends: [
        {
          stream_id: "stream_01",
          expected_version: 0,
          events: [proposedEvent("event_01"), proposedEvent("event_02")],
        },
      ],
    });
    await store.commitAtomically({
      ...oneEventCommit("event_03"),
      appends: [{ stream_id: "stream_02", expected_version: 0, events: [proposedEvent("event_03")] }],
    });

    expect((await store.readPartition("partition_01", 0, 2)).map((event) => event.event_id)).toEqual([
      "event_01",
      "event_02",
    ]);
    expect((await store.readPartition("partition_01", 1, 10)).map((event) => event.event_id)).toEqual([
      "event_02",
      "event_03",
    ]);
    expect((await store.readStream("stream_01", 2)).map((event) => event.event_id)).toEqual([
      "event_02",
    ]);
  });

  it("validates limits, positions, versions, append shapes, and event IDs", async () => {
    const store = new MemoryExchangePersistence();

    await expect(store.readPartition("partition_01", 0, 0)).rejects.toThrow(/limit/i);
    await expect(store.readPartition("partition_01", -1, 1)).rejects.toThrow(/position/i);
    await expect(store.readPartition("partition_01", 0.5, 1)).rejects.toThrow(/position/i);
    await expect(store.readStream("stream_01", -1)).rejects.toThrow(/version/i);
    await expect(
      store.commitAtomically({
        ...oneEventCommit("bad-version"),
        appends: [{ stream_id: "stream_01", expected_version: -1, events: [proposedEvent("event_01")] }],
      }),
    ).rejects.toThrow(/version/i);
    await expect(
      store.commitAtomically({
        ...oneEventCommit("duplicate-stream"),
        appends: [
          { stream_id: "stream_01", expected_version: 0, events: [proposedEvent("event_01")] },
          { stream_id: "stream_01", expected_version: 0, events: [proposedEvent("event_02")] },
        ],
      }),
    ).rejects.toThrow(/stream/i);
    await expect(
      store.commitAtomically({
        ...oneEventCommit("empty-append"),
        appends: [{ stream_id: "stream_01", expected_version: 0, events: [] }],
      }),
    ).rejects.toThrow(/event/i);
    await expect(
      store.commitAtomically({
        ...oneEventCommit("duplicate-event"),
        appends: [
          {
            stream_id: "stream_01",
            expected_version: 0,
            events: [proposedEvent("event_01"), proposedEvent("event_01")],
          },
        ],
      }),
    ).rejects.toThrow(/event.*id/i);

    await committedRecord(store, "stored-event");
    await expect(
      store.commitAtomically({
        ...oneEventCommit("second-command"),
        appends: [{ stream_id: "other-stream", expected_version: 0, events: [proposedEvent("stored-event")] }],
      }),
    ).rejects.toThrow(/event.*id/i);
    expect(await store.findCommand("tenant_01", "key_second-command")).toBeNull();
  });

  it("does not persist temporarily unavailable outcomes", async () => {
    const store = new MemoryExchangePersistence();

    await expect(
      store.commitAtomically({
        ...oneEventCommit("event_01"),
        outcome: { ...acceptedOutcome, operation_status: "temporarily_unavailable" },
      }),
    ).rejects.toThrow(/temporarily_unavailable/i);
    expect(await store.readStream("stream_event_01")).toEqual([]);
    expect(await store.findCommand("tenant_01", "key_event_01")).toBeNull();
  });

  it("round trips, clones, validates, and deletes snapshots", async () => {
    const store = new MemoryExchangePersistence();
    const snapshot = {
      stream_id: "stream_01",
      stream_version: 2,
      schema_version: "1.0",
      state: { nested: { value: "original" } },
    } as const;

    await store.saveSnapshot(snapshot);
    const loaded = await store.loadSnapshot("stream_01");
    expect(loaded).toEqual(snapshot);
    const mutableInput = snapshot.state.nested as { value: string };
    mutableInput.value = "changed-input";
    const mutableOutput = loaded?.state.nested as { value: string };
    mutableOutput.value = "changed-output";
    expect(await store.loadSnapshot("stream_01")).toMatchObject({
      state: { nested: { value: "original" } },
    });

    await expect(
      store.saveSnapshot({ ...snapshot, stream_version: -1 }),
    ).rejects.toThrow(/version/i);
    await store.deleteSnapshot("stream_01");
    expect(await store.loadSnapshot("stream_01")).toBeNull();
  });

  it("compare-and-advances and explicitly resets projection checkpoints", async () => {
    const store = new MemoryExchangePersistence();

    expect(await store.loadProjectionCheckpoint("projector_01", "partition_01")).toBe(0);
    expect(await store.advanceProjectionCheckpoint("projector_01", "partition_01", 0, 3)).toBe(true);
    expect(await store.advanceProjectionCheckpoint("projector_01", "partition_01", 0, 4)).toBe(false);
    expect(await store.advanceProjectionCheckpoint("projector_01", "partition_01", 3, 2)).toBe(false);
    expect(await store.loadProjectionCheckpoint("projector_01", "partition_01")).toBe(3);
    await expect(
      store.advanceProjectionCheckpoint("projector_01", "partition_01", -1, 3),
    ).rejects.toThrow(/position/i);
    await store.resetProjectionCheckpoint("projector_01", "partition_01");
    expect(await store.loadProjectionCheckpoint("projector_01", "partition_01")).toBe(0);
  });

  it("compare-and-advances delivery positions without moving backwards", async () => {
    const store = new MemoryExchangePersistence();

    expect(await store.loadDeliveryPosition("subscription_01", "partition_01")).toBe(0);
    expect(await store.advanceDeliveryPosition("subscription_01", "partition_01", 0, 5)).toBe(true);
    expect(await store.advanceDeliveryPosition("subscription_01", "partition_01", 0, 6)).toBe(false);
    expect(await store.advanceDeliveryPosition("subscription_01", "partition_01", 5, 4)).toBe(false);
    expect(await store.loadDeliveryPosition("subscription_01", "partition_01")).toBe(5);
    await expect(
      store.advanceDeliveryPosition("subscription_01", "partition_01", 5, -1),
    ).rejects.toThrow(/position/i);
  });

  it("clones recorded delivery attempts and dead letters", async () => {
    const store = new MemoryExchangePersistence();
    const event = await committedRecord(store);
    const attempt: DeliveryAttempt = {
      subscription_id: "subscription_01",
      partition_id: "partition_01",
      event_id: event.event_id,
      attempt: 1,
      attempted_at: "2026-07-14T00:01:00.000Z",
      outcome: "retryable_failure",
      detail: "temporary",
    };
    const deadLetter: DeadLetterRecord = {
      subscription_id: "subscription_01",
      event,
      attempts: 3,
      reason: "exhausted",
      recorded_at: "2026-07-14T00:03:00.000Z",
    };

    await store.recordDeliveryAttempt(attempt);
    await store.putDeadLetter(deadLetter);
    const attempts = store.getDeliveryAttempts();
    const deadLetters = store.getDeadLetters();
    (attempt as { detail: string | null }).detail = "mutated-input";
    (deadLetter.event.domain_data as { state: string }).state = "mutated-input";
    (attempts[0] as { detail: string | null }).detail = "mutated-output";
    (deadLetters[0]?.event.domain_data as { state: string }).state = "mutated-output";

    expect(store.getDeliveryAttempts()).toEqual([
      expect.objectContaining({ detail: "temporary" }),
    ]);
    expect(store.getDeadLetters()).toEqual([
      expect.objectContaining({
        reason: "exhausted",
        event: expect.objectContaining({ domain_data: { state: "accepted" } }),
      }),
    ]);
  });

  it("clones every event and command value entering and leaving the adapter", async () => {
    const store = new MemoryExchangePersistence();
    const event = proposedEvent("event_01");
    const outcome = structuredClone(acceptedOutcome);
    const request = {
      ...oneEventCommit("event_01"),
      outcome,
      appends: [{ stream_id: "stream_01", expected_version: 0, events: [event] }],
    };

    const result = await store.commitAtomically(request);
    expect(result.kind).toBe("committed");
    (event.domain_data as { state: string }).state = "mutated-input";
    (outcome.resource as { state: string }).state = "mutated-input";
    if (result.kind === "committed") {
      (result.events[0]?.domain_data as { state: string }).state = "mutated-result";
    }
    const firstRead = await store.readStream("stream_01");
    (firstRead[0]?.protocol_data as { state: string }).state = "mutated-read";
    const command = await store.findCommand("tenant_01", "key_event_01");
    (command?.outcome.resource as { state: string }).state = "mutated-command";

    expect(await store.readStream("stream_01")).toMatchObject([
      { domain_data: { state: "accepted" }, protocol_data: { state: "accepted" } },
    ]);
    expect(await store.findCommand("tenant_01", "key_event_01")).toMatchObject({
      outcome: { resource: { state: "accepted" } },
    });
  });

  it("passes exchange.persistence.v1", async () => {
    await expect(
      verifyPersistenceProfile(() => new MemoryExchangePersistence()),
    ).resolves.toBeUndefined();
  });
});
