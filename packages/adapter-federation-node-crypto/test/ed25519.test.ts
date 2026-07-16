import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  NodeEd25519FederationSigner,
  NodeEd25519FederationTrustResolver,
} from "../src/index.js";

describe("Node Ed25519 Federation trust", () => {
  it("verifies only an explicitly trusted peer, target and key ID", async () => {
    const first = generateKeyPairSync("ed25519");
    const second = generateKeyPairSync("ed25519");
    const signer = new NodeEd25519FederationSigner("key1", first.privateKey);
    const canonical = new TextEncoder().encode('{"profile":"test"}');
    const signature = await signer.sign(canonical);
    const trust = new NodeEd25519FederationTrustResolver([
      {
        source_exchange_id: "exchange-a",
        target_exchange_id: "exchange-b",
        key_id: "key1",
        public_key: first.publicKey,
      },
      {
        source_exchange_id: "exchange-a",
        target_exchange_id: "exchange-b",
        key_id: "key2",
        public_key: second.publicKey,
      },
    ]);
    await expect(trust.verify({
      source_exchange_id: "exchange-a",
      target_exchange_id: "exchange-b",
      key_id: "key1",
      canonical,
      signature,
    })).resolves.toBe(true);
    await expect(trust.verify({
      source_exchange_id: "exchange-a",
      target_exchange_id: "exchange-c",
      key_id: "key1",
      canonical,
      signature,
    })).resolves.toBe(false);
    await expect(trust.verify({
      source_exchange_id: "exchange-a",
      target_exchange_id: "exchange-b",
      key_id: "key2",
      canonical,
      signature,
    })).resolves.toBe(false);
  });

  it("supports an explicit overlapping-key rotation window", async () => {
    const oldPair = generateKeyPairSync("ed25519");
    const newPair = generateKeyPairSync("ed25519");
    const oldSigner = new NodeEd25519FederationSigner("old", oldPair.privateKey);
    const newSigner = new NodeEd25519FederationSigner("new", newPair.privateKey);
    const canonical = new TextEncoder().encode('{"transfer":"one"}');
    const rotating = new NodeEd25519FederationTrustResolver([
      {
        source_exchange_id: "exchange-a",
        target_exchange_id: "exchange-b",
        key_id: "old",
        public_key: oldPair.publicKey,
      },
      {
        source_exchange_id: "exchange-a",
        target_exchange_id: "exchange-b",
        key_id: "new",
        public_key: newPair.publicKey,
      },
    ]);
    await expect(rotating.verify({
      source_exchange_id: "exchange-a",
      target_exchange_id: "exchange-b",
      key_id: "old",
      canonical,
      signature: await oldSigner.sign(canonical),
    })).resolves.toBe(true);
    await expect(rotating.verify({
      source_exchange_id: "exchange-a",
      target_exchange_id: "exchange-b",
      key_id: "new",
      canonical,
      signature: await newSigner.sign(canonical),
    })).resolves.toBe(true);

    const afterRotation = new NodeEd25519FederationTrustResolver([{
      source_exchange_id: "exchange-a",
      target_exchange_id: "exchange-b",
      key_id: "new",
      public_key: newPair.publicKey,
    }]);
    await expect(afterRotation.verify({
      source_exchange_id: "exchange-a",
      target_exchange_id: "exchange-b",
      key_id: "old",
      canonical,
      signature: await oldSigner.sign(canonical),
    })).resolves.toBe(false);
  });
});
