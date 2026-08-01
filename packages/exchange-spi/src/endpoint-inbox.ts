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
  readonly capability_ids: readonly string[];
  readonly active_claim?: {
    readonly claim_id: string;
    readonly fencing_token: number;
    readonly expires_at: string;
  } | null;
  readonly last_event_id: string;
  readonly observed_position: number;
  readonly visible_actor_ids: readonly string[];
  readonly visible_endpoint_ids: readonly string[];
  readonly active: boolean;
}

export interface EndpointClaimableHandoff {
  readonly partition_id: string;
  readonly handoff_id: string;
  readonly resource_version: number;
  readonly lifecycle_state: "claimable";
  readonly capability_ids: readonly string[];
  readonly last_event_id: string;
  readonly observed_position: number;
}

export interface EndpointClaimableHandoffQuery {
  readonly tenant_id: string;
  readonly endpoint_id: string;
  readonly capability_ids: readonly string[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface EndpointClaimableHandoffPage {
  readonly items: readonly EndpointClaimableHandoff[];
  readonly next_cursor?: string;
}

export interface EndpointExpiredClaim {
  readonly partition_id: string;
  readonly handoff_id: string;
  readonly resource_version: number;
  readonly claim_id: string;
  readonly fencing_token: number;
  readonly expires_at: string;
}

export interface EndpointExpiredClaimQuery {
  readonly tenant_id: string;
  readonly expires_at_or_before: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface EndpointExpiredClaimPage {
  readonly items: readonly EndpointExpiredClaim[];
  readonly next_cursor?: string;
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
  listClaimableHandoffs(
    input: EndpointClaimableHandoffQuery,
  ): Promise<EndpointClaimableHandoffPage>;
  listExpiredClaims(
    input: EndpointExpiredClaimQuery,
  ): Promise<EndpointExpiredClaimPage>;
  clearPartitionProjection(tenantId: string, partitionId: string): Promise<void>;
  clearTenantProjection(tenantId: string): Promise<void>;
}
