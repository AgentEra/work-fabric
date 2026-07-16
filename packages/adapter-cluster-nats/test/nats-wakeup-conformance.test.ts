import { describe, expect, it } from "vitest";

import { verifyWakeupTransportProfile } from "@work-fabric/exchange-conformance";

import { NatsWakeupAdapter } from "../src/nats-wakeup-adapter.js";
import { HmacWakeupSubjectCodec } from "../src/subject-codec.js";
import { FakeWakeupJetStreamPort } from "./fake-nats-port.js";

function adapter(): NatsWakeupAdapter {
  const port = new FakeWakeupJetStreamPort(true);
  const subjects = new HmacWakeupSubjectCodec({
    subject_prefix: "workfabric.wakeup",
    subject_key_id: "key1",
    subject_key: new Uint8Array(32).fill(9),
    allowed_tenant_ids: ["tenant-profile"],
  });
  return new NatsWakeupAdapter({
    port,
    subjects,
    stream: "WF_WAKEUP",
    consumer: "wf-runtime",
    config: {
      pull_expires_ms: 1_000,
      retry_delay_ms: 100,
      max_poison_per_pull: 10,
    },
  });
}

describe("NatsWakeupAdapter", () => {
  it("passes the technology-neutral Wakeup Transport profile", async () => {
    await verifyWakeupTransportProfile(adapter);
  });

  it("closes without owning the injected connection and rejects new operations", async () => {
    const subject = adapter();
    await subject.close();
    await expect(subject.next(new AbortController().signal))
      .rejects.toThrow(/wakeup_adapter_closed/);
    await expect(subject.publish({
      wakeup_id: "wakeup-1",
      exchange_id: "exchange-1",
      tenant_id: "tenant-profile",
      partition_id: "partition-1",
      kind: "handoff_projection",
      observed_position: 1,
      occurred_at: "2026-07-16T00:00:00.000Z",
    })).rejects.toThrow(/wakeup_adapter_closed/);
  });
});
