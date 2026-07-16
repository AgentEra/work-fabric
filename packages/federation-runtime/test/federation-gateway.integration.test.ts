import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { MemoryFederationReplayStore } from "@work-fabric/adapter-federation-memory";
import {
  NodeEd25519FederationSigner,
  NodeEd25519FederationTrustResolver,
} from "@work-fabric/adapter-federation-node-crypto";
import type {
  FederationIdGenerator,
  FederationRequestTransport,
  FederationTransferBridge,
} from "@work-fabric/federation-spi";

import {
  FederationEnvelopeCodec,
  FederationGateway,
  federationOfferDigest,
} from "../src/index.js";

const now = "2026-07-16T00:00:00.000Z";
const clock = { now: () => now };

function ids(prefix: string): FederationIdGenerator {
  let value = 0;
  return { nextId: (kind) => `${prefix}-${kind}-${++value}` };
}

function bridge() {
  const offerInbound = vi.fn<FederationTransferBridge["offerInbound"]>(async () => ({
    decision: "accepted",
    target_handoff_id: "handoff-target",
    target_resource_version: 1,
  }));
  const applyOutboundReceipt = vi.fn<
    FederationTransferBridge["applyOutboundReceipt"]
  >(async () => undefined);
  return { value: { offerInbound, applyOutboundReceipt }, offerInbound, applyOutboundReceipt };
}

function setup(federationClock = clock) {
  const keyA = generateKeyPairSync("ed25519");
  const keyB = generateKeyPairSync("ed25519");
  const signerA = new NodeEd25519FederationSigner("key-a", keyA.privateKey);
  const signerB = new NodeEd25519FederationSigner("key-b", keyB.privateKey);
  const trustA = new NodeEd25519FederationTrustResolver([{
    source_exchange_id: "exchange-b",
    target_exchange_id: "exchange-a",
    key_id: "key-b",
    public_key: keyB.publicKey,
  }]);
  const trustB = new NodeEd25519FederationTrustResolver([{
    source_exchange_id: "exchange-a",
    target_exchange_id: "exchange-b",
    key_id: "key-a",
    public_key: keyA.publicKey,
  }]);
  const bridgeA = bridge();
  const bridgeB = bridge();
  const replayB = new MemoryFederationReplayStore({ max_records: 100, clock: federationClock });
  const gatewayA = new FederationGateway({
    local_exchange_id: "exchange-a",
    codec: new FederationEnvelopeCodec({
      local_exchange_id: "exchange-a", signer: signerA, trust: trustA, clock: federationClock,
    }),
    replay_store: new MemoryFederationReplayStore({ max_records: 100, clock: federationClock }),
    bridge: bridgeA.value,
    clock: federationClock,
    ids: ids("a"),
    message_ttl_seconds: 300,
  });
  const gatewayB = new FederationGateway({
    local_exchange_id: "exchange-b",
    codec: new FederationEnvelopeCodec({
      local_exchange_id: "exchange-b", signer: signerB, trust: trustB, clock: federationClock,
    }),
    replay_store: replayB,
    bridge: bridgeB.value,
    clock: federationClock,
    ids: ids("b"),
    message_ttl_seconds: 300,
  });
  return { gatewayA, gatewayB, bridgeA, bridgeB };
}

const handoffOffer = {
  work_reference: { uri: "urn:work:item:1" },
  target: { actor_id: "actor-remote" },
  intent: [{ kind: "text", text: "Perform in target Exchange" }],
} as const;

describe("FederationGateway", () => {
  it("completes a signed two-Exchange transfer and caches an exact Receipt", async () => {
    const { gatewayA, gatewayB, bridgeA, bridgeB } = setup();
    const prepared = await gatewayA.prepareOutbound({
      target_exchange_id: "exchange-b",
      source_handoff_id: "handoff-source",
      source_thread_id: "thread-source",
      source_resource_version: 2,
      handoff_offer: handoffOffer,
    });
    const firstReceipt = await gatewayB.receiveOffer(prepared.request);
    const duplicateReceipt = await gatewayB.receiveOffer(prepared.request);
    expect(duplicateReceipt).toEqual(firstReceipt);
    expect(bridgeB.offerInbound).toHaveBeenCalledTimes(1);

    const transport: FederationRequestTransport = {
      exchange: async () => firstReceipt,
    };
    await expect(gatewayA.deliverOutbound(prepared, transport)).resolves.toMatchObject({
      outcome: "accepted",
      target_handoff_id: "handoff-target",
    });
    expect(bridgeA.applyOutboundReceipt).toHaveBeenCalledTimes(1);
  });

  it("retries the exact signed request after transport failure", async () => {
    const { gatewayA, gatewayB } = setup();
    const prepared = await gatewayA.prepareOutbound({
      target_exchange_id: "exchange-b",
      source_handoff_id: "handoff-source",
      source_thread_id: "thread-source",
      source_resource_version: 2,
      handoff_offer: handoffOffer,
    });
    const requests: Uint8Array[] = [];
    let available = false;
    const transport: FederationRequestTransport = {
      async exchange(request) {
        requests.push(Uint8Array.from(request));
        if (!available) return "retryable_failure";
        return gatewayB.receiveOffer(request);
      },
    };
    await expect(gatewayA.deliverOutbound(prepared, transport))
      .resolves.toEqual({ outcome: "retryable_failure" });
    available = true;
    await expect(gatewayA.deliverOutbound(prepared, transport))
      .resolves.toMatchObject({ outcome: "accepted" });
    expect(requests[0]).toEqual(requests[1]);
  });

  it("rejects a validly signed conflicting replay before a second Bridge call", async () => {
    const { gatewayA, gatewayB, bridgeB } = setup();
    const first = await gatewayA.prepareOutbound({
      message_id: "fixed-message",
      transfer_id: "fixed-transfer",
      target_exchange_id: "exchange-b",
      source_handoff_id: "handoff-source",
      source_thread_id: "thread-source",
      source_resource_version: 2,
      handoff_offer: handoffOffer,
    });
    await gatewayB.receiveOffer(first.request);
    const second = await gatewayA.prepareOutbound({
      message_id: "fixed-message",
      transfer_id: "fixed-transfer",
      target_exchange_id: "exchange-b",
      source_handoff_id: "handoff-source",
      source_thread_id: "thread-source",
      source_resource_version: 3,
      handoff_offer: {
        ...handoffOffer,
        work_reference: { uri: "urn:work:item:changed" },
      },
    });
    expect(federationOfferDigest(handoffOffer)).not.toBe(
      federationOfferDigest(second.offer.handoff_offer),
    );
    await expect(gatewayB.receiveOffer(second.request))
      .rejects.toThrow(/federation_replay_conflict/);
    expect(bridgeB.offerInbound).toHaveBeenCalledTimes(1);
  });

  it("returns a signed rejection as final protocol data", async () => {
    const { gatewayA, gatewayB, bridgeA, bridgeB } = setup();
    bridgeB.offerInbound.mockResolvedValueOnce({
      decision: "rejected",
      reason_code: "policy_denied",
    });
    const prepared = await gatewayA.prepareOutbound({
      target_exchange_id: "exchange-b",
      source_handoff_id: "handoff-source",
      source_thread_id: "thread-source",
      source_resource_version: 2,
      handoff_offer: handoffOffer,
    });
    const receipt = await gatewayB.receiveOffer(prepared.request);
    await expect(gatewayA.deliverOutbound(prepared, {
      exchange: async () => receipt,
    })).resolves.toEqual({
      outcome: "rejected",
      reason_code: "policy_denied",
    });
    expect(bridgeA.applyOutboundReceipt).toHaveBeenCalledTimes(1);
  });

  it("converges concurrent pending deliveries on one byte-identical Receipt", async () => {
    const { gatewayA, gatewayB, bridgeB } = setup();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    bridgeB.offerInbound.mockImplementation(async () => {
      await barrier;
      return {
        decision: "accepted",
        target_handoff_id: "handoff-target",
        target_resource_version: 1,
      };
    });
    const prepared = await gatewayA.prepareOutbound({
      target_exchange_id: "exchange-b",
      source_handoff_id: "handoff-source",
      source_thread_id: "thread-source",
      source_resource_version: 2,
      handoff_offer: handoffOffer,
    });
    const first = gatewayB.receiveOffer(prepared.request);
    const second = gatewayB.receiveOffer(prepared.request);
    await vi.waitFor(() => expect(bridgeB.offerInbound).toHaveBeenCalledTimes(2));
    release();
    const [firstReceipt, secondReceipt] = await Promise.all([first, second]);
    expect(secondReceipt).toEqual(firstReceipt);
    expect(await gatewayB.receiveOffer(prepared.request)).toEqual(firstReceipt);
  });

  it("retains a cached Receipt throughout the accepted clock-skew window", async () => {
    let current = now;
    const { gatewayA, gatewayB, bridgeB } = setup({ now: () => current });
    const prepared = await gatewayA.prepareOutbound({
      target_exchange_id: "exchange-b",
      source_handoff_id: "handoff-source",
      source_thread_id: "thread-source",
      source_resource_version: 2,
      handoff_offer: handoffOffer,
    });
    current = "2026-07-16T00:05:20.000Z";
    const first = await gatewayB.receiveOffer(prepared.request);
    expect(await gatewayB.receiveOffer(prepared.request)).toEqual(first);
    expect(bridgeB.offerInbound).toHaveBeenCalledTimes(1);
  });
});
