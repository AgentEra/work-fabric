import type { CapabilityManifest, ExchangeAdapter } from "@work-fabric/exchange-spi";

export const CHANNEL_ROUTE_REQUIRED_CAPABILITIES = [
  "tenant_isolation",
  "plugin_instance_isolation",
  "idempotent_put",
  "expected_version_cas",
  "deterministic_pagination",
  "payload_isolation",
] as const;

export interface ChannelRoute {
  readonly tenant_id: string;
  readonly plugin_instance_id: string;
  readonly handoff_id: string;
  readonly external_conversation_id: string;
  readonly external_message_id: string;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ChannelRouteScope {
  readonly tenant_id: string;
  readonly plugin_instance_id: string;
  readonly handoff_id: string;
}

export interface PutChannelRoute {
  readonly route: ChannelRoute;
  readonly expected_version: number;
}

export interface ListChannelRoutes {
  readonly tenant_id: string;
  readonly plugin_instance_id: string;
  readonly after_handoff_id?: string;
  readonly limit: number;
}

export interface ChannelRouteStore extends ExchangeAdapter {
  readonly manifest: CapabilityManifest;
  put(input: PutChannelRoute): Promise<void>;
  get(scope: ChannelRouteScope): Promise<ChannelRoute | null>;
  list(query: ListChannelRoutes): Promise<readonly ChannelRoute[]>;
}

export class ChannelRouteStoreError extends Error {
  constructor(readonly code: "route_conflict" | "version_conflict") {
    super(code);
    this.name = "ChannelRouteStoreError";
  }
}

function bounded(value: unknown, field: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${field} is invalid`);
  }
}

export function assertChannelRoute(value: unknown): asserts value is ChannelRoute {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Channel route must be an object");
  }
  const route = value as Record<string, unknown>;
  const fields = ["tenant_id", "plugin_instance_id", "handoff_id", "external_conversation_id", "external_message_id", "version", "created_at", "updated_at"];
  if (Object.keys(route).length !== fields.length || fields.some((field) => !Object.hasOwn(route, field))) {
    throw new TypeError("Channel route contains unknown or missing fields");
  }
  bounded(route.tenant_id, "tenant_id", 128);
  bounded(route.plugin_instance_id, "plugin_instance_id", 128);
  bounded(route.handoff_id, "handoff_id", 128);
  bounded(route.external_conversation_id, "external_conversation_id", 512);
  bounded(route.external_message_id, "external_message_id", 512);
  if (!Number.isSafeInteger(route.version) || (route.version as number) <= 0) {
    throw new RangeError("version is invalid");
  }
  bounded(route.created_at, "created_at", 64);
  bounded(route.updated_at, "updated_at", 64);
  if (!Number.isFinite(Date.parse(route.created_at)) || !Number.isFinite(Date.parse(route.updated_at))) {
    throw new TypeError("Channel route timestamp is invalid");
  }
}

export function channelRouteManifest(adapter: string): CapabilityManifest {
  return {
    profile: "channel.route-store.v1",
    adapter,
    capabilities: Object.fromEntries(CHANNEL_ROUTE_REQUIRED_CAPABILITIES.map((item) => [item, true])),
  };
}
