import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  NodeEd25519DiscoverySigner,
  NodeEd25519DiscoveryTrustResolver,
} from "../src/index.js";

describe("Node Ed25519 discovery crypto", () => {
  it("binds verification to origin, audience and key id", async () => {
    const pair = generateKeyPairSync("ed25519");
    const signer = new NodeEd25519DiscoverySigner("key-1", pair.privateKey);
    const trust = new NodeEd25519DiscoveryTrustResolver([{
      origin_exchange_id: "exchange-a",
      audience_exchange_id: "exchange-b",
      key_id: "key-1",
      public_key: pair.publicKey,
    }]);
    const canonical = new TextEncoder().encode("canonical discovery record");
    const signed = await signer.sign(canonical);

    await expect(trust.verify({
      origin_exchange_id: "exchange-a",
      audience_exchange_id: "exchange-b",
      key_id: "key-1",
      canonical,
      signature: signed,
    })).resolves.toBe(true);
    await expect(trust.verify({
      origin_exchange_id: "exchange-a",
      audience_exchange_id: "exchange-c",
      key_id: "key-1",
      canonical,
      signature: signed,
    })).resolves.toBe(false);
  });

  it("supports explicit overlap and removal during rotation", async () => {
    const oldPair = generateKeyPairSync("ed25519");
    const newPair = generateKeyPairSync("ed25519");
    const canonical = new TextEncoder().encode("rotation");
    const oldSignature = await new NodeEd25519DiscoverySigner("old", oldPair.privateKey).sign(canonical);
    const entries = [oldPair, newPair].map((pair, index) => ({
      origin_exchange_id: "exchange-a",
      audience_exchange_id: "exchange-b",
      key_id: index === 0 ? "old" : "new",
      public_key: pair.publicKey,
    }));
    const overlap = new NodeEd25519DiscoveryTrustResolver(entries);
    const removed = new NodeEd25519DiscoveryTrustResolver([entries[1]!]);

    const input = {
      origin_exchange_id: "exchange-a",
      audience_exchange_id: "exchange-b",
      key_id: "old",
      canonical,
      signature: oldSignature,
    };
    await expect(overlap.verify(input)).resolves.toBe(true);
    await expect(removed.verify(input)).resolves.toBe(false);
  });
});
