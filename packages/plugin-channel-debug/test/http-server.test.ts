import { createHmac, timingSafeEqual } from "node:crypto";

import { MemoryConnectorIngressStore } from "@work-fabric/adapter-connector-memory";
import { MemoryDebugChannelStore } from "@work-fabric/adapter-debug-channel-memory";
import {
  createOpaqueCursorCodec,
  type CursorAuthenticator,
} from "@work-fabric/operations-spi";
import { afterEach, describe, expect, it } from "vitest";

import {
  DebugChannelHttpServer,
  type DebugHandoffSnapshotSource,
  validateDebugPluginConfig,
} from "../src/index.js";
import { validDebugConfig } from "./fixtures.js";

const token = "debug-token-with-enough-entropy";
const clock = { now: () => "2026-07-29T09:00:00.000Z" };

const authenticator: CursorAuthenticator = {
  async sign(payload) {
    return createHmac("sha256", "debug-cursor-secret-for-tests")
      .update(payload)
      .digest("base64url");
  },
  async verify(payload, signature) {
    const expected = Buffer.from(await this.sign(payload));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  },
};

function message(
  idempotencyKey = "message-1",
  text = "请处理这条消息",
): Record<string, unknown> {
  return {
    idempotency_key: idempotencyKey,
    participant_ref: "internal-user",
    content: [{
      kind: "text",
      media_type: "text/markdown",
      text,
    }],
  };
}

describe("DebugChannelHttpServer", () => {
  const servers: DebugChannelHttpServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  async function fixture(options: {
    readonly max_request_bytes?: number;
    readonly snapshots?: DebugHandoffSnapshotSource;
  } = {}) {
    const ingress = new MemoryConnectorIngressStore({
      id_factory: () => "ingress-1",
    });
    const diagnostics = new MemoryDebugChannelStore();
    let request = 0;
    let submission = 0;
    const config = validateDebugPluginConfig(validDebugConfig());
    const server = new DebugChannelHttpServer({
      tenant_id: "tenant-local",
      plugin_instance_id: "debug-local",
      config: {
        ...config,
        listen: { host: "127.0.0.1", port: 0 },
        credentials: { bearer_token: token },
        limits: {
          ...config.limits,
          max_request_bytes:
            options.max_request_bytes ?? config.limits.max_request_bytes,
        },
      },
      ingress,
      diagnostics,
      handoff_snapshots: options.snapshots ?? {
        async load(_tenantId, handoffId) {
          return handoffId === "handoff-1"
            ? { version: 3, lifecycle_state: "result_returned" }
            : null;
        },
      },
      clock,
      ids: {
        requestId: () => `debug_request_${++request}`,
        submissionId: () => `submission-${++submission}`,
      },
      cursor: createOpaqueCursorCodec(authenticator, { max_length: 2048 }),
    });
    servers.push(server);
    const address = await server.start();
    const baseUrl = `http://${address.host}:${address.port}`;
    return {
      ingress,
      diagnostics,
      server,
      baseUrl,
      async request(
        path: string,
        init: RequestInit = {},
        bearer = token,
      ) {
        return fetch(`${baseUrl}${path}`, {
          ...init,
          headers: {
            ...(init.body === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...(bearer === "" ? {} : { authorization: `Bearer ${bearer}` }),
            ...init.headers,
          },
        });
      },
    };
  }

  it("exposes unauthenticated health and authenticates every diagnostic route", async () => {
    const setup = await fixture();
    await expect((await setup.request("/health", {}, "")).json()).resolves
      .toEqual({ state: "healthy", code: "listening" });
    expect((await setup.request(
      "/v1/conversations/conversation-1/messages",
      { method: "POST", body: JSON.stringify(message()) },
      "",
    )).status).toBe(401);
    expect((await setup.request(
      "/v1/conversations/conversation-1/messages",
      { method: "POST", body: JSON.stringify(message()) },
      "wrong-token",
    )).status).toBe(401);
  });

  it("accepts one message through Connector Ingress and replays it idempotently", async () => {
    const setup = await fixture();
    const first = await setup.request(
      "/v1/conversations/conversation-1/messages",
      { method: "POST", body: JSON.stringify(message()) },
    );
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({
      submission_id: "submission-1",
      ingress_id: "ingress-1",
      ingress_state: "pending",
    });
    const replay = await setup.request(
      "/v1/conversations/conversation-1/messages",
      { method: "POST", body: JSON.stringify(message()) },
    );
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toMatchObject({
      submission_id: "submission-1",
      ingress_id: "ingress-1",
    });
    expect((await setup.ingress.list({
      tenant_id: "tenant-local",
      connector_id: "debug-local",
      limit: 10,
    })).items).toHaveLength(1);
  });

  it("rejects idempotency conflicts without creating a second ingress", async () => {
    const setup = await fixture();
    await setup.request(
      "/v1/conversations/conversation-1/messages",
      { method: "POST", body: JSON.stringify(message()) },
    );
    const conflict = await setup.request(
      "/v1/conversations/conversation-1/messages",
      { method: "POST", body: JSON.stringify(message("message-1", "不同内容")) },
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: {
        code: "idempotency_conflict",
        request_id: "debug_request_2",
      },
    });
    expect((await setup.ingress.list({
      tenant_id: "tenant-local",
      connector_id: "debug-local",
      limit: 10,
    })).items).toHaveLength(1);
  });

  it("fails closed for unknown participants, invalid requests and oversized bodies", async () => {
    const setup = await fixture({ max_request_bytes: 1024 });
    const unknown = {
      ...message(),
      participant_ref: "unknown-user",
    };
    expect((await setup.request(
      "/v1/conversations/conversation-1/messages",
      { method: "POST", body: JSON.stringify(unknown) },
    )).status).toBe(403);
    expect((await setup.request(
      "/v1/conversations/conversation-1/messages",
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(message()),
      },
    )).status).toBe(400);
    expect((await setup.request(
      "/v1/conversations/conversation-1/messages",
      { method: "POST", body: JSON.stringify({
        ...message(),
        padding: "x".repeat(2_000),
      }) },
    )).status).toBe(413);
    expect((await setup.ingress.list({
      tenant_id: "tenant-local",
      connector_id: "debug-local",
      limit: 10,
    })).items).toHaveLength(0);
  });

  it("reports submission correlation from the owning stores", async () => {
    const setup = await fixture();
    await setup.request(
      "/v1/conversations/conversation-1/messages",
      { method: "POST", body: JSON.stringify(message()) },
    );
    await setup.diagnostics.linkHandoff({
      tenant_id: "tenant-local",
      plugin_instance_id: "debug-local",
      submission_id: "submission-1",
      handoff_id: "handoff-1",
      updated_at: clock.now(),
    });
    const response = await setup.request("/v1/submissions/submission-1");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      submission_id: "submission-1",
      ingress: { ingress_id: "ingress-1", state: "pending" },
      handoff: {
        handoff_id: "handoff-1",
        version: 3,
        lifecycle_state: "result_returned",
      },
    });
  });

  it("lists captured canonical events with opaque scoped pagination", async () => {
    const setup = await fixture();
    for (const [index, capturedAt] of [
      ["1", "2026-07-29T09:01:00.000Z"],
      ["2", "2026-07-29T09:02:00.000Z"],
    ] as const) {
      await setup.diagnostics.appendCapture({
        capture: {
          tenant_id: "tenant-local",
          plugin_instance_id: "debug-local",
          capture_id: `capture-${index}`,
          conversation_id: "conversation-1",
          event_id: `event-${index}`,
          destination_id: "handoff:handoff-1",
          event: {
            specversion: "1.0",
            id: `event-${index}`,
            source: "urn:work-fabric:exchange:exchange-local",
            type: "workfabric.handoff.result_returned.v1",
            subject: "handoff-1",
            time: capturedAt,
            datacontenttype: "application/json",
            dataschema: "urn:work-fabric:schema:v1:event-data",
            wftenant: "tenant-local",
            wfexchange: "exchange-local",
            wfhandoff: "handoff-1",
            wfsequence: Number(index),
            wfvisibility: "participants",
            data: { resource_version: Number(index) },
          },
          captured_at: capturedAt,
          expires_at: "2026-08-12T09:00:00.000Z",
        },
      });
    }
    const first = await setup.request(
      "/v1/conversations/conversation-1/events?limit=1",
    );
    expect(first.status).toBe(200);
    const firstPage = await first.json() as {
      items: Array<{ capture_id: string }>;
      next_cursor: string;
    };
    expect(firstPage.items.map((item) => item.capture_id)).toEqual(["capture-1"]);
    const second = await setup.request(
      `/v1/conversations/conversation-1/events?limit=1&cursor=${
        encodeURIComponent(firstPage.next_cursor)
      }`,
    );
    await expect(second.json()).resolves.toMatchObject({
      items: [{ capture_id: "capture-2" }],
    });
    expect((await setup.request(
      `/v1/conversations/another/events?cursor=${
        encodeURIComponent(firstPage.next_cursor)
      }`,
    )).status).toBe(400);
    expect((await setup.request("/v1/events/capture-2")).status).toBe(200);
  });

  it("returns stable method and route errors without echoing content", async () => {
    const setup = await fixture();
    const method = await setup.request("/v1/submissions/missing", {
      method: "POST",
      body: JSON.stringify({ secret: "must-not-echo" }),
    });
    expect(method.status).toBe(405);
    expect(await method.text()).not.toContain("must-not-echo");
    expect((await setup.request("/v1/unknown")).status).toBe(404);
    expect((await setup.request("/v1/submissions/missing")).status).toBe(404);
  });
});
