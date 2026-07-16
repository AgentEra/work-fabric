import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { MemoryFederationReplayStore } from "@work-fabric/adapter-federation-memory";
import {
  NodeEd25519FederationSigner,
  NodeEd25519FederationTrustResolver,
} from "@work-fabric/adapter-federation-node-crypto";
import { FederationEnvelopeCodec, FederationGateway } from "@work-fabric/federation-runtime";
import type { FederationIdGenerator, FederationTransferBridge } from "@work-fabric/federation-spi";

import {
  DEFAULT_FEDERATION_PROFILE_FIXTURES,
  verifyFederationProfile,
} from "../src/index.js";

const now = "2026-07-16T00:00:00.000Z";
const clock = { now: () => now };

function ids(prefix: string): FederationIdGenerator {
  let next = 0;
  return { nextId: (kind) => `${prefix}-${kind}-${++next}` };
}

describe("federation conformance profile", () => {
  it("verifies signed request/receipt, exact retry and replay safety", async () => {
    const a = generateKeyPairSync("ed25519");
    const b = generateKeyPairSync("ed25519");
    const targetOffer = vi.fn<FederationTransferBridge["offerInbound"]>(async () => ({
      decision: "accepted",
      target_handoff_id: "profile-target-handoff",
      target_resource_version: 1,
    }));
    const sourceReceipt = vi.fn<FederationTransferBridge["applyOutboundReceipt"]>(
      async () => undefined,
    );
    const noInbound = vi.fn<FederationTransferBridge["offerInbound"]>();
    const noReceipt = vi.fn<FederationTransferBridge["applyOutboundReceipt"]>();
    const source = new FederationGateway({
      local_exchange_id: DEFAULT_FEDERATION_PROFILE_FIXTURES.source_exchange_id,
      codec: new FederationEnvelopeCodec({
        local_exchange_id: DEFAULT_FEDERATION_PROFILE_FIXTURES.source_exchange_id,
        signer: new NodeEd25519FederationSigner("a", a.privateKey),
        trust: new NodeEd25519FederationTrustResolver([{
          source_exchange_id: DEFAULT_FEDERATION_PROFILE_FIXTURES.target_exchange_id,
          target_exchange_id: DEFAULT_FEDERATION_PROFILE_FIXTURES.source_exchange_id,
          key_id: "b",
          public_key: b.publicKey,
        }]),
        clock,
      }),
      replay_store: new MemoryFederationReplayStore({ max_records: 10, clock }),
      bridge: { offerInbound: noInbound, applyOutboundReceipt: sourceReceipt },
      clock,
      ids: ids("source"),
    });
    const target = new FederationGateway({
      local_exchange_id: DEFAULT_FEDERATION_PROFILE_FIXTURES.target_exchange_id,
      codec: new FederationEnvelopeCodec({
        local_exchange_id: DEFAULT_FEDERATION_PROFILE_FIXTURES.target_exchange_id,
        signer: new NodeEd25519FederationSigner("b", b.privateKey),
        trust: new NodeEd25519FederationTrustResolver([{
          source_exchange_id: DEFAULT_FEDERATION_PROFILE_FIXTURES.source_exchange_id,
          target_exchange_id: DEFAULT_FEDERATION_PROFILE_FIXTURES.target_exchange_id,
          key_id: "a",
          public_key: a.publicKey,
        }]),
        clock,
      }),
      replay_store: new MemoryFederationReplayStore({ max_records: 10, clock }),
      bridge: { offerInbound: targetOffer, applyOutboundReceipt: noReceipt },
      clock,
      ids: ids("target"),
    });
    await expect(verifyFederationProfile(() => ({
      source,
      target,
      targetOfferCalls: () => targetOffer.mock.calls.length,
      sourceReceiptCalls: () => sourceReceipt.mock.calls.length,
    }))).resolves.toBeUndefined();
  });
});
