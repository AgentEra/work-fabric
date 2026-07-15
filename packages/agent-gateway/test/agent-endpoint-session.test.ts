import { describe, expect, it, vi } from "vitest";

import {
  WorkFabricHttpError,
  type AckResult,
  type EndpointSession,
  type EventDelivery,
  type HandoffReadModel,
  type SubscriptionDocument,
} from "@work-fabric/sdk-typescript";

import {
  AgentGateway,
  BoundedAsyncQueue,
  type AgentGatewayClient,
} from "../src/index.js";

const subscription: SubscriptionDocument = {
  subscription_id: "subscription_agent",
  owner: { actor_id: "actor_agent", actor_type: "agent" },
  endpoint_id: "endpoint_agent",
  filter: {
    event_types: [], actor_ids: [], endpoint_ids: [], thread_ids: [],
    handoff_ids: [], work_reference_uris: [], capability_ids: [], lifecycle_states: [],
  },
  delivery: { mode: "sse" },
  state: "active",
  cursor: null,
  created_at: "2026-07-15T00:00:00Z",
  updated_at: "2026-07-15T00:00:00Z",
};

const partitionId = "handoff:handoff_01";

const endpointSession: EndpointSession = {
  endpoint_id: "endpoint_agent",
  actor: subscription.owner,
  session_id: "session_01",
  client_session_id: "client_01",
  protocol_version: "1.0",
  capabilities: [],
  availability: "available",
  accepted_lease_seconds: 60,
  fencing_token: 1,
  heartbeat_sequence: 0,
  state: "active",
  expires_at: "2026-07-15T00:01:00Z",
  renew_after: "2026-07-15T00:00:50Z",
  registration_version: 1,
};

const delivery: EventDelivery = {
  delivery_id: "delivery_01",
  subscription_id: subscription.subscription_id,
  next_cursor: "cursor_01",
  events: [{
    specversion: "1.0",
    id: "event_01",
    source: "urn:work-fabric:exchange:exchange_01",
    type: "workfabric.handoff.offered.v1",
    subject: "handoff_01",
    time: "2026-07-15T00:00:00Z",
    datacontenttype: "application/json",
    dataschema: "urn:work-fabric:schema:v1:event-data",
    wftenant: "tenant_01",
    wfexchange: "exchange_01",
    wfthread: "thread_01",
    wfhandoff: "handoff_01",
    wfactor: "actor_sender",
    wfendpoint: "endpoint_sender",
    wfsequence: 1,
    wfvisibility: "participants",
    data: { resource_version: 1 },
  }],
  attempt: 1,
  delivered_at: "2026-07-15T00:00:00Z",
  visibility_expires_at: "2026-07-15T00:01:00Z",
};

const handoff: HandoffReadModel = {
  tenant_id: "tenant_01",
  partition_id: partitionId,
  handoff_id: "handoff_01",
  stream_version: 1,
  state: { lifecycle_state: "offered" },
  latest_status: null,
};

function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
}

function fakeClient(options: { readonly fencedHeartbeat?: boolean } = {}) {
  const acknowledge = vi.fn(async (): Promise<AckResult> => ({ kind: "acknowledged", cursor: "cursor_01" }));
  const heartbeat = vi.fn(async () => {
    if (options.fencedHeartbeat) {
      throw new WorkFabricHttpError({
        type: "urn:work-fabric:problem:session_fenced",
        title: "Endpoint state conflict",
        status: 409,
        code: "session_fenced",
      }, "request_01");
    }
    return { ...endpointSession, heartbeat_sequence: 1 };
  });
  const accept = vi.fn();
  const client = {
    endpoints: {
      openSession: vi.fn(async () => structuredClone(endpointSession)),
      heartbeat,
      closeSession: vi.fn(async () => ({ ...endpointSession, state: "closed" as const })),
      listInboxPartitions: vi.fn(async () => ({ items: [{ partition_id: partitionId, latest_position: 1, active_handoff_count: 1 }] })),
    },
    subscriptions: {
      get: vi.fn(async () => structuredClone(subscription)),
      put: vi.fn(async () => structuredClone(subscription)),
      acknowledgeDelivery: acknowledge,
      async *stream(_id: string, _input: unknown, request?: { signal?: AbortSignal }) {
        yield structuredClone(delivery);
        await waitForAbort(request?.signal);
      },
    },
    queries: { getHandoff: vi.fn(async () => structuredClone(handoff)) },
    handoffs: { accept },
  } as unknown as AgentGatewayClient;
  return { client, acknowledge, heartbeat, accept };
}

function config() {
  return {
    endpoint_id: "endpoint_agent",
    subscription,
    open_session: {
      client_session_id: "client_01",
      protocol_version: "1.0",
      capabilities: [],
      availability: "available" as const,
      requested_lease_seconds: 60,
      expected_registration_version: 1,
    },
    inbox_refresh_ms: 1_000,
    max_active_partitions: 8,
    incoming_queue_capacity: 2,
    heartbeat_retry_count: 0,
    heartbeat_backoff_ms: 10,
    graceful_close_timeout_ms: 1_000,
  };
}

describe("AgentGateway", () => {
  it("delivers incoming Handoffs without implicit Ack or Accept", async () => {
    const fake = fakeClient();
    const gateway = new AgentGateway(fake.client, config());
    const session = await gateway.start();

    const incoming = await session.incoming()[Symbol.asyncIterator]().next();

    expect(incoming.done).toBe(false);
    expect(incoming.value?.handoff.handoff_id).toBe("handoff_01");
    expect(fake.acknowledge).not.toHaveBeenCalled();
    expect(fake.accept).not.toHaveBeenCalled();
    await incoming.value?.acknowledgeSignal("acknowledged");
    expect(fake.acknowledge).toHaveBeenCalledOnce();
    expect(fake.accept).not.toHaveBeenCalled();
    await session.close();
  });

  it("stops the local session when the server fences its heartbeat", async () => {
    const fake = fakeClient({ fencedHeartbeat: true });
    const gateway = new AgentGateway(fake.client, config(), {
      now: () => "2026-07-15T00:00:50Z",
      sleep: async () => {},
    });
    const session = await gateway.start();

    await expect(session.closed).resolves.toEqual({ reason: "fenced" });
    expect(fake.heartbeat).toHaveBeenCalledOnce();
  });
});

describe("BoundedAsyncQueue", () => {
  it("backpressures a producer instead of dropping an item", async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    await queue.push(1);
    let secondCompleted = false;
    const second = queue.push(2).then(() => { secondCompleted = true; });
    await Promise.resolve();
    expect(secondCompleted).toBe(false);

    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    await second;
    await expect(iterator.next()).resolves.toEqual({ value: 2, done: false });
    queue.close();
  });
});
