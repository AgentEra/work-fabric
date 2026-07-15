import { describe, expect, it, vi } from "vitest";

import {
  BearerTokenProvider,
  SubscriptionClient,
  type DeliveryAck,
  type EventDelivery,
  type SubscriptionDocument,
} from "../src/index.js";
import { normalizeClientOptions } from "../src/config.js";
import { SdkTransport } from "../src/transport.js";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fixture(fetch: typeof globalThis.fetch) {
  const config = normalizeClientOptions({
    baseUrl: "https://fabric.example.test",
    tenantId: "tenant_01",
    exchangeId: "exchange_01",
    representation: { actorId: "agent_01", endpointId: "runtime_01" },
    authentication: new BearerTokenProvider("token"),
    fetch,
    clock: { now: () => "2026-07-15T10:02:00.000Z" },
  });
  return new SubscriptionClient(config, new SdkTransport(config), config.representation);
}

const subscription: SubscriptionDocument = {
  subscription_id: "subscription_01",
  owner: { actor_id: "agent_01", actor_type: "agent" },
  endpoint_id: "runtime_01",
  filter: {
    event_types: ["workfabric.handoff.accepted.v1"], actor_ids: [], endpoint_ids: [],
    thread_ids: [], handoff_ids: [], work_reference_uris: [], capability_ids: [], lifecycle_states: [],
  },
  delivery: { mode: "cursor_pull" },
  state: "active",
  cursor: null,
  created_at: "2026-07-15T10:00:00.000Z",
  updated_at: "2026-07-15T10:00:00.000Z",
};

const delivery: EventDelivery = {
  delivery_id: "delivery_01",
  subscription_id: "subscription_01",
  attempt: 1,
  events: [{
    specversion: "1.0", id: "event_01", source: "urn:work-fabric:exchange:exchange_01",
    type: "workfabric.handoff.accepted.v1", subject: "handoff_01", time: "2026-07-15T10:01:00.000Z",
    datacontenttype: "application/json", dataschema: "urn:test", wftenant: "tenant_01",
    wfexchange: "exchange_01", wfthread: "thread_01", wfhandoff: "handoff_01", wfactor: "agent_01",
    wfendpoint: "runtime_01", wfsequence: 2, wfvisibility: "participants", data: { resource_version: 2 },
  }],
  next_cursor: "cursor_02",
  delivered_at: "2026-07-15T10:01:00.000Z",
  visibility_expires_at: "2026-07-15T10:02:00.000Z",
};

describe("SubscriptionClient", () => {
  it("gets, puts, pulls, and acknowledges through canonical endpoints without write retry", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    let ackCount = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ url: String(input), method: String(init?.method), ...(body === undefined ? {} : { body }) });
      if (init?.method === "GET") return json(subscription);
      if (init?.method === "PUT") return json(subscription);
      if (String(input).endsWith("/pull")) return json({ kind: "delivery", delivery });
      ackCount += 1;
      return json({ kind: ackCount === 1 ? "acknowledged" : "acknowledged", cursor: "cursor_02" });
    }) as unknown as typeof globalThis.fetch;
    const client = fixture(fetch);

    await expect(client.get("subscription_01")).resolves.toEqual(subscription);
    await expect(client.put(subscription)).resolves.toEqual(subscription);
    await expect(client.pull("subscription_01", { partitionId: "partition_01" })).resolves.toEqual({ kind: "delivery", delivery });
    const ack: DeliveryAck = {
      delivery_id: "delivery_01", subscription_id: "subscription_01", outcome: "acknowledged",
      acknowledged_at: "2026-07-15T10:02:00.000Z", last_event_id: "event_01", cursor: "cursor_02",
    };
    await expect(client.acknowledge(ack)).resolves.toEqual({ kind: "acknowledged", cursor: "cursor_02" });
    await expect(client.acknowledge(ack)).resolves.toEqual({ kind: "acknowledged", cursor: "cursor_02" });

    expect(requests).toEqual([
      { url: "https://fabric.example.test/v1/subscriptions/subscription_01", method: "GET" },
      { url: "https://fabric.example.test/v1/subscriptions/subscription_01", method: "PUT", body: subscription },
      { url: "https://fabric.example.test/v1/subscriptions/subscription_01/pull", method: "POST", body: { partition_id: "partition_01", cursor: null } },
      { url: "https://fabric.example.test/v1/subscriptions/subscription_01/ack", method: "POST", body: ack },
      { url: "https://fabric.example.test/v1/subscriptions/subscription_01/ack", method: "POST", body: ack },
    ]);
  });

  it("maps idle Pull and builds an explicit acknowledgement from a Delivery", async () => {
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/pull")) return json({ kind: "idle", cursor: "cursor_01" });
      bodies.push(JSON.parse(String(init?.body)));
      return json({ kind: "retry", cursor: "cursor_02" });
    }) as unknown as typeof globalThis.fetch;
    const client = fixture(fetch);

    await expect(client.pull("subscription_01", { partitionId: "partition_01", cursor: "cursor_01", limit: 25 })).resolves.toEqual({ kind: "idle", cursor: "cursor_01" });
    await expect(client.acknowledgeDelivery(delivery, "retry", { details: { reason: "busy" } })).resolves.toEqual({ kind: "retry", cursor: "cursor_02" });
    expect(bodies).toEqual([{
      delivery_id: "delivery_01", subscription_id: "subscription_01", outcome: "retry",
      acknowledged_at: "2026-07-15T10:02:00.000Z", last_event_id: "event_01", cursor: "cursor_02",
      details: { reason: "busy" },
    }]);
  });

  it("rejects an empty Delivery acknowledgement before I/O", () => {
    const fetch = vi.fn(async () => json({})) as unknown as typeof globalThis.fetch;
    const client = fixture(fetch);
    expect(() => client.acknowledgeDelivery({ ...delivery, events: [] }, "acknowledged")).toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
