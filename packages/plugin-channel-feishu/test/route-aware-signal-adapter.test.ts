import { describe, expect, it } from "vitest";
import { MemoryChannelRouteStore } from "@work-fabric/adapter-storage-memory";
import type { ChannelHandoffSnapshotSource } from "@work-fabric/channel-spi";
import {
  signalMediaTypeCapability,
  type ProtocolEvent,
} from "@work-fabric/exchange-spi";
import {
  FeishuActionReferenceCodec,
  FeishuEventRenderer,
  FeishuSignalAdapter,
  type FeishuMessageClient,
  type FeishuSendMessageInput,
} from "@work-fabric/connector-feishu";
import { FeishuRouteAwareSignalAdapter } from "../src/index.js";

const event = {
  specversion: "1.0",
  id: "event-1",
  source: "urn:work-fabric:exchange:exchange-1",
  type: "workfabric.handoff.accepted.v1",
  subject: "handoff-1",
  time: "2026-07-17T00:00:00.000Z",
  datacontenttype: "application/json",
  dataschema: "urn:work-fabric:schema:v1:event-data",
  wftenant: "tenant-1",
  wfexchange: "exchange-1",
  wfhandoff: "handoff-1",
  wfsequence: 2,
  wfvisibility: "participants",
  data: { resource_version: 2 },
} as ProtocolEvent;
const resultEvent = {
  ...event,
  type: "workfabric.handoff.result_returned.v1",
  wfsequence: 3,
  data: { resource_version: 3 },
} as ProtocolEvent;

const snapshotSource = (
  get: ChannelHandoffSnapshotSource["get"] = async () => ({
    kind: "ready",
    snapshot: {
      handoff_id: "handoff-1",
      resource_version: 3,
      lifecycle_state: "result_returned",
      result: {
        summary: [{
          kind: "text",
          media_type: "text/plain",
          text: "Agent authored reply",
        }],
        artifacts: [],
        evidence: [],
        extensions: {},
      },
    },
  }),
): ChannelHandoffSnapshotSource => ({
  manifest: {
    profile: "channel.handoff-snapshot-source.v1",
    adapter: "fake",
    capabilities: {},
  },
  get,
});

describe("FeishuRouteAwareSignalAdapter", () => {
  it("enriches and renders one canonical Markdown Result through the production Channel topology", async () => {
    const routes = new MemoryChannelRouteStore();
    await routes.put({
      route: {
        tenant_id: "tenant-1",
        plugin_instance_id: "feishu-primary",
        handoff_id: "handoff-1",
        external_conversation_id: "oc-1",
        external_message_id: "om-1",
        version: 1,
        created_at: "2026-07-17T00:00:00.000Z",
        updated_at: "2026-07-17T00:00:00.000Z",
      },
      expected_version: 0,
    });
    const inputs: FeishuSendMessageInput[] = [];
    const messages: FeishuMessageClient = {
      async sendMessage(input) {
        inputs.push(structuredClone(input));
        return { kind: "accepted", message_id: "om-result-1" };
      },
    };
    const delegate = new FeishuSignalAdapter({
      messages,
      renderer: new FeishuEventRenderer({
        action_codec: new FeishuActionReferenceCodec({
          encryption_key: new Uint8Array(32).fill(7),
        }),
        clock: { now: () => "2026-07-17T00:00:00.000Z" },
        max_text_bytes: 150_000,
        max_card_bytes: 30_000,
      }),
    });
    const adapter = new FeishuRouteAwareSignalAdapter({
      tenant_id: "tenant-1",
      plugin_instance_id: "feishu-primary",
      connector_id: "feishu-primary",
      external_tenant_id: "tenant-key-1",
      credential_ref: "credential-ref-1",
      render_mode: "card",
      actor_id: "actor-channel",
      routes,
      handoff_snapshots: snapshotSource(async () => ({
        kind: "ready",
        snapshot: {
          handoff_id: "handoff-1",
          resource_version: 3,
          lifecycle_state: "result_returned",
          result: {
            summary: [{
              kind: "text",
              media_type: "text/markdown",
              text: "## 已完成\n\n请查看[需求文档](https://example.com/doc)。",
            }],
            artifacts: [],
            evidence: [],
            extensions: {},
          },
        },
      })),
      static_channels: {},
      delegate,
    });

    await expect(adapter.deliver(resultEvent, {
      destination_id: "handoff:handoff-1",
      binding: "collaboration-channel",
      configuration: {
        plugin_instance_id: "feishu-primary",
        route_mode: "handoff",
      },
    })).resolves.toEqual({ kind: "accepted" });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.msg_type).toBe("post");
    expect(JSON.parse(inputs[0]!.content)).toEqual({
      zh_cn: {
        title: "",
        content: [[{
          tag: "md",
          text: "## 已完成\n\n请查看[需求文档](https://example.com/doc)。",
        }]],
      },
    });
  });

  it("resolves a Handoff route and sends to the original chat without credentials in the destination", async () => {
    const routes = new MemoryChannelRouteStore();
    await routes.put({ route: { tenant_id: "tenant-1", plugin_instance_id: "feishu-primary", handoff_id: "handoff-1", external_conversation_id: "oc-1", external_message_id: "om-1", version: 1, created_at: "2026-07-17T00:00:00.000Z", updated_at: "2026-07-17T00:00:00.000Z" }, expected_version: 0 });
    const observed: unknown[] = [];
    const adapter = new FeishuRouteAwareSignalAdapter({
      tenant_id: "tenant-1", plugin_instance_id: "feishu-primary", connector_id: "feishu-primary",
      external_tenant_id: "tenant-key-1", credential_ref: "private-ref", render_mode: "card",
      actor_id: "actor-channel", routes,
      handoff_snapshots: snapshotSource(),
      static_channels: {},
      delegate: { manifest: { profile: "exchange.signal.v1", adapter: "fake", capabilities: {} }, async deliver(_event, destination) { observed.push(destination); return { kind: "accepted" }; } },
    });
    expect(adapter.manifest.capabilities).toMatchObject({
      [signalMediaTypeCapability("text/plain")]: true,
      [signalMediaTypeCapability("text/markdown")]: true,
    });
    await expect(adapter.deliver(resultEvent, { destination_id: "handoff:handoff-1", binding: "collaboration-channel", configuration: { plugin_instance_id: "feishu-primary", route_mode: "handoff" } })).resolves.toEqual({ kind: "accepted" });
    expect(observed[0]).toMatchObject({ binding: "feishu", configuration: { receive_id_type: "chat_id", receive_id: "oc-1", credential_ref: "private-ref" } });
  });

  it("classifies a missing route as retryable and another instance as permanent", async () => {
    const adapter = new FeishuRouteAwareSignalAdapter({ tenant_id: "tenant-1", plugin_instance_id: "feishu-primary", connector_id: "feishu-primary", external_tenant_id: "tenant-key-1", credential_ref: "ref", render_mode: "text", actor_id: "actor", routes: new MemoryChannelRouteStore(), handoff_snapshots: snapshotSource(), static_channels: {}, delegate: { manifest: { profile: "exchange.signal.v1", adapter: "fake", capabilities: {} }, async deliver() { return { kind: "accepted" }; } } });
    await expect(adapter.deliver(resultEvent, { destination_id: "1", binding: "collaboration-channel", configuration: { plugin_instance_id: "feishu-primary", route_mode: "handoff" } })).resolves.toEqual({ kind: "retryable_failure", detail: "channel_route_missing" });
    await expect(adapter.deliver(resultEvent, { destination_id: "2", binding: "collaboration-channel", configuration: { plugin_instance_id: "other", route_mode: "handoff" } })).resolves.toEqual({ kind: "permanent_failure", detail: "invalid_feishu_plugin_destination" });
  });

  it("enriches a result with an immutable canonical snapshot before delivery", async () => {
    const routes = new MemoryChannelRouteStore();
    await routes.put({ route: { tenant_id: "tenant-1", plugin_instance_id: "feishu-primary", handoff_id: "handoff-1", external_conversation_id: "oc-1", external_message_id: "om-1", version: 1, created_at: "2026-07-17T00:00:00.000Z", updated_at: "2026-07-17T00:00:00.000Z" }, expected_version: 0 });
    const requested: unknown[] = [];
    const delivered: ProtocolEvent[] = [];
    const adapter = new FeishuRouteAwareSignalAdapter({
      tenant_id: "tenant-1", plugin_instance_id: "feishu-primary",
      connector_id: "feishu-primary", external_tenant_id: "tenant-key-1",
      credential_ref: "ref", render_mode: "text", actor_id: "actor",
      routes, static_channels: {},
      handoff_snapshots: snapshotSource(async (input) => {
        requested.push(input);
        return (await snapshotSource().get(input));
      }),
      delegate: {
        manifest: { profile: "exchange.signal.v1", adapter: "fake", capabilities: {} },
        async deliver(deliveredEvent) {
          delivered.push(structuredClone(deliveredEvent));
          return { kind: "accepted" };
        },
      },
    });

    await expect(adapter.deliver(resultEvent, {
      destination_id: "result",
      binding: "collaboration-channel",
      configuration: {
        plugin_instance_id: "feishu-primary",
        route_mode: "handoff",
      },
    })).resolves.toEqual({ kind: "accepted" });
    expect(requested).toEqual([{
      tenant_id: "tenant-1",
      handoff_id: "handoff-1",
      minimum_resource_version: 3,
    }]);
    expect(delivered[0]?.data).toMatchObject({
      snapshot: {
        lifecycle_state: "result_returned",
        result: { summary: [{ text: "Agent authored reply" }] },
      },
    });
    expect(resultEvent.data).not.toHaveProperty("snapshot");
  });

  it.each([
    ["not_ready", "retryable_failure", "handoff_snapshot_not_ready"],
    ["not_found", "permanent_failure", "handoff_snapshot_not_found"],
  ] as const)("maps snapshot %s without delegating", async (kind, outcome, detail) => {
    const routes = new MemoryChannelRouteStore();
    await routes.put({ route: { tenant_id: "tenant-1", plugin_instance_id: "feishu-primary", handoff_id: "handoff-1", external_conversation_id: "oc-1", external_message_id: "om-1", version: 1, created_at: "2026-07-17T00:00:00.000Z", updated_at: "2026-07-17T00:00:00.000Z" }, expected_version: 0 });
    let deliveries = 0;
    const adapter = new FeishuRouteAwareSignalAdapter({
      tenant_id: "tenant-1", plugin_instance_id: "feishu-primary",
      connector_id: "feishu-primary", external_tenant_id: "tenant-key-1",
      credential_ref: "ref", render_mode: "text", actor_id: "actor",
      routes, static_channels: {},
      handoff_snapshots: snapshotSource(async () => ({ kind })),
      delegate: {
        manifest: { profile: "exchange.signal.v1", adapter: "fake", capabilities: {} },
        async deliver() { deliveries += 1; return { kind: "accepted" }; },
      },
    });

    await expect(adapter.deliver({
      ...event,
      type: "workfabric.handoff.result_returned.v1",
      wfsequence: 3,
    } as ProtocolEvent, {
      destination_id: "result",
      binding: "collaboration-channel",
      configuration: {
        plugin_instance_id: "feishu-primary",
        route_mode: "handoff",
      },
    })).resolves.toEqual({ kind: outcome, detail });
    expect(deliveries).toBe(0);
  });

  it("acknowledges non-result conversation events without producing a reply", async () => {
    const routes = new MemoryChannelRouteStore();
    await routes.put({ route: { tenant_id: "tenant-1", plugin_instance_id: "feishu-primary", handoff_id: "handoff-1", external_conversation_id: "oc-1", external_message_id: "om-1", version: 1, created_at: "2026-07-17T00:00:00.000Z", updated_at: "2026-07-17T00:00:00.000Z" }, expected_version: 0 });
    let snapshotReads = 0;
    let deliveries = 0;
    const adapter = new FeishuRouteAwareSignalAdapter({
      tenant_id: "tenant-1", plugin_instance_id: "feishu-primary",
      connector_id: "feishu-primary", external_tenant_id: "tenant-key-1",
      credential_ref: "ref", render_mode: "text", actor_id: "actor",
      routes, static_channels: {},
      handoff_snapshots: snapshotSource(async () => {
        snapshotReads += 1;
        return { kind: "not_found" };
      }),
      delegate: {
        manifest: { profile: "exchange.signal.v1", adapter: "fake", capabilities: {} },
        async deliver() { deliveries += 1; return { kind: "accepted" }; },
      },
    });

    await expect(adapter.deliver(event, {
      destination_id: "accepted",
      binding: "collaboration-channel",
      configuration: {
        plugin_instance_id: "feishu-primary",
        route_mode: "handoff",
      },
    })).resolves.toEqual({ kind: "accepted" });
    expect(snapshotReads).toBe(0);
    expect(deliveries).toBe(0);
  });
});
