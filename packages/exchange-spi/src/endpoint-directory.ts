import type { CapabilityManifest, ExchangeAdapter } from "./capabilities.js";
import type { JsonObject } from "./json.js";

export const ENDPOINT_AUTHORITY_ACTIONS = [
  "workfabric.endpoint.provision.v1",
  "workfabric.endpoint.disable.v1",
  "workfabric.endpoint.session.open.v1",
  "workfabric.endpoint.session.heartbeat.v1",
  "workfabric.endpoint.session.close.v1",
  "workfabric.endpoint.read.v1",
  "workfabric.endpoint.identity.discover.v1",
  "workfabric.endpoint.capability-summary.discover.v1",
  "workfabric.endpoint.discover.v1",
  "workfabric.endpoint.capability.read.v1",
  "workfabric.endpoint.inbox.read.v1",
  "workfabric.endpoint.claim-pool.read.v1",
] as const;

export type EndpointAuthorityAction =
  (typeof ENDPOINT_AUTHORITY_ACTIONS)[number];

export const ENDPOINT_DIRECTORY_REQUIRED_CAPABILITIES = [
  "tenant_isolation",
  "optimistic_registration",
  "idempotent_session_open",
  "monotonic_fencing",
  "monotonic_heartbeat",
  "clock_aware_availability",
  "deterministic_pagination",
] as const;

export type EndpointStoreErrorCode =
  | "registration_exists"
  | "registration_version_conflict"
  | "immutable_binding"
  | "idempotency_conflict"
  | "session_fenced"
  | "stale_sequence"
  | "session_not_found";

export class EndpointStoreError extends Error {
  constructor(
    readonly code: EndpointStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EndpointStoreError";
  }
}

export type EndpointAvailability =
  | "available"
  | "busy"
  | "draining"
  | "unavailable";

export type EndpointSessionState = "active" | "closed" | "fenced";
export type EndpointAdministrativeState = "enabled" | "disabled";

export interface EndpointActorRef {
  readonly actor_id: string;
  readonly actor_type: "human" | "agent" | "system";
}

export interface BindingDescriptor {
  readonly binding_type: string;
  readonly uri: string;
  readonly security_schemes: readonly string[];
  readonly extensions?: JsonObject;
}

export interface CapabilityDescriptor {
  readonly capability_id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly input_media_types: readonly string[];
  readonly output_media_types: readonly string[];
  readonly input_schema_refs: readonly string[];
  readonly output_schema_refs: readonly string[];
  readonly interaction_modes: readonly (
    | "synchronous"
    | "asynchronous"
    | "status_updates"
  )[];
  readonly constraints: JsonObject;
  readonly extensions?: JsonObject;
}

export interface EndpointLimits {
  readonly max_inline_content_bytes: number;
  readonly max_context_bytes?: number;
  readonly max_concurrent_handoffs?: number;
}

export interface EndpointRegistration {
  readonly endpoint_id: string;
  readonly actor: EndpointActorRef;
  readonly endpoint_type: string;
  readonly display_name: string;
  readonly protocol_versions: readonly string[];
  readonly bindings: readonly BindingDescriptor[];
  readonly allowed_capability_ids: readonly string[];
  readonly limits: EndpointLimits;
  readonly administrative_state: EndpointAdministrativeState;
  readonly registration_version: number;
  readonly extensions?: JsonObject;
}

export interface StoredEndpointRegistration extends EndpointRegistration {
  readonly tenant_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface EndpointDescriptor {
  readonly endpoint_id: string;
  readonly actor: EndpointActorRef;
  readonly endpoint_type: string;
  readonly display_name: string;
  readonly protocol_versions: readonly string[];
  readonly bindings: readonly BindingDescriptor[];
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly availability: EndpointAvailability;
  readonly lease: {
    readonly expires_at: string;
    readonly renew_after: string;
  };
  readonly limits: EndpointLimits;
  readonly extensions?: JsonObject;
}

export interface EndpointIdentityCard {
  readonly endpoint_id: string;
  readonly actor: EndpointActorRef;
  readonly endpoint_type: string;
  readonly display_name: string;
  readonly protocol_versions: readonly string[];
  readonly availability: EndpointAvailability;
  readonly lease: {
    readonly expires_at: string;
    readonly renew_after: string;
  };
}

export interface CapabilitySummary {
  readonly capability_id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
}

export interface EndpointCapabilityCard extends EndpointIdentityCard {
  readonly capabilities: readonly CapabilitySummary[];
}

export interface EndpointIdentityPage {
  readonly items: readonly EndpointIdentityCard[];
  readonly next_cursor?: string;
}

export interface EndpointCapabilityPage {
  readonly items: readonly EndpointCapabilityCard[];
  readonly next_cursor?: string;
}

export interface EndpointCapabilityContract {
  readonly endpoint_id: string;
  readonly actor: EndpointActorRef;
  readonly availability: EndpointAvailability;
  readonly capability: CapabilityDescriptor;
}

export interface EndpointSession {
  readonly endpoint_id: string;
  readonly actor: EndpointActorRef;
  readonly session_id: string;
  readonly client_session_id: string;
  readonly protocol_version: string;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly availability: EndpointAvailability;
  readonly accepted_lease_seconds: number;
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly state: EndpointSessionState;
  readonly expires_at: string;
  readonly renew_after: string;
  readonly registration_version: number;
}

export interface StoredEndpointSession extends EndpointSession {
  readonly tenant_id: string;
  readonly request_digest: string;
  readonly opened_at: string;
  readonly updated_at: string;
}

export interface PutEndpointRegistration {
  readonly registration: StoredEndpointRegistration;
  readonly expected_version: number | null;
}

export interface OpenEndpointSession {
  readonly tenant_id: string;
  readonly endpoint_id: string;
  readonly actor: EndpointActorRef;
  readonly session_id: string;
  readonly client_session_id: string;
  readonly protocol_version: string;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly availability: EndpointAvailability;
  readonly accepted_lease_seconds: number;
  readonly expires_at: string;
  readonly renew_after: string;
  readonly registration_version: number;
  readonly request_digest: string;
  readonly opened_at: string;
}

export interface HeartbeatEndpointSession {
  readonly tenant_id: string;
  readonly endpoint_id: string;
  readonly session_id: string;
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly availability: EndpointAvailability;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly registration_version: number;
  readonly request_digest: string;
  readonly expires_at: string;
  readonly renew_after: string;
  readonly updated_at: string;
}

export interface CloseEndpointSession {
  readonly tenant_id: string;
  readonly endpoint_id: string;
  readonly session_id: string;
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly registration_version: number;
  readonly request_digest: string;
  readonly closed_at: string;
}

export interface EndpointDiscoveryQuery {
  readonly tenant_id: string;
  readonly capability_id?: string;
  readonly version_constraint?: string;
  readonly required_input_media_types?: readonly string[];
  readonly required_output_media_types?: readonly string[];
  readonly availability?: readonly EndpointAvailability[];
  readonly cursor?: string;
  readonly limit: number;
  readonly now: string;
}

export interface EndpointDiscoveryPage {
  readonly items: readonly EndpointDescriptor[];
  readonly next_cursor?: string;
}

export interface CapabilityConstraintEvaluation {
  readonly tenant_id: string;
  readonly capability: CapabilityDescriptor;
  readonly requirement_constraints: JsonObject;
}

export type CapabilityConstraintDecision =
  | "match"
  | "mismatch"
  | "unavailable";

export interface CapabilityConstraintEvaluator extends ExchangeAdapter {
  evaluate(
    input: CapabilityConstraintEvaluation,
  ): Promise<CapabilityConstraintDecision>;
}

export interface EndpointDirectoryStore extends ExchangeAdapter {
  readonly manifest: CapabilityManifest;
  putRegistration(
    input: PutEndpointRegistration,
  ): Promise<StoredEndpointRegistration>;
  getRegistration(
    tenantId: string,
    endpointId: string,
  ): Promise<StoredEndpointRegistration | null>;
  openSession(input: OpenEndpointSession): Promise<StoredEndpointSession>;
  heartbeat(input: HeartbeatEndpointSession): Promise<StoredEndpointSession>;
  closeSession(input: CloseEndpointSession): Promise<StoredEndpointSession>;
  getSessionByClientId(
    tenantId: string,
    endpointId: string,
    clientSessionId: string,
  ): Promise<StoredEndpointSession | null>;
  getSession(
    tenantId: string,
    endpointId: string,
    sessionId: string,
  ): Promise<StoredEndpointSession | null>;
  getProjectedEndpoint(
    tenantId: string,
    endpointId: string,
    now: string,
  ): Promise<EndpointDescriptor | null>;
  discover(input: EndpointDiscoveryQuery): Promise<EndpointDiscoveryPage>;
  listActorEndpoints(
    tenantId: string,
    actorId: string,
    now: string,
  ): Promise<readonly EndpointDescriptor[]>;
}
