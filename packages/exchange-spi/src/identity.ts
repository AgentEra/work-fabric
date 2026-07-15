import type { ExchangeAdapter } from "./capabilities.js";
import type { JsonObject } from "./json.js";

export const IDENTITY_REQUIRED_CAPABILITIES = [
  "authenticated_principal",
  "trusted_actor_claims",
  "tenant_binding",
] as const;

export interface ResolvedPrincipal {
  readonly principal_id: string;
  readonly tenant_id: string;
  readonly actor_claims: readonly {
    readonly actor_id: string;
    readonly actor_type: "human" | "agent" | "system";
    readonly endpoint_ids: readonly string[];
  }[];
  readonly attributes: JsonObject;
}

export interface IdentityProvider extends ExchangeAdapter {
  resolve(authenticationEvidence: JsonObject): Promise<ResolvedPrincipal | null>;
}
