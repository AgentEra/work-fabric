import { isDeepStrictEqual } from "node:util";

import {
  EndpointStoreError,
  addUtcTimestampSeconds,
  type CapabilityDescriptor,
  type CapabilitySummary,
  type EndpointActorRef,
  type EndpointAvailability,
  type EndpointCapabilityCard,
  type EndpointCapabilityContract,
  type EndpointCapabilityPage,
  type EndpointDescriptor,
  type EndpointDirectoryStore,
  type EndpointDiscoveryPage,
  type EndpointIdentityCard,
  type EndpointIdentityPage,
  type EndpointRegistration,
  type EndpointSession,
  type StoredEndpointRegistration,
  type StoredEndpointSession,
} from "@work-fabric/exchange-spi";

import { EndpointDirectoryError, mapStoreErrorCode } from "./errors.js";
import {
  assertCapability,
  assertOpaqueId,
  assertPositiveInteger,
  assertRegistration,
  sameActor,
  semanticDigest,
} from "./validation.js";

export interface EndpointCallContext {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly represented_actor?: EndpointActorRef;
  readonly represented_endpoint_id?: string;
}

export interface EndpointDirectoryClock {
  now(): string;
}

export interface EndpointDirectoryLimits {
  readonly min_lease_seconds: number;
  readonly default_lease_seconds: number;
  readonly max_lease_seconds: number;
  readonly renew_ahead_seconds: number;
  readonly max_capabilities: number;
  readonly max_bindings: number;
  readonly default_page_limit: number;
  readonly max_page_limit: number;
}

export interface EndpointSessionOpenInput {
  readonly client_session_id: string;
  readonly protocol_version: string;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly availability: EndpointAvailability;
  readonly requested_lease_seconds?: number;
  readonly expected_registration_version: number;
}

export interface EndpointHeartbeatInput {
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly availability: EndpointAvailability;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly expected_registration_version: number;
}

export interface EndpointSessionCloseInput {
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly expected_registration_version: number;
}

export interface EndpointDiscoveryInput {
  readonly capability_id?: string;
  readonly version_constraint?: string;
  readonly required_input_media_types?: readonly string[];
  readonly required_output_media_types?: readonly string[];
  readonly availability?: readonly EndpointAvailability[];
  readonly cursor?: string;
  readonly limit?: number;
}

function identityCard(value: EndpointDescriptor): EndpointIdentityCard {
  return {
    endpoint_id: value.endpoint_id,
    actor: structuredClone(value.actor),
    endpoint_type: value.endpoint_type,
    display_name: value.display_name,
    protocol_versions: [...value.protocol_versions],
    availability: value.availability,
    lease: structuredClone(value.lease),
  };
}

function capabilitySummary(value: CapabilityDescriptor): CapabilitySummary {
  return {
    capability_id: value.capability_id,
    version: value.version,
    name: value.name,
    description: value.description,
  };
}

function pageWithItems<T>(
  page: EndpointDiscoveryPage,
  items: readonly T[],
): { readonly items: readonly T[]; readonly next_cursor?: string } {
  return {
    items,
    ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
  };
}

function publicRegistration(value: StoredEndpointRegistration): EndpointRegistration {
  const { tenant_id: _tenant, created_at: _created, updated_at: _updated, ...publicValue } = value;
  return publicValue;
}

function publicSession(value: StoredEndpointSession): EndpointSession {
  const { tenant_id: _tenant, request_digest: _digest, opened_at: _opened, updated_at: _updated, ...publicValue } = value;
  return publicValue;
}

function assertLimits(limits: EndpointDirectoryLimits): void {
  for (const [field, value] of Object.entries(limits)) assertPositiveInteger(value, field);
  if (limits.min_lease_seconds > limits.default_lease_seconds || limits.default_lease_seconds > limits.max_lease_seconds) {
    throw new TypeError("lease bounds must satisfy min <= default <= max");
  }
  if (limits.renew_ahead_seconds >= limits.min_lease_seconds) {
    throw new TypeError("renew_ahead_seconds must be less than min_lease_seconds");
  }
  if (limits.default_page_limit > limits.max_page_limit) {
    throw new TypeError("default_page_limit must not exceed max_page_limit");
  }
}

export class EndpointDirectoryService {
  constructor(private readonly dependencies: {
    readonly store: EndpointDirectoryStore;
    readonly clock: EndpointDirectoryClock;
    readonly ids: { sessionId(): string };
    readonly limits: EndpointDirectoryLimits;
  }) {
    assertLimits(dependencies.limits);
  }

  async provision(
    context: EndpointCallContext,
    input: EndpointRegistration,
    expectedVersion: number | null,
  ): Promise<EndpointRegistration> {
    this.assertContext(context);
    assertRegistration(input, this.dependencies.limits.max_bindings);
    const existing = await this.dependencies.store.getRegistration(context.tenant_id, input.endpoint_id);
    if (existing !== null && !sameActor(existing.actor, input.actor)) {
      throw new EndpointDirectoryError("immutable_binding", "Endpoint Actor binding is immutable");
    }
    if (
      existing !== null &&
      existing.registration_version === input.registration_version &&
      isDeepStrictEqual(publicRegistration(existing), input)
    ) {
      return publicRegistration(existing);
    }
    const now = this.dependencies.clock.now();
    try {
      return publicRegistration(await this.dependencies.store.putRegistration({
        expected_version: expectedVersion,
        registration: {
          ...structuredClone(input),
          tenant_id: context.tenant_id,
          created_at: existing?.created_at ?? now,
          updated_at: now,
        },
      }));
    } catch (error) {
      throw this.mapStoreError(error);
    }
  }

  async openSession(
    context: EndpointCallContext,
    endpointId: string,
    input: EndpointSessionOpenInput,
  ): Promise<EndpointSession> {
    const registration = await this.registrationForRuntime(context, endpointId);
    this.assertSessionDeclaration(registration, input.protocol_version, input.capabilities, input.expected_registration_version);
    assertOpaqueId(input.client_session_id, "client_session_id");
    const requested = input.requested_lease_seconds ?? this.dependencies.limits.default_lease_seconds;
    if (requested < this.dependencies.limits.min_lease_seconds || requested > this.dependencies.limits.max_lease_seconds) {
      throw new EndpointDirectoryError("invalid_request", "requested lease is outside configured bounds");
    }
    const digest = semanticDigest(input);
    const replay = await this.dependencies.store.getSessionByClientId(context.tenant_id, endpointId, input.client_session_id);
    if (replay !== null) {
      if (replay.request_digest !== digest) throw new EndpointDirectoryError("idempotency_conflict", "client_session_id was reused with different content");
      return publicSession(replay);
    }
    const openedAt = this.dependencies.clock.now();
    try {
      return publicSession(await this.dependencies.store.openSession({
        tenant_id: context.tenant_id,
        endpoint_id: endpointId,
        actor: registration.actor,
        session_id: this.dependencies.ids.sessionId(),
        client_session_id: input.client_session_id,
        protocol_version: input.protocol_version,
        capabilities: structuredClone(input.capabilities),
        availability: input.availability,
        accepted_lease_seconds: requested,
        expires_at: addUtcTimestampSeconds(openedAt, requested),
        renew_after: addUtcTimestampSeconds(openedAt, requested - this.dependencies.limits.renew_ahead_seconds),
        registration_version: registration.registration_version,
        request_digest: digest,
        opened_at: openedAt,
      }));
    } catch (error) {
      throw this.mapStoreError(error);
    }
  }

  async heartbeat(
    context: EndpointCallContext,
    endpointId: string,
    sessionId: string,
    input: EndpointHeartbeatInput,
  ): Promise<EndpointSession> {
    const registration = await this.registrationForRuntime(context, endpointId);
    this.assertSessionDeclaration(registration, undefined, input.capabilities, input.expected_registration_version);
    const current = await this.dependencies.store.getSession(context.tenant_id, endpointId, sessionId);
    if (current === null) throw new EndpointDirectoryError("not_found", "Endpoint session was not found");
    const digest = semanticDigest(input);
    if (input.heartbeat_sequence === current.heartbeat_sequence) {
      if (current.request_digest === digest) return publicSession(current);
      throw new EndpointDirectoryError("stale_sequence", "heartbeat sequence was reused with different content");
    }
    const updatedAt = this.dependencies.clock.now();
    try {
      return publicSession(await this.dependencies.store.heartbeat({
        tenant_id: context.tenant_id,
        endpoint_id: endpointId,
        session_id: sessionId,
        fencing_token: input.fencing_token,
        heartbeat_sequence: input.heartbeat_sequence,
        availability: input.availability,
        capabilities: structuredClone(input.capabilities),
        registration_version: input.expected_registration_version,
        request_digest: digest,
        expires_at: addUtcTimestampSeconds(updatedAt, current.accepted_lease_seconds),
        renew_after: addUtcTimestampSeconds(updatedAt, current.accepted_lease_seconds - this.dependencies.limits.renew_ahead_seconds),
        updated_at: updatedAt,
      }));
    } catch (error) {
      throw this.mapStoreError(error);
    }
  }

  async closeSession(
    context: EndpointCallContext,
    endpointId: string,
    sessionId: string,
    input: EndpointSessionCloseInput,
  ): Promise<EndpointSession> {
    await this.registrationForRuntime(context, endpointId);
    const digest = semanticDigest(input);
    const current = await this.dependencies.store.getSession(context.tenant_id, endpointId, sessionId);
    if (current?.state === "closed" && current.heartbeat_sequence === input.heartbeat_sequence && current.request_digest === digest) return publicSession(current);
    try {
      return publicSession(await this.dependencies.store.closeSession({
        tenant_id: context.tenant_id,
        endpoint_id: endpointId,
        session_id: sessionId,
        fencing_token: input.fencing_token,
        heartbeat_sequence: input.heartbeat_sequence,
        registration_version: input.expected_registration_version,
        request_digest: digest,
        closed_at: this.dependencies.clock.now(),
      }));
    } catch (error) {
      throw this.mapStoreError(error);
    }
  }

  async getEndpoint(context: EndpointCallContext, endpointId: string): Promise<EndpointDescriptor> {
    this.assertContext(context);
    const endpoint = await this.dependencies.store.getProjectedEndpoint(context.tenant_id, endpointId, this.dependencies.clock.now());
    if (endpoint === null) throw new EndpointDirectoryError("not_found", "Endpoint was not found");
    return endpoint;
  }

  discover(context: EndpointCallContext, input: EndpointDiscoveryInput = {}): Promise<EndpointDiscoveryPage> {
    this.assertContext(context);
    const limit = input.limit ?? this.dependencies.limits.default_page_limit;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > this.dependencies.limits.max_page_limit) {
      throw new EndpointDirectoryError("invalid_request", "discovery limit is outside configured bounds");
    }
    return this.dependencies.store.discover({ ...input, tenant_id: context.tenant_id, limit, now: this.dependencies.clock.now() });
  }

  async discoverIdentities(
    context: EndpointCallContext,
    input: EndpointDiscoveryInput = {},
  ): Promise<EndpointIdentityPage> {
    const page = await this.discover(context, input);
    return pageWithItems(page, page.items.map(identityCard));
  }

  async discoverCapabilityCards(
    context: EndpointCallContext,
    input: EndpointDiscoveryInput = {},
  ): Promise<EndpointCapabilityPage> {
    const page = await this.discover(context, input);
    const items: EndpointCapabilityCard[] = page.items.map((endpoint) => ({
      ...identityCard(endpoint),
      capabilities: endpoint.capabilities.map(capabilitySummary),
    }));
    return pageWithItems(page, items);
  }

  async getCapability(
    context: EndpointCallContext,
    endpointId: string,
    capabilityId: string,
  ): Promise<EndpointCapabilityContract> {
    assertOpaqueId(capabilityId, "capability_id");
    const endpoint = await this.getEndpoint(context, endpointId);
    const capability = endpoint.capabilities.find(
      (candidate) => candidate.capability_id === capabilityId,
    );
    if (capability === undefined) {
      throw new EndpointDirectoryError("not_found", "Endpoint Capability was not found");
    }
    return {
      endpoint_id: endpoint.endpoint_id,
      actor: structuredClone(endpoint.actor),
      availability: endpoint.availability,
      capability: structuredClone(capability),
    };
  }

  private assertSessionDeclaration(
    registration: StoredEndpointRegistration,
    protocolVersion: string | undefined,
    capabilities: readonly CapabilityDescriptor[],
    expectedVersion: number,
  ): void {
    if (registration.administrative_state !== "enabled") throw new EndpointDirectoryError("endpoint_disabled", "Endpoint is disabled");
    if (registration.registration_version !== expectedVersion) throw new EndpointDirectoryError("version_conflict", "registration version is stale");
    if (protocolVersion !== undefined && !registration.protocol_versions.includes(protocolVersion)) throw new EndpointDirectoryError("invalid_request", "protocol version is not provisioned");
    if (capabilities.length > this.dependencies.limits.max_capabilities) throw new EndpointDirectoryError("invalid_request", "capabilities exceed configured bound");
    const allowed = new Set(registration.allowed_capability_ids);
    const seen = new Set<string>();
    for (const capability of capabilities) {
      assertCapability(capability);
      if (!allowed.has(capability.capability_id)) throw new EndpointDirectoryError("invalid_request", "capability is not provisioned");
      if (seen.has(capability.capability_id)) throw new EndpointDirectoryError("invalid_request", "capability IDs must be unique");
      seen.add(capability.capability_id);
    }
  }

  private async registrationForRuntime(context: EndpointCallContext, endpointId: string): Promise<StoredEndpointRegistration> {
    this.assertContext(context);
    assertOpaqueId(endpointId, "endpoint_id");
    const registration = await this.dependencies.store.getRegistration(context.tenant_id, endpointId);
    if (registration === null) throw new EndpointDirectoryError("not_found", "Endpoint was not found");
    if (context.represented_endpoint_id !== endpointId || context.represented_actor === undefined || !sameActor(context.represented_actor, registration.actor)) {
      throw new EndpointDirectoryError("representation_denied", "Runtime cannot represent this Endpoint");
    }
    return registration;
  }

  private assertContext(context: EndpointCallContext): void {
    assertOpaqueId(context.tenant_id, "tenant_id");
    assertOpaqueId(context.principal_id, "principal_id");
  }

  private mapStoreError(error: unknown): Error {
    if (error instanceof EndpointStoreError) return new EndpointDirectoryError(mapStoreErrorCode(error.code), error.message);
    return new EndpointDirectoryError("unavailable", "Endpoint Directory is unavailable");
  }
}
