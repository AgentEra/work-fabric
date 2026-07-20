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

const ALLOW: AuthorityDecision = Object.freeze({ kind: "allow" });
const INVALID_DECISION = "Authority policy returned an invalid decision";

function decisionKind(decision: unknown): "allow" | "deny" {
  if (typeof decision !== "object" || decision === null) {
    throw new TypeError(INVALID_DECISION);
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(decision, "kind");
  } catch {
    throw new TypeError(INVALID_DECISION);
  }
  if (
    descriptor === undefined
    || !("value" in descriptor)
    || (descriptor.value !== "allow" && descriptor.value !== "deny")
  ) {
    throw new TypeError(INVALID_DECISION);
  }
  return descriptor.value;
}

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
      if (decisionKind(decision) === "allow") return ALLOW;
    }
    return DENY;
  }
}
