import type {
  CapabilityConstraintDecision,
  CapabilityConstraintEvaluation,
  CapabilityConstraintEvaluator,
} from "@work-fabric/exchange-spi";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const FIELDS = new Set(["selected_citizen_id", "contract_digest"]);

function ownString(
  value: object,
  key: "selected_citizen_id" | "contract_digest",
): string | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
    ? descriptor.value
    : null;
}

function binding(value: unknown): {
  readonly selected_citizen_id: string;
  readonly contract_digest: string;
} | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== FIELDS.size ||
    keys.some((key) => typeof key !== "string" || !FIELDS.has(key))
  ) return null;
  const selectedCitizenId = ownString(value, "selected_citizen_id");
  const contractDigest = ownString(value, "contract_digest");
  if (
    selectedCitizenId === null ||
    selectedCitizenId.length === 0 ||
    selectedCitizenId.length > 128 ||
    selectedCitizenId.trim() !== selectedCitizenId ||
    contractDigest === null ||
    !DIGEST.test(contractDigest)
  ) return null;
  return {
    selected_citizen_id: selectedCitizenId,
    contract_digest: contractDigest,
  };
}

/**
 * Evaluates only Work Fabric's standard dynamic Citizen binding. Other
 * constraint vocabularies require a deployment-owned evaluator and fail
 * closed here.
 */
export class NetworkCitizenBindingConstraintEvaluator
  implements CapabilityConstraintEvaluator {
  readonly manifest = Object.freeze({
    profile: "exchange.capability-constraint.v1",
    adapter: "network-citizen-binding",
    capabilities: Object.freeze({
      exact_citizen_binding: true,
      exact_contract_digest: true,
    }),
  });

  async evaluate(
    input: CapabilityConstraintEvaluation,
  ): Promise<CapabilityConstraintDecision> {
    const required = binding(input.requirement_constraints);
    const advertised = binding(input.capability.constraints);
    if (required === null || advertised === null) return "unavailable";
    return required.selected_citizen_id === advertised.selected_citizen_id &&
        required.contract_digest === advertised.contract_digest
      ? "match"
      : "mismatch";
  }
}
