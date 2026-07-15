import { beforeAll, describe, expect, it } from "vitest";

import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import {
  LocalAuthorityPolicy,
  LocalIdentityProvider,
  type LocalAuthorityAllowRule,
} from "@work-fabric/adapter-identity-local";
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import {
  ExchangeApplication,
  type Clock,
  type CommandEnvelope,
  type IdGenerator,
} from "@work-fabric/exchange-core";
import {
  CursorPullService,
  DefaultSubscriptionDeliveryPolicy,
  HandoffProjector,
  MemoryHandoffReadModelStore,
  MemorySubscriptionStore,
  OpaqueCursorCodec,
} from "@work-fabric/exchange-runtime";
import type {
  JsonObject,
  ResolvedPrincipal,
  TargetEligibilityVerifier,
} from "@work-fabric/exchange-spi";
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
} from "../src/index.js";

const tenantId = "tenant_http_reference";
const exchangeId = "exchange_http_reference";
const human = principal("principal_human", "actor_human", "human", "endpoint_human");
const agent = principal("principal_agent", "actor_agent", "agent", "endpoint_agent");
const resolver = principal("principal_resolver", "actor_resolver", "system", "endpoint_resolver");

function principal(
  principalId: string,
  actorId: string,
  actorType: "human" | "agent" | "system",
  endpointId: string,
): ResolvedPrincipal {
  return {
    principal_id: principalId,
    tenant_id: tenantId,
    actor_claims: [{ actor_id: actorId, actor_type: actorType, endpoint_ids: [endpointId] }],
    attributes: {},
  };
}

function rule(
  subject: ResolvedPrincipal,
  action: string,
  resourceId: string | null,
): LocalAuthorityAllowRule {
  const claim = subject.actor_claims[0];
  const endpointId = claim?.endpoint_ids[0];
  if (claim === undefined || endpointId === undefined) throw new Error("invalid principal fixture");
  return {
    tenant_id: tenantId,
    principal_id: subject.principal_id,
    actor_id: claim.actor_id,
    actor_type: claim.actor_type,
    endpoint_id: endpointId,
    action,
    resource_id: resourceId,
  };
}

class ReferenceClock implements Clock {
  now(): string {
    return "2026-07-15T09:00:00.000Z";
  }
}

class ReferenceIds implements IdGenerator {
  private readonly counts = new Map<string, number>();

  nextId(kind: "handoff" | "event" | "commit" | "receipt" | "delivery") {
    const next = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, next);
    return `${kind}_http_${next}`;
  }
}

const baseOffer: JsonObject = {
  work_reference: { uri: "feishu://document/http-reference-requirements", extensions: {} },
  target: { actor_id: "actor_agent" },
  intent: [{ kind: "text", media_type: "text/plain", text: "Implement outside Work Fabric" }],
  authority_scope: {
    delegation_id: "delegation_http",
    scopes: ["work:read", "result:write"],
    resource_refs: ["feishu://document/http-reference-requirements"],
    expires_at: "2026-07-16T09:00:00.000Z",
    may_redelegate: false,
  },
  acceptance_criteria: [{
    criterion_id: "tests-pass",
    description: "The external implementation tests pass",
    required: true,
    result_schema_ref: null,
    required_evidence_types: ["test_report"],
  }],
  verifier: { actor_id: "actor_human", actor_type: "human" },
  priority: "normal",
  accept_by: "2026-07-15T10:00:00.000Z",
  result_due_at: "2026-07-16T09:00:00.000Z",
};

function command(
  interaction: string,
  subject: "human" | "agent" | "resolver",
  payload: JsonObject,
  options: { expectedVersion?: number; key?: string; messageId?: string } = {},
): CommandEnvelope {
  const actor = subject === "human" ? human : subject === "agent" ? agent : resolver;
  const claim = actor.actor_claims[0];
  const endpointId = claim?.endpoint_ids[0];
  if (claim === undefined || endpointId === undefined) throw new Error("invalid command fixture");
  return {
    spec_version: "1.0",
    message_id: options.messageId ?? `message_${interaction}_${subject}`,
    message_type: `workfabric.handoff.${interaction}.v1`,
    sent_at: "2026-07-15T09:00:00.000Z",
    tenant_id: tenantId,
    exchange_id: exchangeId,
    actor_id: claim.actor_id,
    endpoint_id: endpointId,
    delegation_id: "delegation_http",
    idempotency_key: options.key ?? `${interaction}-${subject}`,
    ...(options.expectedVersion === undefined ? {} : { expected_version: options.expectedVersion }),
    payload,
  };
}

let validator: WfppCommandValidator;
let schemas: WfppSchemaValidator;

beforeAll(async () => {
  schemas = await loadWfppSchemaValidator("protocol/schemas/v1");
  validator = await loadWfppCommandValidator(
    schemas,
    "protocol/spec/interaction-payloads.json",
  );
});

function clientHeaders(token: string, subject: ResolvedPrincipal) {
  const claim = subject.actor_claims[0];
  const endpointId = claim?.endpoint_ids[0];
  if (claim === undefined || endpointId === undefined) throw new Error("invalid client fixture");
  return {
    authorization: `Bearer ${token}`,
    "x-wf-actor-id": claim.actor_id,
    "x-wf-endpoint-id": endpointId,
  };
}

async function jsonRequest(origin: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${origin}${path}`, options);
  return { response, body: await response.json() as Record<string, unknown> };
}

async function readSseFrame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 1_000;
  while (!text.includes("\n\n")) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out reading SSE frame: ${text}`);
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out reading SSE frame: ${text}`)), remaining),
      ),
    ]);
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
  }
  const frame = text.split("\n\n")[0] ?? "";
  const id = frame.match(/^id: (.+)$/m)?.[1];
  const data = frame.match(/^data: (.+)$/m)?.[1];
  if (id === undefined || data === undefined) throw new Error(`invalid SSE frame: ${frame}`);
  return { id, data: JSON.parse(data) as Record<string, unknown> };
}

describe("Phase 3B public HTTP reference", () => {
  it("coordinates direct and capability-targeted handoffs through one public surface", async () => {
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
    const directId = "handoff_http_1";
    const capabilityId = "handoff_http_2";
    const rules = [
      rule(human, "workfabric.handoff.offer.v1", null),
      rule(agent, "workfabric.handoff.accept.v1", directId),
      rule(agent, "workfabric.handoff.accept.v1", capabilityId),
      rule(resolver, "workfabric.handoff.resolve_target.v1", capabilityId),
      rule(human, "workfabric.query.handoff.read.v1", directId),
      rule(human, "workfabric.query.handoff.read.v1", capabilityId),
      ...["subscription_cursor", "subscription_sse"].flatMap((subscriptionId) => [
        rule(agent, "workfabric.subscription.manage.v1", subscriptionId),
        rule(agent, "workfabric.subscription.pull.v1", subscriptionId),
        rule(agent, "workfabric.subscription.ack.v1", subscriptionId),
        rule(agent, "workfabric.subscription.stream.v1", subscriptionId),
      ]),
      rule(human, "workfabric.operations.health.read.v1", null),
    ];
    const authority = new LocalAuthorityPolicy(rules);
    const targetEligibility: TargetEligibilityVerifier = {
      manifest: {
        profile: "exchange.target-eligibility.v1",
        adapter: "http-reference",
        capabilities: {
          explicit_target_only: true,
          no_candidate_selection: true,
          fail_closed: true,
        },
      },
      async verify() { return { kind: "eligible" }; },
    };
    const application = new ExchangeApplication({
      persistence,
      identity: identities,
      authority,
      context: new MemoryContextRepository(),
      validator,
      clock,
      ids,
      target_eligibility: targetEligibility,
    });
    const projector = new HandoffProjector(
      persistence,
      persistence,
      persistence,
      models,
      clock,
    );
    const storedQueries = new StoreBackedExchangeQueryService(
      persistence,
      models,
      subscriptions,
      persistence,
      persistence,
    );
    const query: ExchangeQueryService = {
      ...storedQueries,
      async getHandoff(requestTenantId, handoffId) {
        const records = await persistence.readStream(handoffId);
        const partitionId = records[0]?.partition_id;
        if (partitionId !== undefined) await projector.runPartition(partitionId, 100);
        return storedQueries.getHandoff(requestTenantId, handoffId);
      },
      readHandoffEvents: storedQueries.readHandoffEvents.bind(storedQueries),
      listPartitionHandoffs: storedQueries.listPartitionHandoffs.bind(storedQueries),
      readPartitionEvents: storedQueries.readPartitionEvents.bind(storedQueries),
      getSubscription: storedQueries.getSubscription.bind(storedQueries),
      listSubscriptions: storedQueries.listSubscriptions.bind(storedQueries),
      listProjectionFailures: storedQueries.listProjectionFailures.bind(storedQueries),
      listDeliveryAttempts: storedQueries.listDeliveryAttempts.bind(storedQueries),
      getDeliveryPosition: storedQueries.getDeliveryPosition.bind(storedQueries),
    };
    const delivery = new CursorPullService(
      persistence,
      persistence,
      subscriptions,
      new DefaultSubscriptionDeliveryPolicy(),
      clock,
      ids,
      new OpaqueCursorCodec(
        new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
      ),
      schemas,
      30,
    );
    const service = createHttpService(
      {
        application,
        authenticator: new BearerAuthenticationEvidenceMapper(),
        identity: identities,
        authority,
        query,
        subscriptions,
        schemas,
        delivery,
        health_probes: [
          { dependency_id: "exchange", async check() { return "healthy"; } },
        ],
      },
      normalizeHttpServiceConfig({
        default_page_limit: 10,
        max_page_limit: 20,
        sse_poll_interval_ms: 5,
        sse_heartbeat_interval_ms: 25,
        sse_idle_timeout_ms: 1_000,
      }),
    );
    const { origin } = await service.listen({ host: "127.0.0.1", port: 0 });
    const humanHeaders = clientHeaders("human", human);
    const agentHeaders = clientHeaders("agent", agent);
    const resolverHeaders = clientHeaders("resolver", resolver);

    try {
      const directOffer = command("offer", "human", baseOffer, {
        key: "direct-offer",
        messageId: "message_direct_offer",
      });
      const offered = await jsonRequest(origin, "/v1/commands", {
        method: "POST",
        headers: { authorization: "Bearer human", "content-type": "application/json" },
        body: JSON.stringify(directOffer),
      });
      expect(offered.response.status).toBe(200);
      expect(offered.body).toMatchObject({
        operation_status: "accepted",
        resource: { resource_id: directId, resource_version: 1 },
      });
      const replayed = await jsonRequest(origin, "/v1/commands", {
        method: "POST",
        headers: { authorization: "Bearer human", "content-type": "application/json" },
        body: JSON.stringify({ ...directOffer, message_id: "message_direct_offer_replay" }),
      });
      expect(replayed.body).toMatchObject({
        operation_status: "accepted",
        request_message_id: "message_direct_offer_replay",
        resource: { resource_id: directId, resource_version: 1 },
      });

      const conflict = await jsonRequest(origin, "/v1/commands", {
        method: "POST",
        headers: { authorization: "Bearer agent", "content-type": "application/json" },
        body: JSON.stringify(command("accept", "agent", { handoff_id: directId }, {
          expectedVersion: 9,
          key: "direct-accept-conflict",
        })),
      });
      expect(conflict.response.status).toBe(409);
      expect(conflict.body).toMatchObject({ operation_status: "conflict" });
      const acceptedDirect = await jsonRequest(origin, "/v1/commands", {
        method: "POST",
        headers: { authorization: "Bearer agent", "content-type": "application/json" },
        body: JSON.stringify(command("accept", "agent", { handoff_id: directId }, {
          expectedVersion: 1,
          key: "direct-accept",
        })),
      });
      expect(acceptedDirect.body).toMatchObject({
        operation_status: "accepted",
        resource: { resource_id: directId, resource_version: 2 },
      });

      const capabilityOffer = command("offer", "human", {
        ...baseOffer,
        target: {
          capability_requirement: {
            capability_id: "software.implementation",
            version_constraint: ">=1.0.0 <2.0.0",
            input_media_types: ["text/markdown"],
          },
        },
      }, { key: "capability-offer", messageId: "message_capability_offer" });
      const capabilityOffered = await jsonRequest(origin, "/v1/commands", {
        method: "POST",
        headers: { authorization: "Bearer human", "content-type": "application/json" },
        body: JSON.stringify(capabilityOffer),
      });
      expect(capabilityOffered.body).toMatchObject({
        operation_status: "accepted",
        resource: { resource_id: capabilityId, resource_version: 1 },
      });
      const resolved = await jsonRequest(origin, "/v1/commands", {
        method: "POST",
        headers: { authorization: "Bearer resolver", "content-type": "application/json" },
        body: JSON.stringify(command("resolve_target", "resolver", {
          handoff_id: capabilityId,
          resolved_target: { actor_id: "actor_agent" },
          evidence: [],
        }, { expectedVersion: 1, key: "capability-resolve" })),
      });
      expect(resolved.body).toMatchObject({
        operation_status: "accepted",
        resource: { resource_id: capabilityId, resource_version: 2 },
      });
      const acceptedCapability = await jsonRequest(origin, "/v1/commands", {
        method: "POST",
        headers: { authorization: "Bearer agent", "content-type": "application/json" },
        body: JSON.stringify(command("accept", "agent", { handoff_id: capabilityId }, {
          expectedVersion: 2,
          key: "capability-accept",
        })),
      });
      expect(acceptedCapability.body).toMatchObject({ operation_status: "accepted" });

      const capabilityModel = await jsonRequest(origin, `/v1/handoffs/${capabilityId}`, {
        headers: humanHeaders,
      });
      expect(capabilityModel.response.status).toBe(200);
      expect(capabilityModel.body).toMatchObject({
        state: {
          package: {
            target: {
              capability_requirement: { capability_id: "software.implementation" },
            },
          },
          target_binding: { target: { actor_id: "actor_agent" } },
        },
      });
      const directModel = await jsonRequest(origin, `/v1/handoffs/${directId}`, {
        headers: humanHeaders,
      });
      const partitionId = (directModel.body.partition_id as string | undefined);
      expect(partitionId).toBeTypeOf("string");
      if (partitionId === undefined) throw new Error("missing direct partition");
      const safeEvents = await jsonRequest(origin, `/v1/handoffs/${directId}/events?limit=10`, {
        headers: humanHeaders,
      });
      expect(safeEvents.response.status).toBe(200);
      expect(JSON.stringify(safeEvents.body)).not.toMatch(
        /domain_data|partition_position|commit_id|idempotency_key/,
      );

      async function putSubscription(id: string, mode: "cursor_pull" | "sse") {
        return jsonRequest(origin, `/v1/subscriptions/${id}`, {
          method: "PUT",
          headers: { ...agentHeaders, "content-type": "application/json" },
          body: JSON.stringify({
            subscription_id: id,
            owner: { actor_id: "actor_agent", actor_type: "agent" },
            endpoint_id: "endpoint_agent",
            filter: {
              event_types: [], actor_ids: [], endpoint_ids: [], thread_ids: [],
              handoff_ids: [directId], work_reference_uris: [], capability_ids: [],
              lifecycle_states: [],
            },
            delivery: { mode },
            state: "active",
            cursor: null,
            created_at: "2026-07-15T08:00:00.000Z",
            updated_at: "2026-07-15T08:00:00.000Z",
          }),
        });
      }
      expect((await putSubscription("subscription_cursor", "cursor_pull")).response.status).toBe(200);
      expect((await putSubscription("subscription_sse", "sse")).response.status).toBe(200);

      const pulled = await jsonRequest(origin, "/v1/subscriptions/subscription_cursor/pull", {
        method: "POST",
        headers: { ...agentHeaders, "content-type": "application/json" },
        body: JSON.stringify({ partition_id: partitionId, cursor: null, limit: 10 }),
      });
      expect(pulled.response.status).toBe(200);
      expect(pulled.body).toMatchObject({ kind: "delivery" });
      const pulledDelivery = pulled.body.delivery as Record<string, unknown>;
      const pulledEvents = pulledDelivery.events as readonly Record<string, unknown>[];
      expect(pulledEvents.length).toBeGreaterThan(0);
      const pullAck = await jsonRequest(origin, "/v1/subscriptions/subscription_cursor/ack", {
        method: "POST",
        headers: { ...agentHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          delivery_id: pulledDelivery.delivery_id,
          subscription_id: "subscription_cursor",
          outcome: "acknowledged",
          acknowledged_at: "2026-07-15T09:00:10.000Z",
          cursor: pulledDelivery.next_cursor,
        }),
      });
      expect(pullAck.body).toMatchObject({ kind: "acknowledged" });

      const firstController = new AbortController();
      const firstStream = await fetch(
        `${origin}/v1/subscriptions/subscription_sse/events?partition_id=${encodeURIComponent(partitionId)}`,
        { headers: agentHeaders, signal: firstController.signal },
      );
      expect(firstStream.status).toBe(200);
      const firstReader = firstStream.body?.getReader();
      if (firstReader === undefined) throw new Error("missing first SSE stream");
      const firstFrame = await readSseFrame(firstReader);
      expect(firstFrame.data).toMatchObject({
        delivery_id: expect.any(String),
        events: [{ id: expect.any(String) }],
      });
      firstController.abort();

      const replayController = new AbortController();
      const replayStream = await fetch(
        `${origin}/v1/subscriptions/subscription_sse/events?partition_id=${encodeURIComponent(partitionId)}`,
        {
          headers: { ...agentHeaders, "last-event-id": firstFrame.id },
          signal: replayController.signal,
        },
      );
      const replayReader = replayStream.body?.getReader();
      if (replayReader === undefined) throw new Error("missing replay SSE stream");
      const replayFrame = await readSseFrame(replayReader);
      expect(replayFrame).toEqual(firstFrame);
      const sseAck = await jsonRequest(origin, "/v1/subscriptions/subscription_sse/ack", {
        method: "POST",
        headers: { ...agentHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          delivery_id: firstFrame.data.delivery_id,
          subscription_id: "subscription_sse",
          outcome: "acknowledged",
          acknowledged_at: "2026-07-15T09:00:10.000Z",
          cursor: firstFrame.id,
        }),
      });
      expect(sseAck.body).toMatchObject({ kind: "acknowledged" });
      const continuedFrame = await readSseFrame(replayReader);
      expect(continuedFrame.id).not.toBe(firstFrame.id);
      replayController.abort();

      const live = await jsonRequest(origin, "/health/live");
      const ready = await jsonRequest(origin, "/health/ready");
      const health = await jsonRequest(origin, "/v1/admin/health", { headers: humanHeaders });
      expect(live.body).toEqual({ status: "live" });
      expect(ready.body).toEqual({ status: "ready" });
      expect(health.body).toMatchObject({
        status: "ready",
        dependencies: [{ dependency_id: "exchange", status: "healthy" }],
      });
    } finally {
      await service.close();
    }
  });
});
