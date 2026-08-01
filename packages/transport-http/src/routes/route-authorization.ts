import type { FastifyRequest } from "fastify";
import type { AuthorityPolicy, IdentityProvider, ResolvedPrincipal } from "@work-fabric/exchange-spi";
import type { OperationAuditRecorder } from "@work-fabric/operations-runtime";
import type { HttpRequestAuthenticator } from "../public-types.js";
import { authorizeHttpRequest } from "../request-authorization.js";
import { createProblemDetails } from "../problem-details.js";

function singleton(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const auditByRequest = new WeakMap<FastifyRequest, OperationAuditRecorder>();

export function bindRequestAudit(
  request: FastifyRequest,
  audit: OperationAuditRecorder,
): void {
  auditByRequest.set(request, audit);
}

export function requestTraceId(request: FastifyRequest): string | null {
  const value = singleton(request.headers.traceparent);
  if (value === null) return null;
  const match = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i.exec(value);
  const candidate = match?.[1]?.toLowerCase() ?? null;
  return candidate === null || /^0{32}$/.test(candidate) ? null : candidate;
}

function resourceKind(action: string): string {
  if (action.includes("handoff")) return "handoff";
  if (action.includes("partition") || action.includes("responsibility") ||
      action.includes("timeline") || action.includes("relationship")) return "partition";
  if (action.includes("endpoint")) return "endpoint";
  if (action.includes("context")) return "context";
  if (action.includes("subscription")) return "subscription";
  if (action.includes("delivery")) return "delivery";
  return "tenant";
}

export async function authorizeRoute(
  request: FastifyRequest,
  dependencies: { readonly authenticator: HttpRequestAuthenticator; readonly identity: IdentityProvider; readonly authority: AuthorityPolicy },
  action: string,
  resourceId:
    | string
    | null
    | ((principal: ResolvedPrincipal) => string | null),
) {
  const actorId = singleton(request.headers["x-wf-actor-id"]);
  const endpointId = singleton(request.headers["x-wf-endpoint-id"]);
  if (actorId === null || endpointId === null) {
    return { kind: "denied" as const, problem: createProblemDetails(400, "invalid_request", "Actor and Endpoint headers are required", { instance: request.url }) };
  }
  const evidence = await dependencies.authenticator.authenticationEvidence({
    authorization: singleton(request.headers.authorization), request_id: request.id,
  });
  const result = await authorizeHttpRequest({
    authentication_evidence: evidence, actor_id: actorId, endpoint_id: endpointId,
    delegation_id: singleton(request.headers["x-wf-delegation-id"]), action, resource_id: resourceId,
  }, dependencies);
  const audit = auditByRequest.get(request);
  const principal = result.principal;
  if (audit !== undefined && principal !== undefined) {
    const resolvedResource = typeof resourceId === "function"
      ? resourceId(principal)
      : resourceId;
    audit.stageHttp(request.id, {
      tenant_id: principal.tenant_id,
      trace_id: requestTraceId(request),
      principal_id: principal.principal_id,
      represented_actor: result.kind === "authorized"
        ? result.actor
        : result.actor ?? null,
      represented_endpoint_id: result.kind === "authorized"
        ? result.endpoint_id
        : result.endpoint_id ?? null,
      delegation_id: result.kind === "authorized"
        ? result.delegation_id
        : result.delegation_id ?? null,
      operation: action,
      resource_kind: resourceKind(action),
      resource_id: resolvedResource ?? principal.tenant_id,
      authorization_decision: result.kind === "authorized" ? "allowed" : "denied",
    });
  }
  return result;
}
