import { describe, expect, it } from "vitest";

import {
  HmacWakeupSubjectCodec,
  NatsWakeupAdapter,
  type WakeupJetStreamMessage,
  type WakeupJetStreamPort,
} from "@work-fabric/adapter-cluster-nats";
import { ClusterHost, type ClusterPartitionRunner } from "@work-fabric/cluster-runtime";
import {
  CLUSTER_REQUIRED_CAPABILITIES,
  type PartitionWakeup,
  type PartitionWorkCatalog,
  type PartitionWorkItem,
} from "@work-fabric/cluster-spi";

const tenant = "tenant-phase6b";
const partition = "partition-phase6b";

class DisconnectableWakeupPort implements WakeupJetStreamPort {
  available = false;
  private readonly messages: WakeupJetStreamMessage[] = [];

  async publish(input: {
    readonly subject: string;
    readonly payload: Uint8Array;
    readonly message_id: string;
  }): Promise<void> {
    if (!this.available) throw new Error("broker unavailable");
    const message = (): WakeupJetStreamMessage => ({
      subject: input.subject,
      payload: Uint8Array.from(input.payload),
      redelivered: false,
      acknowledge: async () => undefined,
      retry: async () => { this.messages.unshift(message()); },
      terminate: async () => undefined,
    });
    this.messages.push(message());
  }

  async pull(): Promise<WakeupJetStreamMessage | null> {
    if (!this.available) throw new Error("broker unavailable");
    return this.messages.shift() ?? null;
  }
}

const items: readonly PartitionWorkItem[] = [
  {
    tenant_id: tenant,
    partition_id: partition,
    kind: "handoff_projection",
    observed_position: 5,
    available_at: "2026-07-16T00:00:00.000Z",
  },
  {
    tenant_id: tenant,
    partition_id: partition,
    kind: "collaboration_projection",
    observed_position: 5,
    available_at: "2026-07-16T00:00:00.000Z",
  },
  {
    tenant_id: tenant,
    partition_id: partition,
    kind: "signal_delivery",
    observed_position: 5,
    available_at: "2026-07-16T00:00:00.000Z",
  },
];

const catalog: PartitionWorkCatalog = {
  manifest: {
    profile: "workfabric.cluster.v1",
    adapter: "authoritative-fallback-test",
    capabilities: Object.fromEntries(
      CLUSTER_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
    ),
  },
  async scanReady(input) {
    return {
      items: structuredClone(items.filter((item) =>
        item.tenant_id === input.tenant_id && input.kinds.includes(item.kind)
      ).slice(0, input.limit)),
      next_cursor: null,
    };
  },
};

async function settle(hosts: readonly ClusterHost[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (hosts.every((host) => host.snapshot().in_flight_turns === 0)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("fallback hosts did not settle");
}

describe("Phase 6B NATS outage fallback", () => {
  it("keeps catalog polling authoritative and coalesces stale hints after recovery", async () => {
    const port = new DisconnectableWakeupPort();
    const subjects = new HmacWakeupSubjectCodec({
      subject_prefix: "workfabric.cluster.wakeup.v1",
      subject_key_id: "key1",
      subject_key: new Uint8Array(32).fill(6),
      allowed_tenant_ids: [tenant],
    });
    const transport = new NatsWakeupAdapter({
      port,
      subjects,
      stream: "WF_WAKEUP",
      consumer: "wf_runtime",
      config: {
        pull_expires_ms: 1_000,
        retry_delay_ms: 100,
        max_poison_per_pull: 10,
      },
    });
    const projected = new Map<string, number>();
    const advances = new Map<string, number>();
    const runner: ClusterPartitionRunner = {
      async run(item) {
        const current = projected.get(item.kind) ?? 0;
        if (current >= item.observed_position) {
          return {
            kind: "ran",
            fencing_token: 1,
            outcome: { outcome: "idle", processed: 0 },
          };
        }
        projected.set(item.kind, item.observed_position);
        advances.set(item.kind, (advances.get(item.kind) ?? 0) + 1);
        return {
          kind: "ran",
          fencing_token: 1,
          outcome: { outcome: "advanced", processed: 1 },
        };
      },
    };
    const limits = {
      max_concurrent_turns: 2,
      max_ready_items: 16,
      catalog_page_size: 8,
      turn_item_limit: 10,
      lease_seconds: 10,
      drain_timeout_seconds: 2,
      poll_interval_ms: 100,
      max_tenants_per_host: 1,
    } as const;
    const hosts = ["host-a", "host-b"].map(() => new ClusterHost({
      catalog,
      wakeup_consumer: transport,
      tenant_ids: [tenant],
      worker: runner,
      clock: { now: () => "2026-07-16T00:00:00.000Z" },
    }, limits));
    const wakeup: PartitionWakeup = {
      wakeup_id: "wakeup-phase6b",
      exchange_id: "exchange-phase6b",
      tenant_id: tenant,
      partition_id: partition,
      kind: "handoff_projection",
      observed_position: 5,
      occurred_at: "2026-07-16T00:00:00.000Z",
    };

    try {
      await expect(transport.publish(wakeup)).resolves.toBe("retryable_failure");
      await expect(hosts[0]?.ingestOnce()).rejects.toThrow(/wakeup_transport_unavailable/);

      await Promise.all(hosts.map((host) => host.pollOnce()));
      await Promise.all(hosts.map((host) => host.pump()));
      await settle(hosts);
      expect(projected).toEqual(new Map([
        ["handoff_projection", 5],
        ["collaboration_projection", 5],
        ["signal_delivery", 5],
      ]));
      expect(advances).toEqual(new Map([
        ["handoff_projection", 1],
        ["collaboration_projection", 1],
        ["signal_delivery", 1],
      ]));

      port.available = true;
      await expect(transport.publish(wakeup)).resolves.toBe("accepted");
      await expect(transport.publish(wakeup)).resolves.toBe("accepted");
      await hosts[0]?.ingestOnce();
      await hosts[1]?.ingestOnce();
      await Promise.all(hosts.map((host) => host.pump()));
      await settle(hosts);

      expect(projected.get("handoff_projection")).toBe(5);
      expect(advances.get("handoff_projection")).toBe(1);
      expect(advances.get("signal_delivery")).toBe(1);
    } finally {
      await Promise.all(hosts.map((host) => host.drain()));
      await transport.close();
    }
  });
});
