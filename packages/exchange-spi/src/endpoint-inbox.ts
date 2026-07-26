import type { CapabilityManifest, ExchangeAdapter } from "./capabilities.js";

export const ENDPOINT_INBOX_REQUIRED_CAPABILITIES = [
  "tenant_isolation",
  "audience_union",
  "monotonic_projection",
  "deterministic_pagination",
  "rebuildable",
] as const;

export interface EndpointInboxRoutingFact {
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly handoff_id: string;
  readonly resource_version: number;
  readonly lifecycle_state: string;
  readonly last_event_id: string;
  readonly observed_position: number;
  readonly visible_actor_ids: readonly string[];
  readonly visible_endpoint_ids: readonly string[];
  readonly active: boolean;
}

export interface EndpointInboxPartition {
  readonly partition_id: string;
  readonly latest_position: number;
  readonly active_handoff_count: number;
}

export interface EndpointInboxPartitionQuery {
  readonly tenant_id: string;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface EndpointInboxPartitionPage {
  readonly items: readonly EndpointInboxPartition[];
  readonly next_cursor?: string;
}

export interface EndpointInboxStore extends ExchangeAdapter {
  readonly manifest: CapabilityManifest;
  upsertRoutingFact(fact: EndpointInboxRoutingFact): Promise<void>;
  listPartitions(
    input: EndpointInboxPartitionQuery,
  ): Promise<EndpointInboxPartitionPage>;
  clearPartitionProjection(tenantId: string, partitionId: string): Promise<void>;
  clearTenantProjection(tenantId: string): Promise<void>;
}
