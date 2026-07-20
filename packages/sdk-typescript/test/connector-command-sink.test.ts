import { describe, expect, it, vi } from "vitest";

import type { ConnectorCommandExecution } from "@work-fabric/connector-spi";

import {
  BearerTokenProvider,
  ConnectorSdkCommandSink,
  WorkFabricClient,
} from "../src/index.js";

function operation(
  status: "accepted" | "conflict" | "temporarily_unavailable",
  errorCode: string = status,
) {
  return {
    spec_version: "1.0",
    request_message_id: "message-1",
    operation_status: status,
    resource: status === "accepted" ? { resource_type: "handoff", resource_id: "handoff-1", resource_version: 1 } : null,
    receipt: status === "accepted" ? { receipt_id: "receipt-1" } : null,
    error: status === "accepted" ? null : { code: errorCode },
  };
}

function execution(): ConnectorCommandExecution {
  return {
    tenant_id: "tenant-1",
    connector_id: "feishu-primary",
    ingress_id: "ingress-1",
    command: {
      operation: "handoff.accept",
      idempotency_key: "connector:action-1",
      expected_version: 4,
      identity: {
        actor_id: "human-1",
        actor_type: "human",
        endpoint_id: "feishu-endpoint-1",
      },
      input: { handoff_id: "handoff-1" },
    },
  };
}

function sink(
  status: "accepted" | "conflict" | "temporarily_unavailable",
  errorCode: string = status,
  response?: Record<string, unknown>,
) {
  const fetchMock = vi.fn(async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ) => new Response(JSON.stringify(response ?? operation(status, errorCode)), {
    status: status === "accepted" ? 202 : status === "conflict" ? 409 : 503,
    headers: { "content-type": "application/json" },
  }));
  const fetch = fetchMock as unknown as typeof globalThis.fetch;
  const client = new WorkFabricClient({
    baseUrl: "https://work-fabric.test",
    authentication: new BearerTokenProvider("base-token"),
    representation: { actorId: "bootstrap", endpointId: "bootstrap-endpoint" },
    tenantId: "tenant-1",
    exchangeId: "exchange-1",
    fetch,
    clock: { now: () => "2026-07-16T00:00:00Z" },
    messageIdGenerator: { nextMessageId: () => "message-1" },
  });
  return { adapter: new ConnectorSdkCommandSink(client), fetch: fetchMock };
}

describe("ConnectorSdkCommandSink", () => {
  it("uses the public SDK with the mapped representation", async () => {
    const { adapter, fetch } = sink("accepted");
    await expect(adapter.execute(execution())).resolves.toEqual({
      kind: "accepted",
      receipt_id: "receipt-1",
      event_ids: [],
      resource: { resource_type: "handoff", resource_id: "handoff-1", resource_version: 1 },
    });
    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({
      message_type: "workfabric.handoff.accept.v1",
      actor_id: "human-1",
      endpoint_id: "feishu-endpoint-1",
      expected_version: 4,
      idempotency_key: "connector:action-1",
      payload: { handoff_id: "handoff-1" },
    });
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer base-token");
  });

  it("uses a command bearer only for that command and preserves base authentication", async () => {
    const { adapter, fetch } = sink("accepted");
    await adapter.execute(execution());
    await adapter.execute({
      ...execution(),
      ingress_id: "ingress-scoped",
      command: {
        ...execution().command,
        authentication: { kind: "bearer", credential: "representation-grant" },
      },
    });
    await adapter.execute({ ...execution(), ingress_id: "ingress-after" });

    expect(fetch.mock.calls.map((call) => {
      const headers = new Headers((call[1] as RequestInit).headers);
      return [
        headers.get("authorization"),
        headers.get("x-wf-actor-id"),
        headers.get("x-wf-endpoint-id"),
      ];
    })).toEqual([
      ["Bearer base-token", "human-1", "feishu-endpoint-1"],
      ["Bearer representation-grant", "human-1", "feishu-endpoint-1"],
      ["Bearer base-token", "human-1", "feishu-endpoint-1"],
    ]);
  });

  it("keeps concurrent command bearer credentials isolated", async () => {
    const { adapter, fetch } = sink("accepted");
    await Promise.all([
      adapter.execute({
        ...execution(),
        ingress_id: "ingress-one",
        command: { ...execution().command, authentication: { kind: "bearer", credential: "grant-one" } },
      }),
      adapter.execute({
        ...execution(),
        ingress_id: "ingress-two",
        command: { ...execution().command, authentication: { kind: "bearer", credential: "grant-two" } },
      }),
    ]);
    expect(fetch.mock.calls.map((call) =>
      new Headers((call[1] as RequestInit).headers).get("authorization"),
    )).toEqual(expect.arrayContaining(["Bearer grant-one", "Bearer grant-two"]));
  });

  it("never returns a scoped bearer credential in result details", async () => {
    const grant = "representation-grant-must-stay-secret";
    const { adapter } = sink("conflict", `conflict:${grant}`);
    const result = await adapter.execute({
      ...execution(),
      command: {
        ...execution().command,
        authentication: { kind: "bearer", credential: grant },
      },
    });

    expect(result).toMatchObject({
      kind: "permanent_failure",
      error_code: "work_fabric_conflict",
    });
    expect(JSON.stringify(result)).not.toContain(grant);
  });

  it.each([
    ["receipt id", {
      ...operation("accepted"),
      receipt: { receipt_id: "receipt:representation-grant-reflected" },
    }],
    ["request message id fallback", {
      ...operation("accepted"),
      request_message_id: "request:representation-grant-reflected",
      receipt: null,
    }],
    ["resource id", {
      ...operation("accepted"),
      resource: {
        resource_type: "handoff",
        resource_id: "resource:representation-grant-reflected",
        resource_version: 1,
      },
    }],
  ])("never copies a reflected credential from accepted %s", async (_name, response) => {
    const grant = "representation-grant-reflected";
    const { adapter } = sink("accepted", "accepted", response);
    const result = await adapter.execute({
      ...execution(),
      command: {
        ...execution().command,
        authentication: { kind: "bearer", credential: grant },
      },
    });

    expect(result.kind).toBe("accepted");
    expect(JSON.stringify(result)).not.toContain(grant);
    if (_name !== "resource id") {
      expect(result).toMatchObject({ receipt_id: "connector:ingress-1" });
    } else {
      expect(result).not.toHaveProperty("resource");
    }
  });

  it("rejects inherited, accessor, extra, and invalid bearer authentication without reading getters", async () => {
    const { adapter, fetch } = sink("accepted");
    let getterCalls = 0;
    const accessor = Object.defineProperties({}, {
      kind: { enumerable: true, get() { getterCalls += 1; return "bearer"; } },
      credential: { enumerable: true, get() { getterCalls += 1; return "hidden-grant"; } },
    });
    const inherited = Object.create({ kind: "bearer", credential: "hidden-grant" });
    const malformed = [
      inherited,
      accessor,
      { kind: "bearer", credential: "hidden-grant", extra: true },
      { kind: "basic", credential: "hidden-grant" },
      { kind: "bearer", credential: "invalid grant" },
    ];

    for (const authentication of malformed) {
      const result = await adapter.execute({
        ...execution(),
        command: { ...execution().command, authentication } as never,
      });
      expect(result).toEqual({
        kind: "permanent_failure",
        error_code: "invalid_command",
      });
      expect(JSON.stringify(result)).not.toContain("hidden-grant");
      expect(JSON.stringify(result)).not.toContain("invalid grant");
    }
    expect(getterCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an inherited outer authentication property without base or scoped I/O", async () => {
    const { adapter, fetch } = sink("accepted");
    const command = Object.assign(Object.create({
      authentication: { kind: "bearer", credential: "inherited-outer-grant" },
    }), execution().command);

    await expect(adapter.execute({
      ...execution(),
      command: command as never,
    })).resolves.toEqual({
      kind: "permanent_failure",
      error_code: "invalid_command",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an outer authentication getter without invoking it or performing I/O", async () => {
    const { adapter, fetch } = sink("accepted");
    let getterCalls = 0;
    const command = { ...execution().command } as Record<string, unknown>;
    Object.defineProperty(command, "authentication", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { kind: "bearer", credential: "outer-getter-grant" };
      },
    });

    await expect(adapter.execute({
      ...execution(),
      command: command as never,
    })).resolves.toEqual({
      kind: "permanent_failure",
      error_code: "invalid_command",
    });
    expect(getterCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a present own undefined authentication property without I/O", async () => {
    const { adapter, fetch } = sink("accepted");
    await expect(adapter.execute({
      ...execution(),
      command: {
        ...execution().command,
        authentication: undefined,
      } as never,
    })).resolves.toEqual({
      kind: "permanent_failure",
      error_code: "invalid_command",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["presence", { has() { throw new Error("presence trap"); } }],
    ["descriptor", {
      has(_target: object, property: PropertyKey) {
        return property === "authentication";
      },
      getOwnPropertyDescriptor() {
        throw new Error("descriptor trap");
      },
    }],
  ])("rejects an outer authentication %s proxy error without I/O", async (_name, handler) => {
    const { adapter, fetch } = sink("accepted");
    const command = new Proxy({ ...execution().command }, handler);

    await expect(adapter.execute({
      ...execution(),
      command: command as never,
    })).resolves.toEqual({
      kind: "permanent_failure",
      error_code: "invalid_command",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("offers a new Handoff without pretending an existing version exists", async () => {
    const { adapter, fetch } = sink("accepted");
    await expect(adapter.execute({
      ...execution(),
      command: {
        operation: "handoff.offer",
        idempotency_key: "connector:message-1",
        identity: { actor_id: "human-1", actor_type: "human", endpoint_id: "feishu-endpoint-1" },
        input: {
          work_reference: { uri: "feishu://message/om_1" },
          target: { kind: "explicit", actor_id: "agent-1", endpoint_id: "agent-endpoint-1" },
          intent: [{ text: "create a requirement" }], authority_scope: {},
          acceptance_criteria: [], verifier: { mode: "initiator" }, priority: "normal",
          accept_by: "2026-07-18T00:00:00.000Z", result_due_at: "2026-07-19T00:00:00.000Z",
        },
      },
    })).resolves.toMatchObject({
      kind: "accepted",
      resource: { resource_id: "handoff-1", resource_version: 1 },
    });
    const body = JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.message_type).toBe("workfabric.handoff.offer.v1");
    expect(body.expected_version).toBeUndefined();
  });

  it.each([
    ["conflict", "permanent_failure"],
    ["temporarily_unavailable", "retryable_failure"],
  ] as const)("classifies %s without bypassing SDK semantics", async (status, kind) => {
    const { adapter } = sink(status);
    await expect(adapter.execute(execution())).resolves.toMatchObject({ kind });
  });

  it("rejects missing endpoint identity and unsupported operations before I/O", async () => {
    const { adapter, fetch } = sink("accepted");
    await expect(adapter.execute({
      ...execution(),
      command: {
        ...execution().command,
        identity: { actor_id: "human-1", actor_type: "human" },
      },
    })).resolves.toMatchObject({ kind: "permanent_failure" });
    await expect(adapter.execute({
      ...execution(),
      command: { ...execution().command, operation: "system.execute_work" },
    })).resolves.toMatchObject({ kind: "permanent_failure" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
