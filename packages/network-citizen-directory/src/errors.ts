import { CitizenStoreError } from "@work-fabric/network-citizen-spi";

export type CitizenDirectoryErrorCode =
  | "invalid_request"
  | "not_found"
  | "representation_denied"
  | "citizen_disabled"
  | "version_conflict"
  | "idempotency_conflict"
  | "immutable_binding"
  | "session_fenced"
  | "stale_sequence"
  | "schema_digest_conflict"
  | "temporarily_unavailable";

export class CitizenDirectoryError extends Error {
  constructor(
    readonly code: CitizenDirectoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CitizenDirectoryError";
  }
}

export function mapCitizenStoreError(error: unknown): CitizenDirectoryError {
  if (!(error instanceof CitizenStoreError)) {
    return new CitizenDirectoryError(
      "temporarily_unavailable",
      "Network Citizen store is unavailable",
    );
  }
  switch (error.code) {
    case "registration_version_conflict":
    case "declaration_version_conflict":
      return new CitizenDirectoryError("version_conflict", error.message);
    case "immutable_binding":
    case "idempotency_conflict":
    case "session_fenced":
    case "stale_sequence":
    case "schema_digest_conflict":
      return new CitizenDirectoryError(error.code, error.message);
    case "session_not_found":
      return new CitizenDirectoryError("not_found", error.message);
  }
}
