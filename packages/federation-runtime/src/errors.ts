export type FederationErrorCode =
  | "federation_envelope_invalid"
  | "federation_envelope_too_large"
  | "federation_signature_invalid"
  | "federation_wrong_audience"
  | "federation_expired"
  | "federation_not_yet_valid"
  | "federation_digest_mismatch"
  | "federation_replay_conflict"
  | "federation_receipt_mismatch"
  | "federation_transport_unavailable";

export class FederationError extends Error {
  constructor(readonly code: FederationErrorCode) {
    super(code);
    this.name = "FederationError";
  }
}
