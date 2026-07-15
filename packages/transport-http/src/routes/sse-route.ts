import type { FastifyInstance } from "fastify";

import type { AuthorityPolicy, IdentityProvider } from "@work-fabric/exchange-spi";

import type { HttpServiceConfig } from "../config.js";
import { createProblemDetails } from "../problem-details.js";
import type { HttpRequestAuthenticator } from "../public-types.js";
import type { SseConnectionManager } from "../sse-connection-manager.js";
import type { DurableDeliveryService } from "./delivery-routes.js";
import { authorizeRoute } from "./route-authorization.js";

interface Dependencies {
  readonly authenticator: HttpRequestAuthenticator;
  readonly identity: IdentityProvider;
  readonly authority: AuthorityPolicy;
  readonly delivery: DurableDeliveryService;
  readonly connections: SseConnectionManager;
}

function singleton(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

export function registerSseRoute(
  server: FastifyInstance,
  dependencies: Dependencies,
  config: HttpServiceConfig,
): void {
  server.get<{
    Params: { id: string };
    Querystring: { partition_id?: string };
  }>("/v1/subscriptions/:id/events", async (request, reply) => {
    const partitionId = singleton(request.query.partition_id);
    const lastEventId = singleton(request.headers["last-event-id"]);
    if (
      partitionId === null ||
      partitionId.length > 256 ||
      (lastEventId !== null &&
        (lastEventId.length > 2048 || lastEventId.includes(",")))
    ) {
      return reply
        .type("application/problem+json")
        .code(400)
        .send(
          createProblemDetails(400, "invalid_argument", "Invalid partition", {
            instance: request.url,
          }),
        );
    }
    const identity = await authorizeRoute(
      request,
      dependencies,
      "workfabric.subscription.stream.v1",
      request.params.id,
    );
    if (identity.kind === "denied") {
      return reply
        .type("application/problem+json")
        .code(identity.problem.status)
        .send(identity.problem);
    }
    const lease = dependencies.connections.acquire();
    if (lease === null) {
      return reply
        .type("application/problem+json")
        .code(503)
        .send(
          createProblemDetails(
            503,
            "stream_capacity_exceeded",
            "Stream capacity exceeded",
            { instance: request.url },
          ),
        );
    }

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-request-id": request.id,
    });
    response.flushHeaders();

    let disconnected = false;
    const disconnect = () => { disconnected = true; };
    request.raw.once("close", disconnect);
    lease.signal.addEventListener("abort", disconnect, { once: true });
    let lastEmittedCursor: string | null = null;
    let lastWriteAt = Date.now();
    let idleSince = Date.now();

    try {
      while (!disconnected && !lease.signal.aborted) {
        const result = await dependencies.delivery.pullSse(
          request.params.id,
          partitionId,
          lastEventId,
        );
        if (result.kind === "delivery") {
          if (result.delivery.next_cursor !== lastEmittedCursor) {
            const protocolEvent = result.delivery.events[0];
            if (protocolEvent === undefined) break;
            response.write(
              `id: ${result.delivery.next_cursor}\nevent: workfabric.event\ndata: ${JSON.stringify(protocolEvent)}\n\n`,
            );
            lastEmittedCursor = result.delivery.next_cursor;
            lastWriteAt = Date.now();
            idleSince = lastWriteAt;
          }
        } else if (result.kind === "error") {
          response.write(
            `event: workfabric.error\ndata: ${JSON.stringify({ code: result.code })}\n\n`,
          );
          break;
        }

        const now = Date.now();
        if (now - lastWriteAt >= config.sse_heartbeat_interval_ms) {
          response.write(": heartbeat\n\n");
          lastWriteAt = now;
        }
        if (now - idleSince >= config.sse_idle_timeout_ms) break;
        await wait(config.sse_poll_interval_ms, lease.signal);
      }
    } finally {
      request.raw.removeListener("close", disconnect);
      lease.release();
      if (!response.destroyed && !response.writableEnded) response.end();
    }
  });
}
