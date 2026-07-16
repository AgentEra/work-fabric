import type { JsonObject } from "@work-fabric/exchange-spi";
import type {
  FederationClock,
  FederationIdGenerator,
  FederationReplayStore,
  FederationRequestTransport,
  FederationTransferBridge,
  FederationTransferOffer,
  FederationTransferReceipt,
} from "@work-fabric/federation-spi";

import {
  asFederationOffer,
  asFederationReceipt,
  FederationEnvelopeCodec,
  federationEnvelopeDigest,
} from "./federation-codec.js";
import { federationOfferDigest } from "./canonical-json.js";
import { FederationError } from "./errors.js";

const MAX_REPLAY_CLOCK_SKEW_SECONDS = 60;

export interface FederationGatewayOptions {
  readonly local_exchange_id: string;
  readonly codec: FederationEnvelopeCodec;
  readonly replay_store: FederationReplayStore;
  readonly bridge: FederationTransferBridge;
  readonly clock: FederationClock;
  readonly ids: FederationIdGenerator;
  readonly message_ttl_seconds?: number;
}

export interface PrepareOutboundFederationTransferInput {
  readonly message_id?: string;
  readonly transfer_id?: string;
  readonly target_exchange_id: string;
  readonly source_handoff_id: string;
  readonly source_thread_id: string;
  readonly source_resource_version: number;
  readonly handoff_offer: JsonObject;
}

export interface PreparedFederationTransfer {
  readonly request: Uint8Array;
  readonly request_message_id: string;
  readonly transfer_id: string;
  readonly target_exchange_id: string;
  readonly offer: FederationTransferOffer;
}

export type FederationDeliveryResult =
  | { readonly outcome: "retryable_failure" }
  | {
      readonly outcome: "accepted";
      readonly target_handoff_id: string;
      readonly target_resource_version: number;
    }
  | { readonly outcome: "rejected"; readonly reason_code: string };

function timestamp(value: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError("clock.now() must return a valid timestamp");
  }
  return new Date(milliseconds).toISOString();
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1_000).toISOString();
}

export class FederationGateway {
  private readonly ttlSeconds: number;

  constructor(private readonly options: FederationGatewayOptions) {
    this.ttlSeconds = options.message_ttl_seconds ?? 300;
    if (
      !Number.isSafeInteger(this.ttlSeconds) ||
      this.ttlSeconds < 1 ||
      this.ttlSeconds > 300
    ) {
      throw new RangeError("message_ttl_seconds must be between 1 and 300");
    }
    if (options.local_exchange_id.length < 1 || options.local_exchange_id.length > 128) {
      throw new RangeError("local_exchange_id must contain 1 to 128 characters");
    }
    timestamp(options.clock.now());
  }

  async prepareOutbound(
    input: PrepareOutboundFederationTransferInput,
  ): Promise<PreparedFederationTransfer> {
    const issuedAt = timestamp(this.options.clock.now());
    const offer: FederationTransferOffer = {
      source_handoff_id: input.source_handoff_id,
      source_thread_id: input.source_thread_id,
      source_resource_version: input.source_resource_version,
      handoff_offer: structuredClone(input.handoff_offer),
      handoff_offer_sha256: federationOfferDigest(input.handoff_offer),
    };
    const messageId = input.message_id ?? this.options.ids.nextId("message");
    const transferId = input.transfer_id ?? this.options.ids.nextId("transfer");
    const request = await this.options.codec.sign({
      message_id: messageId,
      transfer_id: transferId,
      message_type: "transfer_offer",
      source_exchange_id: this.options.local_exchange_id,
      target_exchange_id: input.target_exchange_id,
      sequence: 1,
      issued_at: issuedAt,
      expires_at: addSeconds(issuedAt, this.ttlSeconds),
      payload: offer,
    });
    return {
      request: Uint8Array.from(request),
      request_message_id: messageId,
      transfer_id: transferId,
      target_exchange_id: input.target_exchange_id,
      offer: structuredClone(offer),
    };
  }

  async receiveOffer(request: Uint8Array): Promise<Uint8Array> {
    const envelope = await this.options.codec.verify(request, "transfer_offer");
    const offer = asFederationOffer(envelope.payload);
    const requestDigest = federationEnvelopeDigest(envelope);
    const replay = await this.options.replay_store.begin({
      source_exchange_id: envelope.source_exchange_id,
      message_id: envelope.message_id,
      request_digest: requestDigest,
      // Keep the replay record for every timestamp the strict codec may accept.
      expires_at: addSeconds(envelope.expires_at, MAX_REPLAY_CLOCK_SKEW_SECONDS),
    });
    if (replay.kind === "conflict") {
      throw new FederationError("federation_replay_conflict");
    }
    if (replay.kind === "completed") return Uint8Array.from(replay.response);

    // Both new and pending records call the deployment-owned idempotent Bridge.
    // This makes crash recovery deterministic without executing participant work.
    const decision = await this.options.bridge.offerInbound({
      transfer_id: envelope.transfer_id,
      source_exchange_id: envelope.source_exchange_id,
      offer,
    });
    const recordedAt = timestamp(this.options.clock.now());
    const receipt: FederationTransferReceipt = decision.decision === "accepted"
      ? {
          request_message_id: envelope.message_id,
          handoff_offer_sha256: offer.handoff_offer_sha256,
          decision: "accepted",
          target_handoff_id: decision.target_handoff_id,
          target_resource_version: decision.target_resource_version,
          reason_code: null,
          recorded_at: recordedAt,
        }
      : {
          request_message_id: envelope.message_id,
          handoff_offer_sha256: offer.handoff_offer_sha256,
          decision: "rejected",
          target_handoff_id: null,
          target_resource_version: null,
          reason_code: decision.reason_code,
          recorded_at: recordedAt,
        };
    const response = await this.options.codec.sign({
      message_id: this.options.ids.nextId("message"),
      transfer_id: envelope.transfer_id,
      message_type: "transfer_receipt",
      source_exchange_id: this.options.local_exchange_id,
      target_exchange_id: envelope.source_exchange_id,
      sequence: 2,
      issued_at: recordedAt,
      expires_at: addSeconds(recordedAt, this.ttlSeconds),
      payload: receipt,
    });
    const stableResponse = await this.options.replay_store.complete({
      source_exchange_id: envelope.source_exchange_id,
      message_id: envelope.message_id,
      request_digest: requestDigest,
      response,
    });
    return Uint8Array.from(stableResponse);
  }

  async deliverOutbound(
    prepared: PreparedFederationTransfer,
    transport: FederationRequestTransport,
  ): Promise<FederationDeliveryResult> {
    const response = await transport.exchange(prepared.request);
    if (response === "retryable_failure") return { outcome: "retryable_failure" };
    const envelope = await this.options.codec.verify(response, "transfer_receipt");
    const receipt = asFederationReceipt(envelope.payload);
    if (
      envelope.source_exchange_id !== prepared.target_exchange_id ||
      envelope.transfer_id !== prepared.transfer_id ||
      receipt.request_message_id !== prepared.request_message_id ||
      receipt.handoff_offer_sha256 !== prepared.offer.handoff_offer_sha256
    ) {
      throw new FederationError("federation_receipt_mismatch");
    }
    await this.options.bridge.applyOutboundReceipt({
      transfer_id: prepared.transfer_id,
      target_exchange_id: prepared.target_exchange_id,
      receipt,
    });
    return receipt.decision === "accepted"
      ? {
          outcome: "accepted",
          target_handoff_id: receipt.target_handoff_id,
          target_resource_version: receipt.target_resource_version,
        }
      : { outcome: "rejected", reason_code: receipt.reason_code };
  }
}
