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

describe("Discovery and Federation responsibility boundary", () => {
  it("keeps explicitly addressed Federation and local Handoff working with no published Discovery data", async () => {
    const scenario = await createDiscoveryFederationScenario(
      schemas,
      validator,
      { publishDiscovery: false },
    );
    try {
      await expect(scenario.exchangeB.client.discovery.findCapabilities({
        capability_id: "software.implementation",
      })).resolves.toMatchObject({ items: [] });

      const source = await scenario.exchangeB.client.handoffs.offer(
        handoffOffer("actor_exchange_b"),
        { idempotencyKey: "explicit-source-handoff" },
      );
      const sourceHandoffId = source.resource?.resource_id;
      if (typeof sourceHandoffId !== "string") throw new Error("source Handoff was not created");
      const prepared = await scenario.federationB.prepareOutbound({
        target_exchange_id: "exchange_a",
        source_handoff_id: sourceHandoffId,
        source_thread_id: "thread_explicit_federation",
        source_resource_version: 1,
        handoff_offer: handoffOffer("actor_exchange_a"),
      });
      const receipt = await scenario.federationA.receiveOffer(prepared.request);
      const delivered = await scenario.federationB.deliverOutbound(prepared, {
        exchange: async () => receipt,
      });
      expect(delivered.outcome).toBe("accepted");
      if (delivered.outcome !== "accepted") throw new Error("federation transfer failed");
      expect((await scenario.exchangeA.client.queries.getHandoff(delivered.target_handoff_id)).state.lifecycle_state)
        .toBe("offered");
    } finally {
      await scenario.close();
    }
  }, 20_000);
});
