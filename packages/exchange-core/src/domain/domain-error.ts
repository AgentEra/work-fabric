import type { HandoffEvent } from "./handoff-events.js";

export interface DomainError {
  readonly code:
    | "invalid_argument"
    | "permission_denied"
    | "not_found"
    | "invalid_state_transition"
    | "precondition_failed"
    | "expired"
    | "context_unavailable";
  readonly message: string;
  readonly retryable: false;
}

export type DomainDecision =
  | { readonly kind: "accepted"; readonly events: readonly HandoffEvent[] }
  | { readonly kind: "rejected"; readonly error: DomainError };
