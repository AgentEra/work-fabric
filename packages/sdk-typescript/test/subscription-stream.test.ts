import { describe, expect, it, vi } from "vitest";

import {
  BearerTokenProvider,
  SubscriptionClient,
  WorkFabricTransportError,
  type EventDelivery,
} from "../src/index.js";
import { normalizeClientOptions } from "../src/config.js";
import { SdkTransport } from "../src/transport.js";

const delivery = (cursor: string): EventDelivery => ({
  delivery_id: `delivery_${cursor}`,
  subscription_id: "subscription_01",
  attempt: 1,
  events: [{
    specversion: "1.0", id: `event_${cursor}`, source: "urn:test", type: "workfabric.handoff.accepted.v1",
    subject: "handoff_01", time: "2026-07-15T10:00:00.000Z", datacontenttype: "application/json",
    dataschema: "urn:test", wftenant: "tenant_01", wfexchange: "exchange_01", wfthread: "thread_01",
    wfhandoff: "handoff_01", wfactor: "agent_01", wfendpoint: "runtime_01", wfsequence: 1,
    wfvisibility: "participants", data: { resource_version: 1 },
  }],
  next_cursor: cursor,
  delivered_at: "2026-07-15T10:00:00.000Z",
  visibility_expires_at: "2026-07-15T10:01:00.000Z",
});

function sse(value: EventDelivery) {
  return `id: ${value.next_cursor}\nevent: workfabric.delivery\ndata: ${JSON.stringify(value)}\n\n`;
}

function streamResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  }), { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

function client(
  fetch: typeof globalThis.fetch,
  options: { maxReconnects?: number; sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void> } = {},
) {
  const config = normalizeClientOptions({
    baseUrl: "https://fabric.example.test",
    tenantId: "tenant_01",
    exchangeId: "exchange_01",
    representation: { actorId: "agent_01", endpointId: "runtime_01" },
    authentication: new BearerTokenProvider(async () => `token-${Date.now()}`),
    fetch,
    requestTimeoutMs: 100,
    streamReconnect: { maxReconnects: options.maxReconnects ?? 2, baseDelayMs: 10, maxDelayMs: 20 },
  });
  const transport = new SdkTransport(config, {
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    random: () => 1,
  });
  return new SubscriptionClient(config, transport, config.representation);
}

describe("SubscriptionClient.stream", () => {
  it("authenticates each connection, resumes before yield, preserves duplicates, and never auto-Acks", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const responses = [streamResponse(sse(delivery("cursor_01"))), streamResponse(sse(delivery("cursor_01")))];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return responses.shift() ?? streamResponse("");
    }) as unknown as typeof globalThis.fetch;
    const sleeps: number[] = [];
    const controller = new AbortController();
    const iterator = client(fetch, { sleep: async (milliseconds) => { sleeps.push(milliseconds); } })
      .stream("subscription_01", { partitionId: "partition / 01", cursor: "cursor_00" }, { signal: controller.signal })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { next_cursor: "cursor_01" }, done: false });
    await expect(iterator.next()).resolves.toMatchObject({ value: { next_cursor: "cursor_01" }, done: false });
    controller.abort();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://fabric.example.test/v1/subscriptions/subscription_01/events?partition_id=partition+%2F+01",
      "https://fabric.example.test/v1/subscriptions/subscription_01/events?partition_id=partition+%2F+01",
    ]);
    expect(requests[0]?.headers.get("last-event-id")).toBe("cursor_00");
    expect(requests[1]?.headers.get("last-event-id")).toBe("cursor_01");
    expect(requests.every(({ headers }) => headers.get("authorization")?.startsWith("Bearer token-") === true)).toBe(true);
    expect(requests.every(({ headers }) => headers.get("x-wf-actor-id") === "agent_01")).toBe(true);
    expect(sleeps).toEqual([10]);
    expect(requests.every(({ url }) => !url.endsWith("/ack"))).toBe(true);
  });

  it("rejects malformed frames without reconnecting", async () => {
    const fetch = vi.fn(async () => streamResponse("event: wrong\nid: cursor\ndata: {}\n\n")) as unknown as typeof globalThis.fetch;
    const iterator = client(fetch).stream("subscription_01", { partitionId: "partition_01" })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "stream_protocol_error" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("bounds reconnects and reports exhaustion without response content", async () => {
    const secret = "delivery-secret";
    const fetch = vi.fn(async () => { throw new Error(secret); }) as unknown as typeof globalThis.fetch;
    const sleeps: number[] = [];
    const iterator = client(fetch, { maxReconnects: 2, sleep: async (milliseconds) => { sleeps.push(milliseconds); } })
      .stream("subscription_01", { partitionId: "partition_01" })[Symbol.asyncIterator]();
    const error = await iterator.next().catch((candidate: unknown) => candidate);
    expect(error).toBeInstanceOf(WorkFabricTransportError);
    if (!(error instanceof WorkFabricTransportError)) throw new TypeError("expected stream error");
    expect(error).toMatchObject({ code: "stream_reconnect_exhausted" });
    expect(error.message).not.toContain(secret);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it("ends cleanly when aborted during reconnect backoff", async () => {
    const fetch = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof globalThis.fetch;
    const controller = new AbortController();
    const iterator = client(fetch).stream("subscription_01", { partitionId: "partition_01" }, { signal: controller.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
  });

  it("ends cleanly when aborted during stream Fetch or read", async () => {
    const fetchController = new AbortController();
    const hangingFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new DOMException("aborted", "AbortError"));
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      })) as unknown as typeof globalThis.fetch;
    const fetching = client(hangingFetch).stream("subscription_01", { partitionId: "partition_01" }, { signal: fetchController.signal })[Symbol.asyncIterator]();
    const fetchPending = fetching.next();
    await Promise.resolve();
    fetchController.abort();
    await expect(fetchPending).resolves.toEqual({ value: undefined, done: true });

    const readController = new AbortController();
    let streamStarted!: () => void;
    const started = new Promise<void>((resolve) => { streamStarted = resolve; });
    const hangingRead = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamStarted();
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof globalThis.fetch;
    const reading = client(hangingRead).stream("subscription_01", { partitionId: "partition_01" }, { signal: readController.signal })[Symbol.asyncIterator]();
    const readPending = reading.next();
    await started;
    readController.abort();
    await expect(readPending).resolves.toEqual({ value: undefined, done: true });
  });
});
