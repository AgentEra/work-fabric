import { describe, expect, it } from "vitest";

import { MemoryAdmissionDecisionStore, MemoryParticipantBindingStore } from "@work-fabric/adapter-admission-memory";
import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";
import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import { MemoryEndpointDirectoryStore, MemoryEndpointInboxStore } from "@work-fabric/adapter-endpoint-memory";
import { MemoryDiscrepancyStore, MemoryOperationsFixture, MemoryRecoveryStore } from "@work-fabric/adapter-operations-memory";
import { MemoryChannelRouteStore, MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import { MemoryHandoffReadModelStore, MemorySubscriptionStore } from "@work-fabric/exchange-runtime";
import { EndpointDirectoryService } from "@work-fabric/endpoint-directory";
import type { IdGenerator } from "@work-fabric/exchange-core";
import {
  BearerTokenProvider,
  WorkFabricClient,
  type HandoffOfferPayload,
} from "@work-fabric/sdk-typescript";

import {
  claimExpiryIdempotencyKey,
  composeNodeService,
  parseServiceConfig,
  type NodeStorageComposition,
} from "../src/index.js";

const runtime = {
  tenant_id: "tenant-local",
  principal_id: "principal-intake-agent",
  actor_id: "actor-intake-agent",
  endpoint_id: "endpoint-intake-agent",
  subscription_id: "subscription-intake-agent",
};

function handoffState(id: string, target: Record<string, string>) {
  return {
    handoff_id: id,
    thread_id: `thread:${id}`,
    resource_version: 1,
    lifecycle_state: "offered",
    initiator: { actor_id: "actor-initiator", actor_type: "human" },
    recipient: null,
    verifier: { actor_id: "actor-verifier", actor_type: "human" },
    current_responsible_actor: null,
    target_binding: null,
    package: {
      work_reference: { uri: "urn:work:item:1" },
      target,
      intent: [],
      context: null,
      authority_scope: {
        delegation_id: "delegation-runtime",
        scopes: [],
        resource_refs: [],
        expires_at: "2026-07-20T01:00:00.000Z",
        may_redelegate: false,
      },
      acceptance_criteria: [],
      verifier: { actor_id: "actor-verifier", actor_type: "human" },
      priority: "normal",
      accept_by: "2026-07-20T01:00:00.000Z",
      result_due_at: "2026-07-20T02:00:00.000Z",
    },
    result: null,
    parent_handoff_id: null,
    child_handoff_id: null,
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
  };
}

function storage(): NodeStorageComposition {
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
    admissionBindings: new MemoryParticipantBindingStore(),
    admissionDecisions: new MemoryAdmissionDecisionStore(),
    channelRoutes: new MemoryChannelRouteStore(),
    discrepancies: new MemoryDiscrepancyStore(),
    recoveries: new MemoryRecoveryStore(),
    sqlite: null,
  };
}

describe("Agent Runtime authority composition", () => {
  it("scopes mechanical expiry idempotency to the Handoff as well as the Claim fence", () => {
    expect(
      claimExpiryIdempotencyKey(
        "tenant-local",
        "handoff-a",
        "claim-shared",
        1,
      ),
    ).not.toBe(
      claimExpiryIdempotencyKey(
        "tenant-local",
        "handoff-b",
        "claim-shared",
        1,
      ),
    );
  });
  it("allows configured self and assigned-Handoff calls while making unknown and unassigned Handoffs indistinguishable", async () => {
    const owned = storage();
    await owned.handoffs.putHandoff({
      tenant_id: runtime.tenant_id,
      partition_id: "handoff:handoff-targeted",
      handoff_id: "handoff-targeted",
      stream_version: 1,
      state: handoffState("handoff-targeted", { actor_id: runtime.actor_id }),
      latest_status: null,
    });
    await owned.handoffs.putHandoff({
      tenant_id: runtime.tenant_id,
      partition_id: "handoff:handoff-unassigned",
      handoff_id: "handoff-unassigned",
      stream_version: 1,
      state: handoffState("handoff-unassigned", { actor_id: "actor-other" }),
      latest_status: null,
    });
    const service = await composeNodeService(parseServiceConfig({
      storage_profile: "postgres",
      tenant_id: runtime.tenant_id,
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      postgres: { connection_string: "postgres://deployment-owned" },
      identities: [{
        authentication_evidence: { bearer_token: "runtime-token" },
        principal: {
          principal_id: runtime.principal_id,
          tenant_id: runtime.tenant_id,
          actor_claims: [{ actor_id: runtime.actor_id, actor_type: "agent", endpoint_ids: [runtime.endpoint_id] }],
          attributes: { capabilities: ["workfabric.handoff.offer.v1"] },
        },
      }],
      authority_rules: [{
        tenant_id: runtime.tenant_id,
        principal_id: "unrelated-principal",
        actor_id: "unrelated-actor",
        actor_type: "human",
        endpoint_id: "unrelated-endpoint",
        action: "workfabric.operations.health.read.v1",
        resource_id: null,
      }],
      listen: { host: "127.0.0.1", port: 0 },
    }), {
      postgres_storage: owned,
      agent_runtime_authority: { grants: { "daily-assistant": runtime } },
    });
    const headers = {
      authorization: "Bearer runtime-token",
      "x-wf-actor-id": runtime.actor_id,
      "x-wf-endpoint-id": runtime.endpoint_id,
    };
    try {
      await expect(service.http.dispatch({
        method: "GET",
        url: "/v1/handoffs/handoff-targeted",
        headers,
      })).resolves.toMatchObject({ status_code: 200 });
      const unknown = await service.http.dispatch({ method: "GET", url: "/v1/handoffs/handoff-unknown", headers });
      const unassigned = await service.http.dispatch({ method: "GET", url: "/v1/handoffs/handoff-unassigned", headers });
      expect(unassigned.status_code).toBe(unknown.status_code);
      expect(unassigned.json()).toMatchObject({
        status: 403,
        code: "permission_denied",
        title: "The operation is not authorized",
      });
      expect(unknown.json()).toMatchObject({
        status: 403,
        code: "permission_denied",
        title: "The operation is not authorized",
      });
    } finally {
      await service.close();
    }
  });

  it("fails closed when a runtime directly Claims without a live matching Endpoint capability", async () => {
    const owned = storage();
    const handoffId = "handoff-ineligible-claim";
    let sequence = 0;
    const ids: IdGenerator = {
      nextId(kind) {
        sequence += 1;
        return kind === "handoff" ? handoffId : `${kind}_claim_${sequence}`;
      },
    };
    const clock = { now: () => "2026-07-27T00:00:00.000Z" };
    const human = {
      principal_id: "principal-human",
      actor_id: "actor-human",
      endpoint_id: "endpoint-human",
    };
    const service = await composeNodeService(parseServiceConfig({
      storage_profile: "postgres",
      tenant_id: runtime.tenant_id,
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      postgres: { connection_string: "postgres://deployment-owned" },
      identities: [
        {
          authentication_evidence: { bearer_token: "human-token" },
          principal: {
            principal_id: human.principal_id,
            tenant_id: runtime.tenant_id,
            actor_claims: [{
              actor_id: human.actor_id,
              actor_type: "human",
              endpoint_ids: [human.endpoint_id],
            }],
            attributes: {},
          },
        },
        {
          authentication_evidence: { bearer_token: "runtime-token" },
          principal: {
            principal_id: runtime.principal_id,
            tenant_id: runtime.tenant_id,
            actor_claims: [{
              actor_id: runtime.actor_id,
              actor_type: "agent",
              endpoint_ids: [runtime.endpoint_id],
            }],
            attributes: {},
          },
        },
      ],
      authority_rules: [{
        tenant_id: runtime.tenant_id,
        principal_id: human.principal_id,
        actor_id: human.actor_id,
        actor_type: "human",
        endpoint_id: human.endpoint_id,
        action: "workfabric.handoff.offer.v1",
        resource_id: null,
      }],
      listen: { host: "127.0.0.1", port: 0 },
    }), {
      postgres_storage: owned,
      agent_runtime_authority: { grants: { "daily-assistant": runtime } },
      ids,
      clock,
    });
    const { origin } = await service.listen();
    const client = (
      token: string,
      actorId: string,
      endpointId: string,
    ) => new WorkFabricClient({
      baseUrl: origin,
      tenantId: runtime.tenant_id,
      exchangeId: "exchange-local",
      representation: { actorId, endpointId },
      authentication: new BearerTokenProvider(token),
      clock,
    });
    const initiator = client("human-token", human.actor_id, human.endpoint_id);
    const claimant = client(
      "runtime-token",
      runtime.actor_id,
      runtime.endpoint_id,
    );
    const offer: HandoffOfferPayload = {
      thread_id: "thread-claim",
      work_reference: { uri: "urn:work:claim", extensions: {} },
      target: {
        capability_requirement: {
          capability_id: "software.implementation",
          assignment_mode: "eligible_pool_claim",
        },
      },
      intent: [{ kind: "text", media_type: "text/plain", text: "Implement" }],
      authority_scope: {
        delegation_id: "delegation-claim",
        scopes: ["work:read"],
        resource_refs: ["urn:work:claim"],
        expires_at: "2026-07-27T02:00:00.000Z",
        may_redelegate: false,
      },
      acceptance_criteria: [{
        criterion_id: "done",
        description: "Work is complete",
        required: true,
        result_schema_ref: null,
        required_evidence_types: [],
      }],
      verifier: { actor_id: human.actor_id, actor_type: "human" },
      priority: "normal",
      accept_by: "2026-07-27T01:00:00.000Z",
      result_due_at: "2026-07-27T02:00:00.000Z",
    };
    try {
      const offered = await initiator.handoffs.offer(
        offer,
        { idempotencyKey: "offer-claim" },
      );
      expect(
        offered,
        JSON.stringify(offered),
      ).toMatchObject({
        operation_status: "accepted",
        resource: { resource_id: handoffId, resource_version: 1 },
      });
      const record = (await owned.persistence.readStream(handoffId))[0]!;
      await service.runProjection(record.partition_id, 100);

      await expect(
        claimant.handoffs.claim(
          { handoff_id: handoffId, claim_id: "claim-ineligible" },
          { expectedVersion: 1, idempotencyKey: "claim-ineligible" },
        ),
      ).resolves.toMatchObject({
        operation_status: "rejected",
        error: { code: "permission_denied" },
      });
      expect(await owned.persistence.readStream(handoffId)).toHaveLength(1);
    } finally {
      await service.close();
    }
  });

  it("mechanically expires a crashed runtime's child Claim in the root partition and returns it to the pool", async () => {
    const owned = storage();
    const handoffId = "handoff-expiring-claim";
    const parentHandoffId = "handoff-expiry-parent";
    let now = "2026-07-27T00:00:00.000Z";
    const clock = { now: () => now };
    const directory = new EndpointDirectoryService({
      store: owned.endpointDirectory,
      clock,
      ids: { sessionId: () => "session-runtime" },
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
    await directory.provision(
      { tenant_id: runtime.tenant_id, principal_id: "admin" },
      {
        endpoint_id: runtime.endpoint_id,
        actor: { actor_id: runtime.actor_id, actor_type: "agent" },
        endpoint_type: "native_agent",
        display_name: "Daily Assistant",
        protocol_versions: ["1.0"],
        bindings: [{
          binding_type: "http_sse",
          uri: "https://runtime.example.test/work-fabric",
          security_schemes: ["oauth2"],
          extensions: {},
        }],
        allowed_capability_ids: ["software.implementation"],
        limits: { max_inline_content_bytes: 65_536 },
        administrative_state: "enabled",
        registration_version: 1,
        extensions: {},
      },
      null,
    );
    await directory.openSession(
      {
        tenant_id: runtime.tenant_id,
        principal_id: runtime.principal_id,
        represented_actor: { actor_id: runtime.actor_id, actor_type: "agent" },
        represented_endpoint_id: runtime.endpoint_id,
      },
      runtime.endpoint_id,
      {
        client_session_id: "client-runtime",
        protocol_version: "1.0",
        capabilities: [{
          capability_id: "software.implementation",
          version: "1.0.0",
          name: "Implementation",
          description: "Implements explicit work",
          input_media_types: ["application/json"],
          output_media_types: ["application/json"],
          input_schema_refs: [],
          output_schema_refs: [],
          interaction_modes: ["asynchronous"],
          constraints: {},
          extensions: {},
        }],
        availability: "available",
        requested_lease_seconds: 60,
        expected_registration_version: 1,
      },
    );
    let sequence = 0;
    const handoffIds = [parentHandoffId, handoffId];
    const ids: IdGenerator = {
      nextId(kind) {
        sequence += 1;
        if (kind === "handoff") {
          const next = handoffIds.shift();
          if (next === undefined) throw new Error("Unexpected Handoff ID");
          return next;
        }
        return `${kind}_expiry_${sequence}`;
      },
    };
    const human = {
      principal_id: "principal-human",
      actor_id: "actor-human",
      endpoint_id: "endpoint-human",
    };
    const service = await composeNodeService(parseServiceConfig({
      storage_profile: "postgres",
      tenant_id: runtime.tenant_id,
      exchange_id: "exchange-local",
      cursor_secret: "x".repeat(32),
      postgres: { connection_string: "postgres://deployment-owned" },
      identities: [
        {
          authentication_evidence: { bearer_token: "human-token" },
          principal: {
            principal_id: human.principal_id,
            tenant_id: runtime.tenant_id,
            actor_claims: [{
              actor_id: human.actor_id,
              actor_type: "human",
              endpoint_ids: [human.endpoint_id],
            }],
            attributes: {},
          },
        },
        {
          authentication_evidence: { bearer_token: "runtime-token" },
          principal: {
            principal_id: runtime.principal_id,
            tenant_id: runtime.tenant_id,
            actor_claims: [{
              actor_id: runtime.actor_id,
              actor_type: "agent",
              endpoint_ids: [runtime.endpoint_id],
            }],
            attributes: {},
          },
        },
      ],
      authority_rules: [
        {
          tenant_id: runtime.tenant_id,
          principal_id: human.principal_id,
          actor_id: human.actor_id,
          actor_type: "human",
          endpoint_id: human.endpoint_id,
          action: "workfabric.handoff.offer.v1",
          resource_id: null,
        },
        {
          tenant_id: runtime.tenant_id,
          principal_id: human.principal_id,
          actor_id: human.actor_id,
          actor_type: "human",
          endpoint_id: human.endpoint_id,
          action: "workfabric.handoff.accept.v1",
          resource_id: parentHandoffId,
        },
        {
          tenant_id: runtime.tenant_id,
          principal_id: human.principal_id,
          actor_id: human.actor_id,
          actor_type: "human",
          endpoint_id: human.endpoint_id,
          action: "workfabric.handoff.transfer.v1",
          resource_id: parentHandoffId,
        },
      ],
      listen: { host: "127.0.0.1", port: 0 },
    }), {
      postgres_storage: owned,
      agent_runtime_authority: { grants: { "daily-assistant": runtime } },
      ids,
      clock,
    });
    const { origin } = await service.listen();
    const client = (
      token: string,
      actorId: string,
      endpointId: string,
    ) => new WorkFabricClient({
      baseUrl: origin,
      tenantId: runtime.tenant_id,
      exchangeId: "exchange-local",
      representation: { actorId, endpointId },
      authentication: new BearerTokenProvider(token),
      clock,
    });
    const initiator = client("human-token", human.actor_id, human.endpoint_id);
    const claimant = client(
      "runtime-token",
      runtime.actor_id,
      runtime.endpoint_id,
    );
    const offer: HandoffOfferPayload = {
      thread_id: "thread-expiry",
      work_reference: { uri: "urn:work:expiry", extensions: {} },
      target: {
        capability_requirement: {
          capability_id: "software.implementation",
          assignment_mode: "eligible_pool_claim",
        },
      },
      intent: [{ kind: "text", media_type: "text/plain", text: "Implement" }],
      authority_scope: {
        delegation_id: "delegation-expiry",
        scopes: ["work:read"],
        resource_refs: ["urn:work:expiry"],
        expires_at: "2026-07-27T02:00:00.000Z",
        may_redelegate: false,
      },
      acceptance_criteria: [{
        criterion_id: "done",
        description: "Work is complete",
        required: true,
        result_schema_ref: null,
        required_evidence_types: [],
      }],
      verifier: { actor_id: human.actor_id, actor_type: "human" },
      priority: "normal",
      accept_by: "2026-07-27T01:00:00.000Z",
      result_due_at: "2026-07-27T02:00:00.000Z",
    };
    try {
      await expect(initiator.handoffs.offer(
        {
          ...offer,
          target: { actor_id: human.actor_id },
          authority_scope: {
            ...offer.authority_scope,
            delegation_id: "delegation-parent-expiry",
            may_redelegate: true,
          },
        },
        { idempotencyKey: "offer-expiry" },
      )).resolves.toMatchObject({
        operation_status: "accepted",
        resource: { resource_id: parentHandoffId, resource_version: 1 },
      });
      await expect(initiator.handoffs.accept(
        { handoff_id: parentHandoffId },
        { expectedVersion: 1, idempotencyKey: "accept-parent-expiry" },
      )).resolves.toMatchObject({
        operation_status: "accepted",
        resource: { resource_version: 2 },
      });
      const { thread_id: _threadId, ...childOffer } = offer;
      await expect(initiator.handoffs.transfer(
        {
          parent_handoff_id: parentHandoffId,
          child_offer: childOffer,
        },
        { expectedVersion: 2, idempotencyKey: "transfer-child-expiry" },
      )).resolves.toMatchObject({
        operation_status: "accepted",
        resource: { resource_id: handoffId, resource_version: 1 },
      });
      let records = await owned.persistence.readStream(handoffId);
      expect(records[0]?.partition_id).toBe(
        (await owned.persistence.readStream(parentHandoffId))[0]?.partition_id,
      );
      await expect(
        claimant.handoffs.claim(
          {
            handoff_id: handoffId,
            claim_id: "claim-expiring",
            requested_lease_seconds: 10,
          },
          { expectedVersion: 1, idempotencyKey: "claim-expiring" },
        ),
      ).resolves.toMatchObject({
        operation_status: "accepted",
        resource: { resource_version: 2 },
      });
      records = await owned.persistence.readStream(handoffId);
      await service.runProjection(records[0]!.partition_id, 100);

      now = "2026-07-27T00:00:11.000Z";
      await service.start();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        records = await owned.persistence.readStream(handoffId);
        if (records.length === 3) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(records).toHaveLength(3);
      expect(records[2]?.event_type).toBe(
        "workfabric.handoff.claim_expired.v1",
      );
      await service.runProjection(records[0]!.partition_id, 100);
      await expect(owned.endpointInbox.listExpiredClaims({
        tenant_id: runtime.tenant_id,
        expires_at_or_before: now,
        limit: 10,
      })).resolves.toEqual({ items: [] });
      await expect(owned.endpointInbox.listClaimableHandoffs({
        tenant_id: runtime.tenant_id,
        endpoint_id: runtime.endpoint_id,
        capability_ids: ["software.implementation"],
        limit: 10,
      })).resolves.toMatchObject({
        items: [{ handoff_id: handoffId, lifecycle_state: "claimable" }],
      });
    } finally {
      await service.close();
    }
  });
});
