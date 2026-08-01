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
      capability_facets: [{
        citizen: {
          citizen_id: "citizen-message",
          principal_id: "principal-provider",
          actor_id: "actor-provider",
          endpoint_id: "endpoint-provider",
          registration_version: 3,
        },
        declarations: [{
          declaration_id: "feishu.message.send",
          risk: "medium",
        }],
      }, {
        citizen: {
          citizen_id: "citizen-document",
          principal_id: "principal-provider",
          actor_id: "actor-provider",
          endpoint_id: "endpoint-provider",
          registration_version: 3,
        },
        declarations: [{
          declaration_id: "feishu.document.create",
          risk: "medium",
        }],
      }, {
        citizen: {
          citizen_id: "citizen-calendar",
          principal_id: "principal-provider",
          actor_id: "actor-provider",
          endpoint_id: "endpoint-provider",
          registration_version: 3,
        },
        declarations: [{
          declaration_id: "feishu.calendar.event.delete",
          risk: "destructive",
        }],
      }],
      context_citizen: {
        citizen_id: "citizen-context",
        principal_id: "principal-provider",
        actor_id: "actor-provider",
        endpoint_id: "endpoint-provider",
        registration_version: 4,
      },
      context_declarations: [{
        declaration_id: "feishu.document.context",
        risk: "low",
      }],
    });
    expect(endpoints.provision).toHaveBeenCalledWith(
      "endpoint-provider",
      expect.objectContaining({
        allowed_capability_ids: [
          "feishu.calendar.event.delete",
          "feishu.document.create",
          "feishu.message.send",
        ],
      }),
    );
    expect(citizens.provision).toHaveBeenCalledTimes(4);
    expect(citizens.provision).toHaveBeenNthCalledWith(
      1,
      "citizen-message",
      expect.objectContaining({
        citizen_kind: "capability-provider",
        maximum_risk: "medium",
      }),
    );
    expect(citizens.provision).toHaveBeenNthCalledWith(
      2,
      "citizen-document",
      expect.objectContaining({
        citizen_kind: "capability-provider",
        maximum_risk: "medium",
      }),
    );
    expect(citizens.provision).toHaveBeenNthCalledWith(
      3,
      "citizen-calendar",
      expect.objectContaining({
        citizen_kind: "capability-provider",
        maximum_risk: "destructive",
      }),
    );
    expect(citizens.provision).toHaveBeenNthCalledWith(
      4,
      "citizen-context",
      expect.objectContaining({
        citizen_kind: "context-provider",
        maximum_risk: "low",
      }),
    );
  });

  it("advances the Endpoint registration version when declarations change", async () => {
    const endpoints = {
      provision: vi.fn(async (_id, input) => {
        if (input.registration_version === 1) {
          throw Object.assign(new Error("Endpoint state conflict"), {
            code: "version_conflict",
          });
        }
        return input;
      }),
    };
    const citizens = { provision: vi.fn(async (_id, input) => input) };
    const result = await provisionFeishuProviderRecords({
      endpoints,
      citizens,
      participant: {
        actor_id: "actor-provider",
        actor_type: "agent",
        endpoint_id: "endpoint-provider",
      },
      capability_facets: [{
        citizen: {
          citizen_id: "citizen-calendar",
          principal_id: "principal-provider",
          actor_id: "actor-provider",
          endpoint_id: "endpoint-provider",
          registration_version: 3,
        },
        declarations: [{
          declaration_id: "feishu.calendar.events.list",
          risk: "low",
        }],
      }],
      context_citizen: {
        citizen_id: "citizen-context",
        principal_id: "principal-provider",
        actor_id: "actor-provider",
        endpoint_id: "endpoint-provider",
        registration_version: 4,
      },
      context_declarations: [{
        declaration_id: "feishu.document.context",
        risk: "low",
      }],
    });

    expect(endpoints.provision).toHaveBeenNthCalledWith(
      1,
      "endpoint-provider",
      expect.objectContaining({ registration_version: 1 }),
    );
    expect(endpoints.provision).toHaveBeenNthCalledWith(
      2,
      "endpoint-provider",
      expect.objectContaining({ registration_version: 2 }),
    );
    expect(result.endpoint_registration_version).toBe(2);
  });
});
