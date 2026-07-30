import { describe, expect, it } from "vitest";

import { verifySignalProfile } from "@work-fabric/exchange-conformance";
import { signalMediaTypeCapability } from "@work-fabric/exchange-spi";
import type {
  JsonObject,
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

const agentResultEvent: ProtocolEvent = {
  ...event,
  id: "event-agent-result",
  type: "workfabric.handoff.result_returned.v1",
  wfsequence: 5,
  data: {
    resource_version: 5,
    snapshot: {
      handoff_id: "handoff-1",
      resource_version: 5,
      lifecycle_state: "result_returned",
      result: {
        summary: [{
          kind: "text",
          media_type: "text/plain",
          text: "已整理需求目标、缺失信息和验收条件。",
        }],
        artifacts: [],
        evidence: [],
        extensions: {},
      },
    },
  },
};

function resultEvent(
  id: string,
  summary: readonly JsonObject[],
  resourceRefs: readonly string[] = [],
): ProtocolEvent {
  return {
    ...agentResultEvent,
    id,
    data: {
      ...agentResultEvent.data,
      snapshot: {
        ...(agentResultEvent.data.snapshot as Record<string, unknown>),
        package: {
          authority_scope: {
            resource_refs: [...resourceRefs],
          },
        },
        result: {
          summary,
          artifacts: [],
          evidence: [],
          extensions: {},
        },
      },
    },
  };
}

const markdownResultEvent = resultEvent("event-agent-markdown-result", [{
  kind: "text",
  media_type: "text/markdown",
  text: "## 已完成\n\n请查看[需求文档](https://example.com/doc)。",
}]);

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
      actor_type: "human",
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
    expect(adapter.manifest.capabilities).toMatchObject({
      [signalMediaTypeCapability("text/plain")]: true,
      [signalMediaTypeCapability("text/markdown")]: true,
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
    expect(messages.inputs[0]?.content).toContain("wfaf2.");
  });

  it("renders an authorized recipient reference as one native Feishu mention", async () => {
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
    const recipient = "feishu://user/open-id/ou-initiator";
    const result = resultEvent("event-agent-mentioned-proposal", [{
      kind: "text",
      media_type: "text/markdown",
      text: "请确认 **EDA 方案评审** 的排期提案。",
      extensions: {
        "workfabric.dev/recipient_references": [{
          kind: "mention",
          resource_uri: recipient,
          display_text: "发起人",
        }],
      },
    }], [recipient]);

    await expect(adapter.deliver(
      result,
      destination("agent-mentioned", "oc-team", "card"),
    )).resolves.toEqual({ kind: "accepted" });

    expect(messages.inputs).toHaveLength(1);
    expect(messages.inputs[0]?.msg_type).toBe("post");
    expect(JSON.parse(messages.inputs[0]!.content)).toEqual({
      zh_cn: {
        title: "",
        content: [[{
          tag: "md",
          text: "<at user_id=\"ou-initiator\">发起人</at>\n请确认 **EDA 方案评审** 的排期提案。",
        }]],
      },
    });
  });

  it.each([
    ["unscoped", "feishu://user/open-id/ou-other"],
    ["non-Feishu", "https://example.com/users/1"],
    ["all", "feishu://user/open-id/all"],
    ["encoded slash", "feishu://user/open-id/ou%2Fother"],
    ["control", "feishu://user/open-id/ou%0Aother"],
  ])("rejects an invalid or unauthorized %s recipient reference", async (
    _case,
    recipient,
  ) => {
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
    const result = resultEvent(`event-agent-recipient-${_case}`, [{
      kind: "text",
      media_type: "text/markdown",
      text: "请确认。",
      extensions: {
        "workfabric.dev/recipient_references": [{
          kind: "mention",
          resource_uri: recipient,
          display_text: "确认人",
        }],
      },
    }], ["feishu://user/open-id/ou-initiator"]);

    await expect(adapter.deliver(
      result,
      destination(`agent-recipient-${_case}`, "oc-team"),
    )).resolves.toEqual({
      kind: "permanent_failure",
      detail: "rendering_failed",
    });
    expect(messages.inputs).toHaveLength(0);
  });

  it("rejects more than sixteen recipient references", async () => {
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
    const recipients = Array.from(
      { length: 17 },
      (_, index) => `feishu://user/open-id/ou-user-${index}`,
    );
    const result = resultEvent("event-agent-too-many-recipients", [{
      kind: "text",
      media_type: "text/plain",
      text: "请确认。",
      extensions: {
        "workfabric.dev/recipient_references": recipients.map(
          (resourceUri) => ({
            kind: "mention",
            resource_uri: resourceUri,
            display_text: "确认人",
          }),
        ),
      },
    }], recipients);

    await expect(adapter.deliver(
      result,
      destination("agent-too-many-recipients", "oc-team"),
    )).resolves.toEqual({
      kind: "permanent_failure",
      detail: "rendering_failed",
    });
    expect(messages.inputs).toHaveLength(0);
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

  it("renders Agent-owned plain text as text regardless of presentation mode", async () => {
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

    await expect(adapter.deliver(
      agentResultEvent,
      destination("agent-text", "ou-accepted", "text"),
    )).resolves.toEqual({ kind: "accepted" });
    await expect(adapter.deliver(
      agentResultEvent,
      destination("agent-card", "ou-accepted", "card"),
    )).resolves.toEqual({ kind: "accepted" });

    expect(messages.inputs).toHaveLength(2);
    for (const input of messages.inputs) {
      expect(input.msg_type).toBe("text");
      expect(input.content).toContain(
        "已整理需求目标、缺失信息和验收条件。",
      );
      expect(input.content).not.toMatch(
        /handoff-1|result_returned|accepted|State:/,
      );
    }
  });

  it("renders Agent-owned Markdown as a native Feishu post with clickable link syntax", async () => {
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

    await expect(adapter.deliver(
      markdownResultEvent,
      destination("agent-markdown", "ou-accepted", "card"),
    )).resolves.toEqual({ kind: "accepted" });

    expect(messages.inputs).toHaveLength(1);
    expect(messages.inputs[0]?.msg_type).toBe("post");
    expect(JSON.parse(messages.inputs[0]!.content)).toEqual({
      zh_cn: {
        title: "",
        content: [[{
          tag: "md",
          text: "## 已完成\n\n请查看[需求文档](https://example.com/doc)。",
        }]],
      },
    });
  });

  it("fails closed for unsupported or unsafe Agent-owned content", async () => {
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

    await expect(adapter.deliver(
      resultEvent("event-agent-html", [{
        kind: "text",
        media_type: "text/html",
        text: "<strong>unsafe</strong>",
      }]),
      destination("agent-html", "ou-accepted"),
    )).resolves.toEqual({
      kind: "permanent_failure",
      detail: "unsupported_media_type",
    });
    await expect(adapter.deliver(
      resultEvent("event-agent-unsafe-link", [{
        kind: "text",
        media_type: "text/markdown",
        text: "[危险](javascript:alert(1))",
      }]),
      destination("agent-unsafe-link", "ou-accepted"),
    )).resolves.toEqual({
      kind: "permanent_failure",
      detail: "unsafe_link",
    });
    await expect(adapter.deliver(
      resultEvent("event-agent-mixed", [{
        kind: "text",
        media_type: "text/plain",
        text: "plain",
      }, {
        kind: "text",
        media_type: "text/markdown",
        text: "**markdown**",
      }]),
      destination("agent-mixed", "ou-accepted"),
    )).resolves.toEqual({
      kind: "permanent_failure",
      detail: "unsupported_media_type",
    });
    expect(messages.inputs).toHaveLength(0);
  });

  it("does not synthesize a reply when a Result has no text summary", async () => {
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
    const withoutText = {
      ...agentResultEvent,
      data: {
        ...agentResultEvent.data,
        snapshot: {
          ...(agentResultEvent.data.snapshot as Record<string, unknown>),
          result: {
            summary: [{
              kind: "data",
              schema_ref: "urn:work-fabric:test:result",
              data: { completed: true },
            }],
            artifacts: [],
            evidence: [],
            extensions: {},
          },
        },
      },
    };

    await expect(adapter.deliver(
      withoutText,
      destination("agent-no-text", "ou-accepted", "text"),
    )).resolves.toEqual({
      kind: "permanent_failure",
      detail: "invalid_feishu_destination",
    });
    expect(messages.inputs).toHaveLength(0);
  });
});
