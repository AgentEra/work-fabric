import { describe, expect, it } from "vitest";

import {
  desiredNatsWakeupTopology,
  reconcileNatsWakeupTopology,
  type NatsTopologyConsumer,
  type NatsTopologyManagementPort,
  type NatsTopologyStream,
} from "../src/topology.js";

class MemoryTopologyPort implements NatsTopologyManagementPort {
  stream: NatsTopologyStream | null = null;
  consumer: NatsTopologyConsumer | null = null;
  readonly mutations: string[] = [];

  async readStream(): Promise<NatsTopologyStream | null> {
    return this.stream === null ? null : structuredClone(this.stream);
  }

  async createStream(stream: NatsTopologyStream): Promise<void> {
    this.mutations.push("create-stream");
    this.stream = structuredClone(stream);
  }

  async updateStream(stream: NatsTopologyStream): Promise<void> {
    this.mutations.push("update-stream");
    this.stream = structuredClone(stream);
  }

  async readConsumer(): Promise<NatsTopologyConsumer | null> {
    return this.consumer === null ? null : structuredClone(this.consumer);
  }

  async createConsumer(consumer: NatsTopologyConsumer): Promise<void> {
    this.mutations.push("create-consumer");
    this.consumer = structuredClone(consumer);
  }

  async updateConsumer(consumer: NatsTopologyConsumer): Promise<void> {
    this.mutations.push("update-consumer");
    this.consumer = structuredClone(consumer);
  }
}

const input = {
  stream: "WF_WAKEUP",
  consumer: "wf_runtime",
  subject_prefix: "workfabric.cluster.wakeup.v1",
  filter_subjects: [
    "workfabric.cluster.wakeup.v1.key1.tenanttoken.handoff_projection",
    "workfabric.cluster.wakeup.v1.key1.tenanttoken.collaboration_projection",
    "workfabric.cluster.wakeup.v1.key1.tenanttoken.outbox_wakeup",
    "workfabric.cluster.wakeup.v1.key1.tenanttoken.signal_delivery",
  ],
} as const;

describe("desiredNatsWakeupTopology", () => {
  it("builds the bounded production topology defaults", () => {
    expect(desiredNatsWakeupTopology(input)).toEqual({
      stream: {
        name: "WF_WAKEUP",
        subjects: ["workfabric.cluster.wakeup.v1.*.*.*"],
        retention: "limits",
        storage: "file",
        discard: "old",
        max_msg_size: 4_096,
        max_age_nanoseconds: 900_000_000_000,
        max_bytes: 268_435_456,
        duplicate_window_nanoseconds: 120_000_000_000,
        num_replicas: 3,
      },
      consumer: {
        stream: "WF_WAKEUP",
        name: "wf_runtime",
        durable_name: "wf_runtime",
        filter_subjects: [...input.filter_subjects].sort(),
        ack_policy: "explicit",
        deliver_policy: "new",
        replay_policy: "instant",
        ack_wait_nanoseconds: 30_000_000_000,
        max_deliver: 5,
        max_ack_pending: 1_024,
        max_waiting: 32,
        num_replicas: 0,
        memory_storage: false,
      },
    });
  });

  it("enforces every documented resource bound", () => {
    expect(() => desiredNatsWakeupTopology({ ...input, max_age_seconds: 59 }))
      .toThrow(/max_age_seconds/);
    expect(() => desiredNatsWakeupTopology({ ...input, max_bytes: 1_048_575 }))
      .toThrow(/max_bytes/);
    expect(() => desiredNatsWakeupTopology({ ...input, replicas: 6 }))
      .toThrow(/replicas/);
    expect(() => desiredNatsWakeupTopology({ ...input, ack_wait_seconds: 4 }))
      .toThrow(/ack_wait_seconds/);
    expect(() => desiredNatsWakeupTopology({ ...input, max_deliver: 21 }))
      .toThrow(/max_deliver/);
    expect(() => desiredNatsWakeupTopology({ ...input, max_ack_pending: 0 }))
      .toThrow(/max_ack_pending/);
    expect(() => desiredNatsWakeupTopology({ ...input, max_waiting: 257 }))
      .toThrow(/max_waiting/);
  });
});

describe("reconcileNatsWakeupTopology", () => {
  it("plans missing resources without mutation and applies them explicitly", async () => {
    const desired = desiredNatsWakeupTopology(input);
    const port = new MemoryTopologyPort();

    await expect(reconcileNatsWakeupTopology(port, desired, "plan"))
      .resolves.toEqual({
        mode: "plan",
        actions: [
          { resource: "stream", action: "create" },
          { resource: "consumer", action: "create" },
        ],
      });
    expect(port.mutations).toEqual([]);

    await expect(reconcileNatsWakeupTopology(port, desired, "apply"))
      .resolves.toMatchObject({ mode: "apply" });
    expect(port.mutations).toEqual(["create-stream", "create-consumer"]);
    await expect(reconcileNatsWakeupTopology(port, desired, "verify"))
      .resolves.toEqual({ mode: "verify", actions: [] });
  });

  it("updates compatible limits, replicas, filters and timing", async () => {
    const original = desiredNatsWakeupTopology(input);
    const desired = desiredNatsWakeupTopology({
      ...input,
      max_age_seconds: 1_800,
      max_bytes: 536_870_912,
      replicas: 2,
      ack_wait_seconds: 60,
      max_deliver: 7,
      max_ack_pending: 2_048,
      max_waiting: 64,
      filter_subjects: [
        ...input.filter_subjects,
        "workfabric.cluster.wakeup.v1.key1.secondtoken.handoff_projection",
        "workfabric.cluster.wakeup.v1.key1.secondtoken.collaboration_projection",
        "workfabric.cluster.wakeup.v1.key1.secondtoken.outbox_wakeup",
        "workfabric.cluster.wakeup.v1.key1.secondtoken.signal_delivery",
      ],
    });
    const port = new MemoryTopologyPort();
    port.stream = original.stream;
    port.consumer = original.consumer;

    await expect(reconcileNatsWakeupTopology(port, desired, "apply"))
      .resolves.toEqual({
        mode: "apply",
        actions: [
          { resource: "stream", action: "update" },
          { resource: "consumer", action: "update" },
        ],
      });
    expect(port.stream).toEqual(desired.stream);
    expect(port.consumer).toEqual(desired.consumer);
  });

  it.each([
    ["subject namespace", { subjects: ["other.namespace.*.*.*"] }],
    ["retention", { retention: "workqueue" }],
    ["storage", { storage: "memory" }],
  ])("rejects incompatible %s drift without mutation", async (_name, drift) => {
    const desired = desiredNatsWakeupTopology(input);
    const port = new MemoryTopologyPort();
    port.stream = { ...desired.stream, ...drift } as NatsTopologyStream;
    port.consumer = desired.consumer;

    await expect(reconcileNatsWakeupTopology(port, desired, "apply"))
      .rejects.toThrow(/wakeup_topology_drift/);
    expect(port.mutations).toEqual([]);
  });

  it("fails verification when a compatible action is still required", async () => {
    const desired = desiredNatsWakeupTopology(input);
    const port = new MemoryTopologyPort();
    port.stream = { ...desired.stream, max_bytes: desired.stream.max_bytes / 2 };
    port.consumer = desired.consumer;

    await expect(reconcileNatsWakeupTopology(port, desired, "verify"))
      .rejects.toThrow(/wakeup_topology_drift/);
    expect(port.mutations).toEqual([]);
  });
});
