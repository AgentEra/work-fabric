import { describe, expect, it, vi } from "vitest";

import type { ConnectorCommandExecution } from "@work-fabric/connector-spi";

import {
  ConnectorSdkCommandSink,
  WorkFabricClient,
} from "../src/index.js";

function operation(status: "accepted" | "conflict" | "temporarily_unavailable") {
  return {
    spec_version: "1.0",
    request_message_id: "message-1",
    operation_status: status,
    resource: status === "accepted" ? { resource_type: "handoff", resource_id: "handoff-1", resource_version: 1 } : null,
    receipt: status === "accepted" ? { receipt_id: "receipt-1" } : null,
    error: status === "accepted" ? null : { code: status },
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
        endpoint_id: "feishu-endpoint-1",
      },
      input: { handoff_id: "handoff-1" },
    },
  };
}

function sink(status: "accepted" | "conflict" | "temporarily_unavailable") {
  const fetchMock = vi.fn(async (
    _input: string | URL | Request,
    _init?: RequestInit,
  ) => new Response(JSON.stringify(operation(status)), {
    status: status === "accepted" ? 202 : status === "conflict" ? 409 : 503,
    headers: { "content-type": "application/json" },
  }));
  const fetch = fetchMock as unknown as typeof globalThis.fetch;
  const client = new WorkFabricClient({
    baseUrl: "https://work-fabric.test",
    authentication: { async getAuthorization() { return "Bearer test"; } },
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
  });

  it("offers a new Handoff without pretending an existing version exists", async () => {
    const { adapter, fetch } = sink("accepted");
    await expect(adapter.execute({
      ...execution(),
      command: {
        operation: "handoff.offer",
        idempotency_key: "connector:message-1",
        identity: { actor_id: "human-1", endpoint_id: "feishu-endpoint-1" },
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
        identity: { actor_id: "human-1" },
      },
    })).resolves.toMatchObject({ kind: "permanent_failure" });
    await expect(adapter.execute({
      ...execution(),
      command: { ...execution().command, operation: "system.execute_work" },
    })).resolves.toMatchObject({ kind: "permanent_failure" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
