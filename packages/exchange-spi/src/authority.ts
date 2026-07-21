import type { ExchangeAdapter } from "./capabilities.js";
import type { ResolvedPrincipal } from "./identity.js";

export const AUTHORITY_REQUIRED_CAPABILITIES = [
  "explicit_decision",
  "default_deny",
  "resource_scoping",
] as const;

export interface AuthorityRequest {
  readonly principal: ResolvedPrincipal;
  readonly actor_id: string;
  readonly actor_type: "human" | "agent" | "system";
  readonly endpoint_id: string;
  readonly delegation_id: string | null;
  readonly action: string;
  readonly resource_id: string | null;
  readonly correlation_id: string | null;
  readonly idempotency_key: string;
}

export type AuthorityDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string };

export interface AuthorityPolicy extends ExchangeAdapter {
  authorize(request: AuthorityRequest): Promise<AuthorityDecision>;
}
