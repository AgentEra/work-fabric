import type { FastifyInstance, FastifyReply } from "fastify";

import type {
  AckResult,
  CursorPullService,
  PullResult,
} from "@work-fabric/exchange-runtime";
import type { AuthorityPolicy, IdentityProvider } from "@work-fabric/exchange-spi";

import type { HttpServiceConfig } from "../config.js";
import { createProblemDetails } from "../problem-details.js";
import type { HttpRequestAuthenticator } from "../public-types.js";
import { authorizeRoute } from "./route-authorization.js";

export type DurableDeliveryService = Pick<
  CursorPullService,
  "pull" | "acknowledge" | "pullSse"
>;

interface Dependencies {
  readonly authenticator: HttpRequestAuthenticator;
  readonly identity: IdentityProvider;
  readonly authority: AuthorityPolicy;
  readonly delivery: DurableDeliveryService;
}

interface PullBody {
  readonly partition_id: string;
  readonly cursor: string | null;
  readonly limit: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pullBody(value: unknown, config: HttpServiceConfig): PullBody | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !["partition_id", "cursor", "limit"].includes(key))) {
    return null;
  }
  const partitionId = value.partition_id;
  const cursor = value.cursor ?? null;
  const limit = value.limit ?? config.default_page_limit;
  if (
    typeof partitionId !== "string" ||
    partitionId.length === 0 ||
    partitionId.length > 256 ||
    (cursor !== null &&
      (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 2048)) ||
    !Number.isSafeInteger(limit) ||
    (limit as number) <= 0 ||
    (limit as number) > config.max_page_limit
  ) {
    return null;
  }
  return { partition_id: partitionId, cursor, limit: limit as number };
}

function jsonRequest(reply: FastifyReply, contentType: unknown, url: string): boolean {
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;|$)/i.test(contentType)
  ) {
    reply
      .type("application/problem+json")
      .code(415)
      .send(
        createProblemDetails(
          415,
          "unsupported_media_type",
          "Unsupported media type",
          { instance: url },
        ),
      );
    return false;
  }
  return true;
}

function problem(
  reply: FastifyReply,
  status: number,
  code: string,
  title: string,
  url: string,
) {
  return reply
    .type("application/problem+json")
    .code(status)
    .send(createProblemDetails(status, code, title, { instance: url }));
}

function pullProblem(reply: FastifyReply, result: Extract<PullResult, { kind: "error" }>, url: string) {
  const status =
    result.code === "invalid_argument"
      ? 400
      : result.code === "cursor_expired"
        ? 410
        : 412;
  const title =
    result.code === "invalid_argument"
      ? "Invalid pull request"
      : result.code === "cursor_expired"
        ? "Cursor expired"
        : "Pull precondition failed";
  return problem(reply, status, result.code, title, url);
}

function ackProblem(reply: FastifyReply, result: Extract<AckResult, { kind: "error" }>, url: string) {
  const status =
    result.code === "invalid_argument"
      ? 400
      : result.code === "not_found"
        ? 404
        : result.code === "cursor_expired"
          ? 410
          : 412;
  const title =
    result.code === "invalid_argument"
      ? "Invalid acknowledgement"
      : result.code === "not_found"
        ? "Delivery not found"
        : result.code === "cursor_expired"
          ? "Cursor expired"
          : "Acknowledgement precondition failed";
  return problem(reply, status, result.code, title, url);
}

export function registerDeliveryRoutes(
  server: FastifyInstance,
  dependencies: Dependencies,
  config: HttpServiceConfig,
): void {
  server.post<{ Params: { id: string } }>(
    "/v1/subscriptions/:id/pull",
    async (request, reply) => {
      reply.header("x-request-id", request.id);
      if (!jsonRequest(reply, request.headers["content-type"], request.url)) return;
      const body = pullBody(request.body, config);
      if (body === null) {
        return problem(reply, 400, "invalid_argument", "Invalid pull request", request.url);
      }
      const identity = await authorizeRoute(
        request,
        dependencies,
        "workfabric.subscription.pull.v1",
        request.params.id,
      );
      if (identity.kind === "denied") {
        return reply
          .type("application/problem+json")
          .code(identity.problem.status)
          .send(identity.problem);
      }
      const result = await dependencies.delivery.pull(
        request.params.id,
        body.partition_id,
        body.cursor,
        body.limit,
      );
      return result.kind === "error"
        ? pullProblem(reply, result, request.url)
        : reply.code(200).send(result);
    },
  );

  server.post<{ Params: { id: string } }>(
    "/v1/subscriptions/:id/ack",
    async (request, reply) => {
      reply.header("x-request-id", request.id);
      if (!jsonRequest(reply, request.headers["content-type"], request.url)) return;
      if (!isObject(request.body)) {
        return problem(reply, 400, "invalid_argument", "Invalid acknowledgement", request.url);
      }
      if (request.body.subscription_id !== request.params.id) {
        return problem(
          reply,
          412,
          "precondition_failed",
          "Subscription does not match request path",
          request.url,
        );
      }
      const identity = await authorizeRoute(
        request,
        dependencies,
        "workfabric.subscription.ack.v1",
        request.params.id,
      );
      if (identity.kind === "denied") {
        return reply
          .type("application/problem+json")
          .code(identity.problem.status)
          .send(identity.problem);
      }
      const result = await dependencies.delivery.acknowledge(request.body);
      return result.kind === "error"
        ? ackProblem(reply, result, request.url)
        : reply.code(200).send(result);
    },
  );
}
