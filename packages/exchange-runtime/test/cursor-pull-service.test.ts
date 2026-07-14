import { beforeAll, describe, expect, it } from "vitest";

import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import type { Clock, IdGenerator } from "@work-fabric/exchange-core";
import type {
  EventJournal,
  EventRecord,
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
  MemorySubscriptionStore,
  OpaqueCursorCodec,
} from "../src/index.js";

const partitionId = "partition_cursor_01";
const tenantId = "tenant_01";
const secret = new TextEncoder().encode(
  "0123456789abcdef0123456789abcdef",
);

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

function record(
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
  constructor(private readonly records: readonly EventRecord[]) {}

  async readStream(
    streamId: string,
    fromVersion = 0,
  ): Promise<readonly EventRecord[]> {
    return structuredClone(
      this.records.filter(
        (event) =>
          event.stream_id === streamId && event.stream_version >= fromVersion,
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
          (event) =>
            event.partition_id === requestedPartitionId &&
            event.partition_position > afterPosition,
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

class TestIds implements IdGenerator {
  calls = 0;

  nextId(kind: "handoff" | "event" | "commit" | "receipt" | "delivery"): string {
    this.calls += 1;
    return `${kind}_${this.calls}`;
  }
}

function subscription(
  overrides: Partial<RuntimeSubscription> = {},
): RuntimeSubscription {
  return {
    subscription_id: "subscription_01",
    tenant_id: tenantId,
    owner: { actor_id: "subscriber_actor", actor_type: "agent" },
    endpoint_id: "subscriber_endpoint",
    filter: {
      ...emptyFilter(),
      event_types: ["workfabric.handoff.accepted.v1"],
    },
    destination: {
      destination_id: "destination_01",
      binding: "cursor",
      configuration: {},
    },
    delivery_mode: "cursor_pull",
    state: "active",
    max_attempts: 3,
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

let schemas: WfppSchemaValidator;

beforeAll(async () => {
  schemas = await loadWfppSchemaValidator("protocol/schemas/v1");
});

async function fixture(
  records: readonly EventRecord[] = [
    record(1, "workfabric.handoff.offered.v1"),
    record(2),
  ],
) {
  const state = new MemoryExchangePersistence();
  const subscriptions = new MemorySubscriptionStore();
  const clock = new MutableClock();
  const ids = new TestIds();
  await subscriptions.putSubscription(subscription());
  const cursors = new OpaqueCursorCodec(secret);
  const service = new CursorPullService(
    new StaticJournal(records),
    state,
    subscriptions,
    new DefaultSubscriptionDeliveryPolicy(),
    clock,
    ids,
    cursors,
    schemas,
    30,
  );
  return { state, subscriptions, clock, ids, cursors, service };
}

function ack(
  deliveryId: string,
  outcome: "acknowledged" | "retry" | "rejected",
  overrides: Record<string, unknown> = {},
) {
  return {
    delivery_id: deliveryId,
    subscription_id: "subscription_01",
    outcome,
    acknowledged_at: "2026-07-15T08:00:20.000Z",
    ...overrides,
  };
}

describe("OpaqueCursorCodec", () => {
  it("round-trips a strict payload only through an authenticated opaque cursor", () => {
    const codec = new OpaqueCursorCodec(secret);
    const payload = {
      subscription_id: "subscription_01",
      partition_id: partitionId,
      position: 2,
      expires_at: "2026-07-15T09:00:00.000Z",
    };
    const cursor = codec.encode(payload);

    expect(cursor).not.toContain("subscription_id");
    expect(codec.decode(cursor, "2026-07-15T08:30:00.000Z")).toEqual(payload);
    expect(() =>
      codec.decode(`${cursor.slice(0, -1)}A`, "2026-07-15T08:30:00.000Z"),
    ).toThrow(/invalid cursor/i);
  });

  it("rejects a non-canonical base64url signature alias even when it decodes to the same HMAC", () => {
    const codec = new OpaqueCursorCodec(secret);
    const cursor = codec.encode({
      subscription_id: "subscription_01",
      partition_id: partitionId,
      position: 2,
      expires_at: "2026-07-15T09:00:00.000Z",
    });
    const [payload, signature] = cursor.split(".") as [string, string];
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = signature.at(-1);
    if (last === undefined) throw new Error("expected cursor signature");
    const index = alphabet.indexOf(last);
    const aliasIndex = (index & 0b111100) | ((index + 1) & 0b11);
    const alias = `${signature.slice(0, -1)}${alphabet[aliasIndex]}`;
    expect(alias).not.toBe(signature);
    expect(Buffer.from(alias, "base64url")).toEqual(
      Buffer.from(signature, "base64url"),
    );

    expect(() => codec.decodeAuthenticated(`${payload}.${alias}`)).toThrow(
      /invalid cursor/i,
    );
  });

  it("compares expiry at nanosecond precision", () => {
    const codec = new OpaqueCursorCodec(secret);
    const cursor = codec.encode({
      subscription_id: "subscription_01",
      partition_id: partitionId,
      position: 0,
      expires_at: "2026-07-15T09:00:00.000000001Z",
    });

    expect(
      codec.decode(cursor, "2026-07-15T09:00:00.000000000Z"),
    ).toMatchObject({ position: 0 });
    expect(() =>
      codec.decode(cursor, "2026-07-15T09:00:00.000000001Z"),
    ).toThrow(/expired/i);
  });

  it("rejects weak secrets and invalid payload fields before encoding", () => {
    expect(() => new OpaqueCursorCodec(new Uint8Array(31))).toThrow(/32 bytes/i);
    const codec = new OpaqueCursorCodec(secret);
    for (const payload of [
      {
        subscription_id: "",
        partition_id: partitionId,
        position: 0,
        expires_at: "2026-07-15T09:00:00.000Z",
      },
      {
        subscription_id: "subscription_01",
        partition_id: partitionId,
        position: -1,
        expires_at: "2026-07-15T09:00:00.000Z",
      },
      {
        subscription_id: "subscription_01",
        partition_id: partitionId,
        position: 0,
        expires_at: "not-a-time",
      },
    ]) {
      expect(() => codec.encode(payload)).toThrow(/cursor/i);
    }
  });
});

describe("CursorPullService", () => {
  it("returns a precondition error without state when the Journal has a gap", async () => {
    const { service, state } = await fixture([record(2)]);

    await expect(
      service.pull("subscription_01", partitionId, null, 10),
    ).resolves.toMatchObject({ kind: "error", code: "precondition_failed" });
    expect(
      await state.loadDeliveryPosition("subscription_01", partitionId),
    ).toBe(0);
    expect(
      await state.getActiveDelivery("subscription_01", partitionId),
    ).toBeNull();
  });

  it("rejects a gap after a contiguous Journal record without partial state", async () => {
    const { service, state } = await fixture([record(1), record(3)]);

    await expect(
      service.pull("subscription_01", partitionId, null, 10),
    ).resolves.toMatchObject({ kind: "error", code: "precondition_failed" });
    expect(
      await state.loadDeliveryPosition("subscription_01", partitionId),
    ).toBe(0);
    expect(
      await state.getActiveDelivery("subscription_01", partitionId),
    ).toBeNull();
  });

  it("preserves fractional precision and uses nanosecond visibility boundaries", async () => {
    const { service, clock } = await fixture([record(1)]);
    clock.instant = "2026-07-15T08:00:10.123456789Z";
    const first = await service.pull("subscription_01", partitionId, null, 10);
    if (first.kind !== "delivery") throw new Error("expected delivery");
    expect(first.delivery.visibility_expires_at).toBe(
      "2026-07-15T08:00:40.123456789Z",
    );

    clock.instant = "2026-07-15T08:00:40.123456788Z";
    const before = await service.pull("subscription_01", partitionId, null, 10);
    expect(before).toMatchObject({
      kind: "delivery",
      delivery: { delivery_id: first.delivery.delivery_id, attempt: 1 },
    });

    clock.instant = "2026-07-15T08:00:40.123456789Z";
    const atExpiry = await service.pull(
      "subscription_01",
      partitionId,
      null,
      10,
    );
    expect(atExpiry).toMatchObject({ kind: "delivery", delivery: { attempt: 2 } });
  });
  it("skips unmatched Events, returns a schema-valid public Delivery, and keeps position pending", async () => {
    const { service, state } = await fixture();

    const result = await service.pull("subscription_01", partitionId, null, 10);
    expect(result.kind).toBe("delivery");
    if (result.kind !== "delivery") return;

    expect(result.delivery.events.map((event) => event.id)).toEqual(["event_2"]);
    expect(
      schemas.validate(
        "urn:work-fabric:schema:v1:event-delivery",
        result.delivery,
      ),
    ).toEqual({ valid: true });
    expect(await state.loadDeliveryPosition("subscription_01", partitionId)).toBe(
      0,
    );
    expect(result.delivery.events[0]).not.toHaveProperty("domain_data");
    expect(result.delivery.events[0]).not.toHaveProperty("partition_id");
    expect(result.delivery.events[0]).not.toHaveProperty("partition_position");
    expect(result.delivery.events[0]).not.toHaveProperty("commit_id");
    expect(result.delivery.events[0]).not.toHaveProperty("idempotency_key");
    expect(result.delivery.events[0]).not.toHaveProperty("visible_actor_ids");
    expect(result.delivery.events[0]).not.toHaveProperty("visible_endpoint_ids");
  });

  it("recovers one non-overlapping pending Delivery across concurrent and repeated Pull", async () => {
    const { service, state, ids, cursors } = await fixture([record(1)]);
    const requestCursor = cursors.encode({
      subscription_id: "subscription_01",
      partition_id: partitionId,
      position: 0,
      expires_at: "2026-07-15T09:00:00.000Z",
    });

    const [first, concurrent] = await Promise.all([
      service.pull("subscription_01", partitionId, requestCursor, 10),
      service.pull("subscription_01", partitionId, requestCursor, 10),
    ]);
    const repeated = await service.pull(
      "subscription_01",
      partitionId,
      requestCursor,
      10,
    );
    expect(first.kind).toBe("delivery");
    expect(concurrent.kind).toBe("delivery");
    expect(repeated.kind).toBe("delivery");
    if (
      first.kind !== "delivery" ||
      concurrent.kind !== "delivery" ||
      repeated.kind !== "delivery"
    ) {
      return;
    }
    expect(new Set([
      first.delivery.delivery_id,
      concurrent.delivery.delivery_id,
      repeated.delivery.delivery_id,
    ])).toEqual(new Set([first.delivery.delivery_id]));
    expect(ids.calls).toBeGreaterThanOrEqual(1);
    expect(
      await state.getActiveDelivery("subscription_01", partitionId),
    ).toMatchObject({
      delivery_id: first.delivery.delivery_id,
      outcome: "pending",
      attempt: 1,
    });
  });

  it("rejects tampered, cross-Subscription, stale-position, and invalid limit inputs", async () => {
    const { service, cursors, ids } = await fixture([record(1)]);
    const valid = cursors.encode({
      subscription_id: "subscription_01",
      partition_id: partitionId,
      position: 0,
      expires_at: "2026-07-15T09:00:00.000Z",
    });
    const crossSubscription = cursors.encode({
      subscription_id: "subscription_other",
      partition_id: partitionId,
      position: 0,
      expires_at: "2026-07-15T09:00:00.000Z",
    });
    const stale = cursors.encode({
      subscription_id: "subscription_01",
      partition_id: partitionId,
      position: 1,
      expires_at: "2026-07-15T09:00:00.000Z",
    });

    await expect(
      service.pull("subscription_01", partitionId, `${valid.slice(0, -1)}A`, 10),
    ).resolves.toMatchObject({ kind: "error", code: "invalid_argument" });
    await expect(
      service.pull("subscription_01", partitionId, crossSubscription, 10),
    ).resolves.toMatchObject({ kind: "error", code: "precondition_failed" });
    await expect(
      service.pull("subscription_01", partitionId, stale, 10),
    ).resolves.toMatchObject({ kind: "error", code: "precondition_failed" });
    const callsBeforeInvalidLimit = ids.calls;
    await expect(
      service.pull("subscription_01", partitionId, null, 0),
    ).resolves.toMatchObject({ kind: "error", code: "invalid_argument" });
    expect(ids.calls).toBe(callsBeforeInvalidLimit);
  });

  it("Ack acknowledged atomically advances position and is idempotent", async () => {
    const { service, state } = await fixture([record(1)]);
    const pulled = await service.pull("subscription_01", partitionId, null, 10);
    expect(pulled.kind).toBe("delivery");
    if (pulled.kind !== "delivery") return;

    const input = ack(pulled.delivery.delivery_id, "acknowledged", {
      cursor: pulled.delivery.next_cursor,
      last_event_id: "event_1",
    });
    const first = await service.acknowledge(input);
    const replay = await service.acknowledge(input);
    expect(first).toMatchObject({ kind: "acknowledged" });
    expect(replay).toEqual(first);
    expect(await state.loadDeliveryPosition("subscription_01", partitionId)).toBe(
      1,
    );
    expect(await state.getActiveDelivery("subscription_01", partitionId)).toBeNull();
    expect(await state.readStream("handoff_01")).toEqual([]);
  });

  it("replays the same settled Ack after its signed next Cursor expires but still rejects tampering", async () => {
    const { service, clock } = await fixture([record(1)]);
    const pulled = await service.pull("subscription_01", partitionId, null, 10);
    if (pulled.kind !== "delivery") throw new Error("expected delivery");
    const input = ack(pulled.delivery.delivery_id, "acknowledged", {
      cursor: pulled.delivery.next_cursor,
    });
    await expect(service.acknowledge(input)).resolves.toMatchObject({
      kind: "acknowledged",
    });
    clock.instant = "2026-07-15T08:02:00.000Z";

    await expect(service.acknowledge(input)).resolves.toMatchObject({
      kind: "acknowledged",
    });
    const signed = pulled.delivery.next_cursor;
    const tampered = `${signed.slice(0, -1)}${signed.endsWith("A") ? "B" : "A"}`;
    await expect(
      service.acknowledge(ack(pulled.delivery.delivery_id, "acknowledged", {
        cursor: tampered,
      })),
    ).resolves.toMatchObject({ kind: "error", code: "invalid_argument" });
  });

  it("Ack retry leaves position and replaces the active Delivery at attempt + 1", async () => {
    const { service, state, clock } = await fixture([record(1)]);
    const pulled = await service.pull("subscription_01", partitionId, null, 10);
    if (pulled.kind !== "delivery") throw new Error("expected delivery");

    clock.instant = "2026-07-15T08:00:20.000Z";
    const retriedAck = await service.acknowledge(
      ack(pulled.delivery.delivery_id, "retry"),
    );
    expect(retriedAck).toMatchObject({ kind: "retry" });
    if (retriedAck.kind !== "retry") throw new Error("expected retry Ack");
    expect(await state.loadDeliveryPosition("subscription_01", partitionId)).toBe(
      0,
    );
    clock.instant = "2026-07-15T08:00:45.000Z";
    const retried = await service.pull(
      "subscription_01",
      partitionId,
      retriedAck.cursor,
      10,
    );
    expect(retried.kind).toBe("delivery");
    if (retried.kind !== "delivery") return;
    expect(retried.delivery.delivery_id).not.toBe(pulled.delivery.delivery_id);
    expect(retried.delivery.attempt).toBe(2);
    expect(retried.delivery.events.map((event) => event.id)).toEqual(["event_1"]);
  });

  it("Ack rejected atomically dead-letters each Event once and advances", async () => {
    const { service, state } = await fixture([record(1)]);
    const pulled = await service.pull("subscription_01", partitionId, null, 10);
    if (pulled.kind !== "delivery") throw new Error("expected delivery");
    const input = ack(pulled.delivery.delivery_id, "rejected", {
      details: { reason: "consumer rejected" },
    });

    const [first, concurrent] = await Promise.all([
      service.acknowledge(input),
      service.acknowledge(input),
    ]);
    expect(first).toMatchObject({ kind: "rejected" });
    expect(concurrent).toEqual(first);
    expect(await state.loadDeliveryPosition("subscription_01", partitionId)).toBe(
      1,
    );
    expect(await state.listDeadLetters("subscription_01", "event_1")).toEqual([
      expect.objectContaining({
        attempts: 1,
        reason: "consumer rejected",
        recorded_at: "2026-07-15T08:00:10.000Z",
      }),
    ]);
  });

  it("rejects an expired pending Ack and atomically claims a new attempt", async () => {
    const { service, state, clock } = await fixture([record(1)]);
    const pulled = await service.pull("subscription_01", partitionId, null, 10);
    if (pulled.kind !== "delivery") throw new Error("expected delivery");
    clock.instant = "2026-07-15T08:01:00.000Z";

    await expect(
      service.acknowledge(ack(pulled.delivery.delivery_id, "acknowledged")),
    ).resolves.toMatchObject({ kind: "error", code: "cursor_expired" });
    const replacement = await service.pull(
      "subscription_01",
      partitionId,
      null,
      10,
    );
    expect(replacement.kind).toBe("delivery");
    if (replacement.kind !== "delivery") return;
    expect(replacement.delivery.attempt).toBe(2);
    expect(replacement.delivery.delivery_id).not.toBe(
      pulled.delivery.delivery_id,
    );
    expect(await state.getDelivery(pulled.delivery.delivery_id)).toMatchObject({
      outcome: "expired",
    });
  });

  it("rejects a different repeated Ack outcome and a stale position without partial settlement", async () => {
    const { service, state } = await fixture([record(1)]);
    const pulled = await service.pull("subscription_01", partitionId, null, 10);
    if (pulled.kind !== "delivery") throw new Error("expected delivery");

    await expect(
      service.acknowledge(ack(pulled.delivery.delivery_id, "retry")),
    ).resolves.toMatchObject({ kind: "retry" });
    await expect(
      service.acknowledge(ack(pulled.delivery.delivery_id, "rejected")),
    ).resolves.toMatchObject({ kind: "error", code: "precondition_failed" });

    const next = await service.pull("subscription_01", partitionId, null, 10);
    if (next.kind !== "delivery") throw new Error("expected replacement");
    expect(
      await state.advanceDeliveryPosition("subscription_01", partitionId, 0, 1),
    ).toBe(true);
    await expect(
      service.acknowledge(ack(next.delivery.delivery_id, "rejected")),
    ).resolves.toMatchObject({ kind: "error", code: "precondition_failed" });
    expect(await state.listDeadLetters("subscription_01", "event_1")).toEqual([]);
    expect(await state.getDelivery(next.delivery.delivery_id)).toMatchObject({
      outcome: "pending",
    });
  });
});
