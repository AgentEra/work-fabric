import { describe, expect, it } from "vitest";

import type { PartitionWakeup } from "@work-fabric/cluster-spi";

import { NatsWakeupPublisher } from "../src/nats-wakeup-publisher.js";
import { HmacWakeupSubjectCodec } from "../src/subject-codec.js";
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

function fixture(): {
  readonly port: FakeWakeupJetStreamPort;
  readonly subjects: HmacWakeupSubjectCodec;
  readonly publisher: NatsWakeupPublisher;
} {
  const port = new FakeWakeupJetStreamPort();
  const subjects = new HmacWakeupSubjectCodec({
    subject_prefix: "workfabric.wakeup",
    subject_key_id: "key1",
    subject_key: new Uint8Array(32).fill(7),
    allowed_tenant_ids: ["tenant-1"],
  });
  return {
    port,
    subjects,
    publisher: new NatsWakeupPublisher({ port, subjects }),
  };
}

describe("NatsWakeupPublisher", () => {
  it("publishes a validated metadata hint using the wakeup ID as message ID", async () => {
    const { port, publisher, subjects } = fixture();

    await expect(publisher.publish(wakeup)).resolves.toBe("accepted");
    expect(port.publications).toHaveLength(1);
    expect(port.publications[0]).toMatchObject({
      subject: subjects.subjectFor(wakeup),
      message_id: wakeup.wakeup_id,
    });
    expect(new TextDecoder().decode(port.publications[0]?.payload)).not.toContain("content");
  });

  it("classifies lower transport failures without exposing their details", async () => {
    const { port, publisher } = fixture();
    port.publishFailure = new Error("nats://secret.example:4222 disconnected");

    await expect(publisher.publish(wakeup)).resolves.toBe("retryable_failure");
  });

  it("rejects invalid input before calling the lower transport", async () => {
    const { port, publisher } = fixture();

    await expect(publisher.publish({
      ...wakeup,
      wakeup_id: "x".repeat(129),
    })).rejects.toThrow(/invalid_wakeup_payload/);
    expect(port.publications).toHaveLength(0);
  });
});
