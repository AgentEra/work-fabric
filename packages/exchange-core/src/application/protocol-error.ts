import type { JsonObject, JsonValue } from "@work-fabric/exchange-spi";

export type ProtocolErrorCode =
  | "invalid_argument"
  | "unauthenticated"
  | "permission_denied"
  | "not_found"
  | "version_conflict"
  | "invalid_state_transition"
  | "idempotency_key_reused"
  | "precondition_failed"
  | "expired"
  | "unsupported_version"
  | "capability_unavailable"
  | "context_unavailable"
  | "cursor_expired"
  | "rate_limited"
  | "temporarily_unavailable"
  | "internal";

export interface FieldViolation {
  readonly field: string;
  readonly description: string;
}

export function protocolError(
  code: ProtocolErrorCode,
  message: string,
  retryable: boolean,
  options?: {
    readonly retry_after_seconds?: number | null;
    readonly current_resource_version?: number | null;
    readonly field_violations?: readonly FieldViolation[];
    readonly details?: JsonValue;
  },
): JsonObject {
  return {
    code,
    message,
    retryable,
    retry_after_seconds: options?.retry_after_seconds ?? null,
    current_resource_version: options?.current_resource_version ?? null,
    field_violations: (options?.field_violations ?? []).map(
      ({ field, description }) => ({ field, description }),
    ),
    details: options?.details ?? {},
  };
}
