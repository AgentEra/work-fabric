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
  if (typeof value !== "object" || value === null || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
  }
  return value as Record<string, unknown>;
}

function equalTarget(target: unknown, options: DeterministicAcceptancePolicyOptions): boolean {
  const value = object(target);
  if (value === null) return false;
  const keys = Object.keys(value);
  return (keys.length === 1 && keys[0] === "actor_id" && value.actor_id === options.actor_id)
    || (keys.length === 1 && keys[0] === "endpoint_id" && value.endpoint_id === options.endpoint_id);
}

function rfc3339Utc(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function canonicalBinding(value: unknown, options: DeterministicAcceptancePolicyOptions): boolean {
  const binding = object(value);
  if (binding === null || Object.keys(binding).length !== 6 || !["target", "resolved_by", "resolver_endpoint_id", "delegation_id", "resolved_at", "evidence"].every((key) => Object.hasOwn(binding, key))) return false;
  const actor = object(binding.resolved_by);
  return equalTarget(binding.target, options)
    && actor !== null && Object.keys(actor).length === 2 && typeof actor.actor_id === "string" && ["human", "agent", "system"].includes(actor.actor_type as string)
    && typeof binding.resolver_endpoint_id === "string" && binding.resolver_endpoint_id.length > 0
    && (binding.delegation_id === null || typeof binding.delegation_id === "string")
    && rfc3339Utc(binding.resolved_at)
    && Array.isArray(binding.evidence);
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
    if (!rfc3339Utc(authority.expires_at) || Date.parse(authority.expires_at) <= Date.parse(this.now())) return { kind: "decline", code: "expired" };
    if (!rfc3339Utc(handoffPackage.accept_by) || Date.parse(handoffPackage.accept_by) <= Date.parse(this.now())) return { kind: "decline", code: "expired" };
    const target = object(handoffPackage.target);
    if (target === null) return { kind: "decline", code: "not_targeted" };
    if (Object.hasOwn(target, "capability_requirement")) {
      const requirement = object(target.capability_requirement);
      if (requirement === null || typeof requirement.capability_id !== "string" || !this.options.allowed_capability_ids.includes(requirement.capability_id)) return { kind: "decline", code: "unsupported_capability" };
      if (!canonicalBinding(state.target_binding, this.options)) return { kind: "decline", code: "not_targeted" };
    } else if (!equalTarget(target, this.options)) return { kind: "decline", code: "not_targeted" };
    if (alreadyRunning) return { kind: "decline", code: "already_running" };
    return { kind: "accept" };
  }
}
