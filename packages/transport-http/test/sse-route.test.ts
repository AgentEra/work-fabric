import { describe, expect, it, vi } from "vitest";

import {
  LocalAuthorityPolicy,
  LocalIdentityProvider,
} from "@work-fabric/adapter-identity-local";
import type { EventDeliveryDocument } from "@work-fabric/exchange-runtime";

import {
  BearerAuthenticationEvidenceMapper,
  createHttpService,
  normalizeHttpServiceConfig,
} from "../src/index.js";

const principal = {
  principal_id: "principal_01",
  tenant_id: "tenant_01",
  actor_claims: [
    {
      actor_id: "actor_01",
      actor_type: "agent" as const,
      endpoint_ids: ["endpoint_01"],
    },
  ],
  attributes: {},
};

const requestHeaders = {
  authorization: "Bearer known",
  "x-wf-actor-id": "actor_01",
  "x-wf-endpoint-id": "endpoint_01",
};

function event(position: number) {
  return {
    specversion: "1.0" as const,
    id: `event_${position}`,
    source: "urn:work-fabric:exchange:test",
    type: "workfabric.handoff.accepted.v1",
    subject: "handoff_01",
    time: `2026-07-15T08:00:0${position}.000Z`,
    datacontenttype: "application/json" as const,
    dataschema: "urn:work-fabric:schema:v1:protocol-event",
    wftenant: "tenant_01",
    wfexchange: "exchange_01",
    wfthread: "thread_01",
    wfhandoff: "handoff_01",
    wfactor: "actor_01",
    wfendpoint: "endpoint_01",
    wfsequence: position,
    wfvisibility: "participants" as const,
    data: { resource_version: position },
  };
}

function delivery(position: number): EventDeliveryDocument {
  return {
    delivery_id: `delivery_${position}`,
    subscription_id: "subscription_01",
    attempt: 1,
    events: [event(position)],
    next_cursor: `cursor_${position}`,
    delivered_at: `2026-07-15T08:00:0${position}.000Z`,
    visibility_expires_at: "2026-07-15T08:01:00.000Z",
  };
}

function fixture(maxConnections = 2) {
  let acknowledged = false;
  const pullSse = vi.fn(async () => ({
    kind: "delivery" as const,
    delivery: delivery(acknowledged ? 2 : 1),
  }));
  const acknowledge = vi.fn(async () => {
    acknowledged = true;
    return { kind: "acknowledged" as const, cursor: "cursor_01" };
  });
  const authority = new LocalAuthorityPolicy(
    ["workfabric.subscription.stream.v1", "workfabric.subscription.ack.v1"].map(
      (action) => ({
        tenant_id: "tenant_01",
        principal_id: "principal_01",
        actor_id: "actor_01",
        actor_type: "agent" as const,
        endpoint_id: "endpoint_01",
        action,
        resource_id: "subscription_01",
      }),
    ),
  );
  const service = createHttpService(
    {
      application: { async handle() { throw new Error("not used"); } },
      authenticator: new BearerAuthenticationEvidenceMapper(),
      identity: new LocalIdentityProvider([
        { authentication_evidence: { bearer_token: "known" }, principal },
      ]),
      authority,
      delivery: {
        async pull() { return { kind: "idle", cursor: "cursor_idle" }; },
        pullSse,
        acknowledge,
      },
    },
    normalizeHttpServiceConfig({
      sse_max_connections: maxConnections,
      sse_poll_interval_ms: 5,
      sse_heartbeat_interval_ms: 15,
      sse_idle_timeout_ms: 500,
    }),
  );
  return { service, pullSse, acknowledge };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 500,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!predicate(text)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out reading SSE: ${text}`);
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out reading SSE: ${text}`)), remaining),
      ),
    ]);
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
  }
  return text;
}

async function openStream(origin: string, signal: AbortSignal, lastEventId?: string) {
  const response = await fetch(
    `${origin}/v1/subscriptions/subscription_01/events?partition_id=partition_01`,
    {
      headers: {
        ...requestHeaders,
        ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
      },
      signal,
    },
  );
  return {
    response,
    reader: response.status === 200 ? response.body?.getReader() : undefined,
  };
}

describe("SSE subscription route", () => {
  it("streams one Protocol Event per opaque cursor and suppresses pending duplicates", async () => {
    const { service } = fixture();
    const { origin } = await service.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const { response, reader } = await openStream(origin, controller.signal);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (reader === undefined) throw new Error("expected SSE response body");
    const text = await readUntil(reader, (value) => value.includes(": heartbeat"));
    expect(text).toContain("id: cursor_1");
    expect(text).toContain(`data: ${JSON.stringify(delivery(1))}`);
    expect(text.match(/^data:/gm)).toHaveLength(1);
    controller.abort();
    await service.close();
  });

  it("replays after reconnect without Ack and continues after a separate Ack", async () => {
    const { service, acknowledge } = fixture();
    const { origin } = await service.listen({ host: "127.0.0.1", port: 0 });
    const firstController = new AbortController();
    const first = await openStream(origin, firstController.signal);
    if (first.reader === undefined) throw new Error("expected first stream");
    await readUntil(first.reader, (value) => value.includes("id: cursor_1"));
    firstController.abort();

    const replayController = new AbortController();
    const replay = await openStream(origin, replayController.signal, "cursor_1");
    if (replay.reader === undefined) throw new Error("expected replay stream");
    const replayed = await readUntil(replay.reader, (value) => value.includes("id: cursor_1"));
    expect(replayed).toContain(`data: ${JSON.stringify(delivery(1))}`);

    const ack = await fetch(`${origin}/v1/subscriptions/subscription_01/ack`, {
      method: "POST",
      headers: { ...requestHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        delivery_id: "delivery_1",
        subscription_id: "subscription_01",
        outcome: "acknowledged",
        acknowledged_at: "2026-07-15T08:00:10.000Z",
        cursor: "cursor_1",
      }),
    });
    expect(ack.status).toBe(200);
    expect(acknowledge).toHaveBeenCalledOnce();
    const continued = await readUntil(replay.reader, (value) => value.includes("id: cursor_2"));
    expect(continued).toContain(`data: ${JSON.stringify(delivery(2))}`);
    replayController.abort();
    await service.close();
  });

  it("bounds concurrent streams and releases a slot after disconnect", async () => {
    const { service } = fixture(1);
    const { origin } = await service.listen({ host: "127.0.0.1", port: 0 });
    const firstController = new AbortController();
    const first = await openStream(origin, firstController.signal);
    expect(first.response.status).toBe(200);

    const deniedController = new AbortController();
    const denied = await openStream(origin, deniedController.signal);
    expect(denied.response.status).toBe(503);
    expect(await denied.response.json()).toMatchObject({ code: "stream_capacity_exceeded" });
    deniedController.abort();

    firstController.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const nextController = new AbortController();
    const next = await openStream(origin, nextController.signal);
    expect(next.response.status).toBe(200);
    nextController.abort();
    await service.close();
  });
});
