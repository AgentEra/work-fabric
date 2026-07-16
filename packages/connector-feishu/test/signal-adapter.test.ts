import { describe, expect, it } from "vitest";

import { verifySignalProfile } from "@work-fabric/exchange-conformance";
import type {
  ProtocolEvent,
  SignalDestination,
} from "@work-fabric/exchange-spi";

import {
  FeishuActionReferenceCodec,
  FeishuEventRenderer,
  FeishuSignalAdapter,
  type FeishuMessageClient,
  type FeishuSendMessageInput,
  type FeishuSendMessageResult,
} from "../src/index.js";

const event: ProtocolEvent = {
  specversion: "1.0",
  id: "event-1",
  source: "urn:work-fabric:exchange:exchange-1",
  type: "workfabric.handoff.offered.v1",
  subject: "handoff-1",
  time: "2026-07-16T00:00:00Z",
  datacontenttype: "application/json",
  dataschema: "urn:work-fabric:schema:v1:event-data",
  wftenant: "tenant-1",
  wfexchange: "exchange-1",
  wfhandoff: "handoff-1",
  wfsequence: 4,
  wfvisibility: "participants",
  data: {
    resource_version: 4,
    change: { to_state: "offered" },
  },
};

function destination(
  id: string,
  receiveId: string,
  renderMode: "text" | "card" = "card",
): SignalDestination {
  return {
    destination_id: id,
    binding: "feishu",
    configuration: {
      credential_ref: "credential-ref-1",
      connector_id: "feishu-primary",
      external_tenant_id: "tenant-key-1",
      actor_id: "actor-feishu-recipient",
      endpoint_id: "endpoint-feishu-recipient",
      receive_id_type: "open_id",
      receive_id: receiveId,
      render_mode: renderMode,
      action_ttl_seconds: 600,
    },
  };
}

class ControlledMessages implements FeishuMessageClient {
  readonly inputs: FeishuSendMessageInput[] = [];
  async sendMessage(input: FeishuSendMessageInput): Promise<FeishuSendMessageResult> {
    this.inputs.push(structuredClone(input));
    if (input.receive_id === "ou-retry") {
      return { kind: "retryable_failure", error_code: "rate_limited" };
    }
    if (input.receive_id === "ou-permanent") {
      return { kind: "permanent_failure", error_code: "invalid_recipient" };
    }
    return { kind: "accepted", message_id: "om-accepted" };
  }
}

describe("FeishuSignalAdapter", () => {
  it("satisfies the generic Signal profile and preserves stable UUIDs", async () => {
    const messages = new ControlledMessages();
    let nonce = 0;
    const observed: Array<{
      event: ProtocolEvent;
      destination: SignalDestination;
    }> = [];
    const adapter = new FeishuSignalAdapter({
      messages,
      renderer: new FeishuEventRenderer({
        action_codec: new FeishuActionReferenceCodec({
          encryption_key: new Uint8Array(32).fill(7),
          nonce_factory: () => new Uint8Array(12).fill(++nonce),
        }),
        clock: { now: () => "2026-07-16T00:00:00Z" },
        max_text_bytes: 150_000,
        max_card_bytes: 30_000,
      }),
      observer: {
        delivered(deliveredEvent, deliveredDestination) {
          observed.push({
            event: structuredClone(deliveredEvent),
            destination: structuredClone(deliveredDestination),
          });
        },
      },
    });
    await verifySignalProfile(adapter, {
      event,
      accepted_destination: destination("accepted", "ou-accepted"),
      retryable_destination: destination("retryable", "ou-retry"),
      permanent_destination: destination("permanent", "ou-permanent"),
      observe_deliveries: async () => observed,
    });
    expect(messages.inputs).toHaveLength(3);
    expect(messages.inputs.every((input) => input.uuid.length <= 50)).toBe(true);
    expect(new Set(messages.inputs.map((input) => input.uuid)).size).toBe(3);
    expect(messages.inputs[0]?.content).toContain("wfaf1.");
  });

  it("reuses the same UUID for a replay and rejects secret-shaped destinations", async () => {
    const messages = new ControlledMessages();
    const adapter = new FeishuSignalAdapter({
      messages,
      renderer: new FeishuEventRenderer({
        action_codec: new FeishuActionReferenceCodec({
          encryption_key: new Uint8Array(32).fill(7),
        }),
        clock: { now: () => "2026-07-16T00:00:00Z" },
        max_text_bytes: 150_000,
        max_card_bytes: 30_000,
      }),
    });
    const accepted = destination("accepted", "ou-accepted", "text");
    await adapter.deliver(event, accepted);
    await adapter.deliver(event, accepted);
    expect(messages.inputs[0]?.uuid).toBe(messages.inputs[1]?.uuid);

    await expect(adapter.deliver(event, {
      ...accepted,
      configuration: {
        ...accepted.configuration,
        app_secret: "must-not-enter-destination",
      },
    })).resolves.toMatchObject({ kind: "permanent_failure" });
    expect(messages.inputs).toHaveLength(2);
  });
});
