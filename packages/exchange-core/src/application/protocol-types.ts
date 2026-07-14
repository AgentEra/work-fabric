import type { JsonObject } from "@work-fabric/exchange-spi";

export interface CommandEnvelope {
  readonly spec_version: "1.0";
  readonly message_id: string;
  readonly message_type: string;
  readonly sent_at: string;
  readonly tenant_id: string;
  readonly exchange_id: string;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly delegation_id?: string;
  readonly correlation_id?: string;
  readonly causation_id?: string;
  readonly idempotency_key: string;
  readonly expected_version?: number;
  readonly payload: JsonObject;
}

export interface OperationResult {
  readonly spec_version: "1.0";
  readonly request_message_id: string;
  readonly operation_status:
    | "accepted"
    | "rejected"
    | "conflict"
    | "temporarily_unavailable";
  readonly resource: JsonObject | null;
  readonly receipt: JsonObject | null;
  readonly error: JsonObject | null;
}
