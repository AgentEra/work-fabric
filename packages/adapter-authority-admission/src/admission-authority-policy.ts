import type { AdmissionPrincipalTrust } from "@work-fabric/adapter-identity-admission";
import type {
  AuthorityDecision,
  AuthorityPolicy,
  AuthorityRequest,
  CapabilityManifest,
} from "@work-fabric/exchange-spi";

const OFFER_ACTION = "workfabric.handoff.offer.v1" as const;
const MAXIMUM_ID_LENGTH = 255;
const MAXIMUM_PRINCIPAL_ID_LENGTH = "admission:".length + MAXIMUM_ID_LENGTH;
const IDENTITY_KIND_ATTRIBUTE = "workfabric.dev/identity_kind";
const CONNECTOR_ID_ATTRIBUTE = "workfabric.dev/connector_id";
const INGRESS_ID_ATTRIBUTE = "workfabric.dev/ingress_id";
const IDEMPOTENCY_KEY_ATTRIBUTE = "workfabric.dev/idempotency_key";

export interface AdmissionAuthorityRule {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly principal_id: string;
  readonly action: typeof OFFER_ACTION;
}

const manifest = Object.freeze({
  profile: "exchange.authority.v1",
  adapter: "admission",
  capabilities: Object.freeze({
    explicit_decision: true,
    default_deny: true,
    resource_scoping: true,
  }),
}) satisfies CapabilityManifest;

const DENY: AuthorityDecision = Object.freeze({
  kind: "deny",
  reason: "No explicit admission authority rule matched",
});

function ownDataValue(object: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function boundedIdentifier(value: unknown, maximum = MAXIMUM_ID_LENGTH): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value.trim() === value;
}

function validatedRule(value: unknown): Readonly<AdmissionAuthorityRule> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Admission authority rule must be an object");
  }
  let tenantId: unknown;
  let connectorId: unknown;
  let principalId: unknown;
  let action: unknown;
  try {
    tenantId = ownDataValue(value, "tenant_id");
    connectorId = ownDataValue(value, "connector_id");
    principalId = ownDataValue(value, "principal_id");
    action = ownDataValue(value, "action");
  } catch {
    throw new TypeError("Admission authority rule must contain own data fields");
  }
  if (!boundedIdentifier(tenantId)) {
    throw new TypeError("tenant_id must be a bounded trimmed identifier");
  }
  if (!boundedIdentifier(connectorId)) {
    throw new TypeError("connector_id must be a bounded trimmed identifier");
  }
  if (!boundedIdentifier(principalId, MAXIMUM_PRINCIPAL_ID_LENGTH)) {
    throw new TypeError("principal_id must be a bounded trimmed identifier");
  }
  if (action !== OFFER_ACTION) {
    throw new TypeError(`action must be exactly ${OFFER_ACTION}`);
  }
  if (principalId !== `admission:${connectorId}`) {
    throw new TypeError("principal_id must exactly identify the admission connector");
  }
  return Object.freeze({
    tenant_id: tenantId,
    connector_id: connectorId,
    principal_id: principalId,
    action,
  });
}

function validatedRules(values: readonly AdmissionAuthorityRule[]): readonly Readonly<AdmissionAuthorityRule>[] {
  if (!Array.isArray(values)) {
    throw new TypeError("Admission authority rules must be an array");
  }
  const result: Readonly<AdmissionAuthorityRule>[] = [];
  for (let index = 0; index < values.length; index += 1) {
    let value: unknown;
    try {
      value = ownDataValue(values, String(index));
    } catch {
      throw new TypeError("Admission authority rules must contain own data entries");
    }
    const rule = validatedRule(value);
    if (result.some((candidate) =>
      candidate.tenant_id === rule.tenant_id
      && candidate.connector_id === rule.connector_id
      && candidate.principal_id === rule.principal_id
      && candidate.action === rule.action
    )) {
      throw new TypeError("Duplicate admission authority rule");
    }
    result.push(rule);
  }
  return Object.freeze(result);
}

interface ExactRequest {
  readonly principal: object;
  readonly actor_id: unknown;
  readonly actor_type: unknown;
  readonly endpoint_id: unknown;
  readonly delegation_id: unknown;
  readonly action: unknown;
  readonly resource_id: unknown;
  readonly correlation_id: unknown;
  readonly idempotency_key: unknown;
}

function exactRequest(request: AuthorityRequest): ExactRequest | null {
  try {
    const principal = ownDataValue(request, "principal");
    if (typeof principal !== "object" || principal === null) return null;
    return {
      principal,
      actor_id: ownDataValue(request, "actor_id"),
      actor_type: ownDataValue(request, "actor_type"),
      endpoint_id: ownDataValue(request, "endpoint_id"),
      delegation_id: ownDataValue(request, "delegation_id"),
      action: ownDataValue(request, "action"),
      resource_id: ownDataValue(request, "resource_id"),
      correlation_id: ownDataValue(request, "correlation_id"),
      idempotency_key: ownDataValue(request, "idempotency_key"),
    };
  } catch {
    return null;
  }
}

function exactlyRepresented(request: ExactRequest): boolean {
  try {
    const claims = ownDataValue(request.principal, "actor_claims");
    if (!Array.isArray(claims) || claims.length !== 1) return false;
    const claim = ownDataValue(claims, "0");
    if (typeof claim !== "object" || claim === null || Array.isArray(claim)) return false;
    const endpointIds = ownDataValue(claim, "endpoint_ids");
    return Array.isArray(endpointIds)
      && endpointIds.length === 1
      && ownDataValue(claim, "actor_id") === request.actor_id
      && ownDataValue(claim, "actor_type") === request.actor_type
      && ownDataValue(endpointIds, "0") === request.endpoint_id;
  } catch {
    return false;
  }
}

function matchesRule(request: ExactRequest, rule: Readonly<AdmissionAuthorityRule>): boolean {
  try {
    const attributes = ownDataValue(request.principal, "attributes");
    return ownDataValue(request.principal, "tenant_id") === rule.tenant_id
      && ownDataValue(request.principal, "principal_id") === rule.principal_id
      && typeof attributes === "object"
      && attributes !== null
      && !Array.isArray(attributes)
      && ownDataValue(attributes, IDENTITY_KIND_ATTRIBUTE) === "admission"
      && ownDataValue(attributes, CONNECTOR_ID_ATTRIBUTE) === rule.connector_id
      && boundedIdentifier(request.correlation_id, 128)
      && ownDataValue(attributes, INGRESS_ID_ATTRIBUTE) === request.correlation_id
      && boundedIdentifier(request.idempotency_key, 256)
      && ownDataValue(attributes, IDEMPOTENCY_KEY_ATTRIBUTE) === request.idempotency_key
      && request.action === rule.action;
  } catch {
    return false;
  }
}

export class AdmissionAuthorityPolicy implements AuthorityPolicy {
  private readonly allowRules: readonly Readonly<AdmissionAuthorityRule>[];

  constructor(
    allowRules: readonly AdmissionAuthorityRule[],
    private readonly trust: AdmissionPrincipalTrust,
  ) {
    this.allowRules = validatedRules(allowRules);
  }

  get manifest(): CapabilityManifest {
    return structuredClone(manifest);
  }

  async authorize(input: AuthorityRequest): Promise<AuthorityDecision> {
    const request = exactRequest(input);
    if (request === null || !this.trust.isTrusted(request.principal as AuthorityRequest["principal"])) {
      return DENY;
    }
    if (
      request.action !== OFFER_ACTION
      || request.resource_id !== null
      || request.delegation_id !== null
      || !exactlyRepresented(request)
    ) {
      return DENY;
    }
    return this.allowRules.some((rule) => matchesRule(request, rule))
      ? { kind: "allow" }
      : DENY;
  }
}
