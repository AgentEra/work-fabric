import type { CapabilityManifest, EndpointActorRef } from "@work-fabric/exchange-spi";

import type {
  DiscoveryFederatedQueryRequest,
  DiscoveryFederatedQueryResponse,
  DiscoveryQuery,
} from "./messages.js";
import type {
  DiscoveryCoverage,
  DiscoveryRecord,
  DiscoveryRecordKind,
  DiscoveryStoredValue,
} from "./records.js";

export interface DiscoveryScope {
  readonly tenant_id: string;
  readonly tenant_view_id: string;
}

export type DiscoveryApplyResult =
  | { readonly outcome: "applied"; readonly sequence: number }
  | { readonly outcome: "duplicate" | "stale"; readonly sequence: number };

export interface DiscoveryStoreQuery extends DiscoveryQuery, DiscoveryScope {
  readonly now: string;
}

export interface DiscoveryPage {
  readonly coverage: DiscoveryCoverage;
  readonly items: readonly DiscoveryRecord[];
  readonly next_cursor?: string;
  readonly warnings: readonly string[];
}

export interface DiscoveryChangePage {
  readonly items: readonly DiscoveryStoredValue[];
  readonly next_cursor?: string;
  readonly etag: string;
}

export interface DiscoveryStoreStatus {
  readonly live: number;
  readonly expired: number;
  readonly withdrawn: number;
  readonly conflicts: number;
  readonly capacity: number;
}

export interface DiscoveryStore {
  readonly manifest: CapabilityManifest;
  apply(input: DiscoveryScope & {
    readonly source_peer_id: string | null;
    readonly value: DiscoveryStoredValue;
  }): Promise<DiscoveryApplyResult>;
  get(input: DiscoveryScope & {
    readonly origin_exchange_id: string;
    readonly record_id: string;
    readonly now: string;
  }): Promise<DiscoveryRecord | null>;
  query(input: DiscoveryStoreQuery): Promise<DiscoveryPage>;
  changes(input: DiscoveryScope & {
    readonly peer_id: string;
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<DiscoveryChangePage>;
  prune(input: DiscoveryScope & { readonly now: string }): Promise<number>;
  status(input: DiscoveryScope & { readonly now: string }): Promise<DiscoveryStoreStatus>;
}

export interface DiscoveryPeerBinding {
  readonly tenant_id: string;
  readonly tenant_view_id: string;
  readonly peer_id: string;
  readonly exchange_id: string;
  readonly state: "active" | "disabled";
  readonly allow_import: boolean;
  readonly allow_export: boolean;
  readonly allow_query: boolean;
  readonly allow_transit: boolean;
  readonly max_page_size: number;
  readonly max_response_bytes: number;
  readonly version: number;
}

export interface DiscoveryPeerBindingStore {
  readonly manifest: CapabilityManifest;
  put(input: {
    readonly binding: DiscoveryPeerBinding;
    readonly expected_version: number | null;
  }): Promise<DiscoveryPeerBinding>;
  get(scope: DiscoveryScope, peerId: string): Promise<DiscoveryPeerBinding | null>;
  list(scope: DiscoveryScope): Promise<readonly DiscoveryPeerBinding[]>;
}

export interface DiscoveryCallContext extends DiscoveryScope {
  readonly principal_id: string;
  readonly represented_actor?: EndpointActorRef;
  readonly represented_endpoint_id?: string;
}

export interface DiscoveryDisclosurePolicy {
  canRead(input: {
    readonly context: DiscoveryCallContext;
    readonly record: DiscoveryRecord;
  }): Promise<boolean>;
}

export interface DiscoveryExportPolicy {
  exportRecord(input: {
    readonly scope: DiscoveryScope;
    readonly peer: DiscoveryPeerBinding | null;
    readonly record: DiscoveryRecord;
  }): Promise<DiscoveryRecord | null>;
}

export interface DiscoverySigner {
  readonly key_id: string;
  sign(canonical: Uint8Array): Promise<string>;
}

export interface DiscoveryTrustResolver {
  verify(input: {
    readonly origin_exchange_id: string;
    readonly audience_exchange_id: string;
    readonly key_id: string;
    readonly canonical: Uint8Array;
    readonly signature: string;
  }): Promise<boolean>;
}

export interface DiscoveryPeerTransport {
  exchange(request: Uint8Array): Promise<Uint8Array | "retryable_failure">;
}

export interface DiscoveryClock {
  now(): string;
}

export interface DiscoveryIdGenerator {
  nextId(kind: "message" | "query"): string;
}

export interface DiscoveryFederatedQueryPort {
  query(input: DiscoveryFederatedQueryRequest): Promise<DiscoveryFederatedQueryResponse>;
}

export interface DiscoveryRecordSelector {
  readonly record_kinds?: readonly DiscoveryRecordKind[];
}
