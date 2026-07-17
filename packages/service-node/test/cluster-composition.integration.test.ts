import { describe, expect, it, vi } from "vitest";

import { MemoryClusterAdapter } from "@work-fabric/adapter-cluster-memory";
import type { FeishuLongConnectionClientFactory } from "@work-fabric/connector-feishu";
import type { OutboxStore, WorkerLeaseStore } from "@work-fabric/exchange-spi";
import { composeNodeService, parseServiceConfig } from "../src/index.js";

const identity = {
  authentication_evidence: { bearer_token: "configured-test-token" },
  principal: {
    principal_id: "principal-local",
    tenant_id: "tenant-local",
    actor_claims: [{
      actor_id: "actor-local",
      actor_type: "human" as const,
      endpoint_ids: ["endpoint-local"],
    }],
    attributes: {},
  },
};

const rule = {
  tenant_id: "tenant-local",
  principal_id: "principal-local",
  actor_id: "actor-local",
  actor_type: "human" as const,
  endpoint_id: "endpoint-local",
  action: "workfabric.operations.cluster.read.v1",
  resource_id: "tenant-local",
};

const outbox: OutboxStore = {
  async claim() { return []; },
  async markPublished() { return false; },
  async recordFailure() { return false; },
  async listPending() { return []; },
};

const leases: WorkerLeaseStore = {
  async acquire() { return null; },
  async renew() { return false; },
  async release() { return false; },
};

describe("clustered Node composition", () => {
  it("starts only the worker host, exposes aggregate state and drains it", async () => {
    const config = parseServiceConfig({
      storage_profile: "memory-demo",
      development_mode: true,
      role: "worker",
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      identities: [identity],
      authority_rules: [rule],
      cluster: {
        worker_owner_id: "worker-a",
        tenant_ids: ["tenant-local"],
        max_concurrent_turns: 2,
        max_ready_items: 10,
        catalog_page_size: 5,
        turn_item_limit: 10,
        lease_seconds: 30,
        drain_timeout_seconds: 2,
        poll_interval_ms: 1_000,
        max_tenants_per_host: 2,
      },
    });
    const exchange = new MemoryClusterAdapter();
    const service = await composeNodeService(config, {
      cluster_worker: {
        catalog: exchange,
        wakeup_publisher: exchange,
        wakeup_consumer: exchange,
        outbox_store_for_tenant: () => outbox,
        lease_store_for_tenant: () => leases,
        signal_dispatcher: {
          async dispatchPartitionTurn() { return { processed: 0 }; },
        },
      },
    });

    await expect(service.listen()).rejects.toThrow(/worker.*http|http.*worker/i);
    service.start();
    expect(await service.clusterSnapshot()).toMatchObject({
      state: "running",
      ready_items: 0,
      in_flight_turns: 0,
    });
    await service.close();
    expect(await service.clusterSnapshot()).toMatchObject({ state: "stopped" });
  });

  it("drains a started cluster when plugin startup rejects", async () => {
    const config = parseServiceConfig({
      storage_profile: "memory-demo",
      development_mode: true,
      role: "all",
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      identities: [identity],
      authority_rules: [rule],
      cluster: {
        worker_owner_id: "worker-a",
        tenant_ids: ["tenant-local"],
        max_concurrent_turns: 2,
        max_ready_items: 10,
        catalog_page_size: 5,
        turn_item_limit: 10,
        lease_seconds: 30,
        drain_timeout_seconds: 2,
        poll_interval_ms: 1_000,
        max_tenants_per_host: 2,
      },
    });
    const exchange = new MemoryClusterAdapter();
    const client = {
      start: vi.fn(async () => { throw new Error("long start failed"); }),
      status: () => ({
        state: "connecting" as const,
        code: "connecting" as const,
        reconnect_attempts: 0,
        changed_at: "2026-07-17T00:00:00.000Z",
      }),
      stop: vi.fn(async () => {}),
    };
    const factory: FeishuLongConnectionClientFactory = { create: () => client };
    const service = await composeNodeService(config, {
      cluster_worker: {
        catalog: exchange,
        wakeup_publisher: exchange,
        wakeup_consumer: exchange,
        outbox_store_for_tenant: () => outbox,
        lease_store_for_tenant: () => leases,
        signal_dispatcher: {
          async dispatchPartitionTurn() { return { processed: 0 }; },
        },
      },
      plugins: {
        "feishu-primary": {
          type: "collaboration-channel.feishu",
          enabled: true,
          config: {
            connector_id: "feishu-primary",
            external_tenant_id: "tenant-key",
            bot_open_id: "ou-bot",
            credentials: {
              app_id: "app",
              app_secret: "secret",
              work_fabric_access_token: "connector-token",
            },
            inbound: {
              enabled: true,
              transport: "long_connection",
              mention_only: true,
              intake_target: { actor_id: "actor-agent", endpoint_id: "endpoint-agent" },
            },
            outbound: { enabled: false, default_render_mode: "card", channels: {}, subscriptions: {} },
            identities: [],
            worker: { poll_interval_ms: 1_000, lease_seconds: 30, batch_limit: 100, max_attempts: 8 },
          },
        },
      },
      feishu_long_connection_client_factory: factory,
    });

    await expect(service.start()).rejects.toThrow("long start failed");
    expect(await service.clusterSnapshot()).toMatchObject({ state: "stopped" });
    expect(client.stop).toHaveBeenCalledTimes(1);
    await service.close();
  });
});
