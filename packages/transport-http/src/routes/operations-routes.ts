import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthorityPolicy, IdentityProvider, ResolvedPrincipal } from "@work-fabric/exchange-spi";
import type { ConnectorIngressState } from "@work-fabric/connector-spi";
import type { OperationsQueryService } from "@work-fabric/operations-runtime";

import type { HttpServiceConfig } from "../config.js";
import { createProblemDetails } from "../problem-details.js";
import type { HttpRequestAuthenticator } from "../public-types.js";
import { authorizeRoute } from "./route-authorization.js";

type QueryValue = string | readonly string[] | undefined;

interface Dependencies {
  readonly operations: OperationsQueryService;
  readonly authenticator: HttpRequestAuthenticator;
  readonly identity: IdentityProvider;
  readonly authority: AuthorityPolicy;
}

const ingressStates: readonly ConnectorIngressState[] = [
  "pending", "processing", "retry_wait", "completed", "dead_letter",
];
const discrepancyStatuses = ["open", "acknowledged"] as const;

function scalar(value: QueryValue): string | null {
  return typeof value === "string" && value.length > 0 &&
    value.length <= 255 && value.trim() === value
    ? value
    : null;
}

function optional(value: QueryValue): string | undefined | null {
  return value === undefined ? undefined : scalar(value);
}

function values<T extends string>(
  value: QueryValue,
  allowed: readonly T[],
): readonly T[] | undefined | null {
  if (value === undefined) return undefined;
  const input = Array.isArray(value) ? value : [value];
  if (
    input.length === 0 || input.length > 16 ||
    input.some((item) => !allowed.includes(item as T))
  ) return null;
  return [...new Set(input as readonly T[])];
}

function pageLimit(value: QueryValue, config: HttpServiceConfig): number | null {
  if (value === undefined) return config.default_page_limit;
  const input = scalar(value);
  if (input === null || !/^\d+$/.test(input)) return null;
  const parsed = Number(input);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= config.max_page_limit
    ? parsed
    : null;
}

function pageCursor(value: QueryValue): string | undefined | null {
  if (value === undefined) return undefined;
  const input = scalar(value);
  return input !== null && input.length <= 2048 ? input : null;
}

function invalid(reply: FastifyReply, url: string) {
  return reply.code(400).type("application/problem+json").send(
    createProblemDetails(400, "invalid_request", "Invalid request", { instance: url }),
  );
}

function missing(reply: FastifyReply, url: string, title: string) {
  return reply.code(404).type("application/problem+json").send(
    createProblemDetails(404, "not_found", title, { instance: url }),
  );
}

async function authorized(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: Dependencies,
  action: string,
  resource: string | ((principal: ResolvedPrincipal) => string),
) {
  const result = await authorizeRoute(request, dependencies, action, resource);
  if (result.kind === "denied") {
    reply.code(result.problem.status).type("application/problem+json").send(result.problem);
    return null;
  }
  return result;
}

function page(query: { cursor?: QueryValue; limit?: QueryValue }, config: HttpServiceConfig) {
  const cursor = pageCursor(query.cursor);
  const limit = pageLimit(query.limit, config);
  if (cursor === null || limit === null) return null;
  return { ...(cursor === undefined ? {} : { cursor }), limit };
}

export function registerOperationsRoutes(
  server: FastifyInstance,
  dependencies: Dependencies,
  config: HttpServiceConfig,
): void {
  server.get<{ Params: { projectorId: string; partitionId: string } }>(
    "/v1/operations/projections/:projectorId/partitions/:partitionId",
    async (request, reply) => {
      if (scalar(request.params.projectorId) === null || scalar(request.params.partitionId) === null) {
        return invalid(reply, request.url);
      }
      const auth = await authorized(
        request, reply, dependencies, "workfabric.operations.projection.read.v1",
        request.params.partitionId,
      );
      if (auth === null) return;
      const status = await dependencies.operations.getProjectionStatus(
        auth.principal.tenant_id, request.params.projectorId, request.params.partitionId,
      );
      return status === null ? missing(reply, request.url, "Projection not found") : reply.send(status);
    },
  );

  server.get<{ Querystring: { projector_id?: QueryValue; partition_id?: QueryValue; cursor?: QueryValue; limit?: QueryValue } }>(
    "/v1/operations/projection-failures",
    async (request, reply) => {
      const projector = optional(request.query.projector_id);
      const partition = optional(request.query.partition_id);
      const paging = page(request.query, config);
      if (projector === undefined || projector === null || partition === undefined || partition === null || paging === null) {
        return invalid(reply, request.url);
      }
      const auth = await authorized(
        request, reply, dependencies, "workfabric.operations.projection-failure.list.v1", partition,
      );
      if (auth === null) return;
      return reply.send(await dependencies.operations.listProjectionFailures(
        auth.principal.tenant_id,
        { projector_id: projector, partition_id: partition, ...paging },
      ));
    },
  );

  server.get<{ Params: { subscriptionId: string; partitionId: string } }>(
    "/v1/operations/deliveries/:subscriptionId/partitions/:partitionId",
    async (request, reply) => {
      if (scalar(request.params.subscriptionId) === null || scalar(request.params.partitionId) === null) return invalid(reply, request.url);
      const auth = await authorized(
        request, reply, dependencies, "workfabric.operations.delivery.read.v1",
        request.params.subscriptionId,
      );
      if (auth === null) return;
      const state = await dependencies.operations.getDeliveryState(
        auth.principal.tenant_id, request.params.subscriptionId, request.params.partitionId,
      );
      return state === null ? missing(reply, request.url, "Delivery state not found") : reply.send(state);
    },
  );

  server.get<{ Querystring: { subscription_id?: QueryValue; event_id?: QueryValue; cursor?: QueryValue; limit?: QueryValue } }>(
    "/v1/operations/delivery-attempts",
    async (request, reply) => {
      const subscription = optional(request.query.subscription_id);
      const event = optional(request.query.event_id);
      const paging = page(request.query, config);
      if (subscription === undefined || subscription === null || event === undefined || event === null || paging === null) return invalid(reply, request.url);
      const auth = await authorized(request, reply, dependencies, "workfabric.operations.delivery.read.v1", subscription);
      if (auth === null) return;
      return reply.send(await dependencies.operations.listDeliveryAttempts(
        auth.principal.tenant_id, { subscription_id: subscription, event_id: event, ...paging },
      ));
    },
  );

  server.get<{ Querystring: { subscription_id?: QueryValue; event_id?: QueryValue; cursor?: QueryValue; limit?: QueryValue } }>(
    "/v1/operations/dead-letters",
    async (request, reply) => {
      const subscription = optional(request.query.subscription_id);
      const event = optional(request.query.event_id);
      const paging = page(request.query, config);
      if (subscription === undefined || subscription === null || event === null || paging === null) return invalid(reply, request.url);
      const auth = await authorized(request, reply, dependencies, "workfabric.operations.delivery.read.v1", subscription);
      if (auth === null) return;
      return reply.send(await dependencies.operations.listDeadLetters(
        auth.principal.tenant_id,
        { subscription_id: subscription, ...(event === undefined ? {} : { event_id: event }), ...paging },
      ));
    },
  );

  server.get<{ Params: { connectorId: string }; Querystring: { state?: QueryValue; cursor?: QueryValue; limit?: QueryValue } }>(
    "/v1/operations/connectors/:connectorId/ingress",
    async (request, reply) => {
      const states = values(request.query.state, ingressStates);
      const paging = page(request.query, config);
      if (scalar(request.params.connectorId) === null || states === null || paging === null) return invalid(reply, request.url);
      const auth = await authorized(request, reply, dependencies, "workfabric.operations.connector-ingress.read.v1", request.params.connectorId);
      if (auth === null) return;
      return reply.send(await dependencies.operations.listConnectorIngress(
        auth.principal.tenant_id,
        { connector_id: request.params.connectorId, ...(states === undefined ? {} : { states }), ...paging },
      ));
    },
  );

  server.get<{ Params: { connectorId: string; ingressId: string } }>(
    "/v1/operations/connectors/:connectorId/ingress/:ingressId",
    async (request, reply) => {
      if (scalar(request.params.connectorId) === null || scalar(request.params.ingressId) === null) return invalid(reply, request.url);
      const auth = await authorized(request, reply, dependencies, "workfabric.operations.connector-ingress.read.v1", request.params.connectorId);
      if (auth === null) return;
      const ingress = await dependencies.operations.getConnectorIngress(
        auth.principal.tenant_id, request.params.connectorId, request.params.ingressId,
      );
      return ingress === null ? missing(reply, request.url, "Connector ingress not found") : reply.send(ingress);
    },
  );

  server.get<{ Querystring: { connector_id?: QueryValue; status?: QueryValue; cursor?: QueryValue; limit?: QueryValue } }>(
    "/v1/operations/discrepancies",
    async (request, reply) => {
      const connector = optional(request.query.connector_id);
      const statuses = values(request.query.status, discrepancyStatuses);
      const paging = page(request.query, config);
      if (connector === null || statuses === null || paging === null) return invalid(reply, request.url);
      const auth = await authorized(
        request, reply, dependencies, "workfabric.operations.discrepancy.read.v1",
        connector ?? ((principal) => principal.tenant_id),
      );
      if (auth === null) return;
      return reply.send(await dependencies.operations.listDiscrepancies(
        auth.principal.tenant_id,
        { ...(connector === undefined ? {} : { connector_id: connector }), ...(statuses === undefined ? {} : { statuses }), ...paging },
      ));
    },
  );

  server.get<{ Params: { discrepancyId: string }; Querystring: { connector_id?: QueryValue } }>(
    "/v1/operations/discrepancies/:discrepancyId",
    async (request, reply) => {
      const connector = optional(request.query.connector_id);
      if (scalar(request.params.discrepancyId) === null || connector === undefined || connector === null) return invalid(reply, request.url);
      const auth = await authorized(request, reply, dependencies, "workfabric.operations.discrepancy.read.v1", connector);
      if (auth === null) return;
      const discrepancy = await dependencies.operations.getDiscrepancy(
        auth.principal.tenant_id, request.params.discrepancyId,
      );
      if (discrepancy === null || discrepancy.connector_id !== connector) {
        return missing(reply, request.url, "Connector discrepancy not found");
      }
      return reply.send(discrepancy);
    },
  );
}
