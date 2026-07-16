import { randomUUID } from "node:crypto";

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
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import {
  SqliteExchangePersistence,
  SqliteRuntimeState,
  SqliteSession,
  createSqliteContextStore,
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
  EndpointInboxQueryService,
  HandoffProjector,
  MemoryHandoffReadModelStore,
  MemorySubscriptionStore,
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
} from "@work-fabric/exchange-spi";
import {
  CollaborationProjector,
  OperationAuditRecorder,
  StoreBackedCollaborationQueryService,
} from "@work-fabric/operations-runtime";
import type {
  AuditStore,
  CollaborationViewStore,
  ProjectionFreshnessSource,
} from "@work-fabric/operations-spi";
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
const ids: IdGenerator = {
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
  readonly sqlite: SqliteSession | null;
}

export interface NodeServiceCompositionOptions {
  /** Deployment-owned PostgreSQL adapters; the service never creates credentials. */
  readonly postgres_storage?: NodeStorageComposition;
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
    sqlite: session,
  };
}

class StoreFreshness implements ProjectionFreshnessSource {
  constructor(
    private readonly persistence: ExchangePersistence & ProjectionCheckpointStore,
    private readonly projectorId: string,
  ) {}

  async load(tenantId: string, partitionId: string) {
    const projected = await this.persistence.loadProjectionCheckpoint(
      this.projectorId,
      partitionId,
    );
    let journal = 0;
    for (;;) {
      const records = await this.persistence.readPartition(partitionId, journal, 1_000);
      if (records.length === 0) break;
      if (records.some((record) => record.tenant_id !== tenantId)) {
        throw new Error("partition tenant mismatch");
      }
      journal = records.at(-1)?.partition_position ?? journal;
      if (records.length < 1_000) break;
    }
    return {
      projector_id: this.projectorId,
      partition_id: partitionId,
      projected_position: projected,
      journal_position: journal,
      observed_at: clock.now(),
    };
  }
}

export interface ComposedNodeService {
  readonly http: HttpService;
  runProjection(partitionId: string, limit: number): Promise<{
    readonly handoff: Awaited<ReturnType<HandoffProjector["runPartition"]>>;
    readonly collaboration: Awaited<ReturnType<CollaborationProjector["runPartition"]>>;
  }>;
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
    ids,
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
  );
  const query = new StoreBackedExchangeQueryService(
    storage.persistence,
    storage.handoffs,
    storage.subscriptions,
    storage.persistence,
    storage.persistence,
  );
  const collaboration = new StoreBackedCollaborationQueryService(
    storage.collaboration,
    new StoreFreshness(storage.persistence, "workfabric.collaboration.visibility.v1"),
  );
  const audit = new OperationAuditRecorder(storage.audit, clock);
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
    endpoint_directory: endpointDirectory,
    endpoint_inbox: endpointInbox,
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
    listen() { return http.listen(config.listen); },
    async close() {
      await http.close();
      storage.sqlite?.close();
    },
  };
}
