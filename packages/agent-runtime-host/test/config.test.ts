import { describe, expect, it } from "vitest";

import { loadAgentRuntimeConfiguration } from "../src/index.js";

const base = {
  api_version: "workfabric.config/v1",
  service: {
    runtime_id: "daily-runtime", development_mode: true,
    work_fabric: {
      base_url: "http://127.0.0.1:8787",
      tenant_id: "tenant-1",
      exchange_id: "exchange-1",
      actor_id: "actor-1",
      endpoint_id: "endpoint-1",
      subscription_id: "subscription-1",
      access_token: "${AGENT_RUNTIME_WORK_FABRIC_TOKEN}",
    },
    acceptance: {
      mode: "accept_all_targeted",
      require_explicit_target: true,
      reject_expired_handoffs: true,
      require_authority_scope: true,
      allowed_capability_ids: ["information.synthesis"],
    },
    concurrency: {
      max_active_runs: 2,
      queue_capacity: 32,
      max_active_partitions: 32,
    },
    state: { provider: "sqlite", location: "./var/runtime.db", busy_timeout_ms: 5_000 },
    capability_invocation: {
      enabled: false,
      max_invocations_per_handoff: 4,
      max_query_invocations_per_handoff: 3,
      max_query_result_bytes: 65_536,
      allowed_namespaces: ["feishu."],
    },
  },
  role: {
    role_id: "daily-assistant", version: 1, display_name: "Daily Assistant",
    description: "Tenant shared assistant",
  },
  participant: { actor_id: "actor-1", actor_type: "agent", endpoint_id: "endpoint-1" },
  capabilities: ["collaboration.request.intake", "information.synthesis", "collaboration.handoff.draft"],
  plugins: { instances: {
    "agently-primary": {
      type: "agent-runtime.agently", enabled: true,
      config: {
        python: { executable: "python", module: "work_fabric_agently_runtime" },
        workspace_root: "./var/workspaces", execution_timeout_seconds: 900,
        cancellation_grace_seconds: 10,
        provider: { type: "OpenAICompatible", model: "configured-model", base_url: "https://model.example.test", api_key: "${AGENTLY_MODEL_API_KEY}" },
      },
    },
  } },
};

function document(value: unknown) {
  return { revision: "test", value };
}

describe("loadAgentRuntimeConfiguration", () => {
  it("loads a tenant Role Profile and resolves only declared secrets", async () => {
    const loaded = await loadAgentRuntimeConfiguration({
      document: document(base),
      environment: {
        AGENT_RUNTIME_WORK_FABRIC_TOKEN: "wf-token",
        AGENTLY_MODEL_API_KEY: "model-token",
        UNDECLARED_SECRET: "not-read",
      },
    });
    expect(loaded.role).toMatchObject({
      role_id: "daily-assistant", version: 1,
      capability_ids: ["collaboration.request.intake", "information.synthesis", "collaboration.handoff.draft"],
    });
    expect(loaded.service.work_fabric.access_token).toBe("wf-token");
    expect(loaded.service.concurrency.max_active_partitions).toBe(32);
    expect(loaded.driver.config.provider.api_key).toBe("model-token");
  });

  it("selects the daily-assistant view from a shared configuration bundle", async () => {
    const loaded = await loadAgentRuntimeConfiguration({
      document: document({
        api_version: "workfabric.config-bundle/v1",
        applications: {
          "work-fabric": {
            api_version: "workfabric.config/v1",
            service: { sibling_secret: "${MUST_NOT_BE_RESOLVED}" },
          },
          "daily-assistant": base,
        },
      }),
      environment: {
        AGENT_RUNTIME_WORK_FABRIC_TOKEN: "wf-token",
        AGENTLY_MODEL_API_KEY: "model-token",
      },
    });

    expect(loaded.service.runtime_id).toBe("daily-runtime");
    expect(loaded.driver.config.provider.api_key).toBe("model-token");
  });

  it.each([
    ["role contains authority", (value: typeof base) => ({ ...value, role: { ...value.role, authority: ["all"] } }), "role.authority"],
    ["Capability is not supported by Driver", (value: typeof base) => ({ ...value, capabilities: [...value.capabilities, "unsupported.capability"] }), "capabilities"],
    ["Actor type is human", (value: typeof base) => ({ ...value, participant: { ...value.participant, actor_type: "human" } }), "participant.actor_type"],
    ["literal production secret", (value: typeof base) => ({ ...value, service: { ...value.service, work_fabric: { ...value.service.work_fabric, access_token: "literal-token" } } }), "literal_secret_forbidden"],
  ])("rejects %s", async (_name, mutate, expected) => {
    await expect(loadAgentRuntimeConfiguration({ document: document(mutate(structuredClone(base))), environment: {} })).rejects.toThrow(expected);
  });

  it("rejects acceptance capabilities outside the declared Driver role", async () => {
    const value = structuredClone(base);
    value.service.acceptance.allowed_capability_ids.push("unsupported.capability");
    await expect(loadAgentRuntimeConfiguration({ document: document(value), environment: { AGENT_RUNTIME_WORK_FABRIC_TOKEN: "wf-token", AGENTLY_MODEL_API_KEY: "model-token" } })).rejects.toThrow("acceptance.allowed_capability_ids");
  });
});
