import type { ExchangeAdapter } from "./capabilities.js";
import type { ResolvedPrincipal } from "./identity.js";
import type { JsonObject } from "./json.js";

export const TARGET_ELIGIBILITY_REQUIRED_CAPABILITIES = [
  "explicit_target_only",
  "no_candidate_selection",
  "fail_closed",
] as const;

export type ExplicitHandoffTarget =
  | { readonly actor_id: string }
  | { readonly endpoint_id: string };

export interface TargetEligibilityRequest {
  readonly tenant_id: string;
  readonly exchange_id: string;
  readonly handoff_id: string;
  readonly requirement: JsonObject;
  readonly proposed_target: ExplicitHandoffTarget;
  readonly principal: ResolvedPrincipal;
}

export type TargetEligibilityDecision =
  | { readonly kind: "eligible" }
  | { readonly kind: "ineligible"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface TargetEligibilityVerifier extends ExchangeAdapter {
  verify(
    request: TargetEligibilityRequest,
  ): Promise<TargetEligibilityDecision>;
}
