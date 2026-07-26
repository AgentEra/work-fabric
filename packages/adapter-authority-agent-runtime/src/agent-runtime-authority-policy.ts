import type {
  AuthorityDecision,
  AuthorityPolicy,
  AuthorityRequest,
  CapabilityManifest,
  HandoffReadModelStore,
} from "@work-fabric/exchange-spi";

import type { AgentRuntimeAuthorityGrant } from "./config.js";

const MAXIMUM_ID_LENGTH = 255;
const SELF_ENDPOINT_ACTIONS = new Set([
  "workfabric.endpoint.session.open.v1",
  "workfabric.endpoint.session.heartbeat.v1",
  "workfabric.endpoint.session.close.v1",
  "workfabric.endpoint.inbox.read.v1",
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
const HANDOFF_LIFECYCLE_STATES = new Set([
  "target_resolution_pending",
  "target_unavailable",
  "offered",
  "accepted",
  "result_returned",
  "verified",
  "rework_requested",
  "closed",
  "declined",
  "expired",
  "cancelled",
  "transferred",
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

function targetMatches(value: unknown, grant: AgentRuntimeAuthorityGrant): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return ownData(value, "actor_id") === grant.actor_id || ownData(value, "endpoint_id") === grant.endpoint_id;
}

function object(value: unknown): object | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function responsibleActorMatches(value: unknown, grant: AgentRuntimeAuthorityGrant): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && ownData(value, "actor_id") === grant.actor_id;
}

function targeted(state: object, grant: AgentRuntimeAuthorityGrant): boolean {
  const packageValue = ownData(state, "package");
  const packageTarget = typeof packageValue === "object" && packageValue !== null && !Array.isArray(packageValue)
    ? ownData(packageValue, "target")
    : undefined;
  const binding = ownData(state, "target_binding");
  const bindingTarget = typeof binding === "object" && binding !== null && !Array.isArray(binding)
    ? ownData(binding, "target")
    : undefined;
  return targetMatches(packageTarget, grant) || targetMatches(bindingTarget, grant);
}

function responsible(state: object, grant: AgentRuntimeAuthorityGrant): boolean {
  return responsibleActorMatches(ownData(state, "recipient"), grant)
    && responsibleActorMatches(ownData(state, "current_responsible_actor"), grant);
}

function previouslyAccepted(state: object, grant: AgentRuntimeAuthorityGrant): boolean {
  return responsibleActorMatches(ownData(state, "recipient"), grant);
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
  if (action === "workfabric.endpoint.session.open.v1" || action === "workfabric.endpoint.inbox.read.v1") return resourceId === grant.endpoint_id;
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
      || (!TARGETED_HANDOFF_ACTIONS.has(action) && !RESPONSIBLE_HANDOFF_ACTIONS.has(action))) return DENY;
    try {
      const model = await this.handoffs.getHandoff(resourceId);
      const modelObject = object(model);
      if (modelObject === null
        || ownData(modelObject, "tenant_id") !== grant.tenant_id
        || ownData(modelObject, "handoff_id") !== resourceId) return DENY;
      const state = object(ownData(modelObject, "state"));
      if (state === null) return DENY;
      const lifecycleState = ownData(state, "lifecycle_state");
      if (typeof lifecycleState !== "string" || !HANDOFF_LIFECYCLE_STATES.has(lifecycleState)) return DENY;
      if (action === "workfabric.query.handoff.read.v1" && (targeted(state, grant) || previouslyAccepted(state, grant))) return ALLOW;
      if (TARGETED_HANDOFF_ACTIONS.has(action) && lifecycleState === "offered" && targeted(state, grant)) return ALLOW;
      if (RESPONSIBLE_HANDOFF_ACTIONS.has(action) && lifecycleState === "accepted" && responsible(state, grant)) return ALLOW;
    } catch {
      // An unavailable or malformed projection must never grant authority.
    }
    return DENY;
  }
}
