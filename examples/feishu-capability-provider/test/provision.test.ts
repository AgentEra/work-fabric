import { describe, expect, it, vi } from "vitest";

import { provisionFeishuProviderRecords } from "../src/provision.js";

describe("Feishu Provider provisioning", () => {
  it("derives Endpoint capabilities and both Citizen records from runtime declarations", async () => {
    const endpoints = { provision: vi.fn(async (_id, input) => input) };
    const citizens = { provision: vi.fn(async (_id, input) => input) };
    await provisionFeishuProviderRecords({
      endpoints,
      citizens,
      participant: {
        actor_id: "actor-provider",
        actor_type: "agent",
        endpoint_id: "endpoint-provider",
      },
      capability_citizen: {
        citizen_id: "citizen-capability",
        principal_id: "principal-provider",
        actor_id: "actor-provider",
        endpoint_id: "endpoint-provider",
        registration_version: 3,
      },
      context_citizen: {
        citizen_id: "citizen-context",
        principal_id: "principal-provider",
        actor_id: "actor-provider",
        endpoint_id: "endpoint-provider",
        registration_version: 4,
      },
      capability_declarations: [{
        declaration_id: "feishu.document.create",
        risk: "medium",
      }],
      context_declarations: [{
        declaration_id: "feishu.document.context",
        risk: "low",
      }],
    });
    expect(endpoints.provision).toHaveBeenCalledWith(
      "endpoint-provider",
      expect.objectContaining({
        allowed_capability_ids: ["feishu.document.create"],
      }),
    );
    expect(citizens.provision).toHaveBeenCalledTimes(2);
    expect(citizens.provision).toHaveBeenNthCalledWith(
      1,
      "citizen-capability",
      expect.objectContaining({
        citizen_kind: "capability-provider",
        maximum_risk: "medium",
      }),
    );
    expect(citizens.provision).toHaveBeenNthCalledWith(
      2,
      "citizen-context",
      expect.objectContaining({
        citizen_kind: "context-provider",
        maximum_risk: "low",
      }),
    );
  });
});
