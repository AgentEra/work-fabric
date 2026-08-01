import { describe, expect, it } from "vitest";

import {
  CHANNEL_HANDOFF_SNAPSHOT_REQUIRED_CAPABILITIES,
  CHANNEL_ROUTE_REQUIRED_CAPABILITIES,
  assertChannelRoute,
  assertChannelHandoffSnapshotRequest,
  type ChannelHandoffSnapshotSource,
  type ChannelRouteStore,
} from "../src/index.js";

describe("Channel route contracts", () => {
  it("contains only bounded scoped routing facts", () => {
    const route = {
      tenant_id: "tenant-1", plugin_instance_id: "feishu-a", handoff_id: "handoff-1",
      external_conversation_id: "oc_1", external_message_id: "om_1",
      version: 1, created_at: "2026-07-17T00:00:00.000Z", updated_at: "2026-07-17T00:00:00.000Z",
    } as const;
    expect(() => assertChannelRoute(route)).not.toThrow();
    expect(Object.keys(route)).toHaveLength(8);
    expect(CHANNEL_ROUTE_REQUIRED_CAPABILITIES).toContain("expected_version_cas");
    const compileOnly = <T>(_value: T): true => true;
    expect(compileOnly<ChannelRouteStore>).toBeTypeOf("function");
  });

  it("rejects content and secret-bearing extra fields", () => {
    expect(() => assertChannelRoute({
      tenant_id: "tenant-1", plugin_instance_id: "feishu-a", handoff_id: "handoff-1",
      external_conversation_id: "oc_1", external_message_id: "om_1",
      version: 1, created_at: "2026-07-17T00:00:00.000Z", updated_at: "2026-07-17T00:00:00.000Z",
      content: "private message",
    })).toThrow();
  });
});

describe("Channel Handoff snapshot contracts", () => {
  it("accepts only a scoped minimum-version request", () => {
    const request = {
      tenant_id: "tenant-1",
      handoff_id: "handoff-1",
      minimum_resource_version: 4,
    } as const;

    expect(() => assertChannelHandoffSnapshotRequest(request)).not.toThrow();
    expect(() => assertChannelHandoffSnapshotRequest({
      ...request,
      database_table: "work_fabric_snapshots",
    })).toThrow();
    expect(() => assertChannelHandoffSnapshotRequest({
      ...request,
      minimum_resource_version: 0,
    })).toThrow();
    expect(CHANNEL_HANDOFF_SNAPSHOT_REQUIRED_CAPABILITIES).toEqual([
      "tenant_isolation",
      "minimum_resource_version",
      "immutable_reads",
    ]);
    const compileOnly = <T>(_value: T): true => true;
    expect(compileOnly<ChannelHandoffSnapshotSource>).toBeTypeOf("function");
  });
});
