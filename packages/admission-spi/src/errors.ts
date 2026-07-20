export type AdmissionAdapterErrorCode =
  | "policy_unavailable"
  | "evidence_unavailable"
  | "binding_store_unavailable"
  | "decision_store_unavailable"
  | "grant_unavailable";

export class AdmissionAdapterError extends Error {
  constructor(readonly code: AdmissionAdapterErrorCode, message: string = code) {
    super(message);
    this.name = "AdmissionAdapterError";
  }
}
