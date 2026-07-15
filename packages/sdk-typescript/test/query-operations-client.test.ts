import { describe, expect, it, vi } from "vitest";

import {
  BearerTokenProvider,
  OperationsClient,
  QueryClient,
  WorkFabricHttpError,
} from "../src/index.js";
import { normalizeClientOptions } from "../src/config.js";
import { SdkTransport } from "../src/transport.js";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clients(fetch: typeof globalThis.fetch) {
  const config = normalizeClientOptions({
    baseUrl: "https://fabric.example.test/api",
    tenantId: "tenant_01",
    exchangeId: "exchange_01",
    representation: { actorId: "actor_01", endpointId: "endpoint_01" },
    authentication: new BearerTokenProvider("token"),
    fetch,
    queryRetry: { maxRetries: 0 },
  });
  const transport = new SdkTransport(config);
  return {
    queries: new QueryClient(transport, config.representation),
    operations: new OperationsClient(transport, config.representation),
  };
}

describe("QueryClient and OperationsClient", () => {
  it("maps every query and operations resource with encoded values", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith("/health/live")) return json({ status: "live" });
      if (url.endsWith("/health/ready")) return json({ status: "not_ready" }, 503);
      if (url.endsWith("/v1/admin/health")) return json({ status: "ready", dependencies: [] });
      if (url.includes("/handoffs/") && !url.includes("/events")) return json({ handoff_id: "handoff / 01" });
      if (url.includes("/handoffs/") && url.includes("/events")) return json({ events: [] });
      if (url.includes("/partitions/") && url.includes("/handoffs")) return json({ handoffs: [] });
      if (url.includes("/partitions/") && url.includes("/events")) return json({ events: [] });
      if (url.includes("projection-failures")) return json({ failures: [] });
      if (url.includes("delivery-attempts")) return json({ attempts: [] });
      if (url.includes("delivery-position")) return json({ position: 7 });
      return json({ subscriptions: [] });
    }) as unknown as typeof globalThis.fetch;
    const { queries, operations } = clients(fetch);

    await queries.getHandoff("handoff / 01");
    await queries.listHandoffEvents("handoff / 01", { fromVersion: 2, limit: 25 });
    await queries.listPartitionHandoffs("partition / 01", { limit: 20 });
    await queries.listPartitionEvents("partition / 01", { afterPosition: 0, limit: 30 });
    await operations.listSubscriptions({ limit: 15 });
    await operations.listProjectionFailures({ projectorId: "projector / 01", partitionId: "partition / 01", limit: 10 });
    await operations.listDeliveryAttempts({ subscriptionId: "subscription / 01", eventId: "event / 01", limit: 5 });
    await operations.getDeliveryPosition({ subscriptionId: "subscription / 01", partitionId: "partition / 01" });
    await operations.getHealth();
    await operations.getLiveness();
    await operations.getReadiness();

    expect(requests.map(({ url }) => url)).toEqual([
      "https://fabric.example.test/api/v1/handoffs/handoff%20%2F%2001",
      "https://fabric.example.test/api/v1/handoffs/handoff%20%2F%2001/events?from_version=2&limit=25",
      "https://fabric.example.test/api/v1/partitions/partition%20%2F%2001/handoffs?limit=20",
      "https://fabric.example.test/api/v1/partitions/partition%20%2F%2001/events?after_position=0&limit=30",
      "https://fabric.example.test/api/v1/admin/subscriptions?limit=15",
      "https://fabric.example.test/api/v1/admin/projection-failures?projector_id=projector+%2F+01&partition_id=partition+%2F+01&limit=10",
      "https://fabric.example.test/api/v1/admin/delivery-attempts?subscription_id=subscription+%2F+01&event_id=event+%2F+01&limit=5",
      "https://fabric.example.test/api/v1/admin/delivery-position?subscription_id=subscription+%2F+01&partition_id=partition+%2F+01",
      "https://fabric.example.test/api/v1/admin/health",
      "https://fabric.example.test/api/health/live",
      "https://fabric.example.test/api/health/ready",
    ]);
    expect(requests[8]?.headers.get("x-wf-actor-id")).toBe("actor_01");
    expect(requests[9]?.headers.get("x-wf-actor-id")).toBeNull();
    expect(requests[10]?.headers.get("x-wf-actor-id")).toBeNull();
  });

  it("rejects invalid positions before I/O and maps Problem Details", async () => {
    const fetch = vi.fn(async () => json({
      type: "urn:work-fabric:problem:not_found",
      title: "Handoff not found",
      status: 404,
      code: "not_found",
    }, 404)) as unknown as typeof globalThis.fetch;
    const { queries, operations } = clients(fetch);

    expect(() => queries.listHandoffEvents("handoff_01", { fromVersion: 0 })).toThrow(TypeError);
    expect(() => queries.listPartitionEvents("partition_01", { afterPosition: -1 })).toThrow(TypeError);
    expect(() => operations.listSubscriptions({ limit: Number.MAX_SAFE_INTEGER + 1 })).toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();

    await expect(queries.getHandoff("handoff_01")).rejects.toBeInstanceOf(WorkFabricHttpError);
  });
});
