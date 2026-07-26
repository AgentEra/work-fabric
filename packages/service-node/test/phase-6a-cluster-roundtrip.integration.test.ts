import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { MemoryAdmissionDecisionStore, MemoryParticipantBindingStore } from "@work-fabric/adapter-admission-memory";
import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";
import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import {
  MemoryEndpointDirectoryStore,
  MemoryEndpointInboxStore,
} from "@work-fabric/adapter-endpoint-memory";
import type { LocalAuthorityAllowRule } from "@work-fabric/adapter-identity-local";
import {
  MemoryDiscrepancyStore,
  MemoryOperationsFixture,
  MemoryRecoveryStore,
} from "@work-fabric/adapter-operations-memory";
import { InProcessSignalAdapter } from "@work-fabric/adapter-signal-in-process";
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import {
  ClusterHost,
  CollaborationProjectionHandler,
  EndpointInboxProjectionHandler,
  HandoffProjectionHandler,
  OutboxWakeupHandler,
  PartitionWorker,
  SignalDeliveryHandler,
} from "@work-fabric/cluster-runtime";
import {
  CLUSTER_REQUIRED_CAPABILITIES,
  type ClusterCapabilityManifest,
  type PartitionWakeup,
  type PartitionWakeupConsumer,
  type PartitionWakeupPublisher,
  type PartitionWorkCatalog,
  type PartitionWorkItem,
  type PartitionWorkKind,
  type WakeupDelivery,
} from "@work-fabric/cluster-spi";
import type { IdGenerator } from "@work-fabric/exchange-core";
import {
  addUtcTimestampSeconds,
  type OutboxRecord,
  type OutboxStore,
  type WorkerLease,
  type WorkerLeaseStore,
} from "@work-fabric/exchange-spi";
import {
  DefaultSubscriptionDeliveryPolicy,
  EndpointInboxProjector,
  HandoffProjector,
  MemoryHandoffReadModelStore,
  MemorySubscriptionStore,
  SignalDispatcher,
} from "@work-fabric/exchange-runtime";
import { CollaborationProjector } from "@work-fabric/operations-runtime";
import { loadWfppSchemaValidator } from "@work-fabric/protocol-runtime";
import {
  BearerTokenProvider,
  WorkFabricClient,
  type HandoffOfferPayload,
} from "@work-fabric/sdk-typescript";

import {
  composeNodeService,
  parseServiceConfig,
  type NodeStorageComposition,
} from "../src/index.js";

const tenant = "tenant-phase6a";
const exchange = "exchange-phase6a";
const handoffId = "handoff_phase6a_1";
const partition = `partition:${createHash("sha256").update(JSON.stringify({
  root_handoff_id: handoffId,
  tenant_id: tenant,
})).digest("hex")}`;

const clusterManifest: ClusterCapabilityManifest = {
  profile: "workfabric.cluster.v1",
  adapter: "fault-injecting-test",
  capabilities: Object.fromEntries(
    CLUSTER_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
  ),
};

class SharedLeaseStore implements WorkerLeaseStore {
  private readonly leases = new Map<string, WorkerLease>();
  private readonly tokens = new Map<string, number>();

  async acquire(key: string, owner: string, now: string, seconds: number) {
    const current = this.leases.get(key);
    if (current !== undefined && current.expires_at > now && current.owner !== owner) {
      return null;
    }
    const token = (this.tokens.get(key) ?? 0) + 1;
    this.tokens.set(key, token);
    const lease = {
      lease_key: key,
      owner,
      fencing_token: token,
      expires_at: addUtcTimestampSeconds(now, seconds),
    };
    this.leases.set(key, lease);
    return structuredClone(lease);
  }

  async renew(key: string, owner: string, token: number, now: string, seconds: number) {
    const current = this.leases.get(key);
    if (
      current === undefined || current.owner !== owner ||
      current.fencing_token !== token || current.expires_at <= now
    ) return false;
    this.leases.set(key, {
      ...current,
      expires_at: addUtcTimestampSeconds(now, seconds),
    });
    return true;
  }

  async release(key: string, owner: string, token: number) {
    const current = this.leases.get(key);
    if (current?.owner !== owner || current.fencing_token !== token) return false;
    this.leases.delete(key);
    return true;
  }

  forceTakeover(key: string, owner: string, now: string): void {
    const token = (this.tokens.get(key) ?? 0) + 1;
    this.tokens.set(key, token);
    this.leases.set(key, {
      lease_key: key,
      owner,
      fencing_token: token,
      expires_at: addUtcTimestampSeconds(now, 30),
    });
  }
}

class MemoryOutbox implements OutboxStore {
  private readonly rows = new Map<string, OutboxRecord>();

  add(events: readonly OutboxRecord["event"][]): void {
    for (const event of events) {
      const id = `outbox_${event.event_id}`;
      if (!this.rows.has(id)) this.rows.set(id, {
        outbox_id: id,
        tenant_id: event.tenant_id,
        partition_id: event.partition_id,
        position: event.partition_position,
        event: structuredClone(event),
        attempt: 0,
        next_attempt_at: null,
        lease_owner: null,
        lease_expires_at: null,
        fencing_token: 0,
      });
    }
  }

  async claim(request: Parameters<OutboxStore["claim"]>[0]) {
    const selected: OutboxRecord[] = [];
    for (const row of this.rows.values()) {
      if (
        selected.length >= request.limit || row.tenant_id !== request.tenant_id ||
        row.partition_id !== request.partition_id ||
        (row.next_attempt_at !== null && row.next_attempt_at > request.now) ||
        (row.lease_expires_at !== null && row.lease_expires_at > request.now)
      ) continue;
      const claimed = {
        ...row,
        attempt: row.attempt + 1,
        lease_owner: request.owner,
        lease_expires_at: addUtcTimestampSeconds(request.now, request.lease_seconds),
        fencing_token: row.fencing_token + 1,
      };
      this.rows.set(row.outbox_id, claimed);
      selected.push(structuredClone(claimed));
    }
    return selected;
  }

  async markPublished(id: string, owner: string, token: number) {
    const row = this.rows.get(id);
    if (row?.lease_owner !== owner || row.fencing_token !== token) return false;
    this.rows.delete(id);
    return true;
  }

  async recordFailure(id: string, owner: string, token: number, retryAt: string) {
    const row = this.rows.get(id);
    if (row?.lease_owner !== owner || row.fencing_token !== token) return false;
    this.rows.set(id, {
      ...row,
      next_attempt_at: retryAt,
      lease_owner: null,
      lease_expires_at: null,
    });
    return true;
  }

  async listPending(tenantId: string, partitionId: string) {
    return [...this.rows.values()]
      .filter((row) => row.tenant_id === tenantId && row.partition_id === partitionId)
      .map((row) => structuredClone(row));
  }
}

class FaultInjectingCluster
  implements PartitionWorkCatalog, PartitionWakeupPublisher, PartitionWakeupConsumer {
  private readonly pending: PartitionWakeup[] = [];
  private publications = 0;
  readonly deliveredWakeupIds: string[] = [];

  get manifest() { return structuredClone(clusterManifest); }

  async scanReady(input: Parameters<PartitionWorkCatalog["scanReady"]>[0]) {
    const kinds: readonly PartitionWorkKind[] = [
      "outbox_wakeup",
      "handoff_projection",
      "endpoint_inbox_projection",
      "collaboration_projection",
      "signal_delivery",
    ];
    const items = kinds
      .filter((kind) => input.kinds.includes(kind))
      .slice(0, input.limit)
      .map<PartitionWorkItem>((kind) => ({
        tenant_id: tenant,
        partition_id: partition,
        kind,
        observed_position: 5,
        available_at: "2026-07-16T00:00:00.000Z",
      }));
    return { items, next_cursor: null };
  }

  async publish(wakeup: PartitionWakeup) {
    this.publications += 1;
    if (this.publications === 1) return "accepted" as const; // accepted then lost
    this.pending.push(structuredClone(wakeup));
    if (this.publications === 2) this.pending.push(structuredClone(wakeup));
    return "accepted" as const;
  }

  async next(signal: AbortSignal): Promise<WakeupDelivery | null> {
    if (signal.aborted) throw signal.reason;
    const wakeup = this.pending.shift();
    if (wakeup === undefined) return null;
    this.deliveredWakeupIds.push(wakeup.wakeup_id);
    return {
      wakeup: structuredClone(wakeup),
      acknowledge: async () => undefined,
      retry: async () => { this.pending.unshift(structuredClone(wakeup)); },
    };
  }
}

function rule(
  principalId: string,
  actorId: string,
  actorType: "human" | "agent",
  endpointId: string,
  action: string,
  resourceId: string | null,
): LocalAuthorityAllowRule {
  return {
    tenant_id: tenant, principal_id: principalId, actor_id: actorId,
    actor_type: actorType, endpoint_id: endpointId, action, resource_id: resourceId,
  };
}

function client(origin: string, token: string, actorId: string, endpointId: string) {
  return new WorkFabricClient({
    baseUrl: origin, tenantId: tenant, exchangeId: exchange,
    representation: { actorId, endpointId },
    authentication: new BearerTokenProvider(token),
  });
}

const offer: HandoffOfferPayload = {
  thread_id: "thread-phase6a",
  work_reference: { uri: "feishu://document/phase6a", extensions: {} },
  target: { actor_id: "actor-agent" },
  intent: [{ kind: "text", media_type: "text/plain", text: "Run outside Work Fabric" }],
  authority_scope: {
    delegation_id: "delegation-phase6a", scopes: ["work:read", "result:write"],
    resource_refs: ["feishu://document/phase6a"],
    expires_at: "2099-07-20T00:00:00.000Z", may_redelegate: false,
  },
  acceptance_criteria: [{
    criterion_id: "tests-pass", description: "Tests pass", required: true,
    result_schema_ref: null, required_evidence_types: ["test_report"],
  }],
  verifier: { actor_id: "actor-human", actor_type: "human" },
  priority: "normal",
  accept_by: "2099-07-17T00:00:00.000Z",
  result_due_at: "2099-07-19T00:00:00.000Z",
};

async function waitForHosts(hosts: readonly ClusterHost[]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (hosts.every((host) => host.snapshot().in_flight_turns === 0)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("cluster hosts did not settle within the bounded test turns");
}

describe("Phase 6A clustered runtime roundtrip", () => {
  it("recovers lost hints, deduplicates duplicate hints and preserves fenced handoff truth", async () => {
    const persistence = new MemoryExchangePersistence();
    const outbox = new MemoryOutbox();
    const originalCommit = persistence.commitAtomically.bind(persistence);
    persistence.commitAtomically = async (request) => {
      const result = await originalCommit(request);
      if (result.kind === "committed") outbox.add(result.events);
      return result;
    };
    const operations = new MemoryOperationsFixture();
    const subscriptions = new MemorySubscriptionStore();
    const handoffs = new MemoryHandoffReadModelStore();
    const storage: NodeStorageComposition = {
      persistence,
      context: new MemoryContextRepository(),
      subscriptions,
      handoffs,
      collaboration: operations.collaboration,
      audit: operations.audit,
      endpointDirectory: new MemoryEndpointDirectoryStore(),
      endpointInbox: new MemoryEndpointInboxStore(),
      connectorIngress: new MemoryConnectorIngressStore(),
      admissionBindings: new MemoryParticipantBindingStore(),
      admissionDecisions: new MemoryAdmissionDecisionStore(),
      discrepancies: new MemoryDiscrepancyStore(),
      recoveries: new MemoryRecoveryStore(),
      sqlite: null,
    };
    await subscriptions.putSubscription({
      subscription_id: "subscription-phase6a",
      tenant_id: tenant,
      owner: { actor_id: "actor-agent", actor_type: "agent" },
      endpoint_id: "endpoint-agent",
      filter: {
        event_types: [], actor_ids: [], endpoint_ids: [], thread_ids: [],
        handoff_ids: [], work_reference_uris: [], capability_ids: [], lifecycle_states: [],
      },
      destination: { destination_id: "probe-phase6a", binding: "in-process", configuration: {} },
      delivery_mode: "webhook",
      state: "active",
      max_attempts: 3,
      created_at: "2026-07-16T00:00:00.000Z",
      updated_at: "2026-07-16T00:00:00.000Z",
    });
    const authorityRules = [
      rule("principal-human", "actor-human", "human", "endpoint-human", "workfabric.handoff.offer.v1", null),
      rule("principal-agent", "actor-agent", "agent", "endpoint-agent", "workfabric.handoff.accept.v1", handoffId),
      rule("principal-agent", "actor-agent", "agent", "endpoint-agent", "workfabric.handoff.report_status.v1", handoffId),
      rule("principal-agent", "actor-agent", "agent", "endpoint-agent", "workfabric.handoff.return_result.v1", handoffId),
      rule("principal-human", "actor-human", "human", "endpoint-human", "workfabric.handoff.verify.v1", handoffId),
      rule("principal-human", "actor-human", "human", "endpoint-human", "workfabric.query.handoff.read.v1", handoffId),
      rule("principal-human", "actor-human", "human", "endpoint-human", "workfabric.query.timeline.list.v1", partition),
    ];
    let sequence = 0;
    const ids: IdGenerator = {
      nextId(kind) {
        sequence += 1;
        return kind === "handoff" ? handoffId : `${kind}_phase6a_${sequence}`;
      },
    };
    const api = await composeNodeService(parseServiceConfig({
      storage_profile: "postgres", role: "api", development_mode: false,
      tenant_id: tenant, exchange_id: exchange, cursor_secret: "phase6a".repeat(8),
      postgres: { connection_string: "injected://test-only" },
      identities: [
        { authentication_evidence: { bearer_token: "human-token" }, principal: {
          principal_id: "principal-human", tenant_id: tenant,
          actor_claims: [{ actor_id: "actor-human", actor_type: "human", endpoint_ids: ["endpoint-human"] }], attributes: {},
        } },
        { authentication_evidence: { bearer_token: "agent-token" }, principal: {
          principal_id: "principal-agent", tenant_id: tenant,
          actor_claims: [{ actor_id: "actor-agent", actor_type: "agent", endpoint_ids: ["endpoint-agent"] }], attributes: {},
        } },
      ],
      authority_rules: authorityRules,
      listen: { host: "127.0.0.1", port: 0 },
    }), { postgres_storage: storage, ids });
    const { origin } = await api.listen();
    const human = client(origin, "human-token", "actor-human", "endpoint-human");
    const agent = client(origin, "agent-token", "actor-agent", "endpoint-agent");

    const clock = { now: () => new Date().toISOString() };
    const cluster = new FaultInjectingCluster();
    const leases = new SharedLeaseStore();
    const signal = new InProcessSignalAdapter();
    const schemas = await loadWfppSchemaValidator("protocol/schemas/v1");
    const dispatcher = new SignalDispatcher(
      persistence, persistence, subscriptions,
      new DefaultSubscriptionDeliveryPolicy(), signal, clock,
      { base_delay_seconds: 1, max_delay_seconds: 8 }, schemas,
    );
    const handoffProjector = new HandoffProjector(
      persistence, persistence, persistence, handoffs, clock,
    );
    const endpointInboxProjector = new EndpointInboxProjector(
      storage.endpointInbox,
      persistence,
      persistence,
      persistence,
      clock,
    );
    const collaborationProjector = new CollaborationProjector(
      persistence, persistence, persistence, handoffs, operations.collaboration, clock,
    );
    const handlers = [
      new OutboxWakeupHandler({
        store_for_tenant: () => outbox,
        publisher: cluster,
        clock,
        retry_policy: { nextAttemptAt: (_attempt, now) => addUtcTimestampSeconds(now, 1) },
        row_lease_seconds: 10,
      }),
      new HandoffProjectionHandler(handoffProjector),
      new EndpointInboxProjectionHandler(endpointInboxProjector),
      new CollaborationProjectionHandler(collaborationProjector),
      new SignalDeliveryHandler(dispatcher),
    ];
    const worker = (owner: string) => new PartitionWorker({
      owner,
      clock,
      lease_store_for_tenant: () => leases,
      handlers,
      lease_seconds: 10,
      turn_item_limit: 20,
    });
    const limits = {
      max_concurrent_turns: 2, max_ready_items: 32, catalog_page_size: 16,
      turn_item_limit: 20, lease_seconds: 10, drain_timeout_seconds: 2,
      poll_interval_ms: 100, max_tenants_per_host: 1,
    };
    const hosts = ["host-a", "host-b"].map((owner) => new ClusterHost({
      catalog: cluster,
      wakeup_consumer: cluster,
      tenant_ids: [tenant],
      worker: worker(owner),
      clock,
    }, limits));

    try {
      await human.handoffs.offer(offer, { idempotencyKey: "offer-1" });
      await agent.handoffs.accept({ handoff_id: handoffId }, { expectedVersion: 1, idempotencyKey: "accept-1" });
      await agent.handoffs.reportStatus({ handoff_id: handoffId, status: {
        status_report_id: "status-1", execution_status: "in_progress", progress: 0.5,
        message: [], observed_at: "2026-07-16T05:00:00.000Z", blocked_on: [],
      } }, { expectedVersion: 2, idempotencyKey: "status-1" });
      await agent.handoffs.returnResult({ handoff_id: handoffId, result: {
        summary: [{ kind: "text", media_type: "text/plain", text: "External runtime finished" }],
        artifacts: [],
        evidence: [{ evidence_id: "evidence-1", evidence_type: "test_report", content: {
          kind: "resource", resource: { uri: "urn:test-report:phase6a", media_type: "application/json", extensions: {} },
        } }],
      } }, { expectedVersion: 3, idempotencyKey: "result-1" });
      await human.handoffs.verify({
        handoff_id: handoffId, satisfied_criterion_ids: ["tests-pass"],
        summary: [{ kind: "text", media_type: "text/plain", text: "Verified externally" }], evidence: [],
      }, { expectedVersion: 4, idempotencyKey: "verify-1" });

      await Promise.all(hosts.map((host) => host.pollOnce()));
      await Promise.all(hosts.map((host) => host.pump()));
      await waitForHosts(hosts);
      for (let index = 0; index < 20; index += 1) {
        await Promise.all(hosts.map((host) => host.ingestOnce()));
      }
      await Promise.all(hosts.map((host) => host.pump()));
      await waitForHosts(hosts);

      await expect(human.queries.getHandoff(handoffId)).resolves.toMatchObject({
        handoff_id: handoffId,
        stream_version: 5,
        state: { lifecycle_state: "verified" },
      });
      const timeline = await human.collaboration.listTimeline({
        partitionId: partition, handoffId, limit: 20,
      });
      expect(timeline.items).toHaveLength(5);
      expect(timeline.freshness.projected_position).toBe(5);
      expect(timeline.freshness.journal_position).toBe(5);
      const deliveries = signal.deliveries();
      expect(new Set(deliveries.map((delivery) => delivery.event.id)).size).toBe(5);
      expect(deliveries).toHaveLength(5);
      expect(cluster.deliveredWakeupIds.length).toBeGreaterThan(0);
      expect(new Set(cluster.deliveredWakeupIds).size).toBeLessThan(cluster.deliveredWakeupIds.length);
      expect(hosts.reduce((sum, host) => sum + host.snapshot().completed_turns, 0)).toBeGreaterThan(0);

      let staleAdvanced = false;
      let release: () => void = () => undefined;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const staleWorker = new PartitionWorker({
        owner: "stale-owner", clock, lease_store_for_tenant: () => leases,
        lease_seconds: 10, turn_item_limit: 1,
        handlers: [{ kind: "outbox_wakeup", async run(context) {
          await barrier;
          await context.assertOwnership();
          staleAdvanced = true;
          return { outcome: "advanced", processed: 1 };
        } }],
      });
      const staleRun = staleWorker.run({
        tenant_id: tenant, partition_id: "partition-stale", kind: "outbox_wakeup",
        observed_position: 1, available_at: clock.now(),
      }, new AbortController().signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
      leases.forceTakeover("partition:outbox_wakeup:partition-stale", "new-owner", clock.now());
      release();
      await expect(staleRun).resolves.toEqual({ kind: "failed", code: "partition_lease_lost" });
      expect(staleAdvanced).toBe(false);
    } finally {
      await Promise.all(hosts.map((host) => host.drain()));
      await api.close();
    }
  }, 20_000);
});
