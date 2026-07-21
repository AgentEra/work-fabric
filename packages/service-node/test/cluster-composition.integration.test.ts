import { describe, expect, it, vi } from "vitest";

import { MemoryClusterAdapter } from "@work-fabric/adapter-cluster-memory";
import { MemoryAdmissionDecisionStore, MemoryParticipantBindingStore } from "@work-fabric/adapter-admission-memory";
import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";
import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import { MemoryEndpointDirectoryStore, MemoryEndpointInboxStore } from "@work-fabric/adapter-endpoint-memory";
import { MemoryDiscrepancyStore, MemoryOperationsFixture, MemoryRecoveryStore } from "@work-fabric/adapter-operations-memory";
import { MemoryChannelRouteStore, MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import type { FeishuLongConnectionClientFactory } from "@work-fabric/connector-feishu";
import type { OutboxStore, WorkerLeaseStore } from "@work-fabric/exchange-spi";
import { MemoryHandoffReadModelStore, MemorySubscriptionStore } from "@work-fabric/exchange-runtime";
import { composeNodeService, parseServiceConfig, type NodeStorageComposition } from "../src/index.js";

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
  it("uses deployment-owned PostgreSQL Admission stores without creating a database client", async () => {
    const persistence = new MemoryExchangePersistence();
    const operations = new MemoryOperationsFixture();
    const bindings = new MemoryParticipantBindingStore();
    const decisions = new MemoryAdmissionDecisionStore();
    const bindingCall = vi.spyOn(bindings, "getOrCreate");
    const decisionCall = vi.spyOn(decisions, "record");
    const storage: NodeStorageComposition = {
      persistence,
      context: new MemoryContextRepository(),
      subscriptions: new MemorySubscriptionStore(),
      handoffs: new MemoryHandoffReadModelStore(),
      collaboration: operations.collaboration,
      audit: operations.audit,
      endpointDirectory: new MemoryEndpointDirectoryStore(),
      endpointInbox: new MemoryEndpointInboxStore(),
      connectorIngress: new MemoryConnectorIngressStore(),
      channelRoutes: new MemoryChannelRouteStore(),
      discrepancies: new MemoryDiscrepancyStore(),
      recoveries: new MemoryRecoveryStore(),
      admissionBindings: bindings,
      admissionDecisions: decisions,
      sqlite: null,
    };
    const config = parseServiceConfig({
      storage_profile: "postgres",
      role: "api",
      tenant_id: "tenant-local",
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      postgres: { connection_string: "postgres://deployment-owned-not-opened" },
      admission: {
        subject_fingerprint_key: "f".repeat(32),
        grant_active_key_id: "primary",
        grant_keys: { primary: "g".repeat(32) },
        grant_ttl_seconds: 120,
        max_evidence_cache_entries: 10_000,
      },
      identities: [identity],
      authority_rules: [rule],
    });
    const service = await composeNodeService(config, {
      postgres_storage: storage,
      admission: {
        evidence_providers: {},
        policies: {
          "synthetic-participants": {
            policy_id: "synthetic-participants", revision: "1",
            tenant_id: "tenant-local", connector_id: "synthetic-primary",
            source_system: "synthetic", external_tenant_id: "external-local",
            default: "deny",
            allow: { all_internal_members: false, external_subject_ids: ["subject-1"] },
            deny: { external_subject_ids: [] },
            binding: { actor_type: "human", store_ref: "participant-bindings" },
          },
        },
      },
    });
    const result = await service.admission!.admit("synthetic-participants", {
      tenant_id: "tenant-local", connector_id: "synthetic-primary",
      source_system: "synthetic", external_tenant_id: "external-local",
      external_subject_type: "human", external_subject_id: "subject-1",
      ingress_id: "ingress-postgres-injection",
      idempotency_key: "command-postgres-injection",
    });
    expect(result.decision.kind).toBe("allow");
    expect(bindingCall).toHaveBeenCalledTimes(1);
    expect(decisionCall).toHaveBeenCalledTimes(1);
    await service.close();

    const incomplete = { ...storage, admissionBindings: undefined } as unknown as NodeStorageComposition;
    await expect(composeNodeService(config, {
      postgres_storage: incomplete,
      admission: {
        evidence_providers: {},
        policies: {},
      },
    })).rejects.toMatchObject({
      code: "admission_storage_missing",
      path: "postgres_storage.admissionBindings",
    });

    const injectedClose = vi.fn();
    const postgresWithForeignCloser = {
      ...storage,
      sqlite: { close: injectedClose },
    } as unknown as NodeStorageComposition;
    const compositionFailure = new Error("injected protocol schema failure");
    await expect(composeNodeService(config, {
      postgres_storage: postgresWithForeignCloser,
      admission: { policies: {}, evidence_providers: {} },
      protocol_schema_loader: async () => { throw compositionFailure; },
    })).rejects.toBe(compositionFailure);
    expect(injectedClose).not.toHaveBeenCalled();
  });

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
    const firstStart = service.start();
    await firstStart;
    const secondStart = service.start();
    const sharedStart = secondStart === firstStart;
    const [secondOutcome] = await Promise.allSettled([secondStart]);
    expect(sharedStart).toBe(true);
    expect(secondOutcome).toEqual({ status: "fulfilled", value: undefined });
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
