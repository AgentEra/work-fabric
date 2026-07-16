import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  FederationSigner,
  FederationTrustResolver,
  FederationUnsignedEnvelope,
} from "@work-fabric/federation-spi";

import {
  FederationEnvelopeCodec,
  canonicalJsonBytes,
  federationOfferDigest,
} from "../src/index.js";

const signer: FederationSigner = {
  key_id: "key1",
  async sign(canonical) {
    return createHash("sha512").update(canonical).digest("base64url");
  },
};

const trust: FederationTrustResolver = {
  async verify(input) {
    return input.key_id === "key1" && input.signature ===
      createHash("sha512").update(input.canonical).digest("base64url");
  },
};

const handoffOffer = {
  work_reference: { uri: "urn:work:item:1" },
  target: { actor_id: "actor-remote" },
  intent: [{ kind: "text", text: "Perform outside the source Exchange" }],
} as const;

function codec(now = "2026-07-16T00:00:00.000Z"): FederationEnvelopeCodec {
  return new FederationEnvelopeCodec({
    local_exchange_id: "exchange-b",
    signer,
    trust,
    clock: { now: () => now },
    max_clock_skew_seconds: 30,
  });
}

function offer(): Omit<FederationUnsignedEnvelope, "profile" | "key_id"> {
  return {
    message_id: "message-1",
    transfer_id: "transfer-1",
    message_type: "transfer_offer",
    source_exchange_id: "exchange-b",
    target_exchange_id: "exchange-a",
    sequence: 1,
    issued_at: "2026-07-16T00:00:00.000Z",
    expires_at: "2026-07-16T00:05:00.000Z",
    payload: {
      source_handoff_id: "handoff-1",
      source_thread_id: "thread-1",
      source_resource_version: 2,
      handoff_offer: handoffOffer,
      handoff_offer_sha256: federationOfferDigest(handoffOffer),
    },
  };
}

describe("FederationEnvelopeCodec", () => {
  it("signs deterministic canonical JSON and verifies a defensive round-trip", async () => {
    const source = codec();
    const bytes = await source.sign(offer());
    const target = new FederationEnvelopeCodec({
      local_exchange_id: "exchange-a",
      signer,
      trust,
      clock: { now: () => "2026-07-16T00:01:00.000Z" },
      max_clock_skew_seconds: 30,
    });

    const envelope = await target.verify(bytes, "transfer_offer");
    expect(envelope).toMatchObject({
      profile: "workfabric.federation.v1",
      message_id: "message-1",
      source_exchange_id: "exchange-b",
      target_exchange_id: "exchange-a",
      signature: expect.any(String),
    });
    expect(canonicalJsonBytes({ b: 2, a: 1 }))
      .toEqual(new TextEncoder().encode('{"a":1,"b":2}'));
    (envelope.payload as { source_handoff_id: string }).source_handoff_id = "mutated";
    expect((await target.verify(bytes, "transfer_offer")).payload)
      .toMatchObject({ source_handoff_id: "handoff-1" });
  });

  it("rejects tamper, unknown fields, oversized bytes and digest mismatch", async () => {
    const source = codec();
    const target = new FederationEnvelopeCodec({
      local_exchange_id: "exchange-a",
      signer,
      trust,
      clock: { now: () => "2026-07-16T00:01:00.000Z" },
      max_clock_skew_seconds: 30,
    });
    const signed = JSON.parse(new TextDecoder().decode(await source.sign(offer())));
    signed.transfer_id = "tampered";
    await expect(target.verify(new TextEncoder().encode(JSON.stringify(signed))))
      .rejects.toThrow(/federation_signature_invalid/);
    signed.transfer_id = "transfer-1";
    signed.unknown = true;
    await expect(target.verify(new TextEncoder().encode(JSON.stringify(signed))))
      .rejects.toThrow(/federation_envelope_invalid/);
    await expect(target.verify(new Uint8Array(65_537)))
      .rejects.toThrow(/federation_envelope_too_large/);
    const badDigest = offer();
    const payload = badDigest.payload as typeof badDigest.payload & {
      handoff_offer_sha256: string;
    };
    payload.handoff_offer_sha256 = "0".repeat(64);
    await expect(source.sign(badDigest)).rejects.toThrow(/federation_digest_mismatch/);
  });

  it("rejects duplicate JSON members and invalid Unicode before trust", async () => {
    const source = codec();
    const target = new FederationEnvelopeCodec({
      local_exchange_id: "exchange-a",
      signer,
      trust,
      clock: { now: () => "2026-07-16T00:01:00.000Z" },
    });
    const signed = new TextDecoder().decode(await source.sign(offer()));
    const duplicate = signed.replace(
      '"message_id":"message-1"',
      '"message_id":"shadow","message_id":"message-1"',
    );
    await expect(target.verify(new TextEncoder().encode(duplicate)))
      .rejects.toThrow(/federation_envelope_invalid/);

    const invalidUnicode = offer();
    const payload = invalidUnicode.payload as {
      handoff_offer: Record<string, unknown>;
    };
    payload.handoff_offer = { ...payload.handoff_offer, invalid: "\ud800" };
    await expect(source.sign(invalidUnicode))
      .rejects.toThrow(/federation_envelope_invalid/);
  });

  it("rejects wrong audience, expired and future-dated messages", async () => {
    const bytes = await codec().sign(offer());
    await expect(codec("2026-07-16T00:01:00.000Z").verify(bytes))
      .rejects.toThrow(/federation_wrong_audience/);
    const expiredTarget = new FederationEnvelopeCodec({
      local_exchange_id: "exchange-a", signer, trust,
      clock: { now: () => "2026-07-16T00:06:00.000Z" },
      max_clock_skew_seconds: 30,
    });
    await expect(expiredTarget.verify(bytes)).rejects.toThrow(/federation_expired/);
    const futureTarget = new FederationEnvelopeCodec({
      local_exchange_id: "exchange-a", signer, trust,
      clock: { now: () => "2026-07-15T23:58:00.000Z" },
      max_clock_skew_seconds: 30,
    });
    await expect(futureTarget.verify(bytes)).rejects.toThrow(/federation_not_yet_valid/);
  });

  it("enforces receipt sequence and accepted/rejected field coherence", async () => {
    const invalid = {
      ...offer(),
      message_type: "transfer_receipt" as const,
      sequence: 2,
      payload: {
        request_message_id: "message-1",
        handoff_offer_sha256: federationOfferDigest(handoffOffer),
        decision: "accepted" as const,
        target_handoff_id: null,
        target_resource_version: null,
        reason_code: "not_allowed",
        recorded_at: "2026-07-16T00:01:00.000Z",
      },
    };
    await expect(codec().sign(invalid as never))
      .rejects.toThrow(/federation_envelope_invalid/);
  });
});
