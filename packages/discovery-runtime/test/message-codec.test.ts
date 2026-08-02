import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  NodeEd25519DiscoverySigner,
  NodeEd25519DiscoveryTrustResolver,
} from "@work-fabric/adapter-discovery-node-crypto";

import {
  DiscoveryError,
  DiscoveryMessageCodec,
  discoveryCanonicalJsonBytes,
} from "../src/index.js";

const now = "2026-08-01T00:00:00.000Z";
const later = "2026-08-01T00:00:20.000Z";

function codecs() {
  const a = generateKeyPairSync("ed25519");
  const b = generateKeyPairSync("ed25519");
  const signerA = new NodeEd25519DiscoverySigner("key-a", a.privateKey);
  const signerB = new NodeEd25519DiscoverySigner("key-b", b.privateKey);
  const trustB = new NodeEd25519DiscoveryTrustResolver([{
    origin_exchange_id: "exchange-a", audience_exchange_id: "exchange-b", key_id: "key-a", public_key: a.publicKey,
  }]);
  return {
    a: new DiscoveryMessageCodec({
      local_exchange_id: "exchange-a",
      signer: signerA,
      trust: new NodeEd25519DiscoveryTrustResolver([{
        origin_exchange_id: "exchange-b", audience_exchange_id: "exchange-a", key_id: "key-b", public_key: b.publicKey,
      }]),
      clock: { now: () => now },
    }),
    b: new DiscoveryMessageCodec({
      local_exchange_id: "exchange-b",
      signer: signerB,
      trust: trustB,
      clock: { now: () => now },
    }),
    expiredB: new DiscoveryMessageCodec({
      local_exchange_id: "exchange-b",
      signer: signerB,
      trust: trustB,
      clock: { now: () => "2026-08-01T00:01:00.000Z" },
    }),
  };
}

describe("DiscoveryMessageCodec", () => {
  it("creates stable canonical bytes and verifies an exact audience", async () => {
    const { a, b } = codecs();
    const draft = {
      message_id: "message-1",
      message_type: "sync_request" as const,
      target_exchange_id: "exchange-b",
      issued_at: now,
      expires_at: later,
      payload: { limit: 10 },
    };

    const first = await a.sign(draft);
    const retry = await a.sign(draft);
    expect(retry).toEqual(first);
    await expect(b.verify(first)).resolves.toMatchObject({
      message_id: "message-1",
      source_exchange_id: "exchange-a",
      target_exchange_id: "exchange-b",
      payload: { limit: 10 },
    });
    await expect(a.verify(first)).rejects.toMatchObject({ code: "discovery_wrong_audience" });
  });

  it("rejects unknown members, expiry, and oversized envelopes", async () => {
    const { a, b, expiredB } = codecs();
    const bytes = await a.sign({
      message_id: "message-2",
      message_type: "sync_request",
      target_exchange_id: "exchange-b",
      issued_at: now,
      expires_at: later,
      payload: { limit: 10 },
    });
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const unknown = discoveryCanonicalJsonBytes({ ...parsed, unexpected: true } as never);

    await expect(b.verify(unknown)).rejects.toBeInstanceOf(DiscoveryError);
    await expect(b.verify(new Uint8Array(65_537))).rejects.toMatchObject({ code: "discovery_record_too_large" });

    await expect(expiredB.verify(bytes)).rejects.toMatchObject({ code: "discovery_expired" });
  });
});
