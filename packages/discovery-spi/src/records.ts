import type {
  BindingDescriptor,
  CapabilityDescriptor,
  EndpointActorRef,
  EndpointAvailability,
  EndpointLimits,
  JsonObject,
} from "@work-fabric/exchange-spi";

import type { DISCOVERY_PROFILE } from "./capabilities.js";

export type DiscoveryRecordKind =
  | "exchange"
  | "capability_route"
  | "participant"
  | "endpoint";
export type DiscoveryVisibility = "public" | "federated" | "peer";
export type DiscoveryCoverage = "authoritative" | "complete" | "partial";
export type DiscoveryRouteAvailability =
  | "available"
  | "constrained"
  | "unavailable";

export interface ExchangeDiscoveryPayload {
  readonly exchange_id: string;
  readonly display_name: string;
  readonly discovery_profiles: readonly string[];
  readonly federation_profiles: readonly string[];
  readonly bindings: readonly BindingDescriptor[];
  readonly security_schemes: readonly string[];
  readonly extensions?: JsonObject;
}

export interface CapabilityRouteDiscoveryPayload {
  readonly capability_id: string;
  readonly versions: readonly string[];
  readonly input_media_types: readonly string[];
  readonly output_media_types: readonly string[];
  readonly input_schema_refs: readonly string[];
  readonly output_schema_refs: readonly string[];
  readonly interaction_modes: readonly (
    | "synchronous"
    | "asynchronous"
    | "status_updates"
  )[];
  readonly binding_types: readonly string[];
  readonly security_schemes: readonly string[];
  readonly availability: DiscoveryRouteAvailability;
  readonly detail_uri?: string;
  readonly extensions?: JsonObject;
}

export interface ParticipantDiscoveryPayload {
  readonly actor: EndpointActorRef;
  readonly display_name: string;
  readonly endpoint_ids: readonly string[];
  readonly extensions?: JsonObject;
}

export interface EndpointDiscoveryPayload {
  readonly endpoint_id: string;
  readonly actor: EndpointActorRef;
  readonly endpoint_type: string;
  readonly display_name: string;
  readonly protocol_versions: readonly string[];
  readonly bindings: readonly BindingDescriptor[];
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly availability: EndpointAvailability;
  readonly limits: EndpointLimits;
  readonly extensions?: JsonObject;
}

export type DiscoveryRecordPayload =
  | ExchangeDiscoveryPayload
  | CapabilityRouteDiscoveryPayload
  | ParticipantDiscoveryPayload
  | EndpointDiscoveryPayload;

export interface DiscoveryUnsignedRecord<
  P extends DiscoveryRecordPayload = DiscoveryRecordPayload,
> {
  readonly profile: typeof DISCOVERY_PROFILE;
  readonly record_id: string;
  readonly record_kind: DiscoveryRecordKind;
  readonly origin_exchange_id: string;
  readonly revision: number;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly visibility: DiscoveryVisibility;
  readonly audiences: readonly string[];
  readonly transitive: boolean;
  readonly max_hops: number;
  readonly payload: P;
  readonly payload_digest: string;
  readonly key_id: string;
}

export interface DiscoveryRecord<
  P extends DiscoveryRecordPayload = DiscoveryRecordPayload,
> extends DiscoveryUnsignedRecord<P> {
  readonly signature: string;
}

export interface DiscoveryTombstone {
  readonly profile: typeof DISCOVERY_PROFILE;
  readonly record_id: string;
  readonly origin_exchange_id: string;
  readonly revision: number;
  readonly withdrawn_at: string;
  readonly retain_until: string;
  readonly key_id: string;
  readonly signature: string;
}

export type DiscoveryStoredValue = DiscoveryRecord | DiscoveryTombstone;

export function isDiscoveryTombstone(
  value: DiscoveryStoredValue,
): value is DiscoveryTombstone {
  return "withdrawn_at" in value;
}
