import { isDeepStrictEqual } from "node:util";

import {
  ENDPOINT_DIRECTORY_REQUIRED_CAPABILITIES,
  EndpointStoreError,
  assertCapabilities,
  compareUtcTimestamps,
  matchesSemanticVersion,
  type CapabilityManifest,
  type EndpointDescriptor,
  type EndpointDirectoryStore,
  type EndpointDiscoveryPage,
  type EndpointDiscoveryQuery,
  type HeartbeatEndpointSession,
  type CloseEndpointSession,
  type OpenEndpointSession,
  type PutEndpointRegistration,
  type StoredEndpointRegistration,
  type StoredEndpointSession,
} from "@work-fabric/exchange-spi";

const manifest: CapabilityManifest = {
  profile: "exchange.endpoint-directory.v1",
  adapter: "memory",
  capabilities: Object.fromEntries(
    ENDPOINT_DIRECTORY_REQUIRED_CAPABILITIES.map((capability) => [capability, true]),
  ),
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function key(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cursorSignature(query: EndpointDiscoveryQuery): unknown {
  const {
    cursor: _cursor,
    now: _now,
    limit: _limit,
    ...signature
  } = query;
  return signature;
}

function encodeCursor(query: EndpointDiscoveryQuery, endpointId: string): string {
  const signature = cursorSignature(query);
  return Buffer.from(JSON.stringify({ signature, endpoint_id: endpointId })).toString("base64url");
}

function decodeCursor(query: EndpointDiscoveryQuery): string | null {
  if (query.cursor === undefined) return null;
  try {
    const decoded = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as { signature: unknown; endpoint_id: string };
    const signature = cursorSignature(query);
    if (!isDeepStrictEqual(decoded.signature, signature) || typeof decoded.endpoint_id !== "string") throw new Error();
    return decoded.endpoint_id;
  } catch {
    throw new TypeError("invalid cursor");
  }
}

export class MemoryEndpointDirectoryStore implements EndpointDirectoryStore {
  private readonly registrations = new Map<string, StoredEndpointRegistration>();
  private readonly sessions = new Map<string, StoredEndpointSession>();
  private readonly clientSessions = new Map<string, string>();
  private readonly activeSessions = new Map<string, string>();
  private readonly fencingTokens = new Map<string, number>();
  private mutationTail: Promise<void> = Promise.resolve();

  get manifest(): CapabilityManifest {
    const value = clone(manifest);
    assertCapabilities(value, ENDPOINT_DIRECTORY_REQUIRED_CAPABILITIES);
    return value;
  }

  private async atomic<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async putRegistration(input: PutEndpointRegistration): Promise<StoredEndpointRegistration> {
    return this.atomic(() => {
      const candidate = clone(input.registration);
      const compound = key(candidate.tenant_id, candidate.endpoint_id);
      const existing = this.registrations.get(compound);
      if (existing === undefined) {
        if (input.expected_version !== null || candidate.registration_version !== 1) throw new EndpointStoreError("registration_version_conflict", "new registration must start at version 1");
      } else {
        if (input.expected_version !== existing.registration_version || candidate.registration_version !== existing.registration_version + 1) throw new EndpointStoreError("registration_version_conflict", "registration version is stale");
        if (!isDeepStrictEqual(existing.actor, candidate.actor)) throw new EndpointStoreError("immutable_binding", "Endpoint Actor binding is immutable");
      }
      this.registrations.set(compound, candidate);
      return clone(candidate);
    });
  }

  async getRegistration(tenantId: string, endpointId: string): Promise<StoredEndpointRegistration | null> {
    const value = this.registrations.get(key(tenantId, endpointId));
    return value === undefined ? null : clone(value);
  }

  async openSession(input: OpenEndpointSession): Promise<StoredEndpointSession> {
    return this.atomic(() => {
      const endpointKey = key(input.tenant_id, input.endpoint_id);
      const clientKey = key(input.tenant_id, input.endpoint_id, input.client_session_id);
      const existingId = this.clientSessions.get(clientKey);
      if (existingId !== undefined) {
        const existing = this.sessions.get(key(input.tenant_id, input.endpoint_id, existingId))!;
        if (existing.request_digest !== input.request_digest) throw new EndpointStoreError("idempotency_conflict", "client_session_id was reused with different content");
        return clone(existing);
      }
      const activeId = this.activeSessions.get(endpointKey);
      if (activeId !== undefined) {
        const activeKey = key(input.tenant_id, input.endpoint_id, activeId);
        const active = this.sessions.get(activeKey)!;
        this.sessions.set(activeKey, { ...active, state: "fenced", updated_at: input.opened_at });
      }
      const fencing = (this.fencingTokens.get(endpointKey) ?? 0) + 1;
      const session: StoredEndpointSession = {
        ...clone(input),
        fencing_token: fencing,
        heartbeat_sequence: 0,
        state: "active",
        updated_at: input.opened_at,
      };
      this.sessions.set(key(input.tenant_id, input.endpoint_id, input.session_id), session);
      this.clientSessions.set(clientKey, input.session_id);
      this.activeSessions.set(endpointKey, input.session_id);
      this.fencingTokens.set(endpointKey, fencing);
      return clone(session);
    });
  }

  async heartbeat(input: HeartbeatEndpointSession): Promise<StoredEndpointSession> {
    return this.atomic(() => {
      const sessionKey = key(input.tenant_id, input.endpoint_id, input.session_id);
      const current = this.sessions.get(sessionKey);
      if (current === undefined) throw new EndpointStoreError("session_not_found", "Endpoint session was not found");
      if (current.state !== "active" || current.fencing_token !== input.fencing_token || this.activeSessions.get(key(input.tenant_id, input.endpoint_id)) !== input.session_id) throw new EndpointStoreError("session_fenced", "Endpoint session is fenced");
      if (input.registration_version !== current.registration_version) throw new EndpointStoreError("registration_version_conflict", "registration version is stale");
      if (input.heartbeat_sequence <= current.heartbeat_sequence) throw new EndpointStoreError("stale_sequence", "heartbeat sequence is stale");
      const updated: StoredEndpointSession = { ...current, capabilities: clone(input.capabilities), availability: input.availability, heartbeat_sequence: input.heartbeat_sequence, request_digest: input.request_digest, expires_at: input.expires_at, renew_after: input.renew_after, updated_at: input.updated_at };
      this.sessions.set(sessionKey, updated);
      return clone(updated);
    });
  }

  async closeSession(input: CloseEndpointSession): Promise<StoredEndpointSession> {
    return this.atomic(() => {
      const sessionKey = key(input.tenant_id, input.endpoint_id, input.session_id);
      const current = this.sessions.get(sessionKey);
      if (current === undefined) throw new EndpointStoreError("session_not_found", "Endpoint session was not found");
      if (current.state !== "active" || current.fencing_token !== input.fencing_token || this.activeSessions.get(key(input.tenant_id, input.endpoint_id)) !== input.session_id) throw new EndpointStoreError("session_fenced", "Endpoint session is fenced");
      if (input.registration_version !== current.registration_version) throw new EndpointStoreError("registration_version_conflict", "registration version is stale");
      if (input.heartbeat_sequence <= current.heartbeat_sequence) throw new EndpointStoreError("stale_sequence", "close sequence is stale");
      const closed: StoredEndpointSession = { ...current, availability: "unavailable", state: "closed", heartbeat_sequence: input.heartbeat_sequence, request_digest: input.request_digest, updated_at: input.closed_at };
      this.sessions.set(sessionKey, closed);
      this.activeSessions.delete(key(input.tenant_id, input.endpoint_id));
      return clone(closed);
    });
  }

  async getSessionByClientId(tenantId: string, endpointId: string, clientSessionId: string): Promise<StoredEndpointSession | null> {
    const sessionId = this.clientSessions.get(key(tenantId, endpointId, clientSessionId));
    return sessionId === undefined ? null : this.getSession(tenantId, endpointId, sessionId);
  }

  async getSession(tenantId: string, endpointId: string, sessionId: string): Promise<StoredEndpointSession | null> {
    const value = this.sessions.get(key(tenantId, endpointId, sessionId));
    return value === undefined ? null : clone(value);
  }

  async getProjectedEndpoint(tenantId: string, endpointId: string, now: string): Promise<EndpointDescriptor | null> {
    const registration = this.registrations.get(key(tenantId, endpointId));
    if (registration === undefined) return null;
    const activeId = this.activeSessions.get(key(tenantId, endpointId));
    const session = activeId === undefined ? undefined : this.sessions.get(key(tenantId, endpointId, activeId));
    const active = registration.administrative_state === "enabled" && session?.state === "active" && compareUtcTimestamps(session.expires_at, now) > 0;
    return clone({
      endpoint_id: registration.endpoint_id,
      actor: registration.actor,
      endpoint_type: registration.endpoint_type,
      display_name: registration.display_name,
      protocol_versions: registration.protocol_versions,
      bindings: registration.bindings,
      capabilities: session?.capabilities ?? [],
      availability: active ? session!.availability : "unavailable",
      lease: { expires_at: session?.expires_at ?? registration.updated_at, renew_after: session?.renew_after ?? registration.updated_at },
      limits: registration.limits,
      ...(registration.extensions === undefined ? {} : { extensions: registration.extensions }),
    });
  }

  async discover(input: EndpointDiscoveryQuery): Promise<EndpointDiscoveryPage> {
    const after = decodeCursor(input);
    const projected: EndpointDescriptor[] = [];
    for (const registration of this.registrations.values()) {
      if (registration.tenant_id !== input.tenant_id || registration.administrative_state !== "enabled") continue;
      if (after !== null && compare(registration.endpoint_id, after) <= 0) continue;
      const endpoint = await this.getProjectedEndpoint(input.tenant_id, registration.endpoint_id, input.now);
      if (endpoint === null || endpoint.availability === "unavailable") continue;
      if (input.availability !== undefined && !input.availability.includes(endpoint.availability)) continue;
      const capabilities = endpoint.capabilities.filter((capability) => {
        if (input.capability_id !== undefined && capability.capability_id !== input.capability_id) return false;
        if (!matchesSemanticVersion(capability.version, input.version_constraint)) return false;
        if (input.required_input_media_types?.some((item) => !capability.input_media_types.includes(item))) return false;
        if (input.required_output_media_types?.some((item) => !capability.output_media_types.includes(item))) return false;
        return true;
      });
      if (input.capability_id !== undefined && capabilities.length === 0) continue;
      projected.push(endpoint);
    }
    projected.sort((left, right) => compare(left.endpoint_id, right.endpoint_id));
    const page = projected.slice(0, input.limit);
    const hasMore = projected.length > input.limit;
    return { items: clone(page), ...(hasMore ? { next_cursor: encodeCursor(input, page.at(-1)!.endpoint_id) } : {}) };
  }

  async listActorEndpoints(tenantId: string, actorId: string, now: string): Promise<readonly EndpointDescriptor[]> {
    const values: EndpointDescriptor[] = [];
    for (const registration of this.registrations.values()) {
      if (registration.tenant_id !== tenantId || registration.actor.actor_id !== actorId) continue;
      const projected = await this.getProjectedEndpoint(tenantId, registration.endpoint_id, now);
      if (projected !== null && projected.availability !== "unavailable") values.push(projected);
    }
    return clone(values.sort((left, right) => compare(left.endpoint_id, right.endpoint_id)));
  }
}
