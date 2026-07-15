import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthorityPolicy, IdentityProvider, RuntimeSubscription, SubscriptionStore } from "@work-fabric/exchange-spi";
import type { WfppSchemaValidator } from "@work-fabric/protocol-runtime";
import type { HttpRequestAuthenticator } from "../public-types.js";
import type { ExchangeQueryService } from "../query-service.js";
import { createProblemDetails } from "../problem-details.js";
import { authorizeRoute } from "./route-authorization.js";
import { runtimeSubscriptionFromDocument, subscriptionDocument } from "../subscription-codec.js";

interface Dependencies { readonly authenticator: HttpRequestAuthenticator; readonly identity: IdentityProvider; readonly authority: AuthorityPolicy; readonly query: ExchangeQueryService; readonly subscriptions: SubscriptionStore; readonly schemas: WfppSchemaValidator }

function problem(reply: FastifyReply, status: number, code: string, title: string, url: string) {
  return reply.code(status).type("application/problem+json").send(createProblemDetails(status, code, title, { instance: url }));
}

export function registerSubscriptionResourceRoutes(server: FastifyInstance, deps: Dependencies): void {
  server.get<{ Params: { id: string } }>("/v1/subscriptions/:id", async (request, reply) => {
    const auth = await authorizeRoute(request, deps, "workfabric.subscription.read.v1", request.params.id);
    if (auth.kind === "denied") return reply.code(auth.problem.status).send(auth.problem);
    const value = await deps.query.getSubscription(auth.principal.tenant_id, request.params.id);
    return value === null ? problem(reply, 404, "not_found", "Subscription not found", request.url) : reply.send(subscriptionDocument(value));
  });
  server.put<{ Params: { id: string } }>("/v1/subscriptions/:id", async (request, reply) => {
    const auth = await authorizeRoute(request, deps, "workfabric.subscription.manage.v1", request.params.id);
    if (auth.kind === "denied") return reply.code(auth.problem.status).send(auth.problem);
    const validation = deps.schemas.validate("urn:work-fabric:schema:v1:subscription", request.body);
    if (!validation.valid || typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) return problem(reply, 400, "invalid_request", "Invalid Subscription", request.url);
    const document = request.body as unknown as Record<string, unknown>;
    const owner = document.owner as { readonly actor_id?: string };
    if (document.subscription_id !== request.params.id || owner.actor_id !== auth.actor.actor_id || document.endpoint_id !== auth.endpoint_id) return problem(reply, 403, "permission_denied", "Subscription ownership is not authorized", request.url);
    const delivery = document.delivery as { readonly mode?: string };
    if (delivery.mode === "webhook") return problem(reply, 422, "unsupported_delivery_mode", "Webhook delivery is not available", request.url);
    const value = runtimeSubscriptionFromDocument(document, auth.principal.tenant_id);
    await deps.subscriptions.putSubscription(value);
    return reply.send(subscriptionDocument(value));
  });
}
