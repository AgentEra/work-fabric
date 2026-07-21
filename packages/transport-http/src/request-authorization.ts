import type {
  AuthorityPolicy,
  IdentityProvider,
  JsonObject,
  ResolvedPrincipal,
} from "@work-fabric/exchange-spi";

import { createProblemDetails, type ProblemDetails } from "./problem-details.js";

export interface HttpAuthorizationRequest {
  readonly authentication_evidence: JsonObject | null;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly delegation_id: string | null;
  readonly action: string;
  readonly resource_id:
    | string
    | null
    | ((principal: ResolvedPrincipal) => string | null);
}

export interface HttpAuthorizationDependencies {
  readonly identity: IdentityProvider;
  readonly authority: AuthorityPolicy;
}

export type HttpAuthorizationResult =
  | {
      readonly kind: "authorized";
      readonly principal: ResolvedPrincipal;
      readonly actor: {
        readonly actor_id: string;
        readonly actor_type: "human" | "agent" | "system";
      };
      readonly endpoint_id: string;
      readonly delegation_id: string | null;
    }
  | {
      readonly kind: "denied";
      readonly problem: ProblemDetails;
      readonly principal?: ResolvedPrincipal;
      readonly actor?: {
        readonly actor_id: string;
        readonly actor_type: "human" | "agent" | "system";
      };
      readonly endpoint_id?: string;
      readonly delegation_id?: string | null;
    };

function denied(status: 401 | 403, code: string, title: string): HttpAuthorizationResult {
  return { kind: "denied", problem: createProblemDetails(status, code, title) };
}

export async function authorizeHttpRequest(
  request: HttpAuthorizationRequest,
  dependencies: HttpAuthorizationDependencies,
): Promise<HttpAuthorizationResult> {
  if (request.authentication_evidence === null) {
    return denied(401, "unauthenticated", "Authentication is required");
  }
  const principal = await dependencies.identity.resolve(
    request.authentication_evidence,
  );
  if (principal === null) {
    return denied(401, "unauthenticated", "Authentication was not accepted");
  }
  const claim = principal.actor_claims.find(
    (candidate) =>
      candidate.actor_id === request.actor_id &&
      candidate.endpoint_ids.includes(request.endpoint_id),
  );
  if (claim === undefined) {
    return {
      ...denied(
        403,
        "permission_denied",
        "The Principal cannot represent this Actor and Endpoint",
      ),
      principal,
    };
  }
  const decision = await dependencies.authority.authorize({
    principal,
    actor_id: claim.actor_id,
    actor_type: claim.actor_type,
    endpoint_id: request.endpoint_id,
    delegation_id: request.delegation_id,
    action: request.action,
    resource_id:
      typeof request.resource_id === "function"
        ? request.resource_id(principal)
        : request.resource_id,
    correlation_id: null,
    idempotency_key: "http:non-command",
  });
  if (decision.kind === "deny") {
    return {
      ...denied(403, "permission_denied", "The operation is not authorized"),
      principal,
      actor: { actor_id: claim.actor_id, actor_type: claim.actor_type },
      endpoint_id: request.endpoint_id,
      delegation_id: request.delegation_id,
    };
  }
  return {
    kind: "authorized",
    principal,
    actor: { actor_id: claim.actor_id, actor_type: claim.actor_type },
    endpoint_id: request.endpoint_id,
    delegation_id: request.delegation_id,
  };
}
