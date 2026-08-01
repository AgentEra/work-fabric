import type { DiscoveryRecord, DiscoveryRecordKind, DiscoveryStoredValue } from "./records.js";

export type DiscoveryMessageType =
  | "sync_request"
  | "sync_response"
  | "query_request"
  | "query_response";

export interface DiscoveryQueryBudget {
  readonly deadline: string;
  readonly remaining_hops: number;
  readonly remaining_fanout: number;
  readonly remaining_results: number;
  readonly remaining_bytes: number;
}

export interface DiscoveryQuery {
  readonly record_kinds?: readonly DiscoveryRecordKind[];
  readonly capability_id?: string;
  readonly version_constraint?: string;
  readonly input_media_types?: readonly string[];
  readonly output_media_types?: readonly string[];
  readonly interaction_modes?: readonly string[];
  readonly binding_types?: readonly string[];
  readonly origin_exchange_id?: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface DiscoverySyncRequest {
  readonly cursor?: string;
  readonly etag?: string;
  readonly limit: number;
}

export interface DiscoverySyncResponse {
  readonly items: readonly DiscoveryStoredValue[];
  readonly next_cursor?: string;
  readonly etag: string;
  readonly complete: boolean;
}

export interface DiscoveryFederatedQueryRequest {
  readonly query_id: string;
  readonly path: readonly string[];
  readonly query: DiscoveryQuery;
  readonly budget: DiscoveryQueryBudget;
}

export interface DiscoveryFederatedQueryResponse {
  readonly query_id: string;
  readonly coverage: "complete" | "partial";
  readonly items: readonly DiscoveryRecord[];
  readonly warnings: readonly string[];
}

export type DiscoveryMessagePayload =
  | DiscoverySyncRequest
  | DiscoverySyncResponse
  | DiscoveryFederatedQueryRequest
  | DiscoveryFederatedQueryResponse;

export interface DiscoveryUnsignedMessage {
  readonly profile: "workfabric.discovery.v1";
  readonly message_id: string;
  readonly message_type: DiscoveryMessageType;
  readonly source_exchange_id: string;
  readonly target_exchange_id: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly key_id: string;
  readonly payload: DiscoveryMessagePayload;
}

export interface DiscoverySignedMessage extends DiscoveryUnsignedMessage {
  readonly signature: string;
}
