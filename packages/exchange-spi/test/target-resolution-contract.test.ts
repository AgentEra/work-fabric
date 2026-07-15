import { describe, expect, it } from "vitest";

import {
  TARGET_ELIGIBILITY_REQUIRED_CAPABILITIES,
  assertCapabilities,
  type ResolvedPrincipal,
  type TargetEligibilityRequest,
  type TargetEligibilityVerifier,
} from "../src/index.js";

const principal: ResolvedPrincipal = {
  principal_id: "principal_resolver",
  tenant_id: "tenant_01",
  actor_claims: [
    {
      actor_id: "actor_resolver",
      actor_type: "agent",
      endpoint_ids: ["endpoint_resolver"],
    },
  ],
  attributes: {},
};

const request: TargetEligibilityRequest = {
  tenant_id: "tenant_01",
  exchange_id: "exchange_01",
  handoff_id: "handoff_01",
  requirement: { capability_id: "software.implementation" },
  proposed_target: { endpoint_id: "endpoint_agent" },
  principal,
};

describe("TargetEligibilityVerifier contract", () => {
  it("requires explicit-target-only, no-selection, fail-closed capabilities", () => {
    expect(TARGET_ELIGIBILITY_REQUIRED_CAPABILITIES).toEqual([
      "explicit_target_only",
      "no_candidate_selection",
      "fail_closed",
    ]);
    expect(() =>
      assertCapabilities(
        {
          profile: "exchange.target-eligibility.v1",
          adapter: "test",
          capabilities: {
            explicit_target_only: true,
            no_candidate_selection: true,
            fail_closed: true,
          },
        },
        TARGET_ELIGIBILITY_REQUIRED_CAPABILITIES,
      ),
    ).not.toThrow();
  });

  it("returns only an eligibility decision for one proposed target", async () => {
    const verifier: TargetEligibilityVerifier = {
      manifest: {
        profile: "exchange.target-eligibility.v1",
        adapter: "test",
        capabilities: {
          explicit_target_only: true,
          no_candidate_selection: true,
          fail_closed: true,
        },
      },
      async verify(received) {
        expect(received).toEqual(request);
        return { kind: "eligible" };
      },
    };

    await expect(verifier.verify(request)).resolves.toEqual({
      kind: "eligible",
    });
  });
});
