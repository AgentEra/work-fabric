import { describe, expect, it } from "vitest";

import {
  validateAgentRuntimeAuthorityConfiguration,
} from "../src/index.js";

const agentGrant = {
  tenant_id: "tenant-local",
  principal_id: "principal-runtime",
  actor_id: "actor-runtime",
  endpoint_id: "endpoint-runtime",
  subscription_id: "subscription-runtime",
};

describe("Agent Runtime authority configuration", () => {
  it("preserves an existing Agent grant when actor_type is omitted", () => {
    expect(validateAgentRuntimeAuthorityConfiguration({
      grants: { runtime: agentGrant },
    }, "agent_runtime_authority").grants.runtime).toEqual(agentGrant);
  });

  it("loads an explicit system runtime grant", () => {
    expect(validateAgentRuntimeAuthorityConfiguration({
      grants: { runtime: { ...agentGrant, actor_type: "system" } },
    }, "agent_runtime_authority").grants.runtime).toEqual({
      ...agentGrant,
      actor_type: "system",
    });
  });

  it("rejects a human runtime grant", () => {
    expect(() => validateAgentRuntimeAuthorityConfiguration({
      grants: { runtime: { ...agentGrant, actor_type: "human" } },
    }, "agent_runtime_authority")).toThrow("actor_type");
  });
});
