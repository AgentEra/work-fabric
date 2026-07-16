import assert from "node:assert/strict";

import {
  PROJECTION_REQUIRED_CAPABILITIES,
  assertCapabilities,
  type HandoffReadModel,
  type HandoffReadModelStore,
} from "@work-fabric/exchange-spi";

export type ProjectionStoreFactory = () => HandoffReadModelStore;

interface Scenario {
  readonly name: string;
  readonly verify: (store: HandoffReadModelStore) => Promise<void>;
}

function model(
  handoffId: string,
  partitionId: string,
  streamVersion: number,
  tenantId = "tenant_01",
): HandoffReadModel {
  return {
    tenant_id: tenantId,
    partition_id: partitionId,
    handoff_id: handoffId,
    stream_version: streamVersion,
    state: { opaque: { marker: `${handoffId}:${streamVersion}` } },
    latest_status: { progress: streamVersion },
  };
}

const scenarios: readonly Scenario[] = [
  {
    name: "required capabilities",
    async verify(store) {
      assert.equal(store.manifest.profile, "exchange.projection.v1");
      assertCapabilities(store.manifest, PROJECTION_REQUIRED_CAPABILITIES);
    },
  },
  {
    name: "immutable input and read values",
    async verify(store) {
      const input = model("handoff_01", "partition_01", 1);
      const expected = structuredClone(input);
      await store.putHandoff(input);
      (input.state.opaque as { marker: string }).marker = "mutated-input";
      (input.latest_status as { progress: number }).progress = 99;
      assert.deepEqual(await store.getHandoff("handoff_01"), expected);

      const read = await store.getHandoff("handoff_01");
      assert.notEqual(read, null);
      if (read !== null) {
        (read.state.opaque as { marker: string }).marker = "mutated-read";
        (read.latest_status as { progress: number }).progress = 100;
      }
      const listed = await store.listHandoffs("partition_01");
      assert.equal(listed.length, 1);
      const listedModel = listed[0];
      assert.notEqual(listedModel, undefined);
      if (listedModel !== undefined) {
        (listedModel.state.opaque as { marker: string }).marker = "mutated-list";
      }
      assert.deepEqual(await store.getHandoff("handoff_01"), expected);
    },
  },
  {
    name: "idempotent repeated same-version write",
    async verify(store) {
      const first = model("handoff_01", "partition_01", 1);
      await store.putHandoff(first);
      await store.putHandoff(structuredClone(first));
      assert.deepEqual(await store.getHandoff(first.handoff_id), first);
      assert.deepEqual(await store.listHandoffs(first.partition_id), [first]);
    },
  },
  {
    name: "inconsistent same-version write",
    async verify(store) {
      const first = model("handoff_01", "partition_01", 1);
      await store.putHandoff(first);
      await assert.rejects(
        store.putHandoff({
          ...first,
          state: { opaque: { marker: "different-content" } },
        }),
      );
      assert.deepEqual(await store.getHandoff(first.handoff_id), first);
    },
  },
  {
    name: "stale write rejection",
    async verify(store) {
      const newest = model("handoff_01", "partition_01", 2);
      await store.putHandoff(newest);
      await assert.rejects(
        store.putHandoff(model("handoff_01", "partition_01", 1)),
      );
      assert.deepEqual(await store.getHandoff(newest.handoff_id), newest);
    },
  },
  {
    name: "positive safe stream version rejection",
    async verify(store) {
      const invalidVersions = [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ];
      for (const [index, invalidVersion] of invalidVersions.entries()) {
        const handoffId = `handoff_invalid_version_${index}`;
        const invalidModel: HandoffReadModel = {
          ...model(handoffId, "partition_01", invalidVersion),
          latest_status: { progress: 1 },
        };
        await assert.rejects(
          store.putHandoff(invalidModel),
        );
        assert.equal(await store.getHandoff(handoffId), null);
      }
    },
  },
  {
    name: "invalid identity rejection",
    async verify(store) {
      for (const field of [
        "tenant_id",
        "partition_id",
        "handoff_id",
      ] as const) {
        const candidate = model(
          `handoff_invalid_${field}`,
          "partition_01",
          1,
        );
        await assert.rejects(
          store.putHandoff({
            ...candidate,
            [field]: 42 as unknown as string,
          }),
        );
        if (field !== "handoff_id") {
          assert.equal(await store.getHandoff(candidate.handoff_id), null);
        }
      }
    },
  },
  {
    name: "identity invariants",
    async verify(store) {
      const original = model("handoff_01", "partition_01", 1);
      await store.putHandoff(original);
      await assert.rejects(
        store.putHandoff(model("handoff_01", "partition_01", 2, "tenant_02")),
      );
      await assert.rejects(
        store.putHandoff(model("handoff_01", "partition_02", 2)),
      );
      assert.deepEqual(await store.getHandoff(original.handoff_id), original);
    },
  },
  {
    name: "deterministic list and Partition isolation",
    async verify(store) {
      const upper = model("handoff_Z", "partition_01", 1);
      const lower = model("handoff_a", "partition_01", 1);
      const other = model("handoff_other", "partition_02", 1, "tenant_02");
      await store.putHandoff(lower);
      await store.putHandoff(other);
      await store.putHandoff(upper);

      assert.deepEqual(await store.listHandoffs("partition_01"), [upper, lower]);
      assert.deepEqual(await store.listHandoffs("partition_01"), [upper, lower]);
      assert.deepEqual(await store.listHandoffs("partition_02"), [other]);
      await store.clearPartition("partition_01");
      assert.deepEqual(await store.listHandoffs("partition_01"), []);
      assert.deepEqual(await store.getHandoff(other.handoff_id), other);
      assert.deepEqual(await store.listHandoffs("partition_02"), [other]);

      await store.putHandoff(lower);
      await store.putHandoff(upper);
      assert.deepEqual(await store.listHandoffs("partition_01"), [upper, lower]);
    },
  },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function verifyProjectionProfile(
  factory: ProjectionStoreFactory,
): Promise<void> {
  for (const scenario of scenarios) {
    try {
      await scenario.verify(factory());
    } catch (error) {
      throw new Error(
        `Projection Profile scenario "${scenario.name}" failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

export type TenantScopedProjectionStoreFactory = (
  tenantId: string,
) => HandoffReadModelStore;

/**
 * Verifies adapters whose read methods are intentionally bound to one trusted
 * tenant session (for example a database adapter using RLS). This preserves the
 * same monotonic/immutable semantics without requiring one store instance to
 * switch tenant context after construction.
 */
export async function verifyTenantScopedProjectionProfile(
  factory: TenantScopedProjectionStoreFactory,
): Promise<void> {
  const tenantOne = "tenant_scoped_01";
  const tenantTwo = "tenant_scoped_02";
  const first = factory(tenantOne);
  assert.equal(first.manifest.profile, "exchange.projection.v1");
  assertCapabilities(first.manifest, PROJECTION_REQUIRED_CAPABILITIES);
  const original = model("handoff_scoped", "partition_scoped", 1, tenantOne);
  await first.putHandoff(original);
  await first.putHandoff(structuredClone(original));
  const loaded = await first.getHandoff(original.handoff_id);
  assert.deepEqual(loaded, original);
  if (loaded !== null) {
    (loaded.state.opaque as { marker: string }).marker = "mutated";
  }
  assert.deepEqual(await first.getHandoff(original.handoff_id), original);
  await assert.rejects(
    first.putHandoff({ ...original, latest_status: { progress: 99 } }),
  );
  const newer = model("handoff_scoped", "partition_scoped", 2, tenantOne);
  await first.putHandoff(newer);
  await assert.rejects(first.putHandoff(original));
  assert.deepEqual(await first.listHandoffs("partition_scoped"), [newer]);

  const second = factory(tenantTwo);
  assert.equal(await second.getHandoff(original.handoff_id), null);
  const other = model("handoff_scoped", "partition_scoped", 1, tenantTwo);
  await second.putHandoff(other);
  assert.deepEqual(await second.getHandoff(other.handoff_id), other);
  assert.deepEqual(await first.getHandoff(newer.handoff_id), newer);

  await first.clearPartition("partition_scoped");
  assert.deepEqual(await first.listHandoffs("partition_scoped"), []);
  assert.deepEqual(await second.listHandoffs("partition_scoped"), [other]);
}
