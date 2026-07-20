import type {
  AuthorityDecision,
  AuthorityPolicy,
  AuthorityRequest,
  CapabilityManifest,
} from "@work-fabric/exchange-spi";

const manifest = Object.freeze({
  profile: "exchange.authority.v1",
  adapter: "composite",
  capabilities: Object.freeze({
    explicit_decision: true,
    default_deny: true,
    resource_scoping: true,
  }),
}) satisfies CapabilityManifest;

const DENY: AuthorityDecision = Object.freeze({
  kind: "deny",
  reason: "No authority policy allowed the request",
});

export class CompositeAuthorityPolicy implements AuthorityPolicy {
  private readonly policies: readonly AuthorityPolicy[];

  constructor(policies: readonly AuthorityPolicy[]) {
    if (!Array.isArray(policies)) {
      throw new TypeError("Authority policies must be an array");
    }
    this.policies = Object.freeze([...policies]);
  }

  get manifest(): CapabilityManifest {
    return structuredClone(manifest);
  }

  async authorize(request: AuthorityRequest): Promise<AuthorityDecision> {
    for (const policy of this.policies) {
      const decision = await policy.authorize(request);
      if (decision.kind === "allow") return decision;
    }
    return DENY;
  }
}
