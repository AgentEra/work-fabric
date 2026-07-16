import { strict as assert } from "node:assert";

import type { FederationRequestTransport } from "@work-fabric/federation-spi";
import type { FederationGateway } from "@work-fabric/federation-runtime";

export interface FederationProfileHarness {
  readonly source: FederationGateway;
  readonly target: FederationGateway;
  targetOfferCalls(): number;
  sourceReceiptCalls(): number;
}

export type FederationProfileFactory = () =>
  | FederationProfileHarness
  | Promise<FederationProfileHarness>;

export const DEFAULT_FEDERATION_PROFILE_FIXTURES = {
  source_exchange_id: "exchange-profile-a",
  target_exchange_id: "exchange-profile-b",
  handoff_offer: {
    work_reference: { uri: "urn:work:profile:1" },
    target: { actor_id: "actor-profile-target" },
    intent: [{ kind: "text", text: "External participant work" }],
  },
} as const;

export async function verifyFederationProfile(
  factory: FederationProfileFactory,
): Promise<void> {
  const harness = await factory();
  const prepared = await harness.source.prepareOutbound({
    message_id: "profile-message",
    transfer_id: "profile-transfer",
    target_exchange_id: DEFAULT_FEDERATION_PROFILE_FIXTURES.target_exchange_id,
    source_handoff_id: "profile-source-handoff",
    source_thread_id: "profile-source-thread",
    source_resource_version: 1,
    handoff_offer: DEFAULT_FEDERATION_PROFILE_FIXTURES.handoff_offer,
  });
  const receipt = await harness.target.receiveOffer(prepared.request);
  const replayedReceipt = await harness.target.receiveOffer(prepared.request);
  assert.deepEqual(replayedReceipt, receipt);
  assert.equal(harness.targetOfferCalls(), 1);

  const seen: Uint8Array[] = [];
  let available = false;
  const transport: FederationRequestTransport = {
    async exchange(request) {
      seen.push(Uint8Array.from(request));
      return available ? receipt : "retryable_failure";
    },
  };
  assert.deepEqual(await harness.source.deliverOutbound(prepared, transport), {
    outcome: "retryable_failure",
  });
  available = true;
  assert.deepEqual(await harness.source.deliverOutbound(prepared, transport), {
    outcome: "accepted",
    target_handoff_id: "profile-target-handoff",
    target_resource_version: 1,
  });
  assert.deepEqual(seen[0], seen[1]);
  assert.equal(harness.sourceReceiptCalls(), 1);

  const conflicting = await harness.source.prepareOutbound({
    message_id: "profile-message",
    transfer_id: "profile-transfer",
    target_exchange_id: DEFAULT_FEDERATION_PROFILE_FIXTURES.target_exchange_id,
    source_handoff_id: "profile-source-handoff",
    source_thread_id: "profile-source-thread",
    source_resource_version: 2,
    handoff_offer: {
      ...DEFAULT_FEDERATION_PROFILE_FIXTURES.handoff_offer,
      work_reference: { uri: "urn:work:profile:changed" },
    },
  });
  await assert.rejects(
    harness.target.receiveOffer(conflicting.request),
    /federation_replay_conflict/,
  );
  assert.equal(harness.targetOfferCalls(), 1);
}
