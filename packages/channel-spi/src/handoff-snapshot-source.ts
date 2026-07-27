import type {
  CapabilityManifest,
  ExchangeAdapter,
  JsonObject,
} from "@work-fabric/exchange-spi";

export const CHANNEL_HANDOFF_SNAPSHOT_REQUIRED_CAPABILITIES = [
  "tenant_isolation",
  "minimum_resource_version",
  "immutable_reads",
] as const;

export interface ChannelHandoffSnapshotRequest {
  readonly tenant_id: string;
  readonly handoff_id: string;
  readonly minimum_resource_version: number;
}

export type ChannelHandoffSnapshotResult =
  | { readonly kind: "ready"; readonly snapshot: JsonObject }
  | { readonly kind: "not_ready" }
  | { readonly kind: "not_found" };

export interface ChannelHandoffSnapshotSource extends ExchangeAdapter {
  readonly manifest: CapabilityManifest;
  get(
    input: ChannelHandoffSnapshotRequest,
  ): Promise<ChannelHandoffSnapshotResult>;
}

function bounded(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    value.trim() !== value
  ) throw new TypeError(`${field} is invalid`);
}

export function assertChannelHandoffSnapshotRequest(
  value: unknown,
): asserts value is ChannelHandoffSnapshotRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Channel Handoff snapshot request must be an object");
  }
  const request = value as Record<string, unknown>;
  const fields = [
    "tenant_id",
    "handoff_id",
    "minimum_resource_version",
  ];
  if (
    Object.keys(request).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(request, field))
  ) {
    throw new TypeError(
      "Channel Handoff snapshot request contains unknown or missing fields",
    );
  }
  bounded(request.tenant_id, "tenant_id");
  bounded(request.handoff_id, "handoff_id");
  if (
    !Number.isSafeInteger(request.minimum_resource_version) ||
    (request.minimum_resource_version as number) <= 0
  ) throw new RangeError("minimum_resource_version is invalid");
}

export function channelHandoffSnapshotSourceManifest(
  adapter: string,
): CapabilityManifest {
  return {
    profile: "channel.handoff-snapshot-source.v1",
    adapter,
    capabilities: Object.fromEntries(
      CHANNEL_HANDOFF_SNAPSHOT_REQUIRED_CAPABILITIES.map((item) => [
        item,
        true,
      ]),
    ),
  };
}
