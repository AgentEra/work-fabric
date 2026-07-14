import type { ExchangeAdapter } from "./capabilities.js";
import type { JsonObject } from "./json.js";

export const SIGNAL_REQUIRED_CAPABILITIES = [
  "event_id_preservation",
  "outcome_classification",
  "payload_isolation",
] as const;

export interface ProtocolEvent {
  readonly specversion: "1.0";
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly subject: string;
  readonly time: string;
  readonly datacontenttype: "application/json";
  readonly dataschema: string;
  readonly wftenant?: string;
  readonly wfexchange?: string;
  readonly wfthread?: string;
  readonly wfhandoff?: string;
  readonly wfactor?: string;
  readonly wfendpoint?: string;
  readonly wfcorrelation?: string;
  readonly wfcausation?: string;
  readonly wfsequence: number;
  readonly wfvisibility?: "tenant" | "participants" | "restricted" | "public";
  readonly data: JsonObject;
}

export interface SignalDestination {
  readonly destination_id: string;
  readonly binding: string;
  readonly configuration: JsonObject;
}

export type SignalDeliveryResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "retryable_failure"; readonly detail: string }
  | { readonly kind: "permanent_failure"; readonly detail: string };

export interface SignalAdapter extends ExchangeAdapter {
  deliver(
    event: ProtocolEvent,
    destination: SignalDestination,
  ): Promise<SignalDeliveryResult>;
}
