import type { FastifyRequest } from "fastify";
import type { AuthorityPolicy, IdentityProvider, ResolvedPrincipal } from "@work-fabric/exchange-spi";
import type { HttpRequestAuthenticator } from "../public-types.js";
import { authorizeHttpRequest } from "../request-authorization.js";
import { createProblemDetails } from "../problem-details.js";

function singleton(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
  return authorizeHttpRequest({
    authentication_evidence: evidence, actor_id: actorId, endpoint_id: endpointId,
    delegation_id: singleton(request.headers["x-wf-delegation-id"]), action, resource_id: resourceId,
  }, dependencies);
}
