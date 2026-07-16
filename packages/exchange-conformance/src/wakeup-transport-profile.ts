import { strict as assert } from "node:assert";

import {
  WAKEUP_TRANSPORT_REQUIRED_CAPABILITIES,
  type PartitionWakeup,
  type PartitionWakeupConsumer,
  type PartitionWakeupPublisher,
} from "@work-fabric/cluster-spi";
import { assertCapabilities } from "@work-fabric/exchange-spi";

export type WakeupTransportProfileSubject =
  PartitionWakeupPublisher & PartitionWakeupConsumer;

export type WakeupTransportProfileFactory = () =>
  | WakeupTransportProfileSubject
  | Promise<WakeupTransportProfileSubject>;

export const DEFAULT_WAKEUP_TRANSPORT_FIXTURES = {
  wakeup: {
    wakeup_id: "wakeup-profile",
    exchange_id: "exchange-profile",
    tenant_id: "tenant-profile",
    partition_id: "partition-profile",
    kind: "handoff_projection",
    observed_position: 7,
    occurred_at: "2026-07-16T00:00:00.000Z",
  } satisfies PartitionWakeup,
} as const;

export async function verifyWakeupTransportProfile(
  factory: WakeupTransportProfileFactory,
): Promise<void> {
  const subject = await factory();
  const fixture = DEFAULT_WAKEUP_TRANSPORT_FIXTURES.wakeup;
  assert.equal(subject.manifest.profile, "workfabric.cluster.v1");
  assertCapabilities(
    subject.manifest,
    WAKEUP_TRANSPORT_REQUIRED_CAPABILITIES,
  );

  const aborted = new AbortController();
  aborted.abort(new Error("wakeup profile aborted"));
  await assert.rejects(
    subject.next(aborted.signal),
    /aborted|abort/i,
  );

  assert.equal(await subject.publish(fixture), "accepted");
  assert.equal(await subject.publish(fixture), "accepted");
  const signal = new AbortController().signal;
  const first = await subject.next(signal);
  assert.ok(first);
  assert.deepEqual(first.wakeup, fixture);
  const mutable = first.wakeup as PartitionWakeup & { partition_id: string };
  mutable.partition_id = "mutated-by-caller";
  await first.retry();
  await assert.rejects(first.acknowledge(), /settled|acknowledged/i);

  const retried = await subject.next(signal);
  assert.ok(retried);
  assert.deepEqual(retried.wakeup, fixture);
  await retried.acknowledge();
  await assert.rejects(retried.retry(), /settled|acknowledged/i);

  const duplicate = await subject.next(signal);
  assert.ok(duplicate);
  assert.deepEqual(duplicate.wakeup, fixture);
  await duplicate.acknowledge();
  assert.equal(await subject.next(signal), null);

  await assert.rejects(subject.publish({
    ...fixture,
    wakeup_id: "x".repeat(129),
  }), /wakeup_id|invalid|128/i);
}
