import { describe, expect, it, vi } from "vitest";
import type {
  CapabilityExecutionContext,
  CapabilityExecutionRequest,
  CapabilityExecutor,
  CitizenSessionClient,
  PublicCitizenSession,
} from "@work-fabric/network-citizen-spi";

import {
  GitHubCapabilityCitizenRuntime,
  githubReadCapabilityDeclarations,
} from "../src/index.js";

const clock = {
  now: () => "2026-08-02T10:00:00.000Z",
  setTimeout: vi.fn(() => 1),
  clearTimeout: vi.fn(),
};

function client(): CitizenSessionClient {
  let active: PublicCitizenSession | undefined;
  return {
    openSession: vi.fn(async (citizenId, input) => {
      active = {
        citizen_id: citizenId,
        session_id: "github-session-1",
        client_session_id: input.client_session_id,
        descriptor: input.descriptor,
        declarations: input.declarations,
        declaration_version: 1,
        declaration_digest: input.descriptor.declarations.digest,
        accepted_lease_seconds: 60,
        fencing_token: 9,
        heartbeat_sequence: 0,
        state: "active",
        expires_at: "2026-08-02T10:01:00.000Z",
        renew_after: "2026-08-02T10:00:45.000Z",
        registration_version: 3,
      };
      return active;
    }),
    heartbeat: vi.fn(async () => {
      if (active === undefined) throw new Error("not open");
      return active;
    }),
    replaceDeclarations: vi.fn(async () => {
      if (active === undefined) throw new Error("not open");
      return active;
    }),
    closeSession: vi.fn(async (_citizenId, _sessionId, input) => {
      if (active === undefined) throw new Error("not open");
      active = {
        ...active,
        state: "closed",
        heartbeat_sequence: input.heartbeat_sequence,
      };
      return active;
    }),
  };
}

describe("GitHubCapabilityCitizenRuntime", () => {
  it("owns an independent capability-provider lease and exact descriptor extensions", async () => {
    const execute = vi.fn(async () => ({
      outcome: "succeeded" as const,
      data: { state: "empty", items: [], evidence: { provider: "github" } },
      artifacts: [],
    }));
    const executor: CapabilityExecutor = {
      describeCapabilities: githubReadCapabilityDeclarations,
      execute,
    };
    const sessions = client();
    const runtime = new GitHubCapabilityCitizenRuntime({
      citizen_id: "github-read-provider",
      client_session_id: "github-process-1",
      expected_registration_version: 3,
      principal_id: "principal-github-provider",
      actor_id: "actor-github-provider",
      endpoint_id: "endpoint-github-provider",
      executor,
    });

    await runtime.start({
      tenant_id: "tenant-a",
      client: sessions,
      clock,
      requested_lease_seconds: 60,
      heartbeat_safety_margin_ms: 5_000,
      signal: new AbortController().signal,
    });

    expect(runtime.citizen_kind).toBe("capability-provider");
    expect(runtime.executor).toBe(executor);
    const opened = vi.mocked(sessions.openSession).mock.calls[0]?.[1];
    expect(opened).toMatchObject({
      client_session_id: "github-process-1",
      expected_registration_version: 3,
      descriptor: {
        citizen_id: "github-read-provider",
        citizen_kind: "capability-provider",
        identity: {
          principal_id: "principal-github-provider",
          actor: { actor_id: "actor-github-provider", actor_type: "system" },
          endpoint_id: "endpoint-github-provider",
        },
        extensions: {
          "workfabric.dev/provider_family": "github",
          "workfabric.dev/declaration_source": "runtime",
          "workfabric.dev/mutation_support": "none",
        },
      },
      declarations: githubReadCapabilityDeclarations(),
    });
    expect(Object.keys(opened?.descriptor.extensions ?? {})).toHaveLength(3);
    expect(JSON.stringify(opened)).not.toMatch(/token|private_key|credential|installation_id/i);

    const request = {} as CapabilityExecutionRequest;
    const context = {} as CapabilityExecutionContext;
    await runtime.executor.execute(request, context);
    expect(execute).toHaveBeenCalledWith(request, context);
    await runtime.close();
    expect(sessions.closeSession).toHaveBeenCalledWith(
      "github-read-provider",
      "github-session-1",
      {
        fencing_token: 9,
        heartbeat_sequence: 1,
        expected_registration_version: 3,
      },
    );
  });
});
