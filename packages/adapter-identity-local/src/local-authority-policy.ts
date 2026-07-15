import type {
  AuthorityDecision,
  AuthorityPolicy,
  AuthorityRequest,
  CapabilityManifest,
} from "@work-fabric/exchange-spi";

export interface LocalAuthorityAllowRule {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly actor_id: string;
  readonly actor_type: "human" | "agent" | "system";
  readonly endpoint_id: string;
  readonly action: string;
  readonly resource_id: string | null;
}

const manifest: CapabilityManifest = {
  profile: "exchange.authority.v1",
  adapter: "local",
  capabilities: {
    explicit_decision: true,
    default_deny: true,
    resource_scoping: true,
  },
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class LocalAuthorityPolicy implements AuthorityPolicy {
  private readonly allowRules: readonly LocalAuthorityAllowRule[];

  constructor(allowRules: readonly LocalAuthorityAllowRule[]) {
    this.allowRules = clone(allowRules);
  }

  get manifest(): CapabilityManifest {
    return clone(manifest);
  }

  async authorize(request: AuthorityRequest): Promise<AuthorityDecision> {
    const representedActor = request.principal.actor_claims.find(
      (claim) =>
        claim.actor_id === request.actor_id &&
        claim.actor_type === request.actor_type &&
        claim.endpoint_ids.includes(request.endpoint_id),
    );
    if (representedActor === undefined) {
      return {
        kind: "deny",
        reason: "Principal has no trusted Actor representation for this Endpoint",
      };
    }

    const allowed = this.allowRules.some(
      (rule) =>
        rule.tenant_id === request.principal.tenant_id &&
        rule.principal_id === request.principal.principal_id &&
        rule.actor_id === request.actor_id &&
        rule.actor_type === request.actor_type &&
        rule.endpoint_id === request.endpoint_id &&
        rule.action === request.action &&
        rule.resource_id === request.resource_id,
    );
    return allowed
      ? { kind: "allow" }
      : { kind: "deny", reason: "No explicit allow rule matched" };
  }
}
