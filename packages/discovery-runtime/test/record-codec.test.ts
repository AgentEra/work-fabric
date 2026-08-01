import { describe, expect, it } from "vitest";

import type {
  DiscoverySigner,
  DiscoveryTrustResolver,
} from "@work-fabric/discovery-spi";

import {
  DiscoveryRecordCodec,
  discoveryPayloadDigest,
} from "../src/index.js";

const now = "2026-08-01T00:00:30.000Z";
const signature = "A".repeat(86);
const signer: DiscoverySigner = {
  key_id: "key-1",
  async sign() { return signature; },
};
const trust: DiscoveryTrustResolver = {
  async verify(input) { return input.signature === signature; },
};

function codec(localExchangeId: string) {
  return new DiscoveryRecordCodec({
    local_exchange_id: localExchangeId,
    signer,
    trust,
    clock: { now: () => now },
    max_clock_skew_seconds: 0,
  });
}

function exchangeInput() {
  return {
    record_id: "exchange:alpha",
    record_kind: "exchange" as const,
    origin_exchange_id: "exchange-alpha",
    revision: 1,
    issued_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-08-01T00:01:00.000Z",
    visibility: "peer" as const,
    audiences: ["exchange-beta"],
    transitive: false,
    max_hops: 0,
    payload: {
      exchange_id: "exchange-alpha",
      display_name: "Alpha",
      discovery_profiles: ["workfabric.discovery.v1"],
      federation_profiles: ["workfabric.federation.v1"],
      bindings: [{
        binding_type: "workfabric.discovery/http",
        uri: "https://alpha.example.test/discovery",
        security_schemes: ["ed25519"],
      }],
      security_schemes: ["ed25519"],
    },
  };
}

function endpointInput() {
  return {
    record_id: "endpoint:alpha",
    record_kind: "endpoint" as const,
    origin_exchange_id: "exchange-alpha",
    revision: 1,
    issued_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2026-08-01T00:01:00.000Z",
    visibility: "peer" as const,
    audiences: ["exchange-beta"],
    transitive: false,
    max_hops: 0,
    payload: {
      endpoint_id: "endpoint-alpha",
      actor: { actor_id: "actor-alpha", actor_type: "agent" as const },
      endpoint_type: "native_agent",
      display_name: "Alpha Agent",
      protocol_versions: ["1.0"],
      bindings: [],
      capabilities: [{
        capability_id: "software.implementation",
        version: "1.0.0",
        name: "Implementation",
        description: "Implements explicitly accepted work",
        input_media_types: ["application/json"],
        output_media_types: ["application/json"],
        input_schema_refs: [],
        output_schema_refs: [],
        interaction_modes: ["asynchronous" as const],
        constraints: { max_input_bytes: 65_536 },
      }],
      availability: "available" as const,
      limits: { max_inline_content_bytes: 65_536 },
    },
  };
}

describe("DiscoveryRecordCodec", () => {
  it("round-trips one canonical origin-signed record", async () => {
    const bytes = await codec("exchange-alpha").sign(exchangeInput());
    const record = await codec("exchange-beta").verify(bytes, {
      audience: "exchange-beta",
    });

    expect(record.origin_exchange_id).toBe("exchange-alpha");
    expect(record.payload_digest).toBe(discoveryPayloadDigest(record.payload));
    expect(record.signature).toBe(signature);
  });

  it.each([
    ["unknown member", (text: string) => text.replace('"expires_at":', '"extra":true,"expires_at":')],
    ["non canonical bytes", (text: string) => `${text}\n`],
    ["duplicate member", (text: string) => text.replace('"revision":1', '"revision":1,"revision":1')],
    ["digest mismatch", (text: string) => text.replace(/"payload_digest":"[a-f0-9]{64}"/, `"payload_digest":"${"0".repeat(64)}"`)],
  ])("rejects %s before returning a record", async (_name, mutate) => {
    const bytes = await codec("exchange-alpha").sign(exchangeInput());
    const changed = new TextEncoder().encode(mutate(new TextDecoder().decode(bytes)));

    await expect(codec("exchange-beta").verify(changed, { audience: "exchange-beta" }))
      .rejects.toMatchObject({ code: expect.stringMatching(/^discovery_/) });
  });

  it("rejects wrong audience, invalid signature, expiry, and excessive input", async () => {
    const bytes = await codec("exchange-alpha").sign(exchangeInput());
    await expect(codec("exchange-gamma").verify(bytes, { audience: "exchange-gamma" }))
      .rejects.toMatchObject({ code: "discovery_wrong_audience" });

    const badTrust = new DiscoveryRecordCodec({
      local_exchange_id: "exchange-beta",
      signer,
      trust: { async verify() { return false; } },
      clock: { now: () => now },
    });
    await expect(badTrust.verify(bytes, { audience: "exchange-beta" }))
      .rejects.toMatchObject({ code: "discovery_signature_invalid" });

    const expired = new DiscoveryRecordCodec({
      local_exchange_id: "exchange-beta",
      signer,
      trust,
      clock: { now: () => "2026-08-01T00:01:01.000Z" },
      max_clock_skew_seconds: 0,
    });
    await expect(expired.verify(bytes, { audience: "exchange-beta" }))
      .rejects.toMatchObject({ code: "discovery_expired" });

    await expect(codec("exchange-beta").verify(new Uint8Array(65_537), {
      audience: "exchange-beta",
    })).rejects.toMatchObject({ code: "discovery_record_too_large" });
  });

  it("rejects TTL over 300 seconds when signing", async () => {
    await expect(codec("exchange-alpha").sign({
      ...exchangeInput(),
      expires_at: "2026-08-01T00:05:01.000Z",
    })).rejects.toMatchObject({ code: "discovery_record_invalid" });
  });

  it("strictly validates nested Endpoint capabilities", async () => {
    await expect(codec("exchange-alpha").sign(endpointInput())).resolves.toBeInstanceOf(Uint8Array);

    const unknownCapabilityMember = endpointInput();
    (unknownCapabilityMember.payload.capabilities[0] as Record<string, unknown>).unexpected = true;
    await expect(codec("exchange-alpha").sign(unknownCapabilityMember as never))
      .rejects.toMatchObject({ code: "discovery_record_invalid" });

    const invalidInteraction = endpointInput();
    (invalidInteraction.payload.capabilities[0]!.interaction_modes as unknown as string[])[0] = "automatic";
    await expect(codec("exchange-alpha").sign(invalidInteraction as never))
      .rejects.toMatchObject({ code: "discovery_record_invalid" });
  });

  it("origin-signs tombstones so older records cannot be relayed back", async () => {
    const bytes = await codec("exchange-alpha").signTombstone({
      record_id: "exchange:alpha",
      origin_exchange_id: "exchange-alpha",
      revision: 2,
      withdrawn_at: "2026-08-01T00:00:30.000Z",
      retain_until: "2026-08-01T00:05:30.000Z",
    });
    const tombstone = await codec("exchange-beta").verifyTombstone(bytes, {
      audience: "exchange-beta",
    });

    expect(tombstone.revision).toBe(2);
    expect(tombstone.signature).toBe(signature);
  });
});
