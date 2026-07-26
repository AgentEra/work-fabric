import type { HandoffReadModel, ProtocolEvent } from "@work-fabric/sdk-typescript";

export type AcceptanceDecision =
  | { readonly kind: "accept" }
  | { readonly kind: "decline"; readonly code: "not_targeted" | "unsupported_capability" | "expired" | "terminal" | "authority_missing" | "already_running" }
  | { readonly kind: "ignore"; readonly code: "not_offered" | "own_update" };

export interface DeterministicAcceptancePolicyOptions {
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly allowed_capability_ids: readonly string[];
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function equalTarget(target: unknown, options: DeterministicAcceptancePolicyOptions): boolean {
  const value = object(target);
  return value !== null && (value.actor_id === options.actor_id || value.endpoint_id === options.endpoint_id);
}

const TERMINAL_LIFECYCLES = new Set([
  "result_returned", "verified", "closed", "declined", "expired", "cancelled", "transferred", "target_unavailable",
]);

export class DeterministicAcceptancePolicy {
  constructor(private readonly options: DeterministicAcceptancePolicyOptions, private readonly now: () => string = () => new Date().toISOString()) {}

  decide(snapshot: HandoffReadModel, event: ProtocolEvent, alreadyRunning: boolean): AcceptanceDecision {
    if (event.wfactor === this.options.actor_id && (event.type.includes("status") || event.type.includes("result"))) return { kind: "ignore", code: "own_update" };
    const state = object(snapshot.state);
    if (state === null || typeof state.lifecycle_state !== "string") return { kind: "ignore", code: "not_offered" };
    if (TERMINAL_LIFECYCLES.has(state.lifecycle_state)) return { kind: "decline", code: "terminal" };
    if (state.lifecycle_state !== "offered") return { kind: "ignore", code: "not_offered" };
    const handoffPackage = object(state.package);
    if (handoffPackage === null) return { kind: "decline", code: "terminal" };
    const authority = object(handoffPackage.authority_scope);
    if (authority === null || typeof authority.delegation_id !== "string" || authority.delegation_id.length === 0 || !Array.isArray(authority.scopes) || authority.scopes.length === 0 || !Array.isArray(authority.resource_refs)) return { kind: "decline", code: "authority_missing" };
    if (typeof authority.expires_at !== "string" || Date.parse(authority.expires_at) <= Date.parse(this.now())) return { kind: "decline", code: "expired" };
    if (typeof handoffPackage.accept_by !== "string" || Date.parse(handoffPackage.accept_by) <= Date.parse(this.now())) return { kind: "decline", code: "expired" };
    const target = object(handoffPackage.target);
    if (target === null) return { kind: "decline", code: "not_targeted" };
    if (Object.hasOwn(target, "capability_requirement")) {
      const requirement = object(target.capability_requirement);
      if (requirement === null || typeof requirement.capability_id !== "string" || !this.options.allowed_capability_ids.includes(requirement.capability_id)) return { kind: "decline", code: "unsupported_capability" };
      if (!equalTarget(object(state.target_binding)?.target, this.options)) return { kind: "decline", code: "not_targeted" };
    } else if (!equalTarget(target, this.options)) return { kind: "decline", code: "not_targeted" };
    if (alreadyRunning) return { kind: "decline", code: "already_running" };
    return { kind: "accept" };
  }
}
