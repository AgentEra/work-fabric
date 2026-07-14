import assert from "node:assert/strict";

import {
  PERSISTENCE_REQUIRED_CAPABILITIES,
  type AtomicCommitRequest,
  type DeliveryStateStore,
  type ExchangePersistence,
  type NormalizedOperationOutcome,
  type ProjectionFailureRecord,
  type ProjectionFailureStore,
  type ProjectionCheckpointStore,
  type ProposedEvent,
} from "@work-fabric/exchange-spi";

export type PersistenceConformanceAdapter = ExchangePersistence &
  ProjectionCheckpointStore &
  ProjectionFailureStore &
  DeliveryStateStore;

export type ExchangePersistenceFactory = () => PersistenceConformanceAdapter;

type PersistenceStore = ReturnType<ExchangePersistenceFactory>;

interface Scenario {
  readonly name: string;
  readonly verify: (store: PersistenceStore) => Promise<void>;
}

const acceptedOutcome: NormalizedOperationOutcome = {
  operation_status: "accepted",
  resource: { handoff_id: "handoff_01", state: "accepted" },
  receipt: { receipt_id: "receipt_01" },
  error: null,
};

function proposedEvent(eventId: string): ProposedEvent {
  return {
    event_id: eventId,
    event_type: "workfabric.conformance.test.v1",
    schema_version: "1.0",
    exchange_id: "exchange_01",
    request_message_id: `message_${eventId}`,
    idempotency_key: `key_${eventId}`,
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

function request(
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

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const scenarios: readonly Scenario[] = [
  {
    name: "required capabilities",
    async verify(store) {
      assert.equal(store.manifest.profile, "exchange.persistence.v1");
      for (const capability of PERSISTENCE_REQUIRED_CAPABILITIES) {
        assert.equal(
          store.manifest.capabilities[capability],
          true,
          `missing required capability: ${capability}`,
        );
      }
    },
  },
  {
    name: "single stream append and read",
    async verify(store) {
      const result = await store.commitAtomically(request("event_01"));
      assert.equal(result.kind, "committed");
      if (result.kind !== "committed") {
        return;
      }
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]?.stream_version, 1);
      assert.equal(result.events[0]?.partition_position, 1);
      assert.equal(result.events[0]?.commit_ordinal, 0);
      assert.deepEqual(await store.readStream("stream_event_01"), result.events);
    },
  },
  {
    name: "expected version conflict",
    async verify(store) {
      await store.commitAtomically(request("event_01"));
      const result = await store.commitAtomically({
        ...request("event_02"),
        appends: [
          {
            stream_id: "stream_event_01",
            expected_version: 0,
            events: [proposedEvent("event_02")],
          },
        ],
      });
      assert.deepEqual(result, {
        kind: "version_conflict",
        current_versions: { stream_event_01: 1 },
      });
      assert.equal((await store.readStream("stream_event_01")).length, 1);
    },
  },
  {
    name: "read-only version checks are atomic with appends",
    async verify(store) {
      await store.commitAtomically(
        request("parent-1", {
          appends: [
            {
              stream_id: "parent",
              expected_version: 0,
              events: [proposedEvent("parent-1")],
            },
          ],
        }),
      );
      const firstChild = await store.commitAtomically(
        request("child-1", {
          version_checks: [{ stream_id: "parent", expected_version: 1 }],
          appends: [
            {
              stream_id: "child",
              expected_version: 0,
              events: [proposedEvent("child-1")],
            },
          ],
        }),
      );
      assert.equal(firstChild.kind, "committed");
      await store.commitAtomically(
        request("parent-2", {
          appends: [
            {
              stream_id: "parent",
              expected_version: 1,
              events: [proposedEvent("parent-2")],
            },
          ],
        }),
      );

      const stale = await store.commitAtomically(
        request("stale-child", {
          version_checks: [{ stream_id: "parent", expected_version: 1 }],
          appends: [
            {
              stream_id: "stale-child",
              expected_version: 0,
              events: [proposedEvent("stale-child")],
            },
          ],
        }),
      );
      assert.deepEqual(stale, {
        kind: "version_conflict",
        current_versions: { parent: 2, "stale-child": 0 },
      });
      assert.deepEqual(await store.readStream("stale-child"), []);
      assert.equal(
        await store.findCommand("tenant_01", "key_stale-child"),
        null,
      );

      await assert.rejects(
        store.commitAtomically(
          request("cross-partition-child", {
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
        ),
        /partition/i,
      );
      assert.deepEqual(await store.readStream("cross-partition-child"), []);

      await assert.rejects(
        store.commitAtomically(
          request("overlap", {
            version_checks: [
              { stream_id: "stream_overlap", expected_version: 0 },
            ],
          }),
        ),
        /version check.*append/i,
      );
    },
  },
  {
    name: "version checks reject duplicates and preserve special stream keys",
    async verify(store) {
      const duplicate = request("duplicate-check", {
        version_checks: [
          { stream_id: "checked", expected_version: 0 },
          { stream_id: "checked", expected_version: 0 },
        ],
        appends: [
          {
            stream_id: "duplicate-child",
            expected_version: 0,
            events: [proposedEvent("duplicate-check")],
          },
        ],
      });
      await assert.rejects(
        store.commitAtomically(duplicate),
        /duplicate.*version check/i,
      );
      assert.deepEqual(await store.readStream("duplicate-child"), []);
      assert.equal(
        await store.findCommand(
          duplicate.tenant_id,
          duplicate.idempotency_key,
        ),
        null,
      );

      await store.commitAtomically(
        request("special-seed", {
          appends: [
            {
              stream_id: "__proto__",
              expected_version: 0,
              events: [proposedEvent("special-proto")],
            },
            {
              stream_id: "constructor",
              expected_version: 0,
              events: [proposedEvent("special-constructor")],
            },
          ],
        }),
      );
      const specialConflictRequest = request("special-conflict", {
        version_checks: [
          { stream_id: "__proto__", expected_version: 0 },
          { stream_id: "constructor", expected_version: 0 },
        ],
        appends: [
          {
            stream_id: "special-child",
            expected_version: 0,
            events: [proposedEvent("special-conflict")],
          },
        ],
      });
      const specialConflict = await store.commitAtomically(
        specialConflictRequest,
      );
      assert.equal(specialConflict.kind, "version_conflict");
      if (specialConflict.kind !== "version_conflict") return;
      assert.equal(
        Object.hasOwn(specialConflict.current_versions, "__proto__"),
        true,
      );
      assert.equal(
        Object.hasOwn(specialConflict.current_versions, "constructor"),
        true,
      );
      assert.equal(specialConflict.current_versions["__proto__"], 1);
      assert.equal(specialConflict.current_versions.constructor, 1);
      assert.equal(
        Object.hasOwn(specialConflict.current_versions, "special-child"),
        true,
      );
      assert.equal(specialConflict.current_versions["special-child"], 0);
      const versionsPrototype = Object.getPrototypeOf(
        specialConflict.current_versions,
      );
      assert.equal(
        versionsPrototype === null || versionsPrototype === Object.prototype,
        true,
      );
      assert.deepEqual(await store.readStream("special-child"), []);
      assert.equal(
        await store.findCommand(
          specialConflictRequest.tenant_id,
          specialConflictRequest.idempotency_key,
        ),
        null,
      );
    },
  },
  {
    name: "same stream concurrent append has one winner",
    async verify(store) {
      const first = request("event_01", {
        appends: [
          {
            stream_id: "contended",
            expected_version: 0,
            events: [proposedEvent("event_01")],
          },
        ],
      });
      const second = request("event_02", {
        appends: [
          {
            stream_id: "contended",
            expected_version: 0,
            events: [proposedEvent("event_02")],
          },
        ],
      });
      const results = await Promise.all([
        store.commitAtomically(first),
        store.commitAtomically(second),
      ]);
      assert.deepEqual(
        results.map((result) => result.kind).sort(),
        ["committed", "version_conflict"],
      );
      const records = await store.readStream("contended");
      assert.equal(records.length, 1);
      const winner = records[0]?.event_id === "event_01" ? first : second;
      const loser = winner === first ? second : first;
      assert.notEqual(
        await store.findCommand(winner.tenant_id, winner.idempotency_key),
        null,
      );
      assert.equal(
        await store.findCommand(loser.tenant_id, loser.idempotency_key),
        null,
      );
    },
  },
  {
    name: "same key and same digest replays outcome",
    async verify(store) {
      const original = request("event_01");
      await store.commitAtomically(original);
      const replay = await store.commitAtomically({
        ...original,
        commit_id: "commit_replay",
        appends: [
          {
            stream_id: "stream_event_01",
            expected_version: 99,
            events: [proposedEvent("event_replay")],
          },
        ],
      });
      assert.deepEqual(replay, { kind: "replayed", outcome: acceptedOutcome });
      assert.equal((await store.readStream("stream_event_01")).length, 1);
    },
  },
  {
    name: "same key and different digest is rejected",
    async verify(store) {
      const original = request("event_01");
      await store.commitAtomically(original);
      const reused = await store.commitAtomically({
        ...original,
        payload_digest: "sha256:different",
      });
      assert.deepEqual(reused, { kind: "idempotency_key_reused" });
      assert.equal((await store.readStream("stream_event_01")).length, 1);
    },
  },
  {
    name: "multi-stream append is atomic",
    async verify(store) {
      await store.commitAtomically({
        ...request("seed"),
        appends: [
          { stream_id: "first", expected_version: 0, events: [proposedEvent("first-1")] },
          { stream_id: "second", expected_version: 0, events: [proposedEvent("second-1")] },
        ],
      });
      const committed = await store.commitAtomically({
        ...request("multi"),
        appends: [
          { stream_id: "first", expected_version: 1, events: [proposedEvent("first-2")] },
          { stream_id: "second", expected_version: 1, events: [proposedEvent("second-2")] },
        ],
      });
      assert.equal(committed.kind, "committed");
      const failed = await store.commitAtomically({
        ...request("failed-multi"),
        appends: [
          { stream_id: "first", expected_version: 2, events: [proposedEvent("first-3")] },
          { stream_id: "second", expected_version: 1, events: [proposedEvent("second-3")] },
        ],
      });
      assert.equal(failed.kind, "version_conflict");
      assert.equal((await store.readStream("first")).length, 2);
      assert.equal((await store.readStream("second")).length, 2);
      assert.equal(await store.findCommand("tenant_01", "key_failed-multi"), null);
    },
  },
  {
    name: "cross-partition stream append is rejected",
    async verify(store) {
      await store.commitAtomically({
        ...request("event_01"),
        partition_id: "partition_01",
        appends: [
          {
            stream_id: "assigned-stream",
            expected_version: 0,
            events: [proposedEvent("event_01")],
          },
        ],
      });
      await assert.rejects(
        store.commitAtomically({
          ...request("event_02"),
          partition_id: "partition_02",
          appends: [
            {
              stream_id: "assigned-stream",
              expected_version: 1,
              events: [proposedEvent("event_02")],
            },
          ],
        }),
        /partition/i,
      );
      assert.equal((await store.readStream("assigned-stream")).length, 1);
      assert.equal(await store.findCommand("tenant_01", "key_event_02"), null);
    },
  },
  {
    name: "partition positions are stable and increasing",
    async verify(store) {
      await store.commitAtomically({
        ...request("first"),
        appends: [
          {
            stream_id: "first-stream",
            expected_version: 0,
            events: [proposedEvent("event_01"), proposedEvent("event_02")],
          },
        ],
      });
      await store.commitAtomically({
        ...request("second"),
        appends: [
          {
            stream_id: "second-stream",
            expected_version: 0,
            events: [proposedEvent("event_03")],
          },
        ],
      });
      const firstRead = await store.readPartition("partition_01", 0, 10);
      const secondRead = await store.readPartition("partition_01", 0, 10);
      assert.deepEqual(
        firstRead.map((event) => event.partition_position),
        [1, 2, 3],
      );
      assert.deepEqual(secondRead, firstRead);
      assert.deepEqual(
        (await store.readPartition("partition_01", 1, 10)).map(
          (event) => event.partition_position,
        ),
        [2, 3],
      );
    },
  },
  {
    name: "stream versions are stable and increasing",
    async verify(store) {
      await store.commitAtomically({
        ...request("first"),
        appends: [
          {
            stream_id: "versioned-stream",
            expected_version: 0,
            events: [proposedEvent("event_01"), proposedEvent("event_02")],
          },
        ],
      });
      await store.commitAtomically({
        ...request("second"),
        appends: [
          {
            stream_id: "versioned-stream",
            expected_version: 2,
            events: [proposedEvent("event_03")],
          },
        ],
      });
      assert.deepEqual(
        (await store.readStream("versioned-stream")).map(
          (event) => event.stream_version,
        ),
        [1, 2, 3],
      );
      assert.deepEqual(
        (await store.readStream("versioned-stream", 2)).map(
          (event) => event.stream_version,
        ),
        [2, 3],
      );
    },
  },
  {
    name: "failed transaction leaves no events or command record",
    async verify(store) {
      const failedRequest = request("unavailable", {
        outcome: {
          operation_status: "temporarily_unavailable",
          resource: null,
          receipt: null,
          error: { code: "unavailable" },
        },
      });
      await assert.rejects(
        store.commitAtomically(failedRequest),
        /temporarily_unavailable/i,
      );
      assert.deepEqual(await store.readStream("stream_unavailable"), []);
      assert.equal(
        await store.findCommand(
          failedRequest.tenant_id,
          failedRequest.idempotency_key,
        ),
        null,
      );
    },
  },
  {
    name: "returned values cannot mutate stored events",
    async verify(store) {
      const event = proposedEvent("event_01");
      const result = await store.commitAtomically({
        ...request("event_01"),
        appends: [
          {
            stream_id: "immutable-stream",
            expected_version: 0,
            events: [event],
          },
        ],
      });
      assert.equal(result.kind, "committed");
      (event.domain_data as { state: string }).state = "mutated-input";
      if (result.kind === "committed") {
        (result.events[0]?.domain_data as { state: string }).state =
          "mutated-result";
      }
      const firstRead = await store.readStream("immutable-stream");
      (firstRead[0]?.domain_data as { state: string }).state = "mutated-read";
      assert.deepEqual(
        (await store.readStream("immutable-stream"))[0]?.domain_data,
        { state: "accepted" },
      );
    },
  },
  {
    name: "snapshot round trip and delete",
    async verify(store) {
      const snapshot = {
        stream_id: "stream_01",
        stream_version: 3,
        schema_version: "1.0",
        state: { state: "accepted" },
      } as const;
      await store.saveSnapshot(snapshot);
      const loaded = await store.loadSnapshot("stream_01");
      assert.deepEqual(loaded, snapshot);
      if (loaded !== null) {
        (loaded.state as { state: string }).state = "mutated";
      }
      assert.deepEqual((await store.loadSnapshot("stream_01"))?.state, {
        state: "accepted",
      });
      await store.deleteSnapshot("stream_01");
      assert.equal(await store.loadSnapshot("stream_01"), null);
    },
  },
  {
    name: "checkpoint position validation",
    async verify(store) {
      assert.equal(
        await store.advanceProjectionCheckpoint(
          "projector_zero_checkpoint",
          "partition_zero_checkpoint",
          0,
          0,
        ),
        true,
      );
      assert.equal(
        await store.loadProjectionCheckpoint(
          "projector_zero_checkpoint",
          "partition_zero_checkpoint",
        ),
        0,
      );
      const invalidPositions = [
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ];
      for (const invalidPosition of invalidPositions) {
        await assert.rejects(
          store.advanceProjectionCheckpoint(
            "projector_invalid_checkpoint",
            "partition_invalid_checkpoint",
            invalidPosition,
            1,
          ),
        );
        await assert.rejects(
          store.advanceProjectionCheckpoint(
            "projector_invalid_checkpoint",
            "partition_invalid_checkpoint",
            0,
            invalidPosition,
          ),
        );
      }
      assert.equal(
        await store.loadProjectionCheckpoint(
          "projector_invalid_checkpoint",
          "partition_invalid_checkpoint",
        ),
        0,
      );
    },
  },
  {
    name: "Projection Failure position validation",
    async verify(store) {
      const invalidPositions = [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ];
      for (const [index, invalidPosition] of invalidPositions.entries()) {
        await assert.rejects(
          store.putProjectionFailure({
            projector_id: "projector_invalid_failure",
            partition_id: "partition_invalid_failure",
            event_id: `event_invalid_failure_${index}`,
            position: invalidPosition,
            reason: "invalid position",
            recorded_at: "2026-07-15T00:00:00.000Z",
          }),
        );
      }
      assert.deepEqual(
        await store.listProjectionFailures(
          "projector_invalid_failure",
          "partition_invalid_failure",
        ),
        [],
      );
    },
  },
  {
    name: "Projection Failure immutable first-record semantics",
    async verify(store) {
      const first: ProjectionFailureRecord = {
        projector_id: "projector_failure",
        partition_id: "partition_failure",
        event_id: "event_failure",
        position: 7,
        reason: "first reason",
        recorded_at: "2026-07-15T01:00:00.000Z",
      };
      const expected = structuredClone(first);
      await store.putProjectionFailure(first);
      (first as { reason: string }).reason = "mutated input";
      await store.putProjectionFailure({
        ...expected,
        reason: "later reason",
        recorded_at: "2026-07-15T02:00:00.000Z",
      });
      await store.putProjectionFailure({
        ...expected,
        projector_id: "projector_other",
      });
      await store.putProjectionFailure({
        ...expected,
        partition_id: "partition_other",
      });

      const listed = await store.listProjectionFailures(
        expected.projector_id,
        expected.partition_id,
      );
      assert.deepEqual(listed, [expected]);
      const listedFailure = listed[0];
      assert.notEqual(listedFailure, undefined);
      if (listedFailure !== undefined) {
        (listedFailure as { reason: string }).reason = "mutated output";
      }
      assert.deepEqual(
        await store.listProjectionFailures(
          expected.projector_id,
          expected.partition_id,
        ),
        [expected],
      );
      assert.deepEqual(
        await store.listProjectionFailures(
          "projector_other",
          expected.partition_id,
        ),
        [{ ...expected, projector_id: "projector_other" }],
      );
      assert.deepEqual(
        await store.listProjectionFailures(
          expected.projector_id,
          "partition_other",
        ),
        [{ ...expected, partition_id: "partition_other" }],
      );
    },
  },
  {
    name: "projection checkpoint compare-and-advance and explicit reset",
    async verify(store) {
      assert.equal(
        await store.loadProjectionCheckpoint("projector_01", "partition_01"),
        0,
      );
      assert.equal(
        await store.advanceProjectionCheckpoint(
          "projector_01",
          "partition_01",
          0,
          4,
        ),
        true,
      );
      assert.equal(
        await store.advanceProjectionCheckpoint(
          "projector_01",
          "partition_01",
          0,
          5,
        ),
        false,
      );
      assert.equal(
        await store.advanceProjectionCheckpoint(
          "projector_01",
          "partition_01",
          4,
          3,
        ),
        false,
      );
      assert.equal(
        await store.loadProjectionCheckpoint("projector_01", "partition_01"),
        4,
      );
      await store.resetProjectionCheckpoint("projector_01", "partition_01");
      assert.equal(
        await store.loadProjectionCheckpoint("projector_01", "partition_01"),
        0,
      );
    },
  },
  {
    name: "delivery position compare-and-advance",
    async verify(store) {
      assert.equal(
        await store.loadDeliveryPosition("subscription_01", "partition_01"),
        0,
      );
      assert.equal(
        await store.advanceDeliveryPosition(
          "subscription_01",
          "partition_01",
          0,
          5,
        ),
        true,
      );
      assert.equal(
        await store.advanceDeliveryPosition(
          "subscription_01",
          "partition_01",
          0,
          6,
        ),
        false,
      );
      assert.equal(
        await store.advanceDeliveryPosition(
          "subscription_01",
          "partition_01",
          5,
          4,
        ),
        false,
      );
      assert.equal(
        await store.loadDeliveryPosition("subscription_01", "partition_01"),
        5,
      );
    },
  },
];

export async function verifyPersistenceProfile(
  factory: ExchangePersistenceFactory,
): Promise<void> {
  for (const scenario of scenarios) {
    try {
      const store = factory();
      await scenario.verify(store);
    } catch (error: unknown) {
      throw new Error(
        `Persistence profile scenario "${scenario.name}" failed: ${failureMessage(error)}`,
        { cause: error },
      );
    }
  }
}
