import type { EndpointStoreErrorCode } from "@work-fabric/exchange-spi";

export type EndpointDirectoryErrorCode =
  | "not_found"
  | "version_conflict"
  | "idempotency_conflict"
  | "immutable_binding"
  | "session_fenced"
  | "stale_sequence"
  | "invalid_request"
  | "representation_denied"
  | "endpoint_disabled"
  | "unavailable";

export class EndpointDirectoryError extends Error {
  constructor(
    readonly code: EndpointDirectoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EndpointDirectoryError";
  }
}

export function mapStoreErrorCode(
  code: EndpointStoreErrorCode,
): EndpointDirectoryErrorCode {
  switch (code) {
    case "registration_exists":
    case "registration_version_conflict":
      return "version_conflict";
    case "session_not_found":
      return "not_found";
    default:
      return code;
  }
}
