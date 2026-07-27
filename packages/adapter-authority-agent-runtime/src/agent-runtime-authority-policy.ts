import type {
  AuthorityDecision,
  AuthorityPolicy,
  AuthorityRequest,
  CapabilityManifest,
  HandoffReadModelStore,
} from "@work-fabric/exchange-spi";
import type { HandoffState, HandoffTarget } from "@work-fabric/exchange-core";

import type { AgentRuntimeAuthorityGrant } from "./config.js";
import { validateRuntimeHandoffReadModel } from "./handoff-read-model-validator.js";

const MAXIMUM_ID_LENGTH = 255;
const SELF_ENDPOINT_ACTIONS = new Set([
  "workfabric.endpoint.session.open.v1",
  "workfabric.endpoint.session.heartbeat.v1",
  "workfabric.endpoint.session.close.v1",
  "workfabric.endpoint.inbox.read.v1",
  "workfabric.endpoint.claim-pool.read.v1",
]);
const SELF_SUBSCRIPTION_ACTIONS = new Set([
  "workfabric.subscription.read.v1",
  "workfabric.subscription.manage.v1",
  "workfabric.subscription.stream.v1",
  "workfabric.subscription.ack.v1",
]);
const TARGETED_HANDOFF_ACTIONS = new Set([
  "workfabric.query.handoff.read.v1",
  "workfabric.handoff.accept.v1",
  "workfabric.handoff.decline.v1",
]);
const RESPONSIBLE_HANDOFF_ACTIONS = new Set([
  "workfabric.query.handoff.read.v1",
  "workfabric.handoff.report_status.v1",
  "workfabric.handoff.return_result.v1",
]);
const CLAIMABLE_HANDOFF_ACTIONS = new Set([
  "workfabric.handoff.claim.v1",
]);
const CLAIM_HOLDER_ACTIONS = new Set([
  "workfabric.handoff.renew_claim.v1",
  "workfabric.handoff.release_claim.v1",
  "workfabric.handoff.accept.v1",
]);

const manifest = Object.freeze({
  profile: "exchange.authority.v1",
  adapter: "agent-runtime",
  capabilities: Object.freeze({
    explicit_decision: true,
    default_deny: true,
    resource_scoping: true,
  }),
}) satisfies CapabilityManifest;

const DENY: AuthorityDecision = Object.freeze({
  kind: "deny",
  reason: "Runtime authority was not granted",
});
const ALLOW: AuthorityDecision = Object.freeze({ kind: "allow" });

function ownData(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAXIMUM_ID_LENGTH && value.trim() === value;
}

function validGrant(value: unknown): value is AgentRuntimeAuthorityGrant {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return ["tenant_id", "principal_id", "actor_id", "endpoint_id", "subscription_id"]
    .every((field) => boundedIdentifier(ownData(value, field)));
}

function targetMatches(target: HandoffTarget, grant: AgentRuntimeAuthorityGrant): boolean {
  if ("actor_id" in target) return target.actor_id === grant.actor_id;
  if ("endpoint_id" in target) return target.endpoint_id === grant.endpoint_id;
  return false;
}

function responsibleActorMatches(actor: HandoffState["recipient"], grant: AgentRuntimeAuthorityGrant): boolean {
  return actor !== null && actor.actor_id === grant.actor_id;
}

function targeted(state: HandoffState, grant: AgentRuntimeAuthorityGrant): boolean {
  return targetMatches(state.package.target, grant)
    || (state.target_binding !== null && targetMatches(state.target_binding.target, grant));
}

function responsible(state: HandoffState, grant: AgentRuntimeAuthorityGrant): boolean {
  return responsibleActorMatches(state.recipient, grant)
    && responsibleActorMatches(state.current_responsible_actor, grant);
}

function previouslyAccepted(state: HandoffState, grant: AgentRuntimeAuthorityGrant): boolean {
  return responsibleActorMatches(state.recipient, grant);
}

function activeClaimMatches(state: HandoffState, grant: AgentRuntimeAuthorityGrant): boolean {
  return state.active_claim !== null
    && state.active_claim.actor.actor_type === "agent"
    && state.active_claim.actor.actor_id === grant.actor_id
    && state.active_claim.endpoint_id === grant.endpoint_id;
}

function exactRuntimeGrant(request: AuthorityRequest, grants: readonly AgentRuntimeAuthorityGrant[]): AgentRuntimeAuthorityGrant | null {
  try {
    if (typeof request !== "object" || request === null) return null;
    const principal = ownData(request, "principal");
    if (typeof principal !== "object" || principal === null || Array.isArray(principal)) return null;
    const actorId = ownData(request, "actor_id");
    const endpointId = ownData(request, "endpoint_id");
    if (!boundedIdentifier(actorId) || !boundedIdentifier(endpointId) || ownData(request, "actor_type") !== "agent") return null;
    const claims = ownData(principal, "actor_claims");
    if (!Array.isArray(claims) || !claims.some((claim) => typeof claim === "object" && claim !== null && !Array.isArray(claim)
      && ownData(claim, "actor_id") === actorId
      && ownData(claim, "actor_type") === "agent"
      && Array.isArray(ownData(claim, "endpoint_ids"))
      && (ownData(claim, "endpoint_ids") as readonly unknown[]).includes(endpointId))) return null;
    return grants.find((grant) =>
      ownData(principal, "tenant_id") === grant.tenant_id
      && ownData(principal, "principal_id") === grant.principal_id
      && actorId === grant.actor_id
      && endpointId === grant.endpoint_id,
    ) ?? null;
  } catch {
    return null;
  }
}

function selfEndpointAllowed(action: unknown, resourceId: unknown, grant: AgentRuntimeAuthorityGrant): boolean {
  if (typeof action !== "string" || !SELF_ENDPOINT_ACTIONS.has(action)) return false;
  if (
    action === "workfabric.endpoint.session.open.v1"
    || action === "workfabric.endpoint.inbox.read.v1"
    || action === "workfabric.endpoint.claim-pool.read.v1"
  ) return resourceId === grant.endpoint_id;
  if (!boundedIdentifier(resourceId)) return false;
  const prefix = `${grant.endpoint_id}/`;
  const suffix = resourceId.startsWith(prefix) ? resourceId.slice(prefix.length) : "";
  return suffix.length > 0 && suffix.length <= MAXIMUM_ID_LENGTH && !suffix.includes("/") && suffix.trim() === suffix;
}

export class AgentRuntimeAuthorityPolicy implements AuthorityPolicy {
  private readonly grants: readonly AgentRuntimeAuthorityGrant[];

  constructor(grants: readonly AgentRuntimeAuthorityGrant[], private readonly handoffs: HandoffReadModelStore) {
    if (!Array.isArray(grants) || !grants.every(validGrant)) throw new TypeError("Agent Runtime authority grants must be valid");
    this.grants = Object.freeze(grants.map((grant) => Object.freeze({ ...grant })));
  }

  get manifest(): CapabilityManifest {
    return structuredClone(manifest);
  }

  async authorize(request: AuthorityRequest): Promise<AuthorityDecision> {
    const grant = exactRuntimeGrant(request, this.grants);
    if (grant === null || ownData(request, "delegation_id") !== null) return DENY;
    const action = ownData(request, "action");
    const resourceId = ownData(request, "resource_id");
    if (selfEndpointAllowed(action, resourceId, grant)) return ALLOW;
    if (typeof action === "string" && SELF_SUBSCRIPTION_ACTIONS.has(action) && resourceId === grant.subscription_id) return ALLOW;
    if (typeof action !== "string" || !boundedIdentifier(resourceId)
      || (
        !TARGETED_HANDOFF_ACTIONS.has(action)
        && !RESPONSIBLE_HANDOFF_ACTIONS.has(action)
        && !CLAIMABLE_HANDOFF_ACTIONS.has(action)
        && !CLAIM_HOLDER_ACTIONS.has(action)
      )) return DENY;
    try {
      const model = await this.handoffs.getHandoff(resourceId);
      const handoff = validateRuntimeHandoffReadModel(model, grant.tenant_id, resourceId);
      if (handoff === null) return DENY;
      const { state } = handoff;
      const lifecycleState = state.lifecycle_state;
      if (
        action === "workfabric.query.handoff.read.v1"
        && (targeted(state, grant) || previouslyAccepted(state, grant) || activeClaimMatches(state, grant))
      ) return ALLOW;
      if (CLAIMABLE_HANDOFF_ACTIONS.has(action) && lifecycleState === "claimable") return ALLOW;
      if (CLAIM_HOLDER_ACTIONS.has(action) && lifecycleState === "claimed" && activeClaimMatches(state, grant)) return ALLOW;
      if (TARGETED_HANDOFF_ACTIONS.has(action) && lifecycleState === "offered" && targeted(state, grant)) return ALLOW;
      if (RESPONSIBLE_HANDOFF_ACTIONS.has(action) && lifecycleState === "accepted" && responsible(state, grant)) return ALLOW;
    } catch {
      // An unavailable or malformed projection must never grant authority.
    }
    return DENY;
  }
}
