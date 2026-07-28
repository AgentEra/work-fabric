import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthorityPolicy, IdentityProvider } from "@work-fabric/exchange-spi";
import type { HttpServiceConfig } from "../config.js";
import type { HttpRequestAuthenticator } from "../public-types.js";
import type { ExchangeQueryService } from "../query-service.js";
import { createProblemDetails } from "../problem-details.js";
import { authorizeRoute } from "./route-authorization.js";

interface Dependencies { readonly authenticator: HttpRequestAuthenticator; readonly identity: IdentityProvider; readonly authority: AuthorityPolicy; readonly query: ExchangeQueryService }

function integer(value: unknown, fallback: number, max: number, allowZero = false): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= max && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : null;
}

function invalid(reply: FastifyReply, url: string) {
  return reply.code(400).type("application/problem+json").send(createProblemDetails(400, "invalid_request", "Invalid request", { instance: url }));
}

function digest(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    !/^(?:sha-256|sha-384|sha-512):[^\s:][^\s]*$/.test(value)
  ) return undefined;
  return value;
}

async function authorized(request: Parameters<typeof authorizeRoute>[0], reply: FastifyReply, deps: Dependencies, action: string, resource: string) {
  const result = await authorizeRoute(request, deps, action, resource);
  if (result.kind === "denied") {
    reply.code(result.problem.status).type("application/problem+json").send(result.problem);
    return null;
  }
  return result;
}

export function registerQueryRoutes(server: FastifyInstance, deps: Dependencies, config: HttpServiceConfig): void {
  server.get<{ Params: { id: string } }>("/v1/handoffs/:id", async (request, reply) => {
    const auth = await authorized(request, reply, deps, "workfabric.query.handoff.read.v1", request.params.id);
    if (auth === null) return;
    const model = await deps.query.getHandoff(auth.principal.tenant_id, request.params.id);
    if (model === null) return reply.code(404).type("application/problem+json").send(createProblemDetails(404, "not_found", "Handoff not found", { instance: request.url }));
    return reply.send(model);
  });
  server.get<{
    Params: { id: string; version: string };
    Querystring: { digest?: string };
  }>("/v1/contexts/:id/versions/:version", async (request, reply) => {
    const version = integer(request.params.version, 0, Number.MAX_SAFE_INTEGER);
    const normalizedDigest = digest(request.query.digest);
    if (version === null || normalizedDigest === undefined) {
      return invalid(reply, request.url);
    }
    const auth = await authorized(
      request,
      reply,
      deps,
      "workfabric.context.content.read.v1",
      request.params.id,
    );
    if (auth === null) return;
    const bundle = await deps.query.getContextBundle(
      auth.principal.tenant_id,
      auth.actor.actor_id,
      auth.endpoint_id,
      {
        context_id: request.params.id,
        version,
        digest: normalizedDigest,
      },
    );
    if (bundle === null) {
      return reply.code(404).type("application/problem+json").send(
        createProblemDetails(
          404,
          "context_unavailable",
          "Context is unavailable",
          { instance: request.url },
        ),
      );
    }
    return reply.send(bundle);
  });
  server.get<{ Params: { id: string }; Querystring: { from_version?: string; limit?: string } }>("/v1/handoffs/:id/events", async (request, reply) => {
    const auth = await authorized(request, reply, deps, "workfabric.query.handoff.read.v1", request.params.id);
    if (auth === null) return;
    const from = integer(request.query.from_version, 1, Number.MAX_SAFE_INTEGER);
    const limit = integer(request.query.limit, config.default_page_limit, config.max_page_limit);
    if (from === null || limit === null) return invalid(reply, request.url);
    return reply.send({ events: await deps.query.readHandoffEvents(auth.principal.tenant_id, request.params.id, from, limit) });
  });
  server.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/v1/partitions/:id/handoffs", async (request, reply) => {
    const limit = integer(request.query.limit, config.default_page_limit, config.max_page_limit);
    if (limit === null) return invalid(reply, request.url);
    const auth = await authorized(request, reply, deps, "workfabric.operations.partition.read.v1", request.params.id);
    if (auth === null) return;
    return reply.send({ handoffs: await deps.query.listPartitionHandoffs(auth.principal.tenant_id, request.params.id, limit) });
  });
  server.get<{ Params: { id: string }; Querystring: { after_position?: string; limit?: string } }>("/v1/partitions/:id/events", async (request, reply) => {
    const after = integer(request.query.after_position, 0, Number.MAX_SAFE_INTEGER, true);
    const limit = integer(request.query.limit, config.default_page_limit, config.max_page_limit);
    if (after === null || limit === null) return invalid(reply, request.url);
    const auth = await authorized(request, reply, deps, "workfabric.operations.partition.read.v1", request.params.id);
    if (auth === null) return;
    return reply.send({ events: await deps.query.readPartitionEvents(auth.principal.tenant_id, request.params.id, after, limit) });
  });
}
