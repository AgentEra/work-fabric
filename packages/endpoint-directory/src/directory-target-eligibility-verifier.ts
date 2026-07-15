import {
  TARGET_ELIGIBILITY_REQUIRED_CAPABILITIES,
  matchesSemanticVersion,
  type CapabilityConstraintEvaluator,
  type CapabilityDescriptor,
  type CapabilityManifest,
  type EndpointDescriptor,
  type EndpointDirectoryStore,
  type JsonObject,
  type TargetEligibilityDecision,
  type TargetEligibilityRequest,
  type TargetEligibilityVerifier,
} from "@work-fabric/exchange-spi";

export interface DirectoryTargetEligibilityDependencies {
  readonly store: EndpointDirectoryStore;
  readonly clock: { now(): string };
  readonly constraintEvaluator?: CapabilityConstraintEvaluator;
}

interface Requirement {
  readonly capability_id: string;
  readonly version_constraint?: string;
  readonly input_media_types: readonly string[];
  readonly output_media_types: readonly string[];
  readonly constraints: JsonObject | null;
}

const manifest: CapabilityManifest = {
  profile: "exchange.target-eligibility.v1",
  adapter: "endpoint-directory",
  capabilities: Object.fromEntries(
    TARGET_ELIGIBILITY_REQUIRED_CAPABILITIES.map((capability) => [
      capability,
      true,
    ]),
  ),
};

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

function requirement(value: JsonObject): Requirement | null {
  const capabilityId = value.capability_id;
  const version = value.version_constraint;
  const input = value.input_media_types;
  const output = value.output_media_types;
  const constraints = value.constraints;
  if (
    typeof capabilityId !== "string" ||
    capabilityId.length === 0 ||
    (version !== undefined && typeof version !== "string")
  ) {
    return null;
  }
  const inputMedia = input === undefined ? [] : stringArray(input);
  const outputMedia = output === undefined ? [] : stringArray(output);
  if (inputMedia === null || outputMedia === null) return null;
  if (
    constraints !== undefined &&
    (constraints === null ||
      Array.isArray(constraints) ||
      typeof constraints !== "object")
  ) {
    return null;
  }
  return {
    capability_id: capabilityId,
    ...(version === undefined ? {} : { version_constraint: version }),
    input_media_types: inputMedia,
    output_media_types: outputMedia,
    constraints: constraints === undefined
      ? null
      : (constraints as JsonObject),
  };
}

function structurallyMatches(
  capability: CapabilityDescriptor,
  expected: Requirement,
): boolean {
  return (
    capability.capability_id === expected.capability_id &&
    matchesSemanticVersion(capability.version, expected.version_constraint) &&
    expected.input_media_types.every((item) =>
      capability.input_media_types.includes(item),
    ) &&
    expected.output_media_types.every((item) =>
      capability.output_media_types.includes(item),
    )
  );
}

export class DirectoryTargetEligibilityVerifier
  implements TargetEligibilityVerifier
{
  readonly manifest = structuredClone(manifest);

  constructor(
    private readonly dependencies: DirectoryTargetEligibilityDependencies,
  ) {}

  async verify(
    request: TargetEligibilityRequest,
  ): Promise<TargetEligibilityDecision> {
    if (
      request.principal.tenant_id !== request.tenant_id ||
      request.exchange_id.length === 0
    ) {
      return { kind: "unavailable", reason: "request_scope_unavailable" };
    }
    const expected = requirement(request.requirement);
    if (expected === null) {
      return { kind: "unavailable", reason: "invalid_requirement" };
    }
    try {
      const candidates = await this.explicitCandidates(request);
      if (candidates.length === 0) {
        return { kind: "ineligible", reason: "endpoint_unavailable" };
      }
      const capabilities = candidates.flatMap((endpoint) =>
        endpoint.capabilities.filter((capability) =>
          structurallyMatches(capability, expected),
        ),
      );
      if (capabilities.length === 0) {
        return { kind: "ineligible", reason: "capability_mismatch" };
      }
      if (
        expected.constraints === null ||
        Object.keys(expected.constraints).length === 0
      ) {
        return { kind: "eligible" };
      }
      const evaluator = this.dependencies.constraintEvaluator;
      if (evaluator === undefined) {
        return {
          kind: "unavailable",
          reason: "constraint_evaluator_unavailable",
        };
      }
      let unavailable = false;
      for (const capability of capabilities) {
        const decision = await evaluator.evaluate({
          tenant_id: request.tenant_id,
          capability,
          requirement_constraints: expected.constraints,
        });
        if (decision === "match") return { kind: "eligible" };
        if (decision === "unavailable") unavailable = true;
      }
      return unavailable
        ? { kind: "unavailable", reason: "constraint_evaluator_unavailable" }
        : { kind: "ineligible", reason: "constraint_mismatch" };
    } catch {
      return { kind: "unavailable", reason: "directory_unavailable" };
    }
  }

  private async explicitCandidates(
    request: TargetEligibilityRequest,
  ): Promise<readonly EndpointDescriptor[]> {
    const now = this.dependencies.clock.now();
    if ("endpoint_id" in request.proposed_target) {
      const endpoint = await this.dependencies.store.getProjectedEndpoint(
        request.tenant_id,
        request.proposed_target.endpoint_id,
        now,
      );
      return endpoint === null || endpoint.availability !== "available"
        ? []
        : [endpoint];
    }
    return this.dependencies.store.listActorEndpoints(
      request.tenant_id,
      request.proposed_target.actor_id,
      now,
    ).then((endpoints) =>
      endpoints.filter((endpoint) => endpoint.availability === "available"),
    );
  }
}
