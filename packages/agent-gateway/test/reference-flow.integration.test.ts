import { beforeAll, describe, expect, it } from "vitest";

import {
  MemoryEndpointDirectoryStore,
  MemoryEndpointInboxStore,
} from "@work-fabric/adapter-endpoint-memory";
import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import { LocalIdentityProvider } from "@work-fabric/adapter-identity-local";
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import {
  DirectoryTargetEligibilityVerifier,
  EndpointDirectoryService,
} from "@work-fabric/endpoint-directory";
import {
  ExchangeApplication,
  type Clock,
  type IdGenerator,
} from "@work-fabric/exchange-core";
import {
  CursorPullService,
  DefaultSubscriptionDeliveryPolicy,
  EndpointInboxProjector,
  EndpointInboxQueryService,
  HandoffProjector,
  MemoryHandoffReadModelStore,
  MemorySubscriptionStore,
  OpaqueCursorCodec,
} from "@work-fabric/exchange-runtime";
import type {
  AuthorityPolicy,
  CapabilityManifest,
  ResolvedPrincipal,
} from "@work-fabric/exchange-spi";
import {
  loadWfppCommandValidator,
  loadWfppSchemaValidator,
  type WfppCommandValidator,
  type WfppSchemaValidator,
} from "@work-fabric/protocol-runtime";
import {
  BearerTokenProvider,
  WorkFabricClient,
  type CapabilityDescriptor,
  type EndpointRegistration,
  type HandoffOfferPayload,
  type SubscriptionDocument,
} from "@work-fabric/sdk-typescript";
import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
  StoreBackedExchangeQueryService,
  type ExchangeQueryService,
} from "@work-fabric/transport-http";

import { AgentGateway } from "../src/index.js";

const tenantId = "tenant_gateway_reference";
const exchangeId = "exchange_gateway_reference";
const endpointId = "endpoint_agent";
const agentActorId = "actor_agent";

function principal(
  principalId: string,
  actorId: string,
  actorType: "human" | "agent" | "system",
  representedEndpointId: string,
): ResolvedPrincipal {
  return {
    principal_id: principalId,
    tenant_id: tenantId,
    actor_claims: [{
      actor_id: actorId,
      actor_type: actorType,
      endpoint_ids: [representedEndpointId],
    }],
    attributes: {},
  };
}

const admin = principal("principal_admin", "actor_admin", "human", "endpoint_admin");
const human = principal("principal_human", "actor_human", "human", "endpoint_human");
const runtime = principal("principal_runtime", agentActorId, "agent", endpointId);
const resolver = principal("principal_resolver", "actor_resolver", "system", "endpoint_resolver");

class AllowAuthority implements AuthorityPolicy {
  readonly manifest: CapabilityManifest = {
    profile: "exchange.authority.v1",
    adapter: "reference-allow",
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

class ReferenceClock implements Clock {
  now() { return "2026-07-15T09:00:00.000Z"; }
}

class ReferenceIds implements IdGenerator {
  private readonly counts = new Map<string, number>();

  nextId(kind: "handoff" | "event" | "commit" | "receipt" | "delivery") {
    const next = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, next);
    return `${kind}_gateway_${next}`;
  }
}

const capability: CapabilityDescriptor = {
  capability_id: "software.implementation",
  version: "1.0.0",
  name: "Software implementation",
  description: "Implements an explicitly assigned Handoff",
  input_media_types: ["text/markdown"],
  output_media_types: ["application/json"],
  input_schema_refs: [],
  output_schema_refs: [],
  interaction_modes: ["asynchronous"],
  constraints: {},
  extensions: {},
};

const registration: EndpointRegistration = {
  endpoint_id: endpointId,
  actor: { actor_id: agentActorId, actor_type: "agent" },
  endpoint_type: "native_agent",
  display_name: "External local Agent Runtime",
  protocol_versions: ["1.0"],
  bindings: [{
    binding_type: "http_sse",
    uri: "https://runtime.example.test/work-fabric",
    security_schemes: ["oauth2"],
    extensions: {},
  }],
  allowed_capability_ids: [capability.capability_id],
  limits: { max_inline_content_bytes: 65_536 },
  administrative_state: "enabled",
  registration_version: 1,
  extensions: {},
};

const offer: HandoffOfferPayload = {
  work_reference: {
    uri: "feishu://document/gateway-reference-requirements",
    extensions: {},
  },
  target: {
    capability_requirement: {
      capability_id: capability.capability_id,
      version_constraint: ">=1.0.0 <2.0.0",
      input_media_types: ["text/markdown"],
      output_media_types: ["application/json"],
    },
  },
  intent: [{
    kind: "text",
    media_type: "text/plain",
    text: "Implement this work in the external Runtime",
  }],
  authority_scope: {
    delegation_id: "delegation_gateway",
    scopes: ["work:read", "result:write"],
    resource_refs: ["feishu://document/gateway-reference-requirements"],
    expires_at: "2026-07-16T09:00:00.000Z",
    may_redelegate: false,
  },
  acceptance_criteria: [{
    criterion_id: "tests-pass",
    description: "Tests pass",
    required: true,
    result_schema_ref: null,
    required_evidence_types: ["test_report"],
  }],
  verifier: { actor_id: "actor_human", actor_type: "human" },
  priority: "normal",
  accept_by: "2026-07-15T10:00:00.000Z",
  result_due_at: "2026-07-16T09:00:00.000Z",
};

let validator: WfppCommandValidator;
let schemas: WfppSchemaValidator;

beforeAll(async () => {
  schemas = await loadWfppSchemaValidator("protocol/schemas/v1");
  validator = await loadWfppCommandValidator(
    schemas,
    "protocol/spec/interaction-payloads.json",
  );
});

function sdk(
  origin: string,
  token: string,
  actorId: string,
  representedEndpointId: string,
) {
  let message = 0;
  return new WorkFabricClient({
    baseUrl: origin,
    tenantId,
    exchangeId,
    representation: {
      actorId,
      endpointId: representedEndpointId,
      delegationId: "delegation_gateway",
    },
    authentication: new BearerTokenProvider(token),
    clock: new ReferenceClock(),
    messageIdGenerator: {
      nextMessageId: () => `message_gateway_${token}_${++message}`,
    },
    streamReconnect: {
      baseDelayMs: 5,
      maxDelayMs: 10,
      maxReconnects: 2,
    },
  });
}

describe("Agent Gateway real reference flow", () => {
  it("connects an external Runtime without executing or selecting work inside Work Fabric", async () => {
    const persistence = new MemoryExchangePersistence();
    const subscriptions = new MemorySubscriptionStore();
    const models = new MemoryHandoffReadModelStore();
    const endpointDirectoryStore = new MemoryEndpointDirectoryStore();
    const endpointInboxStore = new MemoryEndpointInboxStore();
    const exchangeClock = new ReferenceClock();
    const ids = new ReferenceIds();
    const identity = new LocalIdentityProvider([
      { authentication_evidence: { bearer_token: "admin" }, principal: admin },
      { authentication_evidence: { bearer_token: "human" }, principal: human },
      { authentication_evidence: { bearer_token: "runtime" }, principal: runtime },
      { authentication_evidence: { bearer_token: "resolver" }, principal: resolver },
    ]);
    const authority = new AllowAuthority();
    const directoryClock = { now: () => new Date().toISOString() };
    let endpointSession = 0;
    const endpointDirectory = new EndpointDirectoryService({
      store: endpointDirectoryStore,
      clock: directoryClock,
      ids: { sessionId: () => `session_gateway_${++endpointSession}` },
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
    const application = new ExchangeApplication({
      persistence,
      identity,
      authority,
      context: new MemoryContextRepository(),
      validator,
      clock: exchangeClock,
      ids,
      target_eligibility: new DirectoryTargetEligibilityVerifier({
        store: endpointDirectoryStore,
        clock: directoryClock,
      }),
    });
    const handoffProjector = new HandoffProjector(
      persistence,
      persistence,
      persistence,
      models,
      exchangeClock,
    );
    const inboxProjector = new EndpointInboxProjector(endpointInboxStore);
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
        const records = await persistence.readStream(handoffId);
        const partitionId = records[0]?.partition_id;
        if (partitionId !== undefined) {
          await handoffProjector.runPartition(partitionId, 100);
        }
        return stored.getHandoff(requestTenantId, handoffId);
      },
      readHandoffEvents: stored.readHandoffEvents.bind(stored),
      listPartitionHandoffs: stored.listPartitionHandoffs.bind(stored),
      readPartitionEvents: stored.readPartitionEvents.bind(stored),
      getSubscription: stored.getSubscription.bind(stored),
      listSubscriptions: stored.listSubscriptions.bind(stored),
      listProjectionFailures: stored.listProjectionFailures.bind(stored),
      listDeliveryAttempts: stored.listDeliveryAttempts.bind(stored),
      getDeliveryPosition: stored.getDeliveryPosition.bind(stored),
    };
    const delivery = new CursorPullService(
      persistence,
      persistence,
      subscriptions,
      new DefaultSubscriptionDeliveryPolicy(),
      exchangeClock,
      ids,
      new OpaqueCursorCodec(
        new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
      ),
      schemas,
      30,
    );
    const endpointInbox = new EndpointInboxQueryService({
      directory: endpointDirectoryStore,
      inbox: endpointInboxStore,
      clock: exchangeClock,
      defaultPageLimit: 20,
      maxPageLimit: 100,
    });
    const service = createHttpService({
      application,
      authenticator: new BearerAuthenticationEvidenceMapper(),
      identity,
      authority,
      query,
      subscriptions,
      schemas,
      delivery,
      endpoint_directory: endpointDirectory,
      endpoint_inbox: endpointInbox,
    }, normalizeHttpServiceConfig({
      default_page_limit: 10,
      max_page_limit: 20,
      sse_poll_interval_ms: 5,
      sse_heartbeat_interval_ms: 25,
      sse_idle_timeout_ms: 1_000,
    }));
    const { origin } = await service.listen({ host: "127.0.0.1", port: 0 });
    const adminSdk = sdk(origin, "admin", "actor_admin", "endpoint_admin");
    const humanSdk = sdk(origin, "human", "actor_human", "endpoint_human");
    const runtimeSdk = sdk(origin, "runtime", agentActorId, endpointId);
    const resolverSdk = sdk(origin, "resolver", "actor_resolver", "endpoint_resolver");
    const subscription: SubscriptionDocument = {
      subscription_id: "subscription_gateway_runtime",
      owner: { actor_id: agentActorId, actor_type: "agent" },
      endpoint_id: endpointId,
      filter: {
        event_types: [], actor_ids: [], endpoint_ids: [], thread_ids: [],
        handoff_ids: [], work_reference_uris: [], capability_ids: [],
        lifecycle_states: [],
      },
      delivery: { mode: "sse" },
      state: "active",
      cursor: null,
      created_at: "2026-07-15T09:00:00.000Z",
      updated_at: "2026-07-15T09:00:00.000Z",
    };
    const gateway = new AgentGateway(runtimeSdk, {
      endpoint_id: endpointId,
      subscription,
      open_session: {
        client_session_id: "client_gateway_reference",
        protocol_version: "1.0",
        capabilities: [capability],
        availability: "available",
        requested_lease_seconds: 60,
        expected_registration_version: 1,
      },
      inbox_refresh_ms: 5,
      max_active_partitions: 8,
      incoming_queue_capacity: 4,
      heartbeat_retry_count: 1,
      heartbeat_backoff_ms: 5,
      graceful_close_timeout_ms: 1_000,
    });

    let session: Awaited<ReturnType<typeof gateway.start>> | undefined;
    try {
      await adminSdk.endpoints.provision(endpointId, registration);
      session = await gateway.start();

      const facts = await resolverSdk.endpoints.discover({
        capability_id: capability.capability_id,
        version_constraint: ">=1.0.0 <2.0.0",
        availability: ["available"],
      });
      expect(facts.items.map(({ endpoint_id }) => endpoint_id)).toEqual([
        endpointId,
      ]);
      expect(facts.items[0]).not.toHaveProperty("score");
      expect(facts.items[0]).not.toHaveProperty("rank");

      const offered = await humanSdk.handoffs.offer(offer, {
        idempotencyKey: "gateway-reference-offer",
      });
      const handoffId = offered.resource?.resource_id;
      if (typeof handoffId !== "string") throw new TypeError("offer failed");
      await expect(resolverSdk.handoffs.resolveTarget({
        handoff_id: handoffId,
        resolved_target: { endpoint_id: endpointId },
      }, {
        expectedVersion: 1,
        idempotencyKey: "gateway-reference-resolve",
      })).resolves.toMatchObject({
        operation_status: "accepted",
        resource: { resource_version: 2 },
      });

      const records = await persistence.readStream(handoffId);
      for (const record of records) await inboxProjector.apply(record);
      await handoffProjector.runPartition(records[0]!.partition_id, 100);

      const incoming = await session.incoming()[Symbol.asyncIterator]().next();
      if (incoming.done) throw new TypeError("expected incoming Handoff");

      const externalRuntimeCalls: string[] = [];
      const persistedDeliveryIds = new Set<string>();
      persistedDeliveryIds.add(incoming.value.delivery.delivery_id);
      externalRuntimeCalls.push("persist");
      externalRuntimeCalls.push("decide");
      await incoming.value.acknowledgeSignal("acknowledged");
      await session.handoffs.accept({ handoff_id: handoffId }, {
        expectedVersion: 2,
        idempotencyKey: "gateway-reference-accept",
      });
      externalRuntimeCalls.push("work");
      await session.handoffs.reportStatus({
        handoff_id: handoffId,
        status: {
          status_report_id: "status_gateway_1",
          execution_status: "in_progress",
          progress: 0.5,
          message: [],
          observed_at: "2026-07-15T09:10:00.000Z",
          blocked_on: [],
        },
      }, {
        expectedVersion: 3,
        idempotencyKey: "gateway-reference-status",
      });
      await session.handoffs.returnResult({
        handoff_id: handoffId,
        result: {
          summary: [{
            kind: "text",
            media_type: "text/plain",
            text: "Work completed by the external Runtime",
          }],
          artifacts: [{
            artifact_id: "artifact_gateway_1",
            artifact_type: "source_repository",
            resource: {
              uri: "urn:git:gateway-reference:commit:abc123",
              extensions: {},
            },
          }],
          evidence: [{
            evidence_id: "evidence_gateway_1",
            evidence_type: "test_report",
            content: {
              kind: "resource",
              resource: {
                uri: "urn:test-report:gateway-reference:1",
                media_type: "application/json",
                extensions: {},
              },
            },
          }],
        },
      }, {
        expectedVersion: 4,
        idempotencyKey: "gateway-reference-result",
      });

      const poolOffer: HandoffOfferPayload = {
        ...offer,
        target: {
          capability_requirement: {
            capability_id: capability.capability_id,
            version_constraint: ">=1.0.0 <2.0.0",
            input_media_types: ["text/markdown"],
            output_media_types: ["application/json"],
            assignment_mode: "eligible_pool_claim",
          },
        },
      };
      const poolOffered = await humanSdk.handoffs.offer(poolOffer, {
        idempotencyKey: "gateway-reference-pool-offer",
      });
      const poolHandoffId = poolOffered.resource?.resource_id;
      if (typeof poolHandoffId !== "string") throw new TypeError("pool offer failed");
      const poolRecords = await persistence.readStream(poolHandoffId);
      for (const record of poolRecords) await inboxProjector.apply(record);

      await expect(session.claimableHandoffs()).resolves.toMatchObject({
        items: [{
          handoff_id: poolHandoffId,
          lifecycle_state: "claimable",
          capability_ids: [capability.capability_id],
        }],
      });
      await expect(runtimeSdk.queries.getHandoff(poolHandoffId)).resolves.toMatchObject({
        state: {
          lifecycle_state: "claimable",
          active_claim: null,
        },
      });

      await expect(session.handoffs.claim({
        handoff_id: poolHandoffId,
        claim_id: "claim_gateway_reference",
        requested_lease_seconds: 60,
      }, {
        expectedVersion: 1,
        idempotencyKey: "gateway-reference-claim",
      })).resolves.toMatchObject({
        operation_status: "accepted",
        receipt: {
          receipt_type: "claim_acquired",
        },
        resource: { resource_version: 2 },
      });
      await expect(session.handoffs.accept({
        handoff_id: poolHandoffId,
        claim_id: "claim_gateway_reference",
        fencing_token: 1,
      }, {
        expectedVersion: 2,
        idempotencyKey: "gateway-reference-pool-accept",
      })).resolves.toMatchObject({
        operation_status: "accepted",
        receipt: {
          receipt_type: "responsibility_accepted",
        },
        resource: { resource_version: 3 },
      });

      expect(persistedDeliveryIds).toContain(incoming.value.delivery.delivery_id);
      expect(externalRuntimeCalls).toEqual(["persist", "decide", "work"]);
      await handoffProjector.runPartition(records[0]!.partition_id, 100);
      await expect(runtimeSdk.queries.getHandoff(handoffId)).resolves.toMatchObject({
        state: { lifecycle_state: "result_returned" },
      });
    } finally {
      await session?.close();
      await service.close();
    }
  }, 15_000);
});
