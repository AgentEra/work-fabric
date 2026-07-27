import {
  assertChannelHandoffSnapshotRequest,
  channelHandoffSnapshotSourceManifest,
  type ChannelHandoffSnapshotRequest,
  type ChannelHandoffSnapshotResult,
  type ChannelHandoffSnapshotSource,
} from "@work-fabric/channel-spi";
import type { HandoffReadModelStore } from "@work-fabric/exchange-spi";

export class StoreBackedChannelHandoffSnapshotSource
implements ChannelHandoffSnapshotSource {
  readonly manifest = channelHandoffSnapshotSourceManifest(
    "store-backed-channel-handoff-snapshot",
  );

  constructor(
    private readonly tenantId: string,
    private readonly handoffs: HandoffReadModelStore,
  ) {}

  async get(
    input: ChannelHandoffSnapshotRequest,
  ): Promise<ChannelHandoffSnapshotResult> {
    assertChannelHandoffSnapshotRequest(input);
    if (input.tenant_id !== this.tenantId) return { kind: "not_found" };
    const model = await this.handoffs.getHandoff(input.handoff_id);
    if (model === null || model.tenant_id !== input.tenant_id) {
      return { kind: "not_found" };
    }
    if (model.stream_version < input.minimum_resource_version) {
      return { kind: "not_ready" };
    }
    return { kind: "ready", snapshot: structuredClone(model.state) };
  }
}
