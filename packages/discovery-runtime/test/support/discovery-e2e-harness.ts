import { generateKeyPairSync } from "node:crypto";

import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import {
  MemoryDiscoveryPeerBindingStore,
  MemoryDiscoveryStore,
} from "@work-fabric/adapter-discovery-memory";
import {
  NodeEd25519DiscoverySigner,
  NodeEd25519DiscoveryTrustResolver,
} from "@work-fabric/adapter-discovery-node-crypto";
import {
  MemoryEndpointDirectoryStore,
  MemoryEndpointInboxStore,
} from "@work-fabric/adapter-endpoint-memory";
import { MemoryFederationReplayStore } from "@work-fabric/adapter-federation-memory";
import {
  NodeEd25519FederationSigner,
  NodeEd25519FederationTrustResolver,
} from "@work-fabric/adapter-federation-node-crypto";
import { LocalIdentityProvider } from "@work-fabric/adapter-identity-local";
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import {
  DiscoveryCacheService,
  DiscoveryGateway,
  DiscoveryMessageCodec,
  DiscoveryQueryService,
  DiscoveryRecordCodec,
  EndpointDiscoveryExporter,
} from "@work-fabric/discovery-runtime";
import type {
  DiscoveryExportPolicy,
  DiscoveryPeerBinding,
  DiscoveryRecord,
} from "@work-fabric/discovery-spi";
import { EndpointDirectoryService } from "@work-fabric/endpoint-directory";
import { ExchangeApplication, type Clock, type IdGenerator } from "@work-fabric/exchange-core";
import {
  EndpointInboxQueryService,
  HandoffProjector,
  MemoryHandoffReadModelStore,
  MemorySubscriptionStore,
} from "@work-fabric/exchange-runtime";
import type {
  AuthorityPolicy,
  CapabilityManifest,
  EndpointRegistration,
  ResolvedPrincipal,
} from "@work-fabric/exchange-spi";
import {
  FederationEnvelopeCodec,
  FederationGateway,
} from "@work-fabric/federation-runtime";
import type {
  FederationIdGenerator,
  FederationTransferBridge,
} from "@work-fabric/federation-spi";
import type {
  WfppCommandValidator,
  WfppSchemaValidator,
} from "@work-fabric/protocol-runtime";
import {
  BearerTokenProvider,
  WorkFabricClient,
  type HandoffOfferPayload,
} from "@work-fabric/sdk-typescript";
import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
  StoreBackedExchangeQueryService,
  type ExchangeQueryService,
  type HttpService,
} from "@work-fabric/transport-http";

export const tenantId = "tenant_discovery_e2e";
export const tenantViewId = "tenant_view_discovery_e2e";
export const now = "2026-08-01T09:00:00.000Z";
export const clock = { now: () => now };

class AllowAuthority implements AuthorityPolicy {
  readonly manifest: CapabilityManifest = {
    profile: "exchange.authority.v1",
    adapter: "discovery-e2e-allow",
    capabilities: {
      explicit_decision: true,
      default_deny: true,
      resource_scoping: true,
    },
  };

  async authorize() {
    return { kind: "allow" as const };
  }
}

class ExchangeIds implements IdGenerator {
  private readonly counts = new Map<string, number>();

  constructor(private readonly prefix: string) {}

  nextId(kind: "handoff" | "event" | "commit" | "receipt" | "delivery") {
    const next = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, next);
    return `${kind}_${this.prefix}_${next}`;
  }
}

function federationIds(prefix: string): FederationIdGenerator {
  let next = 0;
  return { nextId: (kind) => `${kind}_${prefix}_${++next}` };
}

function principal(exchangeId: string): ResolvedPrincipal {
  return {
    principal_id: `principal_${exchangeId}`,
    tenant_id: tenantId,
    actor_claims: [{
      actor_id: `actor_${exchangeId}`,
      actor_type: "agent",
      endpoint_ids: [`endpoint_${exchangeId}`],
    }],
    attributes: {},
  };
}

function peer(peerId: string, exchangeId: string): DiscoveryPeerBinding {
  return {
    tenant_id: tenantId,
    tenant_view_id: tenantViewId,
    peer_id: peerId,
    exchange_id: exchangeId,
    state: "active",
    allow_import: true,
    allow_export: true,
    allow_query: true,
    allow_transit: false,
    max_page_size: 20,
    max_response_bytes: 65_536,
    version: 1,
  };
}

function endpointRegistration(exchangeId: string, origin: string): EndpointRegistration {
  return {
    endpoint_id: `endpoint_${exchangeId}`,
    actor: { actor_id: `actor_${exchangeId}`, actor_type: "agent" },
    endpoint_type: "native_agent",
    display_name: `Agent on ${exchangeId}`,
    protocol_versions: ["1.0"],
    bindings: [{
      binding_type: "http_sse",
      uri: origin,
      security_schemes: ["bearer"],
    }],
    allowed_capability_ids: ["software.implementation"],
    limits: { max_inline_content_bytes: 65_536 },
    administrative_state: "enabled",
    registration_version: 1,
  };
}

export function handoffOffer(targetActor: string): HandoffOfferPayload {
  return {
    work_reference: { uri: "urn:work:discovery:e2e", extensions: {} },
    target: { actor_id: targetActor },
    intent: [{
      kind: "text",
      media_type: "text/plain",
      text: "Implement the explicitly accepted work",
    }],
    authority_scope: {
      delegation_id: "delegation_discovery_e2e",
      scopes: ["work:read", "result:write"],
      resource_refs: ["urn:work:discovery:e2e"],
      expires_at: "2026-08-02T09:00:00.000Z",
      may_redelegate: false,
    },
    acceptance_criteria: [{
      criterion_id: "target-recorded",
      description: "Target Exchange records the local Handoff",
      required: true,
      result_schema_ref: null,
      required_evidence_types: ["operation_receipt"],
    }],
    verifier: { actor_id: `verifier_${targetActor}`, actor_type: "human" },
    priority: "normal",
    accept_by: "2026-08-01T10:00:00.000Z",
    result_due_at: "2026-08-02T09:00:00.000Z",
  };
}

interface ExchangeHarness {
  readonly exchangeId: string;
  readonly client: WorkFabricClient;
  readonly service: HttpService;
  readonly persistence: MemoryExchangePersistence;
  readonly directory: MemoryEndpointDirectoryStore;
  readonly records: MemoryDiscoveryStore;
  readonly peers: MemoryDiscoveryPeerBindingStore;
  readonly recordCodec: DiscoveryRecordCodec;
  readonly gateway: DiscoveryGateway;
  readonly origin: string;
}

async function startExchange(input: {
  readonly exchangeId: string;
  readonly remoteExchangeId: string;
  readonly localDiscoveryKey: ReturnType<typeof generateKeyPairSync>;
  readonly remoteDiscoveryPublicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
  readonly schemas: WfppSchemaValidator;
  readonly validator: WfppCommandValidator;
  readonly queryTransport: (peer: DiscoveryPeerBinding) => { exchange(request: Uint8Array): Promise<Uint8Array | "retryable_failure"> } | null;
}): Promise<ExchangeHarness> {
  const persistence = new MemoryExchangePersistence();
  const subscriptions = new MemorySubscriptionStore();
  const models = new MemoryHandoffReadModelStore();
  const directory = new MemoryEndpointDirectoryStore();
  const inboxStore = new MemoryEndpointInboxStore();
  const records = new MemoryDiscoveryStore({
    max_records_per_origin: 100,
    tombstone_retention_seconds: 300,
  });
  const peers = new MemoryDiscoveryPeerBindingStore();
  await peers.put({
    binding: peer(`peer_${input.remoteExchangeId}`, input.remoteExchangeId),
    expected_version: null,
  });
  const signer = new NodeEd25519DiscoverySigner(
    `key_${input.exchangeId}`,
    input.localDiscoveryKey.privateKey,
  );
  const trust = new NodeEd25519DiscoveryTrustResolver([
    {
      origin_exchange_id: input.exchangeId,
      audience_exchange_id: input.exchangeId,
      key_id: `key_${input.exchangeId}`,
      public_key: input.localDiscoveryKey.publicKey,
    },
    {
      origin_exchange_id: input.remoteExchangeId,
      audience_exchange_id: input.exchangeId,
      key_id: `key_${input.remoteExchangeId}`,
      public_key: input.remoteDiscoveryPublicKey,
    },
  ]);
  const recordCodec = new DiscoveryRecordCodec({
    local_exchange_id: input.exchangeId,
    signer,
    trust,
    clock,
  });
  let discoveryId = 0;
  const gateway = new DiscoveryGateway({
    tenant_id: tenantId,
    tenant_view_id: tenantViewId,
    local_exchange_id: input.exchangeId,
    message_codec: new DiscoveryMessageCodec({
      local_exchange_id: input.exchangeId,
      signer,
      trust,
      clock,
    }),
    record_codec: recordCodec,
    cache: new DiscoveryCacheService({
      local_exchange_id: input.exchangeId,
      codec: recordCodec,
      store: records,
      peers,
      clock,
    }),
    store: records,
    peers,
    export_policy: {
      async exportRecord({ record }) { return record; },
    } satisfies DiscoveryExportPolicy,
    clock,
    id_generator: {
      nextId: (kind) => `${input.exchangeId}_${kind}_${++discoveryId}`,
    },
    query_transport: input.queryTransport,
  });
  const identity = new LocalIdentityProvider([{
    authentication_evidence: { bearer_token: input.exchangeId },
    principal: principal(input.exchangeId),
  }]);
  const authority = new AllowAuthority();
  const application = new ExchangeApplication({
    persistence,
    identity,
    authority,
    context: new MemoryContextRepository(),
    validator: input.validator,
    clock: clock as Clock,
    ids: new ExchangeIds(input.exchangeId),
  });
  const projector = new HandoffProjector(
    persistence,
    persistence,
    persistence,
    models,
    clock,
  );
  const stored = new StoreBackedExchangeQueryService(
    persistence,
    models,
    subscriptions,
    persistence,
    persistence,
  );
  const query: ExchangeQueryService = {
    ...stored,
    async getHandoff(requestTenantId, handoffId) {
      const events = await persistence.readStream(handoffId);
      const partitionId = events[0]?.partition_id;
      if (partitionId !== undefined) await projector.runPartition(partitionId, 100);
      return stored.getHandoff(requestTenantId, handoffId);
    },
    getContextBundle: stored.getContextBundle.bind(stored),
    readHandoffEvents: stored.readHandoffEvents.bind(stored),
    listPartitionHandoffs: stored.listPartitionHandoffs.bind(stored),
    readPartitionEvents: stored.readPartitionEvents.bind(stored),
    getSubscription: stored.getSubscription.bind(stored),
    listSubscriptions: stored.listSubscriptions.bind(stored),
    listProjectionFailures: stored.listProjectionFailures.bind(stored),
    listDeliveryAttempts: stored.listDeliveryAttempts.bind(stored),
    getDeliveryPosition: stored.getDeliveryPosition.bind(stored),
  };
  let endpointSession = 0;
  const endpointDirectory = new EndpointDirectoryService({
    store: directory,
    clock,
    ids: { sessionId: () => `session_${input.exchangeId}_${++endpointSession}` },
    limits: {
      min_lease_seconds: 30,
      default_lease_seconds: 60,
      max_lease_seconds: 300,
      renew_ahead_seconds: 10,
      max_capabilities: 64,
      max_bindings: 16,
      default_page_limit: 20,
      max_page_limit: 100,
    },
  });
  const endpointInbox = new EndpointInboxQueryService({
    directory,
    inbox: inboxStore,
    clock,
    defaultPageLimit: 20,
    maxPageLimit: 100,
  });
  const discovery = new DiscoveryQueryService({
    store: records,
    policy: { async canRead() { return true; } },
    clock,
    cursor_secret: `0123456789abcdef0123456789abcdef:${input.exchangeId}`,
    default_page_limit: 20,
    max_page_limit: 100,
    max_scan_results: 100,
  });
  const service = createHttpService({
    application,
    authenticator: new BearerAuthenticationEvidenceMapper(),
    identity,
    authority,
    query,
    subscriptions,
    schemas: input.schemas,
    endpoint_directory: endpointDirectory,
    endpoint_inbox: endpointInbox,
    discovery,
    discovery_gateway: gateway,
    discovery_tenant_view_id: tenantViewId,
  }, normalizeHttpServiceConfig({ default_page_limit: 20, max_page_limit: 100 }));
  const { origin } = await service.listen({ host: "127.0.0.1", port: 0 });
  let message = 0;
  const client = new WorkFabricClient({
    baseUrl: origin,
    tenantId,
    exchangeId: input.exchangeId,
    representation: {
      actorId: `actor_${input.exchangeId}`,
      endpointId: `endpoint_${input.exchangeId}`,
    },
    authentication: new BearerTokenProvider(input.exchangeId),
    clock,
    messageIdGenerator: {
      nextMessageId: () => `message_${input.exchangeId}_${++message}`,
    },
  });
  await client.endpoints.provision(
    `endpoint_${input.exchangeId}`,
    endpointRegistration(input.exchangeId, origin),
  );
  await client.endpoints.openSession(`endpoint_${input.exchangeId}`, {
    client_session_id: `client_${input.exchangeId}`,
    protocol_version: "1.0",
    capabilities: [{
      capability_id: "software.implementation",
      version: "1.0.0",
      name: "Implementation",
      description: "Implements an explicitly accepted Handoff",
      input_media_types: ["application/json"],
      output_media_types: ["application/json"],
      input_schema_refs: [],
      output_schema_refs: [],
      interaction_modes: ["asynchronous"],
      constraints: {},
    }],
    availability: "available",
    requested_lease_seconds: 300,
    expected_registration_version: 1,
  });
  return {
    exchangeId: input.exchangeId,
    client,
    service,
    persistence,
    directory,
    records,
    peers,
    recordCodec,
    gateway,
    origin,
  };
}

async function publishEndpoint(exchange: ExchangeHarness, targetExchangeId: string): Promise<void> {
  const exporter = new EndpointDiscoveryExporter({
    local_exchange_id: exchange.exchangeId,
    directory: exchange.directory,
    store: exchange.records,
    codec: exchange.recordCodec,
    clock,
    audiences: [targetExchangeId],
    safe_binding_types: ["http_sse"],
    record_ttl_seconds: 300,
    renew_ahead_seconds: 30,
    page_size: 20,
    max_endpoints: 100,
  });
  await exporter.refresh(tenantId, tenantViewId);
  const descriptor = await exchange.client.endpoints.get(`endpoint_${exchange.exchangeId}`);
  const bytes = await exchange.recordCodec.sign({
    record_id: `endpoint:${descriptor.endpoint_id}`,
    record_kind: "endpoint",
    origin_exchange_id: exchange.exchangeId,
    revision: 1,
    issued_at: now,
    expires_at: "2026-08-01T09:05:00.000Z",
    visibility: "peer",
    audiences: [targetExchangeId],
    transitive: false,
    max_hops: 0,
    payload: {
      endpoint_id: descriptor.endpoint_id,
      actor: descriptor.actor,
      endpoint_type: descriptor.endpoint_type,
      display_name: descriptor.display_name,
      protocol_versions: descriptor.protocol_versions,
      bindings: descriptor.bindings,
      capabilities: descriptor.capabilities,
      availability: descriptor.availability,
      limits: descriptor.limits,
    },
  });
  await exchange.records.apply({
    tenant_id: tenantId,
    tenant_view_id: tenantViewId,
    source_peer_id: null,
    value: JSON.parse(new TextDecoder().decode(bytes)) as DiscoveryRecord,
  });
}

export interface DiscoveryFederationScenario {
  readonly exchangeA: ExchangeHarness;
  readonly exchangeB: ExchangeHarness;
  readonly federationA: FederationGateway;
  readonly federationB: FederationGateway;
  readonly targetBridgeCalls: () => number;
  close(): Promise<void>;
}

export async function createDiscoveryFederationScenario(
  schemas: WfppSchemaValidator,
  validator: WfppCommandValidator,
  options: { readonly publishDiscovery: boolean },
): Promise<DiscoveryFederationScenario> {
  const discoveryKeyA = generateKeyPairSync("ed25519");
  const discoveryKeyB = generateKeyPairSync("ed25519");
  const gateways = new Map<string, DiscoveryGateway>();
  const origins = new Map<string, string>();
  const httpTransport = (peerBinding: DiscoveryPeerBinding) => ({
    async exchange(request: Uint8Array): Promise<Uint8Array | "retryable_failure"> {
      const origin = origins.get(peerBinding.exchange_id);
      if (origin === undefined) return "retryable_failure";
      const response = await fetch(`${origin}/v1/discovery/peer/query`, {
        method: "POST",
        headers: { "content-type": "application/workfabric-discovery+json" },
        body: Buffer.from(request),
      });
      return response.ok ? new Uint8Array(await response.arrayBuffer()) : "retryable_failure";
    },
  });
  const exchangeA = await startExchange({
    exchangeId: "exchange_a",
    remoteExchangeId: "exchange_b",
    localDiscoveryKey: discoveryKeyA,
    remoteDiscoveryPublicKey: discoveryKeyB.publicKey,
    schemas,
    validator,
    queryTransport: httpTransport,
  });
  origins.set(exchangeA.exchangeId, exchangeA.origin);
  gateways.set(exchangeA.exchangeId, exchangeA.gateway);
  const exchangeB = await startExchange({
    exchangeId: "exchange_b",
    remoteExchangeId: "exchange_a",
    localDiscoveryKey: discoveryKeyB,
    remoteDiscoveryPublicKey: discoveryKeyA.publicKey,
    schemas,
    validator,
    queryTransport: httpTransport,
  });
  origins.set(exchangeB.exchangeId, exchangeB.origin);
  gateways.set(exchangeB.exchangeId, exchangeB.gateway);

  if (options.publishDiscovery) {
    await publishEndpoint(exchangeA, exchangeB.exchangeId);
    const prepared = await exchangeB.gateway.prepareSync({ peer_id: "peer_exchange_a" });
    const result = await exchangeB.gateway.deliverSync(prepared, {
      async exchange(request) {
        const response = await fetch(`${exchangeA.origin}/v1/discovery/peer/sync`, {
          method: "POST",
          headers: { "content-type": "application/workfabric-discovery+json" },
          body: Buffer.from(request),
        });
        return response.ok ? new Uint8Array(await response.arrayBuffer()) : "retryable_failure";
      },
    });
    if (result.outcome !== "applied") throw new Error("discovery sync failed");
  }

  let targetCalls = 0;
  const sourceBridge: FederationTransferBridge = {
    async offerInbound() { throw new Error("source does not receive its own transfer"); },
    async applyOutboundReceipt() {
      // Delivery acknowledgement does not mutate either local Handoff lifecycle.
    },
  };
  const targetBridge: FederationTransferBridge = {
    async offerInbound(input) {
      targetCalls += 1;
      const result = await exchangeA.client.handoffs.offer(
        input.offer.handoff_offer as HandoffOfferPayload,
        { idempotencyKey: input.transfer_id },
      );
      const resourceId = result.resource?.resource_id;
      const resourceVersion = result.resource?.resource_version;
      if (
        result.operation_status !== "accepted" ||
        typeof resourceId !== "string" ||
        !Number.isSafeInteger(resourceVersion)
      ) {
        return { decision: "rejected" as const, reason_code: "target_exchange_rejected" };
      }
      return {
        decision: "accepted" as const,
        target_handoff_id: resourceId,
        target_resource_version: resourceVersion as number,
      };
    },
    async applyOutboundReceipt() { throw new Error("target does not apply its own receipt"); },
  };
  const federationKeyA = generateKeyPairSync("ed25519");
  const federationKeyB = generateKeyPairSync("ed25519");
  const federationA = new FederationGateway({
    local_exchange_id: "exchange_a",
    codec: new FederationEnvelopeCodec({
      local_exchange_id: "exchange_a",
      signer: new NodeEd25519FederationSigner("federation-key-a", federationKeyA.privateKey),
      trust: new NodeEd25519FederationTrustResolver([{
        source_exchange_id: "exchange_b",
        target_exchange_id: "exchange_a",
        key_id: "federation-key-b",
        public_key: federationKeyB.publicKey,
      }]),
      clock,
    }),
    replay_store: new MemoryFederationReplayStore({ max_records: 20, clock }),
    bridge: targetBridge,
    clock,
    ids: federationIds("a"),
  });
  const federationB = new FederationGateway({
    local_exchange_id: "exchange_b",
    codec: new FederationEnvelopeCodec({
      local_exchange_id: "exchange_b",
      signer: new NodeEd25519FederationSigner("federation-key-b", federationKeyB.privateKey),
      trust: new NodeEd25519FederationTrustResolver([{
        source_exchange_id: "exchange_a",
        target_exchange_id: "exchange_b",
        key_id: "federation-key-a",
        public_key: federationKeyA.publicKey,
      }]),
      clock,
    }),
    replay_store: new MemoryFederationReplayStore({ max_records: 20, clock }),
    bridge: sourceBridge,
    clock,
    ids: federationIds("b"),
  });
  return {
    exchangeA,
    exchangeB,
    federationA,
    federationB,
    targetBridgeCalls: () => targetCalls,
    async close() {
      await Promise.all([exchangeA.service.close(), exchangeB.service.close()]);
    },
  };
}
