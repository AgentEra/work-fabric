import { describe, expect, it } from "vitest";
import { MemoryDebugChannelStore } from "@work-fabric/adapter-debug-channel-memory";
import { MemoryChannelRouteStore } from "@work-fabric/adapter-storage-memory";
import {
  channelHandoffSnapshotSourceManifest,
  type ChannelHandoffSnapshotSource,
} from "@work-fabric/channel-spi";
import type { ProtocolEvent } from "@work-fabric/exchange-spi";
import {
  DebugRouteAwareSignalAdapter,
} from "../src/index.js";

const resultEvent: ProtocolEvent = {
  specversion: "1.0",
  id: "event-result-1",
  source: "urn:work-fabric:exchange:exchange-local",
  type: "workfabric.handoff.result_returned.v1",
  subject: "handoff-1",
  time: "2026-07-29T09:01:00.000Z",
  datacontenttype: "application/json",
  dataschema: "urn:work-fabric:schema:v1:event-data",
  wftenant: "tenant-local",
  wfexchange: "exchange-local",
  wfhandoff: "handoff-1",
  wfsequence: 3,
  wfvisibility: "participants",
  data: { resource_version: 3 },
};

function snapshots(
  get: ChannelHandoffSnapshotSource["get"] = async () => ({
    kind: "ready",
    snapshot: {
      handoff_id: "handoff-1",
      resource_version: 3,
      lifecycle_state: "result_returned",
      result: {
        summary: [{
          kind: "text",
          media_type: "text/markdown",
          text: "已完成：[查看资料](https://example.com/eda)",
        }],
        artifacts: [],
        evidence: [],
        extensions: {},
      },
    },
  }),
): ChannelHandoffSnapshotSource {
  return {
    manifest: channelHandoffSnapshotSourceManifest("test"),
    get,
  };
}

async function adapter(snapshotSource = snapshots()) {
  const routes = new MemoryChannelRouteStore();
  const diagnostics = new MemoryDebugChannelStore();
  await routes.put({
    route: {
      tenant_id: "tenant-local",
      plugin_instance_id: "debug-local",
      handoff_id: "handoff-1",
      external_conversation_id: "conversation-1",
      external_message_id: "submission-1",
      version: 1,
      created_at: "2026-07-29T09:00:00.000Z",
      updated_at: "2026-07-29T09:00:00.000Z",
    },
    expected_version: 0,
  });
  return {
    diagnostics,
    adapter: new DebugRouteAwareSignalAdapter({
      tenant_id: "tenant-local",
      plugin_instance_id: "debug-local",
      routes,
      diagnostics,
      handoff_snapshots: snapshotSource,
      clock: { now: () => "2026-07-29T09:01:01.000Z" },
      retention_days: 14,
    }),
  };
}

const destination = {
  destination_id: "handoff:handoff-1",
  binding: "collaboration-channel",
  configuration: {
    plugin_instance_id: "debug-local",
    route_mode: "handoff",
  },
} as const;

describe("DebugRouteAwareSignalAdapter", () => {
  it("preserves the canonical event and stores the semantic Handoff snapshot separately", async () => {
    const setup = await adapter();
    await expect(setup.adapter.deliver(resultEvent, destination)).resolves.toEqual({
      kind: "accepted",
    });
    const page = await setup.diagnostics.listCaptures({
      tenant_id: "tenant-local",
      plugin_instance_id: "debug-local",
      conversation_id: "conversation-1",
      limit: 10,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.event).toEqual(resultEvent);
    expect(page.items[0]?.handoff_snapshot).toMatchObject({
      lifecycle_state: "result_returned",
      result: {
        summary: [{
          media_type: "text/markdown",
          text: "已完成：[查看资料](https://example.com/eda)",
        }],
      },
    });
  });

  it("replays one Signal delivery as one capture", async () => {
    const setup = await adapter();
    await setup.adapter.deliver(resultEvent, destination);
    await setup.adapter.deliver(resultEvent, destination);
    expect((await setup.diagnostics.listCaptures({
      tenant_id: "tenant-local",
      plugin_instance_id: "debug-local",
      conversation_id: "conversation-1",
      limit: 10,
    })).items).toHaveLength(1);
  });

  it("retries when the Handoff snapshot has not reached the event version", async () => {
    const setup = await adapter(snapshots(async () => ({ kind: "not_ready" })));
    await expect(setup.adapter.deliver(resultEvent, destination)).resolves.toEqual({
      kind: "retryable_failure",
      detail: "handoff_snapshot_not_ready",
    });
    expect((await setup.diagnostics.listCaptures({
      tenant_id: "tenant-local",
      plugin_instance_id: "debug-local",
      conversation_id: "conversation-1",
      limit: 10,
    })).items).toHaveLength(0);
  });

  it("fails a cross-plugin destination without reading a route", async () => {
    const setup = await adapter();
    await expect(setup.adapter.deliver(resultEvent, {
      ...destination,
      configuration: {
        plugin_instance_id: "debug-other",
        route_mode: "handoff",
      },
    })).resolves.toEqual({
      kind: "permanent_failure",
      detail: "invalid_debug_plugin_destination",
    });
  });
});
