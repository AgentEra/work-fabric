import type { FastifyInstance, FastifyReply } from "fastify";

import {
  CitizenDirectoryError,
  type CitizenCallContext,
  type CitizenDiscoveryInput,
  type NetworkCitizenDirectoryService,
} from "@work-fabric/network-citizen-directory";
import type {
  CitizenDeclarationReplaceInput,
  CitizenHeartbeatInput,
  CitizenProvisioning,
  CitizenSessionCloseInput,
  CitizenSessionOpenInput,
  NetworkCitizenKind,
} from "@work-fabric/network-citizen-spi";
import type {
  AuthorityPolicy,
  IdentityProvider,
} from "@work-fabric/exchange-spi";
import type { WfppSchemaValidator } from "@work-fabric/protocol-runtime";

import { createProblemDetails } from "../problem-details.js";
import type { HttpRequestAuthenticator } from "../public-types.js";
import { authorizeRoute } from "./route-authorization.js";

export interface CitizenRouteDependencies {
  readonly authenticator: HttpRequestAuthenticator;
  readonly identity: IdentityProvider;
  readonly authority: AuthorityPolicy;
  readonly schemas: WfppSchemaValidator;
  readonly directory: NetworkCitizenDirectoryService;
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

function errorResponse(reply: FastifyReply, error: unknown, url: string) {
  if (error instanceof TypeError) {
    return problem(reply, 400, "invalid_request", "Invalid Citizen request", url);
  }
  if (error instanceof CitizenDirectoryError) {
    switch (error.code) {
      case "invalid_request":
        return problem(reply, 400, error.code, "Invalid Citizen request", url);
      case "not_found":
      case "representation_denied":
      case "citizen_disabled":
        return problem(reply, 404, "not_found", "Network Citizen not found", url);
      case "version_conflict":
      case "idempotency_conflict":
      case "immutable_binding":
      case "session_fenced":
      case "stale_sequence":
      case "schema_digest_conflict":
        return problem(reply, 409, error.code, "Network Citizen state conflict", url);
      case "temporarily_unavailable":
        return problem(reply, 503, error.code, "Network Citizen directory unavailable", url);
    }
  }
  return problem(
    reply,
    503,
    "temporarily_unavailable",
    "Network Citizen directory unavailable",
    url,
  );
}

function context(auth: {
  readonly principal: {
    readonly principal_id: string;
    readonly tenant_id: string;
  };
  readonly actor: {
    readonly actor_id: string;
    readonly actor_type: "human" | "agent" | "system";
  };
  readonly endpoint_id: string;
}): CitizenCallContext {
  return {
    tenant_id: auth.principal.tenant_id,
    principal_id: auth.principal.principal_id,
    represented_actor: auth.actor,
    represented_endpoint_id: auth.endpoint_id,
  };
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

function one(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (
    Array.isArray(value) &&
    typeof value[0] === "string" &&
    value[0].length > 0
  ) {
    return value[0];
  }
  return undefined;
}

function many(value: unknown): readonly string[] | undefined {
  if (typeof value === "string") return value.length === 0 ? undefined : [value];
  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    return value;
  }
  return undefined;
}

function positive(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const raw = one(value);
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return Number.NaN;
  return Number(raw);
}

function boolean(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  const raw = one(value);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

export function registerCitizenRoutes(
  server: FastifyInstance,
  dependencies: CitizenRouteDependencies,
): void {
  server.put<{ Params: { citizenId: string } }>(
    "/v1/admin/citizens/:citizenId",
    async (request, reply) => {
      const raw = request.body as Record<string, unknown> | null;
      const action = raw?.administrative_state === "disabled"
        ? "workfabric.citizen.disable.v1"
        : "workfabric.citizen.provision.v1";
      const authorized = await authorizeRoute(
        request,
        dependencies,
        action,
        request.params.citizenId,
      );
      if (authorized.kind === "denied") {
        return reply.code(authorized.problem.status).send(authorized.problem);
      }
      if (
        !validate(dependencies.schemas, "citizen-provisioning", request.body) ||
        raw === null ||
        raw.citizen_id !== request.params.citizenId
      ) {
        return problem(reply, 400, "invalid_request", "Invalid Citizen provisioning", request.url);
      }
      const registration = raw as unknown as CitizenProvisioning;
      try {
        return reply.send(
          await dependencies.directory.provision(
            context(authorized),
            registration,
            registration.registration_version === 1
              ? null
              : registration.registration_version - 1,
          ),
        );
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );

  server.get<{ Querystring: Record<string, unknown> }>(
    "/v1/citizens",
    async (request, reply) => {
      const authorized = await authorizeRoute(
        request,
        dependencies,
        "workfabric.citizen.discover.v1",
        null,
      );
      if (authorized.kind === "denied") {
        return reply.code(authorized.problem.status).send(authorized.problem);
      }
      const limit = positive(request.query.limit);
      const executableOnly = boolean(request.query.executable_only);
      if (Number.isNaN(limit) || executableOnly === null) {
        return problem(reply, 400, "invalid_request", "Invalid Citizen discovery query", request.url);
      }
      const citizenKind = one(request.query.citizen_kind);
      const availability = many(request.query.availability);
      const input: CitizenDiscoveryInput = {
        ...(citizenKind === undefined
          ? {}
          : { citizen_kind: citizenKind as NetworkCitizenKind }),
        ...(one(request.query.declaration_id) === undefined
          ? {}
          : { declaration_id: one(request.query.declaration_id)! }),
        ...(availability === undefined
          ? {}
          : {
              availability:
                availability as NonNullable<CitizenDiscoveryInput["availability"]>,
            }),
        ...(executableOnly === undefined
          ? {}
          : { executable_only: executableOnly }),
        ...(one(request.query.cursor) === undefined
          ? {}
          : { cursor: one(request.query.cursor)! }),
        ...(limit === undefined ? {} : { limit }),
      };
      try {
        return reply.send(
          await dependencies.directory.discoverCitizens(
            context(authorized),
            input,
          ),
        );
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );

  server.get<{ Params: { citizenId: string } }>(
    "/v1/citizens/:citizenId",
    async (request, reply) => {
      const authorized = await authorizeRoute(
        request,
        dependencies,
        "workfabric.citizen.read.v1",
        request.params.citizenId,
      );
      if (authorized.kind === "denied") {
        return reply.code(authorized.problem.status).send(authorized.problem);
      }
      try {
        return reply.send(
          await dependencies.directory.getCitizen(
            context(authorized),
            request.params.citizenId,
          ),
        );
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );

  server.get<{ Params: { citizenId: string } }>(
    "/v1/citizens/:citizenId/declarations",
    async (request, reply) => {
      const authorized = await authorizeRoute(
        request,
        dependencies,
        "workfabric.citizen.declaration-summary.read.v1",
        request.params.citizenId,
      );
      if (authorized.kind === "denied") {
        return reply.code(authorized.problem.status).send(authorized.problem);
      }
      try {
        return reply.send(
          await dependencies.directory.listDeclarations(
            context(authorized),
            request.params.citizenId,
          ),
        );
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );

  server.get<{
    Params: { citizenId: string; declarationId: string };
  }>(
    "/v1/citizens/:citizenId/declarations/:declarationId",
    async (request, reply) => {
      const resourceId = `${request.params.citizenId}/${request.params.declarationId}`;
      const authorized = await authorizeRoute(
        request,
        dependencies,
        "workfabric.citizen.declaration.read.v1",
        resourceId,
      );
      if (authorized.kind === "denied") {
        return reply.code(authorized.problem.status).send(authorized.problem);
      }
      try {
        return reply.send(
          await dependencies.directory.getDeclaration(
            context(authorized),
            request.params.citizenId,
            request.params.declarationId,
          ),
        );
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );

  server.post<{ Params: { citizenId: string } }>(
    "/v1/citizens/:citizenId/sessions",
    async (request, reply) => {
      const authorized = await authorizeRoute(
        request,
        dependencies,
        "workfabric.citizen.session.open.v1",
        request.params.citizenId,
      );
      if (authorized.kind === "denied") {
        return reply.code(authorized.problem.status).send(authorized.problem);
      }
      if (!validate(dependencies.schemas, "citizen-session-open", request.body)) {
        return problem(reply, 400, "invalid_request", "Invalid Citizen session", request.url);
      }
      try {
        return reply.send(
          await dependencies.directory.openSession(
            context(authorized),
            request.params.citizenId,
            request.body as CitizenSessionOpenInput,
          ),
        );
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );

  server.post<{ Params: { citizenId: string; sessionId: string } }>(
    "/v1/citizens/:citizenId/sessions/:sessionId/heartbeat",
    async (request, reply) => {
      const authorized = await authorizeRoute(
        request,
        dependencies,
        "workfabric.citizen.session.heartbeat.v1",
        `${request.params.citizenId}/${request.params.sessionId}`,
      );
      if (authorized.kind === "denied") {
        return reply.code(authorized.problem.status).send(authorized.problem);
      }
      if (!validate(dependencies.schemas, "citizen-heartbeat", request.body)) {
        return problem(reply, 400, "invalid_request", "Invalid Citizen heartbeat", request.url);
      }
      try {
        return reply.send(
          await dependencies.directory.heartbeat(
            context(authorized),
            request.params.citizenId,
            request.params.sessionId,
            request.body as CitizenHeartbeatInput,
          ),
        );
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );

  server.put<{ Params: { citizenId: string; sessionId: string } }>(
    "/v1/citizens/:citizenId/sessions/:sessionId/declarations",
    async (request, reply) => {
      const authorized = await authorizeRoute(
        request,
        dependencies,
        "workfabric.citizen.session.declarations.replace.v1",
        `${request.params.citizenId}/${request.params.sessionId}`,
      );
      if (authorized.kind === "denied") {
        return reply.code(authorized.problem.status).send(authorized.problem);
      }
      if (
        !validate(
          dependencies.schemas,
          "citizen-declaration-replace",
          request.body,
        )
      ) {
        return problem(reply, 400, "invalid_request", "Invalid Citizen declarations", request.url);
      }
      try {
        return reply.send(
          await dependencies.directory.replaceDeclarations(
            context(authorized),
            request.params.citizenId,
            request.params.sessionId,
            request.body as CitizenDeclarationReplaceInput,
          ),
        );
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );

  server.post<{ Params: { citizenId: string; sessionId: string } }>(
    "/v1/citizens/:citizenId/sessions/:sessionId/close",
    async (request, reply) => {
      const authorized = await authorizeRoute(
        request,
        dependencies,
        "workfabric.citizen.session.close.v1",
        `${request.params.citizenId}/${request.params.sessionId}`,
      );
      if (authorized.kind === "denied") {
        return reply.code(authorized.problem.status).send(authorized.problem);
      }
      if (!validate(dependencies.schemas, "citizen-session-close", request.body)) {
        return problem(reply, 400, "invalid_request", "Invalid Citizen session close", request.url);
      }
      try {
        return reply.send(
          await dependencies.directory.closeSession(
            context(authorized),
            request.params.citizenId,
            request.params.sessionId,
            request.body as CitizenSessionCloseInput,
          ),
        );
      } catch (error) {
        return errorResponse(reply, error, request.url);
      }
    },
  );
}
