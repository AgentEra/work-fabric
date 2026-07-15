import { beforeAll, describe, expect, it } from "vitest";

import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import {
  LocalAuthorityPolicy,
  LocalIdentityProvider,
  type LocalAuthorityAllowRule,
} from "@work-fabric/adapter-identity-local";
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import { ExchangeApplication, type Clock, type IdGenerator } from "@work-fabric/exchange-core";
import {
  CursorPullService,
  DefaultSubscriptionDeliveryPolicy,
  HandoffProjector,
  MemoryHandoffReadModelStore,
  MemorySubscriptionStore,
  OpaqueCursorCodec,
} from "@work-fabric/exchange-runtime";
import type { ResolvedPrincipal, TargetEligibilityVerifier } from "@work-fabric/exchange-spi";
import {
  loadWfppCommandValidator,
  loadWfppSchemaValidator,
  type WfppCommandValidator,
  type WfppSchemaValidator,
} from "@work-fabric/protocol-runtime";
import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
  StoreBackedExchangeQueryService,
  type ExchangeQueryService,
} from "@work-fabric/transport-http";

import {
  BearerTokenProvider,
  WorkFabricClient,
  type EventDelivery,
  type HandoffOfferPayload,
  type SubscriptionDocument,
} from "../src/index.js";

const tenantId = "tenant_sdk_reference";
const exchangeId = "exchange_sdk_reference";

function principal(id: string, actorId: string, actorType: "human" | "agent" | "system", endpointId: string): ResolvedPrincipal {
  return { principal_id: id, tenant_id: tenantId, actor_claims: [{ actor_id: actorId, actor_type: actorType, endpoint_ids: [endpointId] }], attributes: {} };
}

const human = principal("principal_human", "actor_human", "human", "endpoint_human");
const agent = principal("principal_agent", "actor_agent", "agent", "endpoint_agent");
const resolver = principal("principal_resolver", "actor_resolver", "system", "endpoint_resolver");

function rule(subject: ResolvedPrincipal, action: string, resourceId: string | null): LocalAuthorityAllowRule {
  const claim = subject.actor_claims[0];
  const endpointId = claim?.endpoint_ids[0];
  if (claim === undefined || endpointId === undefined) throw new TypeError("invalid principal");
  return { tenant_id: tenantId, principal_id: subject.principal_id, actor_id: claim.actor_id, actor_type: claim.actor_type, endpoint_id: endpointId, action, resource_id: resourceId };
}

class ReferenceClock implements Clock {
  now() { return "2026-07-15T09:00:00.000Z"; }
}

class ReferenceIds implements IdGenerator {
  private readonly counts = new Map<string, number>();
  nextId(kind: "handoff" | "event" | "commit" | "receipt" | "delivery") {
    const next = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, next);
    return `${kind}_sdk_${next}`;
  }
}

const offer: HandoffOfferPayload = {
  work_reference: { uri: "feishu://document/sdk-reference-requirements", extensions: {} },
  target: { actor_id: "actor_agent" },
  intent: [{ kind: "text", media_type: "text/plain", text: "Implement outside Work Fabric" }],
  authority_scope: {
    delegation_id: "delegation_sdk", scopes: ["work:read", "result:write"],
    resource_refs: ["feishu://document/sdk-reference-requirements"], expires_at: "2026-07-16T09:00:00.000Z", may_redelegate: false,
  },
  acceptance_criteria: [{ criterion_id: "tests-pass", description: "Tests pass", required: true, result_schema_ref: null, required_evidence_types: ["test_report"] }],
  verifier: { actor_id: "actor_human", actor_type: "human" },
  priority: "normal",
  accept_by: "2026-07-15T10:00:00.000Z",
  result_due_at: "2026-07-16T09:00:00.000Z",
};

let validator: WfppCommandValidator;
let schemas: WfppSchemaValidator;

beforeAll(async () => {
  schemas = await loadWfppSchemaValidator("protocol/schemas/v1");
  validator = await loadWfppCommandValidator(schemas, "protocol/spec/interaction-payloads.json");
});

function sdk(origin: string, token: string, actorId: string, endpointId: string) {
  let messages = 0;
  return new WorkFabricClient({
    baseUrl: origin,
    tenantId,
    exchangeId,
    representation: { actorId, endpointId, delegationId: "delegation_sdk" },
    authentication: new BearerTokenProvider(token),
    clock: new ReferenceClock(),
    messageIdGenerator: { nextMessageId: () => `message_sdk_${++messages}` },
    streamReconnect: { baseDelayMs: 5, maxDelayMs: 10, maxReconnects: 2 },
  });
}

describe("TypeScript SDK real HTTP reference", () => {
  it("coordinates commands, queries, durable delivery, streaming, and health only through public SDK methods", async () => {
    const persistence = new MemoryExchangePersistence();
    const subscriptions = new MemorySubscriptionStore();
    const models = new MemoryHandoffReadModelStore();
    const clock = new ReferenceClock();
    const ids = new ReferenceIds();
    const identities = new LocalIdentityProvider([
      { authentication_evidence: { bearer_token: "human" }, principal: human },
      { authentication_evidence: { bearer_token: "agent" }, principal: agent },
      { authentication_evidence: { bearer_token: "resolver" }, principal: resolver },
    ]);
    const directId = "handoff_sdk_1";
    const capabilityId = "handoff_sdk_2";
    const authority = new LocalAuthorityPolicy([
      rule(human, "workfabric.handoff.offer.v1", null),
      rule(agent, "workfabric.handoff.accept.v1", directId),
      rule(agent, "workfabric.handoff.accept.v1", capabilityId),
      rule(resolver, "workfabric.handoff.resolve_target.v1", capabilityId),
      rule(human, "workfabric.query.handoff.read.v1", directId),
      rule(human, "workfabric.query.handoff.read.v1", capabilityId),
      ...["subscription_cursor", "subscription_sse"].flatMap((id) => [
        rule(agent, "workfabric.subscription.manage.v1", id),
        rule(agent, "workfabric.subscription.pull.v1", id),
        rule(agent, "workfabric.subscription.ack.v1", id),
        rule(agent, "workfabric.subscription.stream.v1", id),
      ]),
      rule(human, "workfabric.operations.health.read.v1", null),
    ]);
    const eligibility: TargetEligibilityVerifier = {
      manifest: { profile: "exchange.target-eligibility.v1", adapter: "sdk-reference", capabilities: { explicit_target_only: true, no_candidate_selection: true, fail_closed: true } },
      async verify() { return { kind: "eligible" }; },
    };
    const application = new ExchangeApplication({ persistence, identity: identities, authority, context: new MemoryContextRepository(), validator, clock, ids, target_eligibility: eligibility });
    const projector = new HandoffProjector(persistence, persistence, persistence, models, clock);
    const stored = new StoreBackedExchangeQueryService(persistence, models, subscriptions, persistence, persistence);
    const query: ExchangeQueryService = {
      ...stored,
      async getHandoff(requestTenantId, handoffId) {
        const records = await persistence.readStream(handoffId);
        const partitionId = records[0]?.partition_id;
        if (partitionId !== undefined) await projector.runPartition(partitionId, 100);
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
    const delivery = new CursorPullService(persistence, persistence, subscriptions, new DefaultSubscriptionDeliveryPolicy(), clock, ids, new OpaqueCursorCodec(new TextEncoder().encode("0123456789abcdef0123456789abcdef")), schemas, 30);
    const service = createHttpService({
      application, authenticator: new BearerAuthenticationEvidenceMapper(), identity: identities, authority,
      query, subscriptions, schemas, delivery,
      health_probes: [{ dependency_id: "exchange", async check() { return "healthy"; } }],
    }, normalizeHttpServiceConfig({ default_page_limit: 10, max_page_limit: 20, sse_poll_interval_ms: 5, sse_heartbeat_interval_ms: 25, sse_idle_timeout_ms: 1_000 }));
    const { origin } = await service.listen({ host: "127.0.0.1", port: 0 });
    const humanSdk = sdk(origin, "human", "actor_human", "endpoint_human");
    const agentSdk = sdk(origin, "agent", "actor_agent", "endpoint_agent");
    const resolverSdk = sdk(origin, "resolver", "actor_resolver", "endpoint_resolver");

    try {
      const offered = await humanSdk.handoffs.offer(offer, { idempotencyKey: "direct-offer", messageId: "message_direct_offer" });
      expect(offered).toMatchObject({ operation_status: "accepted", resource: { resource_id: directId, resource_version: 1 } });
      const replay = await humanSdk.handoffs.offer(offer, { idempotencyKey: "direct-offer", messageId: "message_direct_replay" });
      expect(replay).toMatchObject({ operation_status: "accepted", request_message_id: "message_direct_replay", resource: { resource_id: directId, resource_version: 1 } });
      await expect(agentSdk.handoffs.accept({ handoff_id: directId }, { expectedVersion: 9, idempotencyKey: "direct-conflict" })).resolves.toMatchObject({ operation_status: "conflict" });
      await expect(agentSdk.handoffs.accept({ handoff_id: directId }, { expectedVersion: 1, idempotencyKey: "direct-accept" })).resolves.toMatchObject({ operation_status: "accepted", resource: { resource_version: 2 } });

      const capabilityOffer: HandoffOfferPayload = { ...offer, target: { capability_requirement: { capability_id: "software.implementation", version_constraint: ">=1.0.0 <2.0.0", input_media_types: ["text/markdown"] } } };
      await expect(humanSdk.handoffs.offer(capabilityOffer, { idempotencyKey: "capability-offer" })).resolves.toMatchObject({ operation_status: "accepted", resource: { resource_id: capabilityId, resource_version: 1 } });
      await expect(resolverSdk.handoffs.resolveTarget({ handoff_id: capabilityId, resolved_target: { actor_id: "actor_agent" } }, { expectedVersion: 1, idempotencyKey: "capability-resolve" })).resolves.toMatchObject({ operation_status: "accepted", resource: { resource_version: 2 } });
      await expect(agentSdk.handoffs.accept({ handoff_id: capabilityId }, { expectedVersion: 2, idempotencyKey: "capability-accept" })).resolves.toMatchObject({ operation_status: "accepted" });

      const capability = await humanSdk.queries.getHandoff(capabilityId);
      expect(capability.state).toMatchObject({ package: { target: { capability_requirement: { capability_id: "software.implementation" } } }, target_binding: { target: { actor_id: "actor_agent" } } });
      const direct = await humanSdk.queries.getHandoff(directId);
      const events = await humanSdk.queries.listHandoffEvents(directId, { limit: 10 });
      expect(events).toHaveLength(2);
      expect(JSON.stringify(events)).not.toMatch(/domain_data|partition_position|commit_id|idempotency_key/);

      const makeSubscription = (subscriptionId: string, mode: "cursor_pull" | "sse"): SubscriptionDocument => ({
        subscription_id: subscriptionId,
        owner: { actor_id: "actor_agent", actor_type: "agent" }, endpoint_id: "endpoint_agent",
        filter: { event_types: [], actor_ids: [], endpoint_ids: [], thread_ids: [], handoff_ids: [directId], work_reference_uris: [], capability_ids: [], lifecycle_states: [] },
        delivery: { mode }, state: "active", cursor: null,
        created_at: "2026-07-15T08:00:00.000Z", updated_at: "2026-07-15T08:00:00.000Z",
      });
      await agentSdk.subscriptions.put(makeSubscription("subscription_cursor", "cursor_pull"));
      await agentSdk.subscriptions.put(makeSubscription("subscription_sse", "sse"));

      const pulled = await agentSdk.subscriptions.pull("subscription_cursor", { partitionId: direct.partition_id, limit: 10 });
      if (pulled.kind !== "delivery") throw new TypeError("expected delivery");
      await expect(agentSdk.subscriptions.acknowledgeDelivery(pulled.delivery, "acknowledged")).resolves.toMatchObject({ kind: "acknowledged" });

      const firstAbort = new AbortController();
      const firstIterator = agentSdk.subscriptions.stream("subscription_sse", { partitionId: direct.partition_id }, { signal: firstAbort.signal })[Symbol.asyncIterator]();
      const first = await firstIterator.next();
      if (first.done) throw new TypeError("expected first SSE delivery");
      firstAbort.abort();
      await firstIterator.next();

      const replayAbort = new AbortController();
      const replayIterator = agentSdk.subscriptions.stream("subscription_sse", { partitionId: direct.partition_id, cursor: first.value.next_cursor }, { signal: replayAbort.signal })[Symbol.asyncIterator]();
      const replayed = await replayIterator.next();
      if (replayed.done) throw new TypeError("expected replayed SSE delivery");
      expect(replayed.value).toEqual(first.value);
      await agentSdk.subscriptions.acknowledgeDelivery(replayed.value, "acknowledged");
      const continued = await replayIterator.next();
      if (continued.done) throw new TypeError("expected continued SSE delivery");
      expect(continued.value.next_cursor).not.toBe(first.value.next_cursor);
      replayAbort.abort();
      await replayIterator.next();

      await expect(humanSdk.operations.getLiveness()).resolves.toEqual({ status: "live" });
      await expect(humanSdk.operations.getReadiness()).resolves.toEqual({ status: "ready" });
      await expect(humanSdk.operations.getHealth()).resolves.toMatchObject({ status: "ready", dependencies: [{ dependency_id: "exchange", status: "healthy" }] });
    } finally {
      await service.close();
    }
  }, 10_000);
});
