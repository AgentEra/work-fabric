import type {
  CapabilityOperationKind,
} from "@work-fabric/agent-runtime-spi";
import type { CitizenJsonObject } from "@work-fabric/network-citizen-spi";

export function capabilityOperationKind(
  constraints: CitizenJsonObject,
): CapabilityOperationKind {
  const value = constraints.operation_kind;
  if (value === undefined) return "command";
  if (
    value !== "query" &&
    value !== "command" &&
    value !== "destructive"
  ) {
    throw new TypeError("Capability operation_kind is invalid");
  }
  return value;
}
