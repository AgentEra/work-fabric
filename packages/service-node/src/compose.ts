import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";

import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import {
  MemoryEndpointDirectoryStore,
  MemoryEndpointInboxStore,
} from "@work-fabric/adapter-endpoint-memory";
import {
  LocalAuthorityPolicy,
  LocalIdentityProvider,
} from "@work-fabric/adapter-identity-local";
import { MemoryOperationsFixture } from "@work-fabric/adapter-operations-memory";
import { MemoryDiscrepancyStore, MemoryRecoveryStore } from "@work-fabric/adapter-operations-memory";
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import {
  ClusterHost,
  CollaborationProjectionHandler,
  HandoffProjectionHandler,
  OutboxWakeupHandler,
  PartitionWorker,
  SignalDeliveryHandler,
  type SignalDispatcherPort,
} from "@work-fabric/cluster-runtime";
import type {
  PartitionWakeupConsumer,
  PartitionWakeupPublisher,
  PartitionWorkCatalog,
} from "@work-fabric/cluster-spi";
import {
  SqliteExchangePersistence,
  SqlitePartitionJournalPositionSource,
  SqliteRuntimeState,
  SqliteSession,
  createSqliteContextStore,
  createSqliteConnectorIngressStore,
  createSqliteEndpointDirectoryStore,
  createSqliteEndpointInboxStore,
  createSqliteHandoffReadModelStore,
  createSqliteOperationsStores,
  migrateSqlite,
} from "@work-fabric/adapter-storage-sqlite";
import {
  ExchangeApplication,
  type Clock,
  type IdGenerator,
} from "@work-fabric/exchange-core";
import { EndpointDirectoryService } from "@work-fabric/endpoint-directory";
import {
  CursorPullService,
  DefaultSubscriptionDeliveryPolicy,
  EndpointInboxQueryService,
  HandoffProjector,
  MemoryHandoffReadModelStore,
  MemorySubscriptionStore,
  OpaqueCursorCodec as DeliveryCursorCodec,
} from "@work-fabric/exchange-runtime";
import type {
  ContextRepository,
  DeliveryStateStore,
  EndpointDirectoryStore,
  EndpointInboxStore,
  ExchangePersistence,
  HandoffReadModelStore,
  ProjectionCheckpointStore,
  ProjectionFailureStore,
  SubscriptionStore,
  TargetEligibilityVerifier,
  OutboxStore,
  WorkerLeaseStore,
} from "@work-fabric/exchange-spi";
import { addUtcTimestampSeconds } from "@work-fabric/exchange-spi";
import type { ConnectorIngressStore } from "@work-fabric/connector-spi";
import type { ConnectorDiscrepancyStore } from "@work-fabric/connector-runtime";
import {
  CollaborationProjector,
  OperationAuditRecorder,
  RecoveryService,
  StoreBackedCollaborationQueryService,
  StoreBackedOperationsQueryService,
} from "@work-fabric/operations-runtime";
import type {
  AuditStore,
  CollaborationViewStore,
  CursorAuthenticator,
  BoundedOperationalHistoryStore,
  PartitionJournalPositionSource,
  RecoveryRequestStore,
  ProjectionFreshnessSource,
  ClusterOperationalSnapshot,
  ClusterOperationalSnapshotSource,
} from "@work-fabric/operations-spi";
import { createOpaqueCursorCodec } from "@work-fabric/operations-spi";
import {
  loadWfppCommandValidator,
  loadWfppSchemaValidator,
} from "@work-fabric/protocol-runtime";
import {
  BearerAuthenticationEvidenceMapper,
  StoreBackedExchangeQueryService,
  createHttpService,
  normalizeHttpServiceConfig,
  type HttpService,
} from "@work-fabric/transport-http";

import type { NodeServiceConfig } from "./config.js";

const clock: Clock = { now: () => new Date().toISOString() };
const defaultIds: IdGenerator = {
  nextId(kind) { return `${kind}_${randomUUID()}`; },
};

const explicitTargetEligibility: TargetEligibilityVerifier = {
  manifest: {
    profile: "exchange.target-eligibility.v1",
    adapter: "explicit-target-boundary",
    capabilities: {
      explicit_target_only: true,
      no_candidate_selection: true,
      fail_closed: true,
    },
  },
  async verify() { return { kind: "eligible" }; },
};

export interface NodeStorageComposition {
  readonly persistence: ExchangePersistence & ProjectionCheckpointStore & ProjectionFailureStore & DeliveryStateStore;
  readonly context: ContextRepository;
  readonly subscriptions: SubscriptionStore;
  readonly handoffs: HandoffReadModelStore;
  readonly collaboration: CollaborationViewStore;
  readonly audit: AuditStore;
  readonly endpointDirectory: EndpointDirectoryStore;
  readonly endpointInbox: EndpointInboxStore;
  readonly connectorIngress: ConnectorIngressStore;
  readonly discrepancies: ConnectorDiscrepancyStore;
  readonly recoveries: RecoveryRequestStore;
  readonly boundedHistory?: BoundedOperationalHistoryStore;
  /** Adapter-native high-water lookup; avoids scanning the journal on reads. */
  readonly journalPositions?: PartitionJournalPositionSource;
  readonly sqlite: SqliteSession | null;
}

export interface NodeServiceCompositionOptions {
  /** Deployment-owned PostgreSQL adapters; the service never creates credentials. */
  readonly postgres_storage?: NodeStorageComposition;
  /** Deployment-owned generator; useful for deterministic integration profiles. */
  readonly ids?: IdGenerator;
  readonly cluster_worker?: NodeClusterWorkerDependencies;
  readonly cluster_snapshot?: ClusterOperationalSnapshotSource;
}

export interface NodeClusterWorkerDependencies {
  readonly catalog: PartitionWorkCatalog;
  readonly wakeup_publisher: PartitionWakeupPublisher;
  readonly wakeup_consumer?: PartitionWakeupConsumer;
  readonly outbox_store_for_tenant: (
    tenantId: string,
  ) => OutboxStore | Promise<OutboxStore>;
  readonly lease_store_for_tenant: (
    tenantId: string,
  ) => WorkerLeaseStore | Promise<WorkerLeaseStore>;
  readonly signal_dispatcher: SignalDispatcherPort;
}

function memoryStorage(): NodeStorageComposition {
  const persistence = new MemoryExchangePersistence();
  const operations = new MemoryOperationsFixture();
  return {
    persistence,
    context: new MemoryContextRepository(),
    subscriptions: new MemorySubscriptionStore(),
    handoffs: new MemoryHandoffReadModelStore(),
    collaboration: operations.collaboration,
    audit: operations.audit,
    endpointDirectory: new MemoryEndpointDirectoryStore(),
    endpointInbox: new MemoryEndpointInboxStore(),
    connectorIngress: new MemoryConnectorIngressStore(),
    discrepancies: new MemoryDiscrepancyStore(),
    recoveries: new MemoryRecoveryStore(),
    sqlite: null,
  };
}

function sqliteStorage(config: NodeServiceConfig): NodeStorageComposition {
  const sqlite = config.sqlite;
  if (sqlite === undefined) throw new Error("SQLite configuration is missing");
  const session = new SqliteSession({
    location: sqlite.location,
    busy_timeout_ms: sqlite.busy_timeout_ms,
  });
  migrateSqlite(session);
  const persistence = new SqliteExchangePersistence(session, config.tenant_id);
  const operations = createSqliteOperationsStores(
    session,
    config.tenant_id,
    config.cursor_secret,
  );
  return {
    persistence,
    context: createSqliteContextStore(session, config.tenant_id),
    subscriptions: new SqliteRuntimeState(session, config.tenant_id),
    handoffs: createSqliteHandoffReadModelStore(session, config.tenant_id),
    collaboration: operations.collaboration,
    audit: operations.audit,
    endpointDirectory: createSqliteEndpointDirectoryStore(session, config.tenant_id),
    endpointInbox: createSqliteEndpointInboxStore(session, config.tenant_id),
    connectorIngress: createSqliteConnectorIngressStore(session, config.tenant_id),
    discrepancies: operations.discrepancies,
    recoveries: operations.recoveries,
    boundedHistory: persistence,
    journalPositions: new SqlitePartitionJournalPositionSource(
      session,
      config.tenant_id,
    ),
    sqlite: session,
  };
}

class StoreFreshness implements ProjectionFreshnessSource {
  constructor(
    private readonly persistence: ExchangePersistence & ProjectionCheckpointStore,
    private readonly projectorId: string,
    private readonly journalPositions: PartitionJournalPositionSource,
  ) {}

  async load(tenantId: string, partitionId: string) {
    const projected = await this.persistence.loadProjectionCheckpoint(
      this.projectorId,
      partitionId,
    );
    const journal = await this.journalPositions.load(tenantId, partitionId) ?? 0;
    return {
      projector_id: this.projectorId,
      partition_id: partitionId,
      projected_position: projected,
      journal_position: journal,
      observed_at: clock.now(),
    };
  }
}

class StoreJournalPositions {
  constructor(private readonly persistence: ExchangePersistence) {}

  async load(tenantId: string, partitionId: string): Promise<number | null> {
    let journal = 0;
    let found = false;
    for (;;) {
      const records = await this.persistence.readPartition(partitionId, journal, 1_000);
      if (records.length === 0) break;
      if (records.some((record) => record.tenant_id !== tenantId)) throw new Error("partition tenant mismatch");
      found = true;
      journal = records.at(-1)?.partition_position ?? journal;
      if (records.length < 1_000) break;
    }
    return found ? journal : null;
  }
}

function operationsCursor(secret: string) {
  const digest = (payload: string) => createHmac("sha256", secret).update(payload).digest();
  const authenticator: CursorAuthenticator = {
    async sign(payload) { return digest(payload).toString("base64url"); },
    async verify(payload, signature) {
      const expected = digest(payload);
      let actual: Buffer;
      try { actual = Buffer.from(signature, "base64url"); } catch { return false; }
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
  };
  return createOpaqueCursorCodec(authenticator, { max_length: 2_048 });
}

export interface ComposedNodeService {
  readonly http: HttpService;
  runProjection(partitionId: string, limit: number): Promise<{
    readonly handoff: Awaited<ReturnType<HandoffProjector["runPartition"]>>;
    readonly collaboration: Awaited<ReturnType<CollaborationProjector["runPartition"]>>;
  }>;
  rebuildProjection(partitionId: string, limit: number): Promise<void>;
  start(): void;
  clusterSnapshot(): Promise<ClusterOperationalSnapshot | null>;
  listen(): Promise<{ readonly origin: string }>;
  close(): Promise<void>;
}

export async function composeNodeService(
  config: NodeServiceConfig,
  options: NodeServiceCompositionOptions = {},
): Promise<ComposedNodeService> {
  const storage = config.storage_profile === "memory-demo"
    ? memoryStorage()
    : config.storage_profile === "sqlite-local"
      ? sqliteStorage(config)
      : options.postgres_storage;
  if (storage === undefined) {
    throw new Error(
      "PostgreSQL composition requires injected deployment-owned adapters; no implicit credentials are loaded",
    );
  }
  const schemas = await loadWfppSchemaValidator("protocol/schemas/v1");
  const validator = await loadWfppCommandValidator(
    schemas,
    "protocol/spec/interaction-payloads.json",
  );
  const identity = new LocalIdentityProvider(config.identities);
  const authority = new LocalAuthorityPolicy(config.authority_rules);
  const application = new ExchangeApplication({
    persistence: storage.persistence,
    identity,
    authority,
    context: storage.context,
    validator,
    clock,
    ids: options.ids ?? defaultIds,
    target_eligibility: explicitTargetEligibility,
  });
  const handoffProjector = new HandoffProjector(
    storage.persistence,
    storage.persistence,
    storage.persistence,
    storage.handoffs,
    clock,
  );
  const collaborationProjector = new CollaborationProjector(
    storage.persistence,
    storage.persistence,
    storage.persistence,
    storage.handoffs,
    storage.collaboration,
    clock,
    undefined,
    storage.journalPositions ?? new StoreJournalPositions(storage.persistence),
  );
  let clusterHost: ClusterHost | undefined;
  if (config.cluster !== undefined) {
    const workerDependencies = options.cluster_worker;
    if (workerDependencies === undefined) {
      throw new Error(
        "cluster composition requires deployment-injected catalog, lease, Outbox, wakeup and Signal ports",
      );
    }
    const handlers = [
      new OutboxWakeupHandler({
        store_for_tenant: workerDependencies.outbox_store_for_tenant,
        publisher: workerDependencies.wakeup_publisher,
        clock,
        retry_policy: {
          nextAttemptAt(attempt, now) {
            const exponent = Math.min(Math.max(0, attempt - 1), 8);
            return addUtcTimestampSeconds(now, Math.min(300, 2 ** exponent));
          },
        },
        row_lease_seconds: config.cluster.lease_seconds,
      }),
      new HandoffProjectionHandler(handoffProjector),
      new CollaborationProjectionHandler(collaborationProjector),
      new SignalDeliveryHandler(workerDependencies.signal_dispatcher),
    ];
    const worker = new PartitionWorker({
      owner: config.cluster.worker_owner_id,
      clock,
      lease_store_for_tenant: workerDependencies.lease_store_for_tenant,
      handlers,
      lease_seconds: config.cluster.lease_seconds,
      turn_item_limit: config.cluster.turn_item_limit,
    });
    clusterHost = new ClusterHost({
      catalog: workerDependencies.catalog,
      ...(workerDependencies.wakeup_consumer === undefined
        ? {}
        : { wakeup_consumer: workerDependencies.wakeup_consumer }),
      tenant_ids: config.cluster.tenant_ids,
      worker,
      clock,
    }, config.cluster);
  }
  const localClusterSnapshot: ClusterOperationalSnapshotSource | undefined =
    clusterHost === undefined || config.cluster === undefined
      ? undefined
      : {
        async load(tenantId) {
          if (!config.cluster?.tenant_ids.includes(tenantId)) return null;
          const snapshot = clusterHost?.snapshot();
          if (snapshot === undefined) return null;
          return {
            state: snapshot.state,
            ready_items: snapshot.queue_depth,
            in_flight_turns: snapshot.in_flight_turns,
            completed_turns: snapshot.completed_turns,
            lease_losses: snapshot.lease_losses,
            dropped_wakeups: snapshot.dropped_hints,
            observed_at: clock.now(),
          };
        },
      };
  const operationalClusterSnapshot =
    options.cluster_snapshot ?? localClusterSnapshot;
  const query = new StoreBackedExchangeQueryService(
    storage.persistence,
    storage.handoffs,
    storage.subscriptions,
    storage.persistence,
    storage.persistence,
  );
  const collaboration = new StoreBackedCollaborationQueryService(
    storage.collaboration,
    new StoreFreshness(
      storage.persistence,
      "workfabric.collaboration.visibility.v1",
      storage.journalPositions ?? new StoreJournalPositions(storage.persistence),
    ),
  );
  const audit = new OperationAuditRecorder(storage.audit, clock);
  const operations = new StoreBackedOperationsQueryService({
    journal_positions: storage.journalPositions ?? new StoreJournalPositions(storage.persistence),
    checkpoints: storage.persistence,
    projection_failures: storage.persistence,
    subscriptions: storage.subscriptions,
    delivery_state: storage.persistence,
    connector_ingress: storage.connectorIngress,
    discrepancies: storage.discrepancies,
    audit: storage.audit,
    cursor: operationsCursor(config.cursor_secret),
    ...(operationalClusterSnapshot === undefined
      ? {}
      : { cluster_snapshot: operationalClusterSnapshot }),
    ...(storage.boundedHistory === undefined ? {} : { bounded_history: storage.boundedHistory }),
    max_page_limit: 100,
  });
  const recovery = new RecoveryService(storage.recoveries, { now: clock.now, audit });
  const endpointDirectory = new EndpointDirectoryService({
    store: storage.endpointDirectory,
    clock,
    ids: { sessionId: () => `session_${randomUUID()}` },
    limits: {
      min_lease_seconds: 30,
      default_lease_seconds: 60,
      max_lease_seconds: 3_600,
      renew_ahead_seconds: 10,
      max_capabilities: 100,
      max_bindings: 20,
      default_page_limit: 25,
      max_page_limit: 100,
    },
  });
  const endpointInbox = new EndpointInboxQueryService({
    directory: storage.endpointDirectory,
    inbox: storage.endpointInbox,
    defaultPageLimit: 25,
    maxPageLimit: 100,
  });
  const delivery = new CursorPullService(
    storage.persistence,
    storage.persistence,
    storage.subscriptions,
    new DefaultSubscriptionDeliveryPolicy(),
    clock,
    options.ids ?? defaultIds,
    new DeliveryCursorCodec(new TextEncoder().encode(config.cursor_secret)),
    schemas,
    30,
  );
  const http = createHttpService({
    application,
    authenticator: new BearerAuthenticationEvidenceMapper(),
    identity,
    authority,
    query,
    subscriptions: storage.subscriptions,
    schemas,
    collaboration,
    audit,
    operations,
    recovery,
    endpoint_directory: endpointDirectory,
    endpoint_inbox: endpointInbox,
    delivery,
    health_probes: [{
      dependency_id: config.storage_profile,
      async check() { return "healthy"; },
    }],
  }, normalizeHttpServiceConfig({}));
  return {
    http,
    async runProjection(partitionId, limit) {
      const handoff = await handoffProjector.runPartition(partitionId, limit);
      const collaborationResult = await collaborationProjector.runPartition(
        partitionId,
        limit,
      );
      return { handoff, collaboration: collaborationResult };
    },
    async rebuildProjection(partitionId, limit) {
      await handoffProjector.rebuildPartition(partitionId, limit);
      await collaborationProjector.rebuildPartition(config.tenant_id, partitionId, limit);
    },
    start() {
      if (config.role === "worker" || config.role === "all") {
        clusterHost?.start();
      }
    },
    async clusterSnapshot() {
      return operationalClusterSnapshot?.load(config.tenant_id) ?? null;
    },
    listen() {
      if (config.role === "worker") {
        return Promise.reject(new Error("worker role does not expose HTTP"));
      }
      return http.listen(config.listen);
    },
    async close() {
      await clusterHost?.drain();
      await http.close();
      storage.sqlite?.close();
    },
  };
}
