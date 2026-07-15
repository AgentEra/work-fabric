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
    resource: status === "accepted" ? { resource_id: "handoff-1" } : null,
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
