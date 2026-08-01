import type { FastifyInstance, FastifyReply } from "fastify";

import {
  DiscoveryError,
  type DiscoveryGateway,
  type DiscoveryQueryService,
} from "@work-fabric/discovery-runtime";
import { DISCOVERY_MAX_MESSAGE_BYTES, type DiscoveryCallContext } from "@work-fabric/discovery-spi";
import type { AuthorityPolicy, IdentityProvider } from "@work-fabric/exchange-spi";

import type { HttpServiceConfig } from "../config.js";
import { createProblemDetails } from "../problem-details.js";
import type { HttpRequestAuthenticator } from "../public-types.js";
import { authorizeRoute } from "./route-authorization.js";

const mediaType = "application/workfabric-discovery+json";

interface ParticipantDependencies {
  readonly discovery: DiscoveryQueryService;
  readonly identity: IdentityProvider;
  readonly authority: AuthorityPolicy;
  readonly authenticator: HttpRequestAuthenticator;
  readonly tenant_view_id: string;
  readonly gateway?: DiscoveryGateway;
  readonly manifest?: never;
}

interface PeerDependencies {
  readonly gateway?: DiscoveryGateway;
  readonly manifest?: () => Promise<Uint8Array>;
  readonly discovery?: never;
  readonly identity?: never;
  readonly authority?: never;
  readonly authenticator?: never;
  readonly tenant_view_id?: never;
}

export type DiscoveryRouteDependencies = ParticipantDependencies | PeerDependencies;

function problem(reply: FastifyReply, status: number, code: string, title: string, url: string) {
  return reply.code(status).type("application/problem+json")
    .send(createProblemDetails(status, code, title, { instance: url }));
}

function discoveryError(reply: FastifyReply, error: unknown, url: string) {
  if (!(error instanceof DiscoveryError)) return problem(reply, 503, "temporarily_unavailable", "Discovery service unavailable", url);
  if (error.code === "discovery_not_found") return problem(reply, 404, "not_found", "Discovery resource not found", url);
  if (error.code === "discovery_rate_limited" || error.code === "discovery_budget_exhausted") {
    return problem(reply, 429, "discovery_limited", "Discovery request is limited", url);
  }
  if (error.code === "discovery_record_too_large") return problem(reply, 413, "payload_too_large", "Payload too large", url);
  if (error.code === "discovery_unavailable") return problem(reply, 503, "temporarily_unavailable", "Discovery service unavailable", url);
  if (error.code === "discovery_record_invalid" || error.code === "discovery_cursor_invalid") {
    return problem(reply, 400, "invalid_request", "Invalid discovery request", url);
  }
  return problem(reply, 403, "peer_request_denied", "Discovery peer request denied", url);
}

function one(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string" && value[0].length > 0) return value[0];
  return undefined;
}

function many(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : null;
  if (items === null || items.length < 1 || items.length > 32 || items.some((item) => typeof item !== "string" || item.length < 1 || item.length > 256)) return null;
  return items as readonly string[];
}

function limit(value: unknown, maximum: number): number | undefined | null {
  if (value === undefined) return undefined;
  const raw = one(value);
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}

function context(auth: {
  readonly principal: { readonly principal_id: string; readonly tenant_id: string };
  readonly actor: { readonly actor_id: string; readonly actor_type: "human" | "agent" | "system" };
  readonly endpoint_id: string;
}, tenantViewId: string): DiscoveryCallContext {
  return Object.freeze({
    tenant_id: auth.principal.tenant_id,
    tenant_view_id: tenantViewId,
    principal_id: auth.principal.principal_id,
    represented_actor: Object.freeze({ ...auth.actor }),
    represented_endpoint_id: auth.endpoint_id,
  });
}

function participant(server: FastifyInstance, deps: ParticipantDependencies, config: HttpServiceConfig): void {
  const detail = (
    path: string,
    method: "getExchange" | "getParticipant" | "getEndpoint",
    parameter: string,
  ) => server.get<{ Params: Record<string, string> }>(path, async (request, reply) => {
    const id = request.params[parameter];
    if (id === undefined || id.length < 1 || id.length > 256) return problem(reply, 400, "invalid_request", "Invalid discovery request", request.url);
    const auth = await authorizeRoute(request, deps, "workfabric.discovery.resolve.v1", id);
    if (auth.kind === "denied") return reply.code(auth.problem.status).send(auth.problem);
    try { return reply.send(await deps.discovery[method](context(auth, deps.tenant_view_id), id)); }
    catch (error) { return discoveryError(reply, error, request.url); }
  });
  detail("/v1/discovery/exchanges/:exchangeId", "getExchange", "exchangeId");
  detail("/v1/discovery/participants/:actorId", "getParticipant", "actorId");
  detail("/v1/discovery/endpoints/:endpointId", "getEndpoint", "endpointId");

  server.get<{ Querystring: Record<string, unknown> }>("/v1/discovery/capabilities", async (request, reply) => {
    const auth = await authorizeRoute(request, deps, "workfabric.discovery.query.v1", null);
    if (auth.kind === "denied") return reply.code(auth.problem.status).send(auth.problem);
    const parsedLimit = limit(request.query.limit, config.max_page_limit);
    const inputMedia = many(request.query.input_media_type);
    const outputMedia = many(request.query.output_media_type);
    const interactions = many(request.query.interaction_mode);
    const bindings = many(request.query.binding_type);
    if (parsedLimit === null || inputMedia === null || outputMedia === null || interactions === null || bindings === null) {
      return problem(reply, 400, "invalid_request", "Invalid discovery query", request.url);
    }
    const input = {
      ...(one(request.query.capability_id) === undefined ? {} : { capability_id: one(request.query.capability_id)! }),
      ...(one(request.query.version_constraint) === undefined ? {} : { version_constraint: one(request.query.version_constraint)! }),
      ...(inputMedia === undefined ? {} : { input_media_types: inputMedia }),
      ...(outputMedia === undefined ? {} : { output_media_types: outputMedia }),
      ...(interactions === undefined ? {} : { interaction_modes: interactions }),
      ...(bindings === undefined ? {} : { binding_types: bindings }),
      ...(one(request.query.cursor) === undefined ? {} : { cursor: one(request.query.cursor)! }),
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
    };
    try { return reply.send(await deps.discovery.findCapabilities(context(auth, deps.tenant_view_id), input)); }
    catch (error) { return discoveryError(reply, error, request.url); }
  });

  if (deps.gateway !== undefined) {
    server.post("/v1/discovery/queries", async (request, reply) => {
      const auth = await authorizeRoute(request, deps, "workfabric.discovery.query.v1", null);
      if (auth.kind === "denied") return reply.code(auth.problem.status).send(auth.problem);
      if (typeof request.body !== "object" || request.body === null || Array.isArray(request.body)) {
        return problem(reply, 400, "invalid_request", "Invalid discovery query", request.url);
      }
      try {
        const remote = await deps.gateway!.executeQueryAny(request.body as never);
        return reply.send(await deps.discovery.filterFederated(context(auth, deps.tenant_view_id), {
          coverage: remote.coverage,
          items: remote.items,
          warnings: remote.warnings,
        }));
      }
      catch (error) { return discoveryError(reply, error, request.url); }
    });
  }
}

function peers(server: FastifyInstance, deps: PeerDependencies): void {
  if (!server.hasContentTypeParser(mediaType)) {
    server.addContentTypeParser(mediaType, { parseAs: "buffer", bodyLimit: DISCOVERY_MAX_MESSAGE_BYTES }, (_request, body, done) => done(null, body));
  }
  if (deps.manifest !== undefined) {
    server.get("/.well-known/work-fabric", async (_request, reply) => {
      try { return reply.type(mediaType).send(Buffer.from(await deps.manifest!())); }
      catch (error) { return discoveryError(reply, error, "/.well-known/work-fabric"); }
    });
  }
  const peerRoute = (path: string, method: "receiveSync" | "receiveQuery") => {
    server.post(path, async (request, reply) => {
      if (!(request.body instanceof Uint8Array)) return problem(reply, 400, "invalid_request", "Invalid discovery peer request", request.url);
      try { return reply.type(mediaType).send(Buffer.from(await deps.gateway![method](request.body))); }
      catch (error) { return discoveryError(reply, error, request.url); }
    });
  };
  if (deps.gateway !== undefined) {
    peerRoute("/v1/discovery/peer/sync", "receiveSync");
    peerRoute("/v1/discovery/peer/query", "receiveQuery");
  }
}

export function registerDiscoveryRoutes(server: FastifyInstance, dependencies: DiscoveryRouteDependencies, config: HttpServiceConfig): void {
  if ("discovery" in dependencies && dependencies.discovery !== undefined) participant(server, dependencies, config);
  else peers(server, dependencies as PeerDependencies);
}
