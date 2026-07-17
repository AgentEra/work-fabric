import { describe, expect, it } from "vitest";

import type { ProtocolEvent, SignalAdapter } from "@work-fabric/exchange-spi";
import { ChannelSignalRouter } from "../src/index.js";

const event = { id: "event-1" } as ProtocolEvent;
const adapter = (result: "accepted" | "retryable_failure" = "accepted"): SignalAdapter => ({
  manifest: { profile: "exchange.signal.v1", adapter: "test", capabilities: {} },
  async deliver() {
    return result === "accepted"
      ? { kind: "accepted" }
      : { kind: "retryable_failure", detail: "temporary" };
  },
});

describe("ChannelSignalRouter", () => {
  it("routes only to the explicitly addressed plugin instance", async () => {
    const router = new ChannelSignalRouter();
    router.register("feishu-a", adapter());
    router.register("feishu-b", adapter("retryable_failure"));
    await expect(router.deliver(event, {
      destination_id: "destination-1",
      binding: "collaboration-channel",
      configuration: { plugin_instance_id: "feishu-b", route_mode: "handoff" },
    })).resolves.toEqual({ kind: "retryable_failure", detail: "temporary" });
  });

  it("classifies missing instances as retryable and invalid destinations as permanent", async () => {
    const router = new ChannelSignalRouter();
    await expect(router.deliver(event, {
      destination_id: "1", binding: "collaboration-channel",
      configuration: { plugin_instance_id: "missing", route_mode: "handoff" },
    })).resolves.toEqual({ kind: "retryable_failure", detail: "plugin_instance_unavailable" });
    await expect(router.deliver(event, {
      destination_id: "2", binding: "other", configuration: {},
    })).resolves.toEqual({ kind: "permanent_failure", detail: "invalid_channel_destination" });
  });

  it("rejects duplicate instance registration", () => {
    const router = new ChannelSignalRouter();
    router.register("feishu-a", adapter());
    expect(() => router.register("feishu-a", adapter())).toThrowError(/duplicate_plugin_instance/);
  });
});
