import { describe, expect, it, vi } from "vitest";

import {
  canonicalCitizenDigest,
  type CitizenDeclaration,
  type CitizenRuntimeContext,
  type CitizenSessionClient,
  type NetworkCitizenDescriptor,
  type PublicCitizenSession,
} from "@work-fabric/network-citizen-spi";

import { LeasedNetworkCitizenRuntime } from "../src/index.js";

const declaration: CitizenDeclaration = {
  declaration_id: "feishu.document.create",
  declaration_kind: "capability",
  version: "1.0.0",
  name: "Create document",
  description: "Create one simple document.",
  interaction_modes: ["asynchronous"],
  risk: "medium",
  confirmation: "none",
  constraints: {},
  extensions: {},
};

function descriptor(
  declarations: readonly CitizenDeclaration[] = [declaration],
): NetworkCitizenDescriptor {
  return {
    citizen_id: "feishu-document-actions",
    citizen_kind: "capability-provider",
    version: "1.0.0",
    identity: {
      principal_id: "principal-feishu-provider",
      actor: {
        actor_id: "actor-feishu-provider",
        actor_type: "system",
      },
      endpoint_id: "endpoint-feishu-provider",
    },
    protocol: { versions: ["1"], bindings: ["workfabric+https"] },
    declarations: {
      count: declarations.length,
      digest: canonicalCitizenDigest(declarations),
    },
    availability: "available",
    extensions: {},
  };
}

function session(
  overrides: Partial<PublicCitizenSession> = {},
): PublicCitizenSession {
  return {
    citizen_id: "feishu-document-actions",
    session_id: "session-1",
    client_session_id: "client-session-1",
    descriptor: descriptor(),
    declarations: [declaration],
    declaration_version: 1,
    declaration_digest: canonicalCitizenDigest([declaration]),
    accepted_lease_seconds: 60,
    fencing_token: 1,
    heartbeat_sequence: 0,
    state: "active",
    expires_at: "2026-07-27T00:01:00.000Z",
    renew_after: "2026-07-27T00:00:45.000Z",
    registration_version: 1,
    ...overrides,
  };
}

class FakeClock {
  nowValue = "2026-07-27T00:00:00.000Z";
  callback: (() => void) | null = null;
  delay: number | null = null;
  throwOnSchedule = false;

  now = () => this.nowValue;

  setTimeout = (callback: () => void, delayMs: number) => {
    if (this.throwOnSchedule) throw new Error("schedule failed");
    this.callback = callback;
    this.delay = delayMs;
    return callback;
  };

  clearTimeout = (handle: unknown) => {
    if (this.callback === handle) this.callback = null;
  };

  async fire(): Promise<void> {
    const callback = this.callback;
    this.callback = null;
    callback?.();
    await vi.waitFor(() => {
      expect(this.callback).not.toBeNull();
    });
  }
}

function fakeClient() {
  let current = session();
  const client: CitizenSessionClient = {
    openSession: vi.fn(async () => current),
    heartbeat: vi.fn(async (_citizenId, _sessionId, input) => {
      current = session({
        ...current,
        descriptor: {
          ...current.descriptor,
          availability: input.availability,
        },
        heartbeat_sequence: input.heartbeat_sequence,
        expires_at: "2026-07-27T00:02:00.000Z",
        renew_after: "2026-07-27T00:01:45.000Z",
      });
      return current;
    }),
    replaceDeclarations: vi.fn(async (_citizenId, _sessionId, input) => {
      current = session({
        ...current,
        declarations: input.declarations,
        declaration_version: current.declaration_version + 1,
        declaration_digest: canonicalCitizenDigest(input.declarations),
        descriptor: descriptor(input.declarations),
      });
      return current;
    }),
    closeSession: vi.fn(async (_citizenId, _sessionId, input) => {
      current = session({
        ...current,
        state: "closed",
        descriptor: {
          ...current.descriptor,
          availability: "unavailable",
        },
        heartbeat_sequence: input.heartbeat_sequence,
      });
      return current;
    }),
  };
  return client;
}

class TestRuntime extends LeasedNetworkCitizenRuntime {
  readonly citizen_kind = "capability-provider" as const;
  descriptorValue = descriptor();
  declarationValues: readonly CitizenDeclaration[] = [declaration];

  constructor() {
    super({
      citizen_id: "feishu-document-actions",
      client_session_id: "client-session-1",
      expected_registration_version: 1,
    });
  }

  protected currentDescriptor(): NetworkCitizenDescriptor {
    return this.descriptorValue;
  }

  protected currentDeclarations(): readonly CitizenDeclaration[] {
    return this.declarationValues;
  }
}

function context(
  client: CitizenSessionClient,
  clock: FakeClock,
): CitizenRuntimeContext {
  return {
    tenant_id: "tenant-a",
    client,
    clock,
    requested_lease_seconds: 60,
    heartbeat_safety_margin_ms: 5_000,
    signal: new AbortController().signal,
  };
}

describe("LeasedNetworkCitizenRuntime", () => {
  it("opens one session and heartbeats without declarations", async () => {
    const runtime = new TestRuntime();
    const client = fakeClient();
    const clock = new FakeClock();

    await runtime.start(context(client, clock));
    expect(client.openSession).toHaveBeenCalledOnce();
    expect(clock.delay).toBe(45_000);

    clock.nowValue = "2026-07-27T00:00:45.000Z";
    await clock.fire();
    expect(client.heartbeat).toHaveBeenCalledWith(
      "feishu-document-actions",
      "session-1",
      {
        fencing_token: 1,
        heartbeat_sequence: 1,
        availability: "available",
        expected_registration_version: 1,
      },
    );
    expect(JSON.stringify(vi.mocked(client.heartbeat).mock.calls)).not.toContain(
      "declarations",
    );
    await runtime.close();
  });

  it("uses explicit declaration CAS and tracks the returned version", async () => {
    const runtime = new TestRuntime();
    const client = fakeClient();
    const clock = new FakeClock();
    await runtime.start(context(client, clock));
    const next = [
      declaration,
      {
        ...declaration,
        declaration_id: "feishu.document.read",
        name: "Read document",
        risk: "low" as const,
      },
    ];
    runtime.declarationValues = next;
    runtime.descriptorValue = descriptor(next);

    await runtime.replaceDeclarations(next);

    expect(client.replaceDeclarations).toHaveBeenCalledWith(
      "feishu-document-actions",
      "session-1",
      {
        fencing_token: 1,
        expected_registration_version: 1,
        expected_declaration_version: 1,
        declarations: next,
      },
    );
    await expect(runtime.health()).resolves.toMatchObject({
      status: "available",
      declaration_version: 2,
    });
    await runtime.close();
  });

  it("stops heartbeating when the descriptor drifts outside replacement", async () => {
    const runtime = new TestRuntime();
    const client = fakeClient();
    const clock = new FakeClock();
    await runtime.start(context(client, clock));
    runtime.descriptorValue = {
      ...runtime.descriptorValue,
      version: "2.0.0",
    };

    clock.nowValue = "2026-07-27T00:00:45.000Z";
    const callback = clock.callback;
    clock.callback = null;
    callback?.();
    await vi.waitFor(async () => {
      expect(await runtime.health()).toMatchObject({
        status: "unavailable",
        detail_code: "descriptor_drift",
      });
    });
    expect(client.heartbeat).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("becomes unavailable after lease renewal failure", async () => {
    const runtime = new TestRuntime();
    const client = fakeClient();
    vi.mocked(client.heartbeat).mockRejectedValueOnce(new Error("lease lost"));
    const clock = new FakeClock();
    await runtime.start(context(client, clock));

    clock.nowValue = "2026-07-27T00:00:45.000Z";
    const callback = clock.callback;
    clock.callback = null;
    callback?.();
    await vi.waitFor(async () => {
      expect(await runtime.health()).toMatchObject({
        status: "unavailable",
        detail_code: "lease_lost",
      });
    });
    expect(clock.callback).toBeNull();
    await runtime.close();
  });

  it("rolls back an opened session when start cannot schedule renewal", async () => {
    const runtime = new TestRuntime();
    const client = fakeClient();
    const clock = new FakeClock();
    clock.throwOnSchedule = true;

    await expect(runtime.start(context(client, clock))).rejects.toThrow(
      "schedule failed",
    );
    expect(client.closeSession).toHaveBeenCalledOnce();
    await expect(runtime.health()).resolves.toMatchObject({
      status: "unavailable",
      detail_code: "start_failed",
    });
  });

  it("closes idempotently with the next heartbeat sequence", async () => {
    const runtime = new TestRuntime();
    const client = fakeClient();
    const clock = new FakeClock();
    await runtime.start(context(client, clock));

    await Promise.all([runtime.close(), runtime.close()]);

    expect(client.closeSession).toHaveBeenCalledOnce();
    expect(client.closeSession).toHaveBeenCalledWith(
      "feishu-document-actions",
      "session-1",
      {
        fencing_token: 1,
        heartbeat_sequence: 1,
        expected_registration_version: 1,
      },
    );
    await expect(runtime.health()).resolves.toMatchObject({ status: "closed" });
  });
});
