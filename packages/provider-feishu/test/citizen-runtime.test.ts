import { describe, expect, it, vi } from "vitest";

import {
  FeishuCapabilityCitizenRuntime,
  FeishuContextCitizenRuntime,
  feishuCapabilityDeclarations,
  feishuContextDeclarations,
} from "../src/index.js";

const clock = {
  now: () => "2026-07-27T10:00:00.000Z",
  setTimeout: vi.fn(() => 1),
  clearTimeout: vi.fn(),
};

function sessionClient() {
  return {
    openSession: vi.fn(async (citizenId, input) => ({
      citizen_id: citizenId,
      session_id: "session-1",
      client_session_id: input.client_session_id,
      descriptor: input.descriptor,
      declarations: input.declarations,
      declaration_version: 1,
      declaration_digest: input.descriptor.declarations.digest,
      accepted_lease_seconds: 60,
      fencing_token: 1,
      heartbeat_sequence: 0,
      state: "active" as const,
      expires_at: "2026-07-27T10:01:00.000Z",
      renew_after: "2026-07-27T10:00:45.000Z",
      registration_version: 1,
    })),
    heartbeat: vi.fn(),
    replaceDeclarations: vi.fn(),
    closeSession: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
}

describe("Feishu Network Citizen runtimes", () => {
  it("registers a capability-provider with dynamic declarations and no credentials", async () => {
    const client = sessionClient();
    const execute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      data: { message_id: "message-1" },
      artifacts: [],
    }));
    const runtime = new FeishuCapabilityCitizenRuntime({
      citizen_id: "feishu-actions",
      client_session_id: "client-1",
      expected_registration_version: 1,
      principal_id: "principal-feishu-actions",
      actor_id: "actor-feishu-actions",
      actor_type: "system",
      endpoint_id: "endpoint-feishu-actions",
      declarations: feishuCapabilityDeclarations,
      execute,
    });

    await runtime.start({
      tenant_id: "tenant-a",
      client,
      clock,
      requested_lease_seconds: 60,
      heartbeat_safety_margin_ms: 5_000,
      signal: new AbortController().signal,
    });

    expect(runtime.citizen_kind).toBe("capability-provider");
    expect(runtime.executor.describeCapabilities()).toHaveLength(7);
    const opened = client.openSession.mock.calls[0]?.[1];
    expect(opened?.descriptor.citizen_kind).toBe("capability-provider");
    expect(opened?.declarations).toEqual(feishuCapabilityDeclarations());
    expect(JSON.stringify(opened)).not.toContain("credential");
  });

  it("registers document context as an independent context-provider", async () => {
    const client = sessionClient();
    const runtime = new FeishuContextCitizenRuntime({
      citizen_id: "feishu-context",
      client_session_id: "client-2",
      expected_registration_version: 1,
      principal_id: "principal-feishu-context",
      actor_id: "actor-feishu-context",
      actor_type: "system",
      endpoint_id: "endpoint-feishu-context",
      declarations: feishuContextDeclarations,
      resolve: async () => ({ document_token: "doc-1", revision: "2" }),
    });

    await runtime.start({
      tenant_id: "tenant-a",
      client,
      clock,
      requested_lease_seconds: 60,
      heartbeat_safety_margin_ms: 5_000,
      signal: new AbortController().signal,
    });

    expect(runtime.citizen_kind).toBe("context-provider");
    expect(await runtime.resolve(
      { document: { document_token: "doc-1" } },
      new AbortController().signal,
    )).toMatchObject({ document_token: "doc-1" });
    expect(client.openSession.mock.calls[0]?.[1].declarations).toHaveLength(2);
  });
});
