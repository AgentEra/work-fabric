export type NatsWakeupErrorCode =
  | "invalid_wakeup_payload"
  | "invalid_wakeup_subject"
  | "wakeup_transport_unavailable"
  | "wakeup_delivery_settled"
  | "wakeup_adapter_closed"
  | "wakeup_topology_drift";

export class NatsWakeupError extends Error {
  constructor(readonly code: NatsWakeupErrorCode) {
    super(code);
    this.name = "NatsWakeupError";
  }
}
