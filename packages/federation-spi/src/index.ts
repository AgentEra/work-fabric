import type { JsonObject } from "@work-fabric/exchange-spi";

export const FEDERATION_PROFILE = "workfabric.federation.v1" as const;
export const FEDERATION_MESSAGE_TYPES = [
  "transfer_offer",
  "transfer_receipt",
] as const;
export const FEDERATION_MAX_ENVELOPE_BYTES = 65_536;

export type FederationMessageType = typeof FEDERATION_MESSAGE_TYPES[number];

export interface FederationTransferOffer {
  readonly source_handoff_id: string;
  readonly source_thread_id: string;
  readonly source_resource_version: number;
  readonly handoff_offer: JsonObject;
  readonly handoff_offer_sha256: string;
}

export type FederationTransferReceipt =
  | {
      readonly request_message_id: string;
      readonly handoff_offer_sha256: string;
      readonly decision: "accepted";
      readonly target_handoff_id: string;
      readonly target_resource_version: number;
      readonly reason_code: null;
      readonly recorded_at: string;
    }
  | {
      readonly request_message_id: string;
      readonly handoff_offer_sha256: string;
      readonly decision: "rejected";
      readonly target_handoff_id: null;
      readonly target_resource_version: null;
      readonly reason_code: string;
      readonly recorded_at: string;
    };

export type FederationPayload = FederationTransferOffer | FederationTransferReceipt;

export interface FederationUnsignedEnvelope {
  readonly profile: typeof FEDERATION_PROFILE;
  readonly message_id: string;
  readonly transfer_id: string;
  readonly message_type: FederationMessageType;
  readonly source_exchange_id: string;
  readonly target_exchange_id: string;
  readonly sequence: number;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly key_id: string;
  readonly payload: FederationPayload;
}

export interface FederationSignedEnvelope extends FederationUnsignedEnvelope {
  readonly signature: string;
}

export interface FederationSigner {
  readonly key_id: string;
  sign(canonical: Uint8Array): Promise<string>;
}

export interface FederationTrustResolver {
  verify(input: {
    readonly source_exchange_id: string;
    readonly target_exchange_id: string;
    readonly key_id: string;
    readonly canonical: Uint8Array;
    readonly signature: string;
  }): Promise<boolean>;
}

export type FederationReplayBeginResult =
  | { readonly kind: "new" | "pending" }
  | { readonly kind: "completed"; readonly response: Uint8Array }
  | { readonly kind: "conflict" };

export interface FederationReplayStore {
  begin(input: {
    readonly source_exchange_id: string;
    readonly message_id: string;
    readonly request_digest: string;
    readonly expires_at: string;
  }): Promise<FederationReplayBeginResult>;
  complete(input: {
    readonly source_exchange_id: string;
    readonly message_id: string;
    readonly request_digest: string;
    readonly response: Uint8Array;
  }): Promise<Uint8Array>;
}

export type FederationInboundOfferDecision =
  | {
      readonly decision: "accepted";
      readonly target_handoff_id: string;
      readonly target_resource_version: number;
    }
  | { readonly decision: "rejected"; readonly reason_code: string };

export interface FederationTransferBridge {
  offerInbound(input: {
    readonly transfer_id: string;
    readonly source_exchange_id: string;
    readonly offer: FederationTransferOffer;
  }): Promise<FederationInboundOfferDecision>;
  applyOutboundReceipt(input: {
    readonly transfer_id: string;
    readonly target_exchange_id: string;
    readonly receipt: FederationTransferReceipt;
  }): Promise<void>;
}

export interface FederationRequestTransport {
  exchange(request: Uint8Array): Promise<Uint8Array | "retryable_failure">;
}

export interface FederationClock {
  now(): string;
}

export interface FederationIdGenerator {
  nextId(kind: "message" | "transfer"): string;
}
