import { beforeAll, describe, expect, it } from "vitest";

import {
  loadWfppCommandValidator,
  loadWfppSchemaValidator,
  type WfppCommandValidator,
  type WfppSchemaValidator,
} from "@work-fabric/protocol-runtime";

import {
  createDiscoveryFederationScenario,
  handoffOffer,
} from "./support/discovery-e2e-harness.js";

let validator: WfppCommandValidator;
let schemas: WfppSchemaValidator;

beforeAll(async () => {
  schemas = await loadWfppSchemaValidator("protocol/schemas/v1");
  validator = await loadWfppCommandValidator(
    schemas,
    "protocol/spec/interaction-payloads.json",
  );
});

describe("generic Agent participation discovery", () => {
  it("discovers a remote capability and endpoint before an explicit federated Handoff acceptance", async () => {
    const scenario = await createDiscoveryFederationScenario(
      schemas,
      validator,
      { publishDiscovery: true },
    );
    try {
      const page = await scenario.exchangeB.client.discovery.findCapabilities({
        capability_id: "software.implementation",
        input_media_types: ["application/json"],
      });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.record_kind).toBe("capability_route");
      expect(page.items[0]?.origin_exchange_id).toBe("exchange_a");
      expect(page.items[0]?.payload).not.toHaveProperty("heartbeat_sequence");

      const endpoint = await scenario.exchangeB.client.discovery.getEndpoint("endpoint_exchange_a");
      expect(endpoint.payload).toMatchObject({
        endpoint_id: "endpoint_exchange_a",
        actor: { actor_id: "actor_exchange_a", actor_type: "agent" },
        capabilities: [{ capability_id: "software.implementation" }],
      });
      expect(JSON.stringify(endpoint)).not.toMatch(/fencing_token|heartbeat_sequence|session_id/);

      // The generic Agent selects a returned candidate outside Discovery.
      const source = await scenario.exchangeB.client.handoffs.offer(
        handoffOffer("actor_exchange_b"),
        { idempotencyKey: "source-handoff" },
      );
      const sourceHandoffId = source.resource?.resource_id;
      if (typeof sourceHandoffId !== "string") throw new Error("source Handoff was not created");
      const prepared = await scenario.federationB.prepareOutbound({
        target_exchange_id: endpoint.origin_exchange_id,
        source_handoff_id: sourceHandoffId,
        source_thread_id: "thread_discovery_e2e",
        source_resource_version: 1,
        handoff_offer: handoffOffer(endpoint.payload.actor.actor_id),
      });
      const receipt = await scenario.federationA.receiveOffer(prepared.request);
      const delivered = await scenario.federationB.deliverOutbound(prepared, {
        exchange: async () => receipt,
      });
      expect(delivered.outcome).toBe("accepted");
      if (delivered.outcome !== "accepted") throw new Error("federation transfer failed");
      expect(scenario.targetBridgeCalls()).toBe(1);

      const offered = await scenario.exchangeA.client.queries.getHandoff(delivered.target_handoff_id);
      expect(offered.state.lifecycle_state).toBe("offered");
      await scenario.exchangeA.client.handoffs.accept(
        { handoff_id: delivered.target_handoff_id },
        { expectedVersion: 1, idempotencyKey: "target-explicit-accept" },
      );
      expect((await scenario.exchangeA.client.queries.getHandoff(delivered.target_handoff_id)).state.lifecycle_state)
        .toBe("accepted");
    } finally {
      await scenario.close();
    }
  }, 20_000);
});
