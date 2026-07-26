import type { HandoffReadModel, ProtocolEvent } from "@work-fabric/sdk-typescript";

import { normalizeRfc3339 } from "./rfc3339.js";

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

function rfc3339(value: unknown): string | null {
  try { return normalizeRfc3339(value, "timestamp"); } catch { return null; }
}

function canonicalBinding(value: unknown, options: DeterministicAcceptancePolicyOptions): boolean {
  const binding = object(value);
  if (binding === null || Object.keys(binding).length !== 6 || !["target", "resolved_by", "resolver_endpoint_id", "delegation_id", "resolved_at", "evidence"].every((key) => Object.hasOwn(binding, key))) return false;
  const actor = object(binding.resolved_by);
  return equalTarget(binding.target, options)
    && actor !== null && Object.keys(actor).length === 2 && typeof actor.actor_id === "string" && ["human", "agent", "system"].includes(actor.actor_type as string)
    && typeof binding.resolver_endpoint_id === "string" && binding.resolver_endpoint_id.length > 0
    && (binding.delegation_id === null || typeof binding.delegation_id === "string")
    && rfc3339(binding.resolved_at) !== null
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
    const now = rfc3339(this.now());
    const authorityExpiry = rfc3339(authority.expires_at);
    const acceptBy = rfc3339(handoffPackage.accept_by);
    if (now === null || authorityExpiry === null || Date.parse(authorityExpiry) <= Date.parse(now)) return { kind: "decline", code: "expired" };
    if (acceptBy === null || Date.parse(acceptBy) <= Date.parse(now)) return { kind: "decline", code: "expired" };
    const target = object(handoffPackage.target);
    if (target === null) return { kind: "decline", code: "not_targeted" };
    if (Object.hasOwn(target, "capability_requirement")) {
      if (Object.keys(target).length !== 1) return { kind: "decline", code: "not_targeted" };
      const requirement = object(target.capability_requirement);
      if (!canonicalRequirement(requirement) || !this.options.allowed_capability_ids.includes(requirement.capability_id)) return { kind: "decline", code: "unsupported_capability" };
      if (!canonicalBinding(state.target_binding, this.options)) return { kind: "decline", code: "not_targeted" };
    } else if (!equalTarget(target, this.options)) return { kind: "decline", code: "not_targeted" };
    if (alreadyRunning) return { kind: "decline", code: "already_running" };
    return { kind: "accept" };
  }
}

function canonicalRequirement(value: Record<string, unknown> | null): value is Record<string, unknown> & { readonly capability_id: string } {
  if (value === null || !Object.hasOwn(value, "capability_id") || Object.keys(value).some((key) => !["capability_id", "version_constraint", "input_media_types", "output_media_types", "constraints", "extensions"].includes(key))) return false;
  if (typeof value.capability_id !== "string" || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(value.capability_id) || value.capability_id.length > 128) return false;
  if (value.version_constraint !== undefined && (typeof value.version_constraint !== "string" || value.version_constraint.length === 0 || value.version_constraint.length > 256)) return false;
  for (const field of ["input_media_types", "output_media_types"] as const) {
    const media = value[field];
    if (media !== undefined && (!Array.isArray(media) || new Set(media).size !== media.length || media.some((item) => typeof item !== "string" || item.length > 255 || !/^[^/\s]+\/[^/\s]+$/.test(item)))) return false;
  }
  return true;
}
