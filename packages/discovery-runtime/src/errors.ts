export type DiscoveryErrorCode =
  | "discovery_record_invalid"
  | "discovery_record_too_large"
  | "discovery_digest_mismatch"
  | "discovery_signature_invalid"
  | "discovery_wrong_audience"
  | "discovery_not_yet_valid"
  | "discovery_expired"
  | "discovery_record_conflict"
  | "discovery_cursor_invalid"
  | "discovery_budget_exhausted"
  | "discovery_rate_limited"
  | "discovery_unavailable"
  | "discovery_not_found";

export class DiscoveryError extends Error {
  constructor(readonly code: DiscoveryErrorCode) {
    super(code);
    this.name = "DiscoveryError";
  }
}
