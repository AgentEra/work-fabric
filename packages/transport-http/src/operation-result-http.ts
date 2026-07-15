import type { NormalizedOperationOutcome } from "@work-fabric/exchange-spi";

function errorCode(outcome: NormalizedOperationOutcome): string | null {
  const code = outcome.error?.code;
  return typeof code === "string" ? code : null;
}

export function operationResultStatus(
  outcome: NormalizedOperationOutcome,
): number {
  switch (outcome.operation_status) {
    case "accepted":
      return 200;
    case "conflict":
      return 409;
    case "temporarily_unavailable":
      return 503;
    case "rejected":
      switch (errorCode(outcome)) {
        case "invalid_argument":
          return 400;
        case "unauthenticated":
          return 401;
        case "permission_denied":
          return 403;
        case "not_found":
          return 404;
        default:
          return 422;
      }
  }
}
