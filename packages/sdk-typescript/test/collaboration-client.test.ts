import { describe, expect, it, vi } from "vitest";

import {
  BearerTokenProvider,
  WorkFabricClient,
  WorkFabricTransportError,
} from "../src/index.js";

function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const freshness = {
  projector_id: "workfabric.collaboration.visibility.v1",
  partition_id: "partition / 1",
  projected_position: 4,
  journal_position: 5,
  observed_at: "2026-07-16T02:00:00.000Z",
};

describe("CollaborationClient", () => {
  it("maps all collaboration resources through the shared transport", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return response({ items: [], next_cursor: null, freshness });
    }) as unknown as typeof globalThis.fetch;
    const client = new WorkFabricClient({
      baseUrl: "https://fabric.example.test/api",
      tenantId: "tenant-1",
      exchangeId: "exchange-1",
      representation: { actorId: "actor-1", endpointId: "endpoint-1" },
      authentication: new BearerTokenProvider("token"),
      fetch,
      queryRetry: { maxRetries: 0 },
    });

    await client.collaboration.listResponsibilities({
      partitionId: "partition / 1",
      responsibleActorId: "agent / 1",
      lifecycleStates: ["accepted"],
      priorities: ["high"],
      limit: 20,
    });
    await client.collaboration.listTimeline({
      partitionId: "partition / 1",
      handoffId: "handoff / 1",
      cursor: "cursor / 1",
      limit: 10,
    });
    await client.collaboration.listRelationships({
      partitionId: "partition / 1",
      threadId: "thread / 1",
      limit: 5,
    });

    expect(urls).toEqual([
      "https://fabric.example.test/api/v1/responsibilities?partition_id=partition+%2F+1&responsible_actor_id=agent+%2F+1&lifecycle_state=accepted&priority=high&limit=20",
      "https://fabric.example.test/api/v1/timeline?partition_id=partition+%2F+1&handoff_id=handoff+%2F+1&cursor=cursor+%2F+1&limit=10",
      "https://fabric.example.test/api/v1/relationships?partition_id=partition+%2F+1&thread_id=thread+%2F+1&limit=5",
    ]);
  });

  it("rejects invalid input and malformed freshness before returning data", async () => {
    const fetch = vi.fn(async () => response({
      items: [],
      next_cursor: null,
      freshness: { ...freshness, projected_position: -1 },
    })) as unknown as typeof globalThis.fetch;
    const client = new WorkFabricClient({
      baseUrl: "https://fabric.example.test",
      tenantId: "tenant-1",
      exchangeId: "exchange-1",
      representation: { actorId: "actor-1", endpointId: "endpoint-1" },
      authentication: new BearerTokenProvider("token"),
      fetch,
      queryRetry: { maxRetries: 0 },
    });

    expect(() => client.collaboration.listResponsibilities({
      partitionId: "partition-1",
      lifecycleStates: ["made_up" as "accepted"],
    })).toThrow(/lifecycle/i);
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      client.collaboration.listTimeline({ partitionId: "partition-1" }),
    ).rejects.toMatchObject({
      name: WorkFabricTransportError.name,
      code: "invalid_response",
    });
  });

  it("rejects content-bearing extra fields instead of passing them to callers", async () => {
    const fetch = vi.fn(async () => response({
      items: [{
        tenant_id: "tenant-1",
        partition_id: "partition-1",
        partition_position: 1,
        handoff_id: "handoff-1",
        thread_id: "thread-1",
        stream_version: 1,
        event_id: "event-1",
        event_type: "workfabric.handoff.offered.v1",
        occurred_at: "2026-07-16T01:00:00.000Z",
        subject: "handoff-1",
        event_source: "urn:work-fabric:exchange:exchange-1",
        actor_id: "actor-1",
        endpoint_id: "endpoint-1",
        correlation_id: null,
        causation_id: null,
        change: {},
        access_token: "must-not-cross-sdk-boundary",
      }],
      next_cursor: null,
      freshness: { ...freshness, partition_id: "partition-1" },
    })) as unknown as typeof globalThis.fetch;
    const client = new WorkFabricClient({
      baseUrl: "https://fabric.example.test",
      tenantId: "tenant-1",
      exchangeId: "exchange-1",
      representation: { actorId: "actor-1", endpointId: "endpoint-1" },
      authentication: new BearerTokenProvider("token"),
      fetch,
      queryRetry: { maxRetries: 0 },
    });

    await expect(
      client.collaboration.listTimeline({ partitionId: "partition-1" }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});
