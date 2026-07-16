import { describe, expect, it } from "vitest";

import type { PartitionWakeup } from "@work-fabric/cluster-spi";
import type {
  SemanticObservation,
  SemanticTelemetryObserver,
} from "@work-fabric/operations-spi";

import { NatsWakeupConsumer } from "../src/nats-wakeup-consumer.js";
import { HmacWakeupSubjectCodec } from "../src/subject-codec.js";
import { encodeWakeup } from "../src/wakeup-codec.js";
import { FakeWakeupJetStreamPort } from "./fake-nats-port.js";

const wakeup: PartitionWakeup = {
  wakeup_id: "wakeup-1",
  exchange_id: "exchange-1",
  tenant_id: "tenant-1",
  partition_id: "partition-1",
  kind: "handoff_projection",
  observed_position: 3,
  occurred_at: "2026-07-16T00:00:00.000Z",
};

function fixture(input: { readonly max_poison_per_pull?: number } = {}): {
  readonly port: FakeWakeupJetStreamPort;
  readonly subjects: HmacWakeupSubjectCodec;
  readonly consumer: NatsWakeupConsumer;
  readonly observations: SemanticObservation[];
} {
  const port = new FakeWakeupJetStreamPort();
  const subjects = new HmacWakeupSubjectCodec({
    subject_prefix: "workfabric.wakeup",
    subject_key_id: "key1",
    subject_key: new Uint8Array(32).fill(7),
    allowed_tenant_ids: ["tenant-1"],
  });
  const observations: SemanticObservation[] = [];
  const telemetry: SemanticTelemetryObserver = {
    observe: (observation) => observations.push(observation),
  };
  return {
    port,
    subjects,
    observations,
    consumer: new NatsWakeupConsumer({
      port,
      subjects,
      stream: "WF_WAKEUP",
      consumer: "wf-runtime",
      config: {
        pull_expires_ms: 1_000,
        retry_delay_ms: 250,
        max_poison_per_pull: input.max_poison_per_pull ?? 10,
      },
      telemetry,
    }),
  };
}

describe("NatsWakeupConsumer", () => {
  it("delivers a defensive clone and acknowledges exactly once", async () => {
    const { port, subjects, consumer } = fixture();
    const message = port.enqueue(subjects.subjectFor(wakeup), encodeWakeup(wakeup));

    const delivery = await consumer.next(new AbortController().signal);
    expect(delivery?.wakeup).toEqual(wakeup);
    (delivery?.wakeup as PartitionWakeup & { partition_id: string }).partition_id = "changed";
    await delivery?.acknowledge();
    expect(message.acknowledgements).toBe(1);
    await expect(delivery?.retry()).rejects.toThrow(/wakeup_delivery_settled/);
    expect(message.retries).toEqual([]);
  });

  it("retries exactly once using the configured bounded delay", async () => {
    const { port, subjects, consumer } = fixture();
    const message = port.enqueue(subjects.subjectFor(wakeup), encodeWakeup(wakeup));

    const delivery = await consumer.next(new AbortController().signal);
    await delivery?.retry();
    expect(message.retries).toEqual([250]);
    await expect(delivery?.acknowledge()).rejects.toThrow(/wakeup_delivery_settled/);
  });

  it("rejects pre-aborted and in-flight-aborted pulls", async () => {
    const first = fixture().consumer;
    const preAborted = new AbortController();
    preAborted.abort(new Error("caller aborted"));
    await expect(first.next(preAborted.signal)).rejects.toThrow(/aborted/);

    const { port, consumer } = fixture();
    port.pendingPull = new Promise(() => undefined);
    const controller = new AbortController();
    const pending = consumer.next(controller.signal);
    controller.abort(new Error("pull aborted"));
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("returns null on pull expiry and refuses concurrent pulls", async () => {
    const { port, consumer } = fixture();
    await expect(consumer.next(new AbortController().signal)).resolves.toBeNull();
    expect(port.pulls[0]).toEqual({
      stream: "WF_WAKEUP",
      consumer: "wf-runtime",
      expires_ms: 1_000,
    });

    port.pendingPull = new Promise(() => undefined);
    const controller = new AbortController();
    const pending = consumer.next(controller.signal);
    await expect(consumer.next(new AbortController().signal))
      .rejects.toThrow(/wakeup_transport_unavailable/);
    controller.abort(new Error("aborted"));
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("terminates malformed hints within the poison bound", async () => {
    const { port, subjects, consumer, observations } = fixture({
      max_poison_per_pull: 2,
    });
    const malformed = port.enqueue("workfabric.wakeup.bad", new Uint8Array([0xff]));
    const mismatch = port.enqueue(
      "workfabric.wakeup.wrong",
      encodeWakeup(wakeup),
    );
    port.enqueue(subjects.subjectFor(wakeup), encodeWakeup(wakeup));

    await expect(consumer.next(new AbortController().signal)).resolves.toBeNull();
    expect(malformed.terminations).toBe(1);
    expect(mismatch.terminations).toBe(1);
    expect(port.messages).toHaveLength(1);
    expect(observations).toEqual([
      {
        operation: "cluster_wakeup_transport",
        outcome: "failed",
        category: "cluster",
        duration_ms: 0,
        count: 1,
      },
      {
        operation: "cluster_wakeup_transport",
        outcome: "failed",
        category: "cluster",
        duration_ms: 0,
        count: 1,
      },
    ]);
    expect(JSON.stringify(observations)).not.toMatch(/tenant|subject|payload|nats:\/\//);
  });

  it("skips poison and returns a valid hint before reaching the bound", async () => {
    const { port, subjects, consumer } = fixture({ max_poison_per_pull: 2 });
    const malformed = port.enqueue("bad.subject", new Uint8Array([0xff]));
    port.enqueue(subjects.subjectFor(wakeup), encodeWakeup(wakeup));

    const delivery = await consumer.next(new AbortController().signal);
    expect(malformed.terminations).toBe(1);
    expect(delivery?.wakeup).toEqual(wakeup);
    await delivery?.acknowledge();
  });

  it("uses stable errors for pull failure and closed operation", async () => {
    const { port, consumer } = fixture();
    port.pullFailure = new Error("nats://secret.example:4222");
    await expect(consumer.next(new AbortController().signal))
      .rejects.toThrow(/^wakeup_transport_unavailable$/);

    await consumer.close();
    await expect(consumer.next(new AbortController().signal))
      .rejects.toThrow(/wakeup_adapter_closed/);
  });
});
