import { createCipheriv, createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";
import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import {
  LocalAuthorityPolicy,
  LocalIdentityProvider,
  type LocalAuthorityAllowRule,
} from "@work-fabric/adapter-identity-local";
import { MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import {
  ConnectorReconciliationService,
  ConnectorWorker,
  type ConnectorDiscrepancy,
} from "@work-fabric/connector-runtime";
import type { ConnectorObservationSink } from "@work-fabric/connector-spi";
import {
  ExchangeApplication,
  type Clock,
  type IdGenerator,
} from "@work-fabric/exchange-core";
import {
  DefaultSubscriptionDeliveryPolicy,
  MemorySubscriptionStore,
  SignalDispatcher,
} from "@work-fabric/exchange-runtime";
import type {
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
  BearerTokenProvider,
  ConnectorSdkCommandSink,
  WorkFabricClient,
  type HandoffOfferPayload,
} from "@work-fabric/sdk-typescript";
import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
} from "@work-fabric/transport-http";

import {
  FeishuActionReferenceCodec,
  FeishuEventMapper,
  FeishuEventRenderer,
  FeishuIdentityMapper,
  FeishuDocumentResourceResolver,
  FeishuSignalAdapter,
  createFeishuDocxReference,
  type FeishuMessageClient,
  type FeishuSendMessageInput,
} from "../src/index.js";

const tenantId = "tenant_feishu_roundtrip";
const exchangeId = "exchange_feishu_roundtrip";
const handoffId = "handoff_roundtrip_1";
const actionKey = new Uint8Array(32).fill(7);

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

const admin = principal("principal_admin", "actor_admin", "human", "endpoint_admin");
const worker = principal("principal_worker", "actor_worker", "human", "endpoint_feishu");

function rule(
  subject: ResolvedPrincipal,
  action: string,
  resourceId: string | null,
): LocalAuthorityAllowRule {
  const claim = subject.actor_claims[0]!;
  return {
    tenant_id: tenantId,
    principal_id: subject.principal_id,
    actor_id: claim.actor_id,
    actor_type: claim.actor_type,
    endpoint_id: claim.endpoint_ids[0]!,
    action,
    resource_id: resourceId,
  };
}

class FixedClock implements Clock {
  now(): string { return "2026-07-16T00:00:00Z"; }
}

class RoundtripIds implements IdGenerator {
  private readonly counts = new Map<string, number>();
  nextId(kind: "handoff" | "event" | "commit" | "receipt" | "delivery") {
    const next = (this.counts.get(kind) ?? 0) + 1;
    this.counts.set(kind, next);
    return `${kind}_roundtrip_${next}`;
  }
}

class RecordingMessages implements FeishuMessageClient {
  readonly inputs: FeishuSendMessageInput[] = [];
  async sendMessage(input: FeishuSendMessageInput) {
    this.inputs.push(structuredClone(input));
    return { kind: "accepted" as const, message_id: `om-${this.inputs.length}` };
  }
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

function client(origin: string, token: string, actorId: string, endpointId: string) {
  let messages = 0;
  return new WorkFabricClient({
    baseUrl: origin,
    authentication: new BearerTokenProvider(token),
    representation: { actorId, endpointId },
    tenantId,
    exchangeId,
    clock: new FixedClock(),
    messageIdGenerator: { nextMessageId: () => `message-roundtrip-${++messages}` },
  });
}

function encrypt(value: unknown, encryptKey: string): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const iv = Buffer.from("0123456789abcdef", "utf8");
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]).toString("base64");
}

describe("Feishu Connector roundtrip", () => {
  it("connects offer, card, durable ingress, SDK accept, and outbound status without executing work", async () => {
    const persistence = new MemoryExchangePersistence();
    const subscriptions = new MemorySubscriptionStore();
    const ingress = new MemoryConnectorIngressStore();
    const identities = new LocalIdentityProvider([
      { authentication_evidence: { bearer_token: "admin" }, principal: admin },
      { authentication_evidence: { bearer_token: "connector" }, principal: worker },
    ]);
    const authority = new LocalAuthorityPolicy([
      rule(admin, "workfabric.handoff.offer.v1", null),
      rule(worker, "workfabric.handoff.accept.v1", handoffId),
    ]);
    const eligibility: TargetEligibilityVerifier = {
      manifest: {
        profile: "exchange.target-eligibility.v1",
        adapter: "roundtrip",
        capabilities: {
          explicit_target_only: true,
          no_candidate_selection: true,
          fail_closed: true,
        },
      },
      async verify() { return { kind: "eligible" }; },
    };
    const clock = new FixedClock();
    const application = new ExchangeApplication({
      persistence,
      identity: identities,
      authority,
      context: new MemoryContextRepository(),
      validator,
      clock,
      ids: new RoundtripIds(),
      target_eligibility: eligibility,
    });
    const encryptKey = "roundtrip-encrypt-key";
    const verificationToken = "roundtrip-verification";
    const service = createHttpService({
      application,
      authenticator: new BearerAuthenticationEvidenceMapper(),
      identity: identities,
      authority,
      schemas,
      feishu_webhook: {
        ingress,
        credential_provider: {
          async loadWebhookCredentials() {
            return {
              verification_token: verificationToken,
              encrypt_key: encryptKey,
            };
          },
        },
        binding_resolver: {
          async resolve(id) {
            return id === "primary" ? {
              route_connector_id: "primary",
              tenant_id: tenantId,
              connector_id: "feishu-primary",
              external_tenant_id: "tenant-key-1",
              credential_ref: "credential-ref-1",
            } : null;
          },
        },
        clock: {
          now: () => "2026-07-16T00:00:01Z",
          nowEpochSeconds: () => 1_784_160_001,
        },
      },
    }, normalizeHttpServiceConfig({}));
    const { origin } = await service.listen({ host: "127.0.0.1", port: 0 });
    const adminSdk = client(origin, "admin", "actor_admin", "endpoint_admin");
    const connectorSdk = client(
      origin,
      "connector",
      "actor_worker",
      "endpoint_feishu",
    );
    const messages = new RecordingMessages();
    const documentCredentialRefs: string[] = [];
    const documentResolver = new FeishuDocumentResourceResolver({
      async resolveWikiToken(_token, _signal, credentialReference) {
        documentCredentialRefs.push(credentialReference);
        return { document_id: "doccnRoundtrip" };
      },
      async getDocumentMetadata(documentId, _signal, credentialReference) {
        documentCredentialRefs.push(credentialReference);
        return {
          document_id: documentId,
          revision_id: "1",
          title: "Customer requirements",
        };
      },
      async getDocumentRawContent(_documentId, _signal, credentialReference) {
        documentCredentialRefs.push(credentialReference);
        return {
          content: "customer-confidential-body",
          media_type: "text/plain",
        };
      },
    }, {
      tenant_id: tenantId,
      connector_id: "feishu-primary",
      credential_ref: "credential-ref-1",
      authorize_content: async () => true,
      request_timeout_ms: 1_000,
      max_content_bytes: 1_024,
    });
    let nonce = 0;
    const renderer = new FeishuEventRenderer({
      action_codec: new FeishuActionReferenceCodec({
        encryption_key: actionKey,
        nonce_factory: () => new Uint8Array(12).fill(++nonce),
      }),
      clock,
      max_text_bytes: 150_000,
      max_card_bytes: 30_000,
    });
    const signal = new FeishuSignalAdapter({ messages, renderer });
    const dispatcher = new SignalDispatcher(
      persistence,
      persistence,
      subscriptions,
      new DefaultSubscriptionDeliveryPolicy(),
      signal,
      clock,
      { base_delay_seconds: 1, max_delay_seconds: 10 },
      schemas,
    );

    try {
      const sourceDocument = createFeishuDocxReference({
        document_id: "doccnRoundtrip",
        revision_id: "1",
        title: "Customer requirements",
      });
      const metadataResolution = await documentResolver.resolve({
        tenant_id: tenantId,
        connector_id: "feishu-primary",
        reference: sourceDocument,
        purpose: "metadata",
        max_bytes: 1_024,
      });
      expect(metadataResolution).toMatchObject({
        kind: "available",
        reference: { version: "1" },
      });
      const contentResolution = await documentResolver.resolve({
        tenant_id: tenantId,
        connector_id: "feishu-primary",
        reference: sourceDocument,
        purpose: "context",
        max_bytes: 1_024,
      });
      expect(contentResolution).toMatchObject({
        kind: "available",
        content: "customer-confidential-body",
      });
      expect(documentCredentialRefs).toEqual([
        "credential-ref-1",
        "credential-ref-1",
        "credential-ref-1",
      ]);
      const offer: HandoffOfferPayload = {
        work_reference: {
          uri: sourceDocument.uri,
          extensions: {},
        },
        target: { actor_id: "actor_worker" },
        intent: [{
          kind: "text",
          media_type: "text/plain",
          text: "External participant performs the work",
        }],
        authority_scope: {
          delegation_id: "delegation-roundtrip",
          scopes: ["work:read"],
          resource_refs: [sourceDocument.uri],
          expires_at: "2026-07-17T00:00:00Z",
          may_redelegate: false,
        },
        acceptance_criteria: [{
          criterion_id: "external-result",
          description: "External result is returned",
          required: true,
          result_schema_ref: null,
          required_evidence_types: [],
        }],
        verifier: { actor_id: "actor_admin", actor_type: "human" },
        priority: "normal",
        accept_by: "2026-07-16T01:00:00Z",
        result_due_at: "2026-07-17T00:00:00Z",
      };
      await expect(adminSdk.handoffs.offer(offer, {
        idempotencyKey: "roundtrip-offer",
      })).resolves.toMatchObject({
        operation_status: "accepted",
        resource: { resource_id: handoffId, resource_version: 1 },
      });
      const records = await persistence.readStream(handoffId);
      const partitionId = records[0]!.partition_id;
      await subscriptions.putSubscription({
        subscription_id: "subscription-feishu",
        tenant_id: tenantId,
        owner: { actor_id: "actor_worker", actor_type: "human" },
        endpoint_id: "endpoint_feishu",
        filter: {
          event_types: [],
          actor_ids: [],
          endpoint_ids: [],
          thread_ids: [],
          handoff_ids: [handoffId],
          work_reference_uris: [],
          capability_ids: [],
          lifecycle_states: [],
        },
        destination: {
          destination_id: "feishu-worker",
          binding: "feishu",
          configuration: {
            credential_ref: "credential-ref-1",
            connector_id: "feishu-primary",
            external_tenant_id: "tenant-key-1",
            actor_id: "actor_worker",
            actor_type: "human",
            endpoint_id: "endpoint_feishu",
            receive_id_type: "open_id",
            receive_id: "ou-worker",
            render_mode: "card",
            action_ttl_seconds: 600,
          },
        },
        delivery_mode: "webhook",
        state: "active",
        max_attempts: 3,
        created_at: "2026-07-16T00:00:00Z",
        updated_at: "2026-07-16T00:00:00Z",
      });
      await dispatcher.dispatchPartition(partitionId, tenantId, 10);
      expect(messages.inputs).toHaveLength(1);
      const card = JSON.parse(messages.inputs[0]!.content) as {
        body: { elements: Array<{ actions?: Array<{ value: { action_ref: string } }> }> };
      };
      const actionRef = card.body.elements[1]?.actions?.[0]?.value.action_ref;
      expect(actionRef).toMatch(/^wfaf2\./);

      const callback = {
        schema: "2.0",
        header: {
          event_id: "event-card-1",
          event_type: "card.action.trigger",
          create_time: "1784160000000",
          tenant_key: "tenant-key-1",
          token: verificationToken,
        },
        event: {
          operator: { operator_id: { open_id: "ou-worker" } },
          action: { value: { action_ref: actionRef }, tag: "button" },
          context: { open_message_id: "om-1" },
        },
      };
      const raw = JSON.stringify({ encrypt: encrypt(callback, encryptKey) });
      const timestamp = "1784160001";
      const nonceHeader = "callback-nonce";
      const signature = createHash("sha256")
        .update(timestamp)
        .update(nonceHeader)
        .update(encryptKey)
        .update(raw)
        .digest("hex");
      const webhookRequest = {
        method: "POST",
        url: "/v1/connectors/feishu/primary/events",
        headers: {
          "content-type": "application/json",
          "x-lark-request-timestamp": timestamp,
          "x-lark-request-nonce": nonceHeader,
          "x-lark-signature": signature,
        },
        payload: raw,
      } as const;
      const webhook = await service.dispatch(webhookRequest);
      expect(webhook.status_code).toBe(200);
      expect(webhook.json()).toMatchObject({ accepted: true, duplicate: false });
      const duplicateWebhook = await service.dispatch(webhookRequest);
      expect(duplicateWebhook.status_code).toBe(200);
      expect(duplicateWebhook.json()).toMatchObject({
        accepted: true,
        duplicate: true,
      });

      const identityResolver = new FeishuIdentityMapper(async (query) =>
        query.external_subject_id === "ou-worker"
          ? { actor_id: "actor_worker", actor_type: "human", endpoint_id: "endpoint_feishu" }
          : null,
      );
      const mapper = new FeishuEventMapper({
        participant_resolver: {
          async resolve(input) {
            const identity = await identityResolver.resolve({
              tenant_id: input.claim.envelope.tenant_id,
              connector_id: input.claim.envelope.connector_id,
              source_system: "feishu",
              external_tenant_id: input.claim.envelope.external_tenant_id,
              external_subject_type: "user",
              external_subject_id: input.external_subject_id,
            });
            return identity === null
              ? { kind: "denied", reason_code: "identity_unmapped" }
              : { kind: "resolved", identity };
          },
        },
        action_codec: new FeishuActionReferenceCodec({ encryption_key: actionKey }),
        clock: { now: () => "2026-07-16T00:05:00Z" },
      });
      const observationSink: ConnectorObservationSink = {
        manifest: {
          profile: "connector.observation-sink.v1",
          adapter: "roundtrip",
          capabilities: {},
        },
        async record() {
          return { kind: "accepted", receipt_id: "observation", event_ids: [] };
        },
      };
      const connectorWorker = new ConnectorWorker({
        store: ingress,
        mapper,
        command_sink: new ConnectorSdkCommandSink(connectorSdk),
        observation_sink: observationSink,
        clock: { now: () => "2026-07-16T00:00:02Z" },
        retry_policy: {
          nextAvailableAt: () => "2026-07-16T00:01:00Z",
        },
        scope: {
          tenant_id: tenantId,
          connector_id: "feishu-primary",
          worker_id: "connector-worker",
          lease_seconds: 30,
          batch_limit: 10,
          max_attempts: 3,
          max_error_detail_length: 256,
        },
      });
      await expect(connectorWorker.runBatch()).resolves.toMatchObject({
        claimed: 1,
        completed: 1,
      });
      const acceptedRecords = await persistence.readStream(handoffId);
      expect(acceptedRecords).toHaveLength(2);
      expect(acceptedRecords[1]?.event_type).toBe(
        "workfabric.handoff.accepted.v1",
      );
      await dispatcher.dispatchPartition(partitionId, tenantId, 10);
      expect(messages.inputs).toHaveLength(2);
      expect(messages.inputs[1]?.content).toContain("accepted");
      const discrepancies: ConnectorDiscrepancy[] = [];
      const reconciliation = new ConnectorReconciliationService({
        expected_state: {
          async getExpectedState() {
            return { resource_id: handoffId, state: "accepted", version: 2 };
          },
        },
        discrepancies: {
          async put(discrepancy) {
            discrepancies.push(structuredClone(discrepancy));
          },
        },
      });
      await expect(reconciliation.reconcile({
        tenant_id: tenantId,
        connector_id: "feishu-primary",
        external_object_id: "om-1",
        observed_state: "declined",
        observed_at: "2026-07-16T00:06:00Z",
        metadata: { source: "feishu_card" },
      })).resolves.toMatchObject({ kind: "discrepancy" });
      expect(discrepancies).toHaveLength(1);
      expect(JSON.stringify(acceptedRecords)).not.toContain("roundtrip-encrypt-key");
      expect(JSON.stringify(acceptedRecords)).not.toContain("roundtrip-verification");
      expect(JSON.stringify(acceptedRecords)).not.toContain("credential-ref-1");
      expect(JSON.stringify(acceptedRecords)).not.toContain(
        "customer-confidential-body",
      );
    } finally {
      await service.close();
    }
  }, 10_000);
});
