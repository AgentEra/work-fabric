export type DebugHttpErrorCode =
  | "authentication_required"
  | "forbidden_participant"
  | "idempotency_conflict"
  | "invalid_request"
  | "method_not_allowed"
  | "not_found"
  | "payload_too_large"
  | "service_unavailable";

export class DebugHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: DebugHttpErrorCode,
  ) {
    super(code);
    this.name = "DebugHttpError";
  }
}
