import { strict as assert } from "node:assert";

import {
  CLUSTER_REQUIRED_CAPABILITIES,
  type PartitionWakeup,
  type PartitionWakeupConsumer,
  type PartitionWakeupPublisher,
  type PartitionWorkCatalog,
  type PartitionWorkItem,
} from "@work-fabric/cluster-spi";
import { assertCapabilities } from "@work-fabric/exchange-spi";

export type ClusterProfileSubject = PartitionWorkCatalog &
  PartitionWakeupPublisher & PartitionWakeupConsumer;

export type ClusterProfileFactory = (
  seed: readonly PartitionWorkItem[],
) => ClusterProfileSubject | Promise<ClusterProfileSubject>;

const now = "2026-07-16T00:00:00.000Z";

export const DEFAULT_CLUSTER_PROFILE_FIXTURES = {
  tenant_id: "tenant-profile",
  other_tenant_id: "tenant-other",
  available_at_or_before: now,
  ready_items: [
    {
      tenant_id: "tenant-profile",
      partition_id: "partition-a",
      kind: "outbox_wakeup",
      observed_position: 1,
      available_at: "2026-07-15T23:59:58.000Z",
    },
    {
      tenant_id: "tenant-profile",
      partition_id: "partition-b",
      kind: "signal_delivery",
      observed_position: 2,
      available_at: "2026-07-15T23:59:59.000Z",
    },
    {
      tenant_id: "tenant-other",
      partition_id: "partition-other",
      kind: "collaboration_projection",
      observed_position: 3,
      available_at: "2026-07-15T23:59:57.000Z",
    },
  ] satisfies readonly PartitionWorkItem[],
  wakeup: {
    wakeup_id: "wakeup-profile",
    exchange_id: "exchange-profile",
    tenant_id: "tenant-profile",
    partition_id: "partition-a",
    kind: "outbox_wakeup",
    observed_position: 1,
    occurred_at: now,
  } satisfies PartitionWakeup,
} as const;

export async function verifyClusterProfile(
  factory: ClusterProfileFactory,
): Promise<void> {
  const fixtures = DEFAULT_CLUSTER_PROFILE_FIXTURES;
  const subject = await factory(fixtures.ready_items);
  assert.equal(subject.manifest.profile, "workfabric.cluster.v1");
  assertCapabilities(subject.manifest, CLUSTER_REQUIRED_CAPABILITIES);

  const first = await subject.scanReady({
    tenant_id: fixtures.tenant_id,
    kinds: ["outbox_wakeup", "signal_delivery"],
    available_at_or_before: fixtures.available_at_or_before,
    limit: 1,
  });
  assert.deepEqual(first.items.map((item) => item.partition_id), ["partition-a"]);
  assert.ok(first.next_cursor);

  const mutated = first.items[0] as PartitionWorkItem & { partition_id: string };
  mutated.partition_id = "mutated-by-caller";
  const firstAgain = await subject.scanReady({
    tenant_id: fixtures.tenant_id,
    kinds: ["outbox_wakeup", "signal_delivery"],
    available_at_or_before: fixtures.available_at_or_before,
    limit: 1,
  });
  assert.equal(firstAgain.items[0]?.partition_id, "partition-a");

  const second = await subject.scanReady({
    tenant_id: fixtures.tenant_id,
    kinds: ["outbox_wakeup", "signal_delivery"],
    available_at_or_before: fixtures.available_at_or_before,
    cursor: first.next_cursor ?? undefined,
    limit: 1,
  });
  assert.deepEqual(second.items.map((item) => item.partition_id), ["partition-b"]);
  assert.equal(second.next_cursor, null);

  const isolated = await subject.scanReady({
    tenant_id: fixtures.other_tenant_id,
    kinds: ["collaboration_projection"],
    available_at_or_before: fixtures.available_at_or_before,
    limit: 10,
  });
  assert.deepEqual(isolated.items.map((item) => item.partition_id), [
    "partition-other",
  ]);

  // Catalog polling is authoritative even when no wakeup has been published.
  assert.equal(firstAgain.items.length, 1);

  assert.equal(await subject.publish(fixtures.wakeup), "accepted");
  assert.equal(await subject.publish(fixtures.wakeup), "accepted");
  const signal = new AbortController().signal;
  const firstDelivery = await subject.next(signal);
  assert.ok(firstDelivery);
  assert.deepEqual(firstDelivery.wakeup, fixtures.wakeup);
  await firstDelivery.retry();
  await assert.rejects(firstDelivery.acknowledge(), /settled|acknowledged/i);

  const retried = await subject.next(signal);
  assert.ok(retried);
  assert.equal(retried.wakeup.wakeup_id, fixtures.wakeup.wakeup_id);
  await retried.acknowledge();
  await assert.rejects(retried.retry(), /settled|acknowledged/i);

  const duplicate = await subject.next(signal);
  assert.ok(duplicate);
  assert.equal(duplicate.wakeup.wakeup_id, fixtures.wakeup.wakeup_id);
  await duplicate.acknowledge();
}
