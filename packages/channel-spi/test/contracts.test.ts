import { describe, expect, it } from "vitest";

import {
  CHANNEL_ROUTE_REQUIRED_CAPABILITIES,
  assertChannelRoute,
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
