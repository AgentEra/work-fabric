import { isDeepStrictEqual } from "node:util";

import {
  CitizenStoreError,
  type CitizenDiscoveryPage,
  type CitizenDiscoveryQuery,
  type CitizenSchemaDigestBinding,
  type CitizenStoreManifest,
  type CloseCitizenSession,
  type HeartbeatCitizenSession,
  type NetworkCitizenStore,
  type OpenCitizenSession,
  type ProjectedCitizen,
  type PutCitizenProvisioning,
  type ReplaceCitizenDeclarations,
  type StoredCitizenProvisioning,
  type StoredCitizenSession,
} from "@work-fabric/network-citizen-spi";

const manifest: CitizenStoreManifest = {
  profile: "network-citizen.store.v1",
  adapter: "memory",
  capabilities: {
    tenant_isolation: true,
    optimistic_registration: true,
    idempotent_session_open: true,
    monotonic_fencing: true,
    declaration_cas: true,
    deterministic_pagination: true,
  },
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

function cursorSignature(
  query: CitizenDiscoveryQuery,
): Omit<CitizenDiscoveryQuery, "cursor" | "now" | "limit"> {
  const {
    cursor: _cursor,
    now: _now,
    limit: _limit,
    ...signature
  } = query;
  return signature;
}

function encodeCursor(query: CitizenDiscoveryQuery, citizenId: string): string {
  return Buffer.from(
    JSON.stringify({
      signature: cursorSignature(query),
      citizen_id: citizenId,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(query: CitizenDiscoveryQuery): string | null {
  if (query.cursor === undefined) return null;
  try {
    const value = JSON.parse(
      Buffer.from(query.cursor, "base64url").toString("utf8"),
    ) as { signature: unknown; citizen_id: unknown };
    if (
      typeof value.citizen_id !== "string" ||
      !isDeepStrictEqual(value.signature, cursorSignature(query))
    ) {
      throw new Error("cursor mismatch");
    }
    return value.citizen_id;
  } catch {
    throw new TypeError("invalid cursor");
  }
}

function immutableProvisioningBinding(
  left: StoredCitizenProvisioning,
  right: PutCitizenProvisioning["provisioning"],
): boolean {
  return (
    left.citizen_kind === right.citizen_kind &&
    left.principal_id === right.principal_id &&
    isDeepStrictEqual(left.allowed_actor, right.allowed_actor) &&
    left.allowed_endpoint_id === right.allowed_endpoint_id
  );
}

export class MemoryNetworkCitizenStore implements NetworkCitizenStore {
  private readonly provisioning = new Map<string, StoredCitizenProvisioning>();
  private readonly sessions = new Map<string, StoredCitizenSession>();
  private readonly clientSessions = new Map<string, string>();
  private readonly activeSessions = new Map<string, string>();
  private readonly fencingTokens = new Map<string, number>();
  private readonly schemaDigests = new Map<string, `sha256:${string}`>();
  private mutationTail: Promise<void> = Promise.resolve();

  get manifest(): CitizenStoreManifest {
    return clone(manifest);
  }

  private async atomic<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async putProvisioning(
    input: PutCitizenProvisioning,
  ): Promise<StoredCitizenProvisioning> {
    return this.atomic(() => {
      const compound = key(input.tenant_id, input.provisioning.citizen_id);
      const existing = this.provisioning.get(compound);
      if (existing === undefined) {
        if (
          input.expected_registration_version !== null ||
          input.provisioning.registration_version !== 1
        ) {
          throw new CitizenStoreError(
            "registration_version_conflict",
            "new Citizen provisioning must start at version 1",
          );
        }
      } else {
        if (!immutableProvisioningBinding(existing, input.provisioning)) {
          throw new CitizenStoreError(
            "immutable_binding",
            "Citizen kind and identity binding are immutable",
          );
        }
        if (
          input.expected_registration_version !== existing.registration_version ||
          input.provisioning.registration_version !==
            existing.registration_version + 1
        ) {
          throw new CitizenStoreError(
            "registration_version_conflict",
            "Citizen registration version is stale",
          );
        }
      }
      const stored: StoredCitizenProvisioning = {
        ...clone(input.provisioning),
        tenant_id: input.tenant_id,
        created_at: existing?.created_at ?? input.recorded_at,
        updated_at: input.recorded_at,
      };
      this.provisioning.set(compound, stored);
      return clone(stored);
    });
  }

  async getProvisioning(
    tenantId: string,
    citizenId: string,
  ): Promise<StoredCitizenProvisioning | null> {
    const value = this.provisioning.get(key(tenantId, citizenId));
    return value === undefined ? null : clone(value);
  }

  async openSession(input: OpenCitizenSession): Promise<StoredCitizenSession> {
    return this.atomic(() => {
      const registration = this.provisioning.get(
        key(input.tenant_id, input.citizen_id),
      );
      if (
        registration === undefined ||
        registration.registration_version !== input.registration_version
      ) {
        throw new CitizenStoreError(
          "registration_version_conflict",
          "Citizen registration version is stale",
        );
      }
      const clientKey = key(
        input.tenant_id,
        input.citizen_id,
        input.client_session_id,
      );
      const existingSessionId = this.clientSessions.get(clientKey);
      if (existingSessionId !== undefined) {
        const existing = this.sessions.get(
          key(input.tenant_id, input.citizen_id, existingSessionId),
        )!;
        if (existing.request_digest !== input.request_digest) {
          throw new CitizenStoreError(
            "idempotency_conflict",
            "client_session_id was reused with different content",
          );
        }
        return clone(existing);
      }
      const citizenKey = key(input.tenant_id, input.citizen_id);
      const activeId = this.activeSessions.get(citizenKey);
      if (activeId !== undefined) {
        const activeKey = key(input.tenant_id, input.citizen_id, activeId);
        const active = this.sessions.get(activeKey)!;
        this.sessions.set(activeKey, {
          ...active,
          state: "fenced",
          updated_at: input.opened_at,
        });
      }
      const fencingToken = (this.fencingTokens.get(citizenKey) ?? 0) + 1;
      const session: StoredCitizenSession = {
        ...clone(input),
        descriptor: {
          ...clone(input.descriptor),
          declarations: {
            count: input.declarations.length,
            digest: input.descriptor.declarations.digest,
          },
        },
        declaration_version: 1,
        declaration_digest: input.descriptor.declarations.digest,
        fencing_token: fencingToken,
        heartbeat_sequence: 0,
        state: "active",
        updated_at: input.opened_at,
      };
      this.sessions.set(
        key(input.tenant_id, input.citizen_id, input.session_id),
        session,
      );
      this.clientSessions.set(clientKey, input.session_id);
      this.activeSessions.set(citizenKey, input.session_id);
      this.fencingTokens.set(citizenKey, fencingToken);
      return clone(session);
    });
  }

  async heartbeat(
    input: HeartbeatCitizenSession,
  ): Promise<StoredCitizenSession> {
    return this.atomic(() => {
      const current = this.requireActiveSession(input);
      if (input.heartbeat_sequence === current.heartbeat_sequence) {
        if (input.request_digest === current.request_digest) return clone(current);
        throw new CitizenStoreError(
          "stale_sequence",
          "heartbeat sequence was reused with different content",
        );
      }
      if (input.heartbeat_sequence <= current.heartbeat_sequence) {
        throw new CitizenStoreError(
          "stale_sequence",
          "heartbeat sequence is stale",
        );
      }
      const updated: StoredCitizenSession = {
        ...current,
        descriptor: {
          ...current.descriptor,
          availability: input.availability,
        },
        heartbeat_sequence: input.heartbeat_sequence,
        request_digest: input.request_digest,
        expires_at: input.expires_at,
        renew_after: input.renew_after,
        updated_at: input.updated_at,
      };
      this.sessions.set(
        key(input.tenant_id, input.citizen_id, input.session_id),
        updated,
      );
      return clone(updated);
    });
  }

  async replaceDeclarations(
    input: ReplaceCitizenDeclarations,
  ): Promise<StoredCitizenSession> {
    return this.atomic(() => {
      const current = this.requireActiveSession(input);
      if (current.registration_version !== input.registration_version) {
        throw new CitizenStoreError(
          "registration_version_conflict",
          "Citizen registration version is stale",
        );
      }
      if (
        current.declaration_version === input.expected_declaration_version + 1 &&
        current.request_digest === input.request_digest
      ) {
        return clone(current);
      }
      if (current.declaration_version !== input.expected_declaration_version) {
        throw new CitizenStoreError(
          "declaration_version_conflict",
          "Citizen declaration version is stale",
        );
      }
      const updated: StoredCitizenSession = {
        ...current,
        descriptor: {
          ...current.descriptor,
          declarations: {
            count: input.declarations.length,
            digest: input.declaration_digest,
          },
        },
        declarations: clone(input.declarations),
        declaration_version: current.declaration_version + 1,
        declaration_digest: input.declaration_digest,
        request_digest: input.request_digest,
        updated_at: input.updated_at,
      };
      this.sessions.set(
        key(input.tenant_id, input.citizen_id, input.session_id),
        updated,
      );
      return clone(updated);
    });
  }

  async closeSession(
    input: CloseCitizenSession,
  ): Promise<StoredCitizenSession> {
    return this.atomic(() => {
      const sessionKey = key(
        input.tenant_id,
        input.citizen_id,
        input.session_id,
      );
      const existing = this.sessions.get(sessionKey);
      if (
        existing?.state === "closed" &&
        existing.heartbeat_sequence === input.heartbeat_sequence &&
        existing.request_digest === input.request_digest
      ) {
        return clone(existing);
      }
      const current = this.requireActiveSession(input);
      if (current.registration_version !== input.registration_version) {
        throw new CitizenStoreError(
          "registration_version_conflict",
          "Citizen registration version is stale",
        );
      }
      if (input.heartbeat_sequence <= current.heartbeat_sequence) {
        throw new CitizenStoreError(
          "stale_sequence",
          "close sequence is stale",
        );
      }
      const closed: StoredCitizenSession = {
        ...current,
        descriptor: {
          ...current.descriptor,
          availability: "unavailable",
        },
        state: "closed",
        heartbeat_sequence: input.heartbeat_sequence,
        request_digest: input.request_digest,
        updated_at: input.closed_at,
      };
      this.sessions.set(sessionKey, closed);
      this.activeSessions.delete(key(input.tenant_id, input.citizen_id));
      return clone(closed);
    });
  }

  async getSession(
    tenantId: string,
    citizenId: string,
    sessionId: string,
  ): Promise<StoredCitizenSession | null> {
    const value = this.sessions.get(key(tenantId, citizenId, sessionId));
    return value === undefined ? null : clone(value);
  }

  async getSessionByClientId(
    tenantId: string,
    citizenId: string,
    clientSessionId: string,
  ): Promise<StoredCitizenSession | null> {
    const sessionId = this.clientSessions.get(
      key(tenantId, citizenId, clientSessionId),
    );
    return sessionId === undefined
      ? null
      : this.getSession(tenantId, citizenId, sessionId);
  }

  async bindSchemaDigests(
    tenantId: string,
    bindings: readonly CitizenSchemaDigestBinding[],
  ): Promise<void> {
    await this.atomic(() => {
      for (const binding of bindings) {
        const existing = this.schemaDigests.get(key(tenantId, binding.uri));
        if (existing !== undefined && existing !== binding.digest) {
          throw new CitizenStoreError(
            "schema_digest_conflict",
            "Schema URI is already bound to a different digest",
          );
        }
      }
      for (const binding of bindings) {
        this.schemaDigests.set(key(tenantId, binding.uri), binding.digest);
      }
    });
  }

  async getProjectedCitizen(
    tenantId: string,
    citizenId: string,
    now: string,
  ): Promise<ProjectedCitizen | null> {
    const registration = this.provisioning.get(key(tenantId, citizenId));
    if (registration === undefined) return null;
    const activeId = this.activeSessions.get(key(tenantId, citizenId));
    const session = activeId === undefined
      ? this.latestSession(tenantId, citizenId)
      : this.sessions.get(key(tenantId, citizenId, activeId));
    if (session === undefined) return null;
    const active =
      registration.administrative_state === "enabled" &&
      session.state === "active" &&
      compare(session.expires_at, now) > 0;
    return clone({
      descriptor: {
        ...session.descriptor,
        availability: active
          ? session.descriptor.availability
          : "unavailable",
      },
      declarations: active ? session.declarations : [],
      lease: {
        session_id: session.session_id,
        fencing_token: session.fencing_token,
        declaration_version: session.declaration_version,
        expires_at: session.expires_at,
        renew_after: session.renew_after,
      },
    });
  }

  async discover(
    input: CitizenDiscoveryQuery,
  ): Promise<CitizenDiscoveryPage> {
    const after = decodeCursor(input);
    const items: ProjectedCitizen[] = [];
    for (const registration of this.provisioning.values()) {
      if (
        registration.tenant_id !== input.tenant_id ||
        registration.administrative_state !== "enabled" ||
        (after !== null && compare(registration.citizen_id, after) <= 0)
      ) {
        continue;
      }
      const projected = await this.getProjectedCitizen(
        input.tenant_id,
        registration.citizen_id,
        input.now,
      );
      if (
        projected === null ||
        projected.descriptor.availability === "unavailable"
      ) {
        continue;
      }
      if (
        input.citizen_kind !== undefined &&
        projected.descriptor.citizen_kind !== input.citizen_kind
      ) {
        continue;
      }
      if (
        input.availability !== undefined &&
        !input.availability.includes(projected.descriptor.availability)
      ) {
        continue;
      }
      if (
        input.executable_only === true &&
        !["available", "degraded"].includes(projected.descriptor.availability)
      ) {
        continue;
      }
      if (
        input.declaration_id !== undefined &&
        !projected.declarations.some(
          (item) => item.declaration_id === input.declaration_id,
        )
      ) {
        continue;
      }
      items.push(projected);
    }
    items.sort((left, right) =>
      compare(left.descriptor.citizen_id, right.descriptor.citizen_id),
    );
    const page = items.slice(0, input.limit);
    return {
      items: clone(page),
      ...(items.length > input.limit
        ? {
            next_cursor: encodeCursor(
              input,
              page.at(-1)!.descriptor.citizen_id,
            ),
          }
        : {}),
    };
  }

  private requireActiveSession(input: {
    readonly tenant_id: string;
    readonly citizen_id: string;
    readonly session_id: string;
    readonly fencing_token: number;
  }): StoredCitizenSession {
    const session = this.sessions.get(
      key(input.tenant_id, input.citizen_id, input.session_id),
    );
    if (session === undefined) {
      throw new CitizenStoreError(
        "session_not_found",
        "Citizen session was not found",
      );
    }
    if (
      session.state !== "active" ||
      session.fencing_token !== input.fencing_token ||
      this.activeSessions.get(key(input.tenant_id, input.citizen_id)) !==
        input.session_id
    ) {
      throw new CitizenStoreError(
        "session_fenced",
        "Citizen session is fenced",
      );
    }
    return session;
  }

  private latestSession(
    tenantId: string,
    citizenId: string,
  ): StoredCitizenSession | undefined {
    let latest: StoredCitizenSession | undefined;
    for (const session of this.sessions.values()) {
      if (
        session.tenant_id !== tenantId ||
        session.citizen_id !== citizenId
      ) {
        continue;
      }
      if (latest === undefined || compare(latest.updated_at, session.updated_at) < 0) {
        latest = session;
      }
    }
    return latest;
  }
}
