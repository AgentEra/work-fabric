import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthorityPolicy, IdentityProvider } from "@work-fabric/exchange-spi";
import type { HttpServiceConfig } from "../config.js";
import type { HttpRequestAuthenticator } from "../public-types.js";
import type { ExchangeQueryService } from "../query-service.js";
import { createProblemDetails } from "../problem-details.js";
import { authorizeRoute } from "./route-authorization.js";

interface Dependencies { readonly authenticator: HttpRequestAuthenticator; readonly identity: IdentityProvider; readonly authority: AuthorityPolicy; readonly query: ExchangeQueryService }
function limit(value: string | undefined, config: HttpServiceConfig): number | null { if (value === undefined) return config.default_page_limit; if (!/^\d+$/.test(value)) return null; const n = Number(value); return Number.isSafeInteger(n) && n > 0 && n <= config.max_page_limit ? n : null; }
function invalid(reply: FastifyReply, url: string) { return reply.code(400).send(createProblemDetails(400, "invalid_request", "Invalid request", { instance: url })); }
async function auth(request: FastifyRequest, reply: FastifyReply, deps: Dependencies, action: string, resource: string) { const result = await authorizeRoute(request, deps, action, resource); if (result.kind === "denied") { reply.code(result.problem.status).send(result.problem); return null; } return result; }

export function registerAdminRoutes(server: FastifyInstance, deps: Dependencies, config: HttpServiceConfig): void {
  server.get<{ Querystring: { limit?: string } }>("/v1/admin/subscriptions", async (request, reply) => {
    const l = limit(request.query.limit, config); if (l === null) return invalid(reply, request.url);
    const identity = await authorizeRoute(
      request,
      deps,
      "workfabric.operations.subscription.list.v1",
      (principal) => principal.tenant_id,
    );
    if (identity.kind === "denied") return reply.code(identity.problem.status).send(identity.problem);
    return reply.send({ subscriptions: await deps.query.listSubscriptions(identity.principal.tenant_id, l) });
  });
  server.get<{ Querystring: { projector_id?: string; partition_id?: string; limit?: string } }>("/v1/admin/projection-failures", async (request, reply) => {
    const { projector_id: projector, partition_id: partition } = request.query; const l = limit(request.query.limit, config);
    if (!projector || !partition || l === null) return invalid(reply, request.url);
    if (await auth(request, reply, deps, "workfabric.operations.projection-failure.list.v1", partition) === null) return;
    return reply.send({ failures: await deps.query.listProjectionFailures(projector, partition, l) });
  });
  server.get<{ Querystring: { subscription_id?: string; event_id?: string; limit?: string } }>("/v1/admin/delivery-attempts", async (request, reply) => {
    const { subscription_id: subscription, event_id: event } = request.query; const l = limit(request.query.limit, config);
    if (!subscription || !event || l === null) return invalid(reply, request.url);
    if (await auth(request, reply, deps, "workfabric.operations.delivery.read.v1", subscription) === null) return;
    return reply.send({ attempts: await deps.query.listDeliveryAttempts(subscription, event, l) });
  });
  server.get<{ Querystring: { subscription_id?: string; partition_id?: string } }>("/v1/admin/delivery-position", async (request, reply) => {
    const { subscription_id: subscription, partition_id: partition } = request.query;
    if (!subscription || !partition) return invalid(reply, request.url);
    if (await auth(request, reply, deps, "workfabric.operations.delivery.read.v1", subscription) === null) return;
    return reply.send({ position: await deps.query.getDeliveryPosition(subscription, partition) });
  });
}
