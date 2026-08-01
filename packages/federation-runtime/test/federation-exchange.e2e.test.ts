import { generateKeyPairSync } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import { MemoryFederationReplayStore } from "@work-fabric/adapter-federation-memory";
import {
  NodeEd25519FederationSigner,
  NodeEd25519FederationTrustResolver,
} from "@work-fabric/adapter-federation-node-crypto";
import { LocalIdentityProvider } from "@work-fabric/adapter-identity-local";
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import { ExchangeApplication, type Clock, type IdGenerator } from "@work-fabric/exchange-core";
import {
  HandoffProjector,
  MemoryHandoffReadModelStore,
  MemorySubscriptionStore,
} from "@work-fabric/exchange-runtime";
import type {
  AuthorityPolicy,
  CapabilityManifest,
  ResolvedPrincipal,
} from "@work-fabric/exchange-spi";
import type {
  FederationIdGenerator,
  FederationTransferBridge,
  FederationTransferReceipt,
} from "@work-fabric/federation-spi";
import {
  loadWfppCommandValidator,
  loadWfppSchemaValidator,
  type WfppCommandValidator,
  type WfppSchemaValidator,
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
} from "@work-fabric/transport-http";

import { FederationEnvelopeCodec, FederationGateway } from "../src/index.js";

const tenantId = "tenant_federation_e2e";
const now = "2026-07-16T09:00:00.000Z";
const clock = { now: () => now };
let validator: WfppCommandValidator;
let schemas: WfppSchemaValidator;

beforeAll(async () => {
  schemas = await loadWfppSchemaValidator("protocol/schemas/v1");
  validator = await loadWfppCommandValidator(
    schemas,
    "protocol/spec/interaction-payloads.json",
  );
});

class AllowAuthority implements AuthorityPolicy {
  readonly manifest: CapabilityManifest = {
    profile: "exchange.authority.v1",
    adapter: "federation-e2e-allow",
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
      actor_type: "system",
      endpoint_ids: [`endpoint_${exchangeId}`],
    }],
    attributes: {},
  };
}

async function startExchange(exchangeId: string) {
  const persistence = new MemoryExchangePersistence();
  const subscriptions = new MemorySubscriptionStore();
  const models = new MemoryHandoffReadModelStore();
  const identity = new LocalIdentityProvider([{
    authentication_evidence: { bearer_token: exchangeId },
    principal: principal(exchangeId),
  }]);
  const authority = new AllowAuthority();
  const exchangeClock: Clock = clock;
  const ids = new ExchangeIds(exchangeId);
  const application = new ExchangeApplication({
    persistence,
    identity,
    authority,
    context: new MemoryContextRepository(),
    validator,
    clock: exchangeClock,
    ids,
  });
  const projector = new HandoffProjector(
    persistence,
    persistence,
    persistence,
    models,
    exchangeClock,
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
    getContextBundle: stored.getContextBundle.bind(stored),
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
  const service = createHttpService({
    application,
    authenticator: new BearerAuthenticationEvidenceMapper(),
    identity,
    authority,
    query,
    subscriptions,
    schemas,
  }, normalizeHttpServiceConfig({ default_page_limit: 10, max_page_limit: 20 }));
  const { origin } = await service.listen({ host: "127.0.0.1", port: 0 });
  let message = 0;
  const client = new WorkFabricClient({
    baseUrl: origin,
    tenantId,
    exchangeId,
    representation: {
      actorId: `actor_${exchangeId}`,
      endpointId: `endpoint_${exchangeId}`,
    },
    authentication: new BearerTokenProvider(exchangeId),
    clock,
    messageIdGenerator: {
      nextMessageId: () => `message_${exchangeId}_${++message}`,
    },
  });
  return { client, persistence, service };
}

function offer(targetActor: string, uri: string): HandoffOfferPayload {
  return {
    work_reference: { uri, extensions: {} },
    target: { actor_id: targetActor },
    intent: [{
      kind: "text",
      media_type: "text/plain",
      text: "Responsibility is performed outside Work Fabric",
    }],
    authority_scope: {
      delegation_id: "delegation_federation_e2e",
      scopes: ["work:read", "result:write"],
      resource_refs: [uri],
      expires_at: "2026-07-17T09:00:00.000Z",
      may_redelegate: false,
    },
    acceptance_criteria: [{
      criterion_id: "receipt-recorded",
      description: "Target Exchange records the local Handoff",
      required: true,
      result_schema_ref: null,
      required_evidence_types: ["operation_receipt"],
    }],
    verifier: { actor_id: `verifier_${targetActor}`, actor_type: "human" },
    priority: "normal",
    accept_by: "2026-07-16T10:00:00.000Z",
    result_due_at: "2026-07-17T09:00:00.000Z",
  };
}

describe("Federation two-Exchange public SDK proof", () => {
  it("keeps each Exchange authoritative only for its local Handoff", async () => {
    const source = await startExchange("exchange_a");
    const target = await startExchange("exchange_b");
    try {
      const sourceOffer = offer("actor_exchange_a", "urn:work:federation:e2e");
      const sourceResult = await source.client.handoffs.offer(sourceOffer, {
        idempotencyKey: "source-local-offer",
      });
      const sourceHandoffId = sourceResult.resource?.resource_id;
      if (typeof sourceHandoffId !== "string") throw new Error("source offer failed");

      let targetBridgeCalls = 0;
      const targetBridge: FederationTransferBridge = {
        async offerInbound(input) {
          targetBridgeCalls += 1;
          const result = await target.client.handoffs.offer(
            input.offer.handoff_offer as HandoffOfferPayload,
            { idempotencyKey: input.transfer_id },
          );
          const resourceId = result.resource?.resource_id;
          const resourceVersion = result.resource?.resource_version;
          if (
            result.operation_status !== "accepted" ||
            typeof resourceId !== "string" ||
            !Number.isSafeInteger(resourceVersion) ||
            (resourceVersion as number) < 1
          ) {
            return { decision: "rejected", reason_code: "target_exchange_rejected" };
          }
          return {
            decision: "accepted",
            target_handoff_id: resourceId,
            target_resource_version: resourceVersion as number,
          };
        },
        async applyOutboundReceipt() {
          throw new Error("target does not apply its own receipt");
        },
      };
      const appliedReceipts: FederationTransferReceipt[] = [];
      const sourceBridge: FederationTransferBridge = {
        async offerInbound() {
          throw new Error("source does not receive this offer");
        },
        async applyOutboundReceipt(input) {
          // The source deployment correlates through its public read contract;
          // the signed receipt does not overwrite the target's local record.
          await source.client.queries.getHandoff(sourceHandoffId);
          appliedReceipts.push(structuredClone(input.receipt));
        },
      };

      const keyA = generateKeyPairSync("ed25519");
      const keyB = generateKeyPairSync("ed25519");
      const gatewayA = new FederationGateway({
        local_exchange_id: "exchange_a",
        codec: new FederationEnvelopeCodec({
          local_exchange_id: "exchange_a",
          signer: new NodeEd25519FederationSigner("key-a", keyA.privateKey),
          trust: new NodeEd25519FederationTrustResolver([{
            source_exchange_id: "exchange_b",
            target_exchange_id: "exchange_a",
            key_id: "key-b",
            public_key: keyB.publicKey,
          }]),
          clock,
        }),
        replay_store: new MemoryFederationReplayStore({ max_records: 10, clock }),
        bridge: sourceBridge,
        clock,
        ids: federationIds("a"),
      });
      const gatewayB = new FederationGateway({
        local_exchange_id: "exchange_b",
        codec: new FederationEnvelopeCodec({
          local_exchange_id: "exchange_b",
          signer: new NodeEd25519FederationSigner("key-b", keyB.privateKey),
          trust: new NodeEd25519FederationTrustResolver([{
            source_exchange_id: "exchange_a",
            target_exchange_id: "exchange_b",
            key_id: "key-a",
            public_key: keyA.publicKey,
          }]),
          clock,
        }),
        replay_store: new MemoryFederationReplayStore({ max_records: 10, clock }),
        bridge: targetBridge,
        clock,
        ids: federationIds("b"),
      });

      const prepared = await gatewayA.prepareOutbound({
        target_exchange_id: "exchange_b",
        source_handoff_id: sourceHandoffId,
        source_thread_id: "thread_federation_e2e",
        source_resource_version: 1,
        handoff_offer: offer("actor_exchange_b", "urn:work:federation:e2e"),
      });
      const receipt = await gatewayB.receiveOffer(prepared.request);
      expect(await gatewayB.receiveOffer(prepared.request)).toEqual(receipt);
      const delivered = await gatewayA.deliverOutbound(prepared, {
        exchange: async () => receipt,
      });
      expect(delivered).toMatchObject({ outcome: "accepted" });
      if (delivered.outcome !== "accepted") throw new Error("transfer not accepted");
      expect(targetBridgeCalls).toBe(1);
      expect(appliedReceipts).toHaveLength(1);
      expect(await source.client.queries.getHandoff(sourceHandoffId))
        .toMatchObject({ handoff_id: sourceHandoffId });
      expect(await target.client.queries.getHandoff(delivered.target_handoff_id))
        .toMatchObject({ handoff_id: delivered.target_handoff_id });
      expect(await source.persistence.readStream(delivered.target_handoff_id)).toEqual([]);
      expect(await target.persistence.readStream(sourceHandoffId)).toEqual([]);
    } finally {
      await Promise.all([source.service.close(), target.service.close()]);
    }
  }, 15_000);
});
