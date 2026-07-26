import { describe, expect, it } from "vitest";

import { MemoryAdmissionDecisionStore, MemoryParticipantBindingStore } from "@work-fabric/adapter-admission-memory";
import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";
import { MemoryContextRepository } from "@work-fabric/adapter-context-memory";
import { MemoryEndpointDirectoryStore, MemoryEndpointInboxStore } from "@work-fabric/adapter-endpoint-memory";
import { MemoryDiscrepancyStore, MemoryOperationsFixture, MemoryRecoveryStore } from "@work-fabric/adapter-operations-memory";
import { MemoryChannelRouteStore, MemoryExchangePersistence } from "@work-fabric/adapter-storage-memory";
import { MemoryHandoffReadModelStore, MemorySubscriptionStore } from "@work-fabric/exchange-runtime";

import { composeNodeService, parseServiceConfig, type NodeStorageComposition } from "../src/index.js";

const runtime = {
  tenant_id: "tenant-local",
  principal_id: "principal-intake-agent",
  actor_id: "actor-intake-agent",
  endpoint_id: "endpoint-intake-agent",
  subscription_id: "subscription-intake-agent",
};

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
  it("allows configured self and assigned-Handoff calls while making unknown and unassigned Handoffs indistinguishable", async () => {
    const owned = storage();
    await owned.handoffs.putHandoff({
      tenant_id: runtime.tenant_id,
      partition_id: "handoff:handoff-targeted",
      handoff_id: "handoff-targeted",
      stream_version: 1,
      state: {
        package: { target: { actor_id: runtime.actor_id } },
        target_binding: null,
        recipient: null,
        current_responsible_actor: null,
      },
      latest_status: null,
    });
    await owned.handoffs.putHandoff({
      tenant_id: runtime.tenant_id,
      partition_id: "handoff:handoff-unassigned",
      handoff_id: "handoff-unassigned",
      stream_version: 1,
      state: {
        package: { target: { actor_id: "actor-other" } },
        target_binding: null,
        recipient: null,
        current_responsible_actor: null,
      },
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
});
