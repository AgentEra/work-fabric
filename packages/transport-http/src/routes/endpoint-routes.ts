import type { FastifyInstance, FastifyReply } from "fastify";

import {
  EndpointDirectoryError,
  type EndpointCallContext,
  type EndpointDirectoryService,
  type EndpointDiscoveryInput,
  type EndpointHeartbeatInput,
  type EndpointSessionCloseInput,
  type EndpointSessionOpenInput,
} from "@work-fabric/endpoint-directory";
import {
  EndpointInboxQueryError,
  type EndpointInboxPartitionInput,
  type EndpointInboxQueryService,
} from "@work-fabric/exchange-runtime";
import type {
  AuthorityPolicy,
  EndpointRegistration,
  IdentityProvider,
} from "@work-fabric/exchange-spi";
import type { WfppSchemaValidator } from "@work-fabric/protocol-runtime";

import type { HttpRequestAuthenticator } from "../public-types.js";
import { createProblemDetails } from "../problem-details.js";
import { authorizeRoute } from "./route-authorization.js";

export interface EndpointRouteDependencies {
  readonly authenticator: HttpRequestAuthenticator;
  readonly identity: IdentityProvider;
  readonly authority: AuthorityPolicy;
  readonly schemas: WfppSchemaValidator;
  readonly directory: EndpointDirectoryService;
  readonly inbox: EndpointInboxQueryService;
}

function problem(
  reply: FastifyReply,
  status: number,
  code: string,
  title: string,
  url: string,
) {
  return reply
    .code(status)
    .type("application/problem+json")
    .send(createProblemDetails(status, code, title, { instance: url }));
}

function errorResponse(
  reply: FastifyReply,
  error: unknown,
  url: string,
) {
  if (error instanceof EndpointDirectoryError) {
    switch (error.code) {
      case "invalid_request":
        return problem(reply, 400, error.code, "Invalid Endpoint request", url);
      case "not_found":
      case "representation_denied":
      case "endpoint_disabled":
        return problem(reply, 404, "not_found", "Endpoint not found", url);
      case "version_conflict":
      case "idempotency_conflict":
      case "immutable_binding":
      case "session_fenced":
      case "stale_sequence":
        return problem(reply, 409, error.code, "Endpoint state conflict", url);
      default:
        return problem(reply, 503, "temporarily_unavailable", "Endpoint service unavailable", url);
    }
  }
  if (error instanceof EndpointInboxQueryError) {
    if (error.code === "invalid_request") {
      return problem(reply, 400, error.code, "Invalid Endpoint inbox request", url);
    }
    if (error.code === "not_found") {
      return problem(reply, 404, error.code, "Endpoint not found", url);
    }
    return problem(reply, 503, "temporarily_unavailable", "Endpoint inbox unavailable", url);
  }
  return problem(reply, 503, "temporarily_unavailable", "Endpoint service unavailable", url);
}

function directoryContext(auth: {
  readonly principal: { readonly principal_id: string; readonly tenant_id: string };
  readonly actor: { readonly actor_id: string; readonly actor_type: "human" | "agent" | "system" };
  readonly endpoint_id: string;
}): EndpointCallContext {
  return {
    tenant_id: auth.principal.tenant_id,
    principal_id: auth.principal.principal_id,
    represented_actor: auth.actor,
    represented_endpoint_id: auth.endpoint_id,
  };
}

function one(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) return value[0];
  return undefined;
}

function many(value: unknown): readonly string[] | undefined {
  if (typeof value === "string") return value.length === 0 ? undefined : [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)) return value;
  return undefined;
}

function positive(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const raw = one(value);
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return Number.NaN;
  return Number(raw);
}

function validate(
  schemas: WfppSchemaValidator,
  schemaName: string,
  body: unknown,
): boolean {
  return schemas.validate(
    `urn:work-fabric:schema:v1:${schemaName}`,
    body,
  ).valid;
}

export function registerEndpointRoutes(
  server: FastifyInstance,
  deps: EndpointRouteDependencies,
): void {
  server.put<{ Params: { endpointId: string } }>(
    "/v1/admin/endpoints/:endpointId",
    async (request, reply) => {
      const raw = request.body as Record<string, unknown> | null;
      const action = raw?.administrative_state === "disabled"
        ? "workfabric.endpoint.disable.v1"
        : "workfabric.endpoint.provision.v1";
      const auth = await authorizeRoute(request, deps, action, request.params.endpointId);
      if (auth.kind === "denied") return reply.code(auth.problem.status).send(auth.problem);
      if (
        !validate(deps.schemas, "endpoint-registration", request.body) ||
        raw === null ||
        raw.endpoint_id !== request.params.endpointId
      ) {
        return problem(reply, 400, "invalid_request", "Invalid Endpoint registration", request.url);
      }
      const registration = raw as unknown as EndpointRegistration;
      try {
        return reply.send(await deps.directory.provision(
          directoryContext(auth),
          registration,
          registration.registration_version === 1
            ? null
            : registration.registration_version - 1,
        ));
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );

  server.get<{ Params: { endpointId: string } }>(
    "/v1/endpoints/:endpointId",
    async (request, reply) => {
      const auth = await authorizeRoute(request, deps, "workfabric.endpoint.read.v1", request.params.endpointId);
      if (auth.kind === "denied") return reply.code(auth.problem.status).send(auth.problem);
      try {
        return reply.send(await deps.directory.getEndpoint(directoryContext(auth), request.params.endpointId));
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );

  server.get<{ Querystring: Record<string, unknown> }>(
    "/v1/endpoints",
    async (request, reply) => {
      const auth = await authorizeRoute(request, deps, "workfabric.endpoint.discover.v1", null);
      if (auth.kind === "denied") return reply.code(auth.problem.status).send(auth.problem);
      const limit = positive(request.query.limit);
      if (Number.isNaN(limit)) return problem(reply, 400, "invalid_request", "Invalid discovery query", request.url);
      const input: EndpointDiscoveryInput = {
        ...(one(request.query.capability_id) === undefined ? {} : { capability_id: one(request.query.capability_id)! }),
        ...(one(request.query.version_constraint) === undefined ? {} : { version_constraint: one(request.query.version_constraint)! }),
        ...(many(request.query.input_media_type) === undefined ? {} : { required_input_media_types: many(request.query.input_media_type)! }),
        ...(many(request.query.output_media_type) === undefined ? {} : { required_output_media_types: many(request.query.output_media_type)! }),
        ...(many(request.query.availability) === undefined ? {} : { availability: many(request.query.availability) as NonNullable<EndpointDiscoveryInput["availability"]> }),
        ...(one(request.query.cursor) === undefined ? {} : { cursor: one(request.query.cursor)! }),
        ...(limit === undefined ? {} : { limit }),
      };
      try {
        return reply.send(await deps.directory.discover(directoryContext(auth), input));
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );

  server.post<{ Params: { endpointId: string } }>(
    "/v1/endpoints/:endpointId/sessions",
    async (request, reply) => {
      const auth = await authorizeRoute(request, deps, "workfabric.endpoint.session.open.v1", request.params.endpointId);
      if (auth.kind === "denied") return reply.code(auth.problem.status).send(auth.problem);
      if (!validate(deps.schemas, "endpoint-session-open", request.body)) return problem(reply, 400, "invalid_request", "Invalid Endpoint session", request.url);
      try {
        return reply.send(await deps.directory.openSession(directoryContext(auth), request.params.endpointId, request.body as EndpointSessionOpenInput));
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );

  server.post<{ Params: { endpointId: string; sessionId: string } }>(
    "/v1/endpoints/:endpointId/sessions/:sessionId/heartbeat",
    async (request, reply) => {
      const auth = await authorizeRoute(request, deps, "workfabric.endpoint.session.heartbeat.v1", `${request.params.endpointId}/${request.params.sessionId}`);
      if (auth.kind === "denied") return reply.code(auth.problem.status).send(auth.problem);
      if (!validate(deps.schemas, "endpoint-heartbeat", request.body)) return problem(reply, 400, "invalid_request", "Invalid Endpoint heartbeat", request.url);
      try {
        return reply.send(await deps.directory.heartbeat(directoryContext(auth), request.params.endpointId, request.params.sessionId, request.body as EndpointHeartbeatInput));
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );

  server.post<{ Params: { endpointId: string; sessionId: string } }>(
    "/v1/endpoints/:endpointId/sessions/:sessionId/close",
    async (request, reply) => {
      const auth = await authorizeRoute(request, deps, "workfabric.endpoint.session.close.v1", `${request.params.endpointId}/${request.params.sessionId}`);
      if (auth.kind === "denied") return reply.code(auth.problem.status).send(auth.problem);
      if (!validate(deps.schemas, "endpoint-session-close", request.body)) return problem(reply, 400, "invalid_request", "Invalid Endpoint session close", request.url);
      try {
        return reply.send(await deps.directory.closeSession(directoryContext(auth), request.params.endpointId, request.params.sessionId, request.body as EndpointSessionCloseInput));
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );

  server.get<{ Params: { endpointId: string }; Querystring: Record<string, unknown> }>(
    "/v1/endpoints/:endpointId/inbox/partitions",
    async (request, reply) => {
      const auth = await authorizeRoute(request, deps, "workfabric.endpoint.inbox.read.v1", request.params.endpointId);
      if (auth.kind === "denied") return reply.code(auth.problem.status).send(auth.problem);
      const limit = positive(request.query.limit);
      if (Number.isNaN(limit)) return problem(reply, 400, "invalid_request", "Invalid Endpoint inbox query", request.url);
      const input: EndpointInboxPartitionInput = {
        ...(one(request.query.cursor) === undefined ? {} : { cursor: one(request.query.cursor)! }),
        ...(limit === undefined ? {} : { limit }),
      };
      try {
        return reply.send(await deps.inbox.listPartitions(
          { tenant_id: auth.principal.tenant_id, principal: auth.principal },
          request.params.endpointId,
          input,
        ));
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );
}
