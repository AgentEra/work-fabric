import { randomBytes } from "node:crypto";

import { jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { describe, expect, it } from "vitest";

import type { PartitionWakeup } from "@work-fabric/cluster-spi";

import {
  HmacWakeupSubjectCodec,
  NatsJetStreamTopologyPort,
  createNatsWakeupAdapter,
  desiredNatsWakeupTopology,
  reconcileNatsWakeupTopology,
} from "../src/index.js";

const url = process.env.NATS_TEST_URL;

describe.skipIf(url === undefined)("NATS Wakeup live integration", () => {
  it("proves Ack, delayed Retry, de-duplication and shared durable consumption", async () => {
    if (url === undefined) throw new Error("NATS_TEST_URL is required");
    const suffix = randomBytes(6).toString("hex");
    const prefix = `wf_test_${suffix}.wakeup`;
    const stream = `WF_TEST_${suffix.toUpperCase()}`;
    const consumer = `wf_test_${suffix}`;
    const tenant = `tenant-${suffix}`;
    const key = randomBytes(32);
    const subjects = new HmacWakeupSubjectCodec({
      subject_prefix: prefix,
      subject_key_id: "key1",
      subject_key: key,
      allowed_tenant_ids: [tenant],
    });
    const managementConnection = await connect({ servers: url });
    const runtimeConnectionA = await connect({ servers: url });
    const runtimeConnectionB = await connect({ servers: url });
    const manager = await jetstreamManager(managementConnection);
    try {
      await reconcileNatsWakeupTopology(
        new NatsJetStreamTopologyPort(manager),
        desiredNatsWakeupTopology({
          stream,
          consumer,
          subject_prefix: prefix,
          filter_subjects: subjects.filterSubjects(),
          replicas: 1,
          ack_wait_seconds: 5,
          max_deliver: 5,
        }),
        "apply",
      );
      const common = {
        stream,
        consumer,
        subject_prefix: prefix,
        subject_key_id: "key1",
        subject_key: key,
        allowed_tenant_ids: [tenant],
        config: {
          pull_expires_ms: 1_000,
          retry_delay_ms: 100,
          max_poison_per_pull: 10,
        },
      } as const;
      const adapterA = await createNatsWakeupAdapter({
        ...common,
        connection: runtimeConnectionA,
      });
      const adapterB = await createNatsWakeupAdapter({
        ...common,
        connection: runtimeConnectionB,
      });
      const wakeup = (id: string, position: number): PartitionWakeup => ({
        wakeup_id: id,
        exchange_id: `exchange-${suffix}`,
        tenant_id: tenant,
        partition_id: `partition-${position}`,
        kind: "handoff_projection",
        observed_position: position,
        occurred_at: "2026-07-16T00:00:00.000Z",
      });
      try {
        const retried = wakeup(`retry-${suffix}`, 1);
        await expect(adapterA.publish(retried)).resolves.toBe("accepted");
        const first = await adapterA.next(new AbortController().signal);
        expect(first?.wakeup).toEqual(retried);
        await first?.retry();
        const redelivery = await adapterB.next(new AbortController().signal);
        expect(redelivery?.wakeup).toEqual(retried);
        await redelivery?.acknowledge();

        const duplicate = wakeup(`duplicate-${suffix}`, 2);
        await expect(adapterA.publish(duplicate)).resolves.toBe("accepted");
        await expect(adapterB.publish(duplicate)).resolves.toBe("accepted");
        const once = await adapterA.next(new AbortController().signal);
        expect(once?.wakeup).toEqual(duplicate);
        await once?.acknowledge();
        await expect(adapterB.next(new AbortController().signal)).resolves.toBeNull();

        const sharedA = wakeup(`shared-a-${suffix}`, 3);
        const sharedB = wakeup(`shared-b-${suffix}`, 4);
        await adapterA.publish(sharedA);
        await adapterA.publish(sharedB);
        const [deliveryA, deliveryB] = await Promise.all([
          adapterA.next(new AbortController().signal),
          adapterB.next(new AbortController().signal),
        ]);
        expect(new Set([
          deliveryA?.wakeup.wakeup_id,
          deliveryB?.wakeup.wakeup_id,
        ])).toEqual(new Set([sharedA.wakeup_id, sharedB.wakeup_id]));
        await deliveryA?.acknowledge();
        await deliveryB?.acknowledge();
      } finally {
        await adapterA.close();
        await adapterB.close();
      }
    } finally {
      try { await manager.consumers.delete(stream, consumer); } catch { /* exact test resource */ }
      try { await manager.streams.delete(stream); } catch { /* exact test resource */ }
      await runtimeConnectionA.drain();
      await runtimeConnectionB.drain();
      await managementConnection.drain();
    }
  }, 20_000);
});
