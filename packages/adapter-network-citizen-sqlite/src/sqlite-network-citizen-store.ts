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

import { migrateNetworkCitizenSqlite } from "./migrations.js";
import {
  NetworkCitizenSqliteSession,
  type SqliteNetworkCitizenStoreOptions,
} from "./sqlite-session.js";

const manifest: CitizenStoreManifest = {
  profile: "network-citizen.store.v1",
  adapter: "sqlite",
  capabilities: {
    tenant_isolation: true,
    optimistic_registration: true,
    idempotent_session_open: true,
    monotonic_fencing: true,
    declaration_cas: true,
    deterministic_pagination: true,
  },
};

interface ProvisioningRow {
  readonly registration_json: string;
}

interface SessionRow {
  readonly session_json: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseProvisioning(row: ProvisioningRow): StoredCitizenProvisioning {
  return JSON.parse(row.registration_json) as StoredCitizenProvisioning;
}

function parseSession(row: SessionRow): StoredCitizenSession {
  return JSON.parse(row.session_json) as StoredCitizenSession;
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

export class SqliteNetworkCitizenStore implements NetworkCitizenStore {
  private readonly session: NetworkCitizenSqliteSession;
  private closed = false;

  constructor(options: SqliteNetworkCitizenStoreOptions) {
    this.session = new NetworkCitizenSqliteSession(options);
    migrateNetworkCitizenSqlite(this.session);
  }

  get manifest(): CitizenStoreManifest {
    return clone(manifest);
  }

  async putProvisioning(
    input: PutCitizenProvisioning,
  ): Promise<StoredCitizenProvisioning> {
    return this.write(() => {
      const existing = this.getProvisioningRow(
        input.tenant_id,
        input.provisioning.citizen_id,
      );
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
        const stored = parseProvisioning(existing);
        if (!immutableProvisioningBinding(stored, input.provisioning)) {
          throw new CitizenStoreError(
            "immutable_binding",
            "Citizen kind and identity binding are immutable",
          );
        }
        if (
          input.expected_registration_version !== stored.registration_version ||
          input.provisioning.registration_version !==
            stored.registration_version + 1
        ) {
          throw new CitizenStoreError(
            "registration_version_conflict",
            "Citizen registration version is stale",
          );
        }
      }
      const previous = existing === undefined ? undefined : parseProvisioning(existing);
      const stored: StoredCitizenProvisioning = {
        ...clone(input.provisioning),
        tenant_id: input.tenant_id,
        created_at: previous?.created_at ?? input.recorded_at,
        updated_at: input.recorded_at,
      };
      this.session
        .prepare(`
          INSERT INTO network_citizen_provisioning (
            tenant_id, citizen_id, citizen_kind, principal_id,
            administrative_state, registration_version, registration_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, citizen_id) DO UPDATE SET
            administrative_state = excluded.administrative_state,
            registration_version = excluded.registration_version,
            registration_json = excluded.registration_json,
            updated_at = excluded.updated_at
        `)
        .run(
          stored.tenant_id,
          stored.citizen_id,
          stored.citizen_kind,
          stored.principal_id,
          stored.administrative_state,
          stored.registration_version,
          JSON.stringify(stored),
          stored.created_at,
          stored.updated_at,
        );
      return clone(stored);
    });
  }

  async getProvisioning(
    tenantId: string,
    citizenId: string,
  ): Promise<StoredCitizenProvisioning | null> {
    return this.read(() => {
      const row = this.getProvisioningRow(tenantId, citizenId);
      return row === undefined ? null : clone(parseProvisioning(row));
    });
  }

  async openSession(input: OpenCitizenSession): Promise<StoredCitizenSession> {
    return this.write(() => {
      const registrationRow = this.getProvisioningRow(
        input.tenant_id,
        input.citizen_id,
      );
      if (
        registrationRow === undefined ||
        parseProvisioning(registrationRow).registration_version !==
          input.registration_version
      ) {
        throw new CitizenStoreError(
          "registration_version_conflict",
          "Citizen registration version is stale",
        );
      }
      const replayRow = this.session
        .prepare(
          "SELECT session_json FROM network_citizen_sessions WHERE tenant_id = ? AND citizen_id = ? AND client_session_id = ?",
        )
        .get(
          input.tenant_id,
          input.citizen_id,
          input.client_session_id,
        ) as SessionRow | undefined;
      if (replayRow !== undefined) {
        const replay = parseSession(replayRow);
        if (replay.request_digest !== input.request_digest) {
          throw new CitizenStoreError(
            "idempotency_conflict",
            "client_session_id was reused with different content",
          );
        }
        return clone(replay);
      }
      const activeRow = this.session
        .prepare(
          "SELECT session_id, fencing_token FROM network_citizen_active_sessions WHERE tenant_id = ? AND citizen_id = ?",
        )
        .get(input.tenant_id, input.citizen_id) as
        | { session_id: string; fencing_token: number }
        | undefined;
      if (activeRow !== undefined) {
        const previousRow = this.getSessionRow(
          input.tenant_id,
          input.citizen_id,
          activeRow.session_id,
        )!;
        const previous = {
          ...parseSession(previousRow),
          state: "fenced" as const,
          updated_at: input.opened_at,
        };
        this.updateSession(previous);
      }
      const fencingToken = (activeRow?.fencing_token ?? this.maximumFencing(
        input.tenant_id,
        input.citizen_id,
      )) + 1;
      const stored: StoredCitizenSession = {
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
      this.insertSession(stored);
      this.session
        .prepare(`
          INSERT INTO network_citizen_active_sessions
            (tenant_id, citizen_id, session_id, fencing_token)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (tenant_id, citizen_id) DO UPDATE SET
            session_id = excluded.session_id,
            fencing_token = excluded.fencing_token
        `)
        .run(
          input.tenant_id,
          input.citizen_id,
          input.session_id,
          fencingToken,
        );
      return clone(stored);
    });
  }

  async heartbeat(
    input: HeartbeatCitizenSession,
  ): Promise<StoredCitizenSession> {
    return this.write(() => {
      const current = this.requireActive(input);
      if (input.heartbeat_sequence === current.heartbeat_sequence) {
        if (input.request_digest === current.request_digest) return clone(current);
        throw new CitizenStoreError(
          "stale_sequence",
          "heartbeat sequence was reused with different content",
        );
      }
      if (input.heartbeat_sequence <= current.heartbeat_sequence) {
        throw new CitizenStoreError("stale_sequence", "heartbeat sequence is stale");
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
      this.updateSession(updated);
      return clone(updated);
    });
  }

  async replaceDeclarations(
    input: ReplaceCitizenDeclarations,
  ): Promise<StoredCitizenSession> {
    return this.write(() => {
      const current = this.requireActive(input);
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
      this.updateSession(updated);
      return clone(updated);
    });
  }

  async closeSession(
    input: CloseCitizenSession,
  ): Promise<StoredCitizenSession> {
    return this.write(() => {
      const row = this.getSessionRow(
        input.tenant_id,
        input.citizen_id,
        input.session_id,
      );
      const existing = row === undefined ? undefined : parseSession(row);
      if (
        existing?.state === "closed" &&
        existing.heartbeat_sequence === input.heartbeat_sequence &&
        existing.request_digest === input.request_digest
      ) {
        return clone(existing);
      }
      const current = this.requireActive(input);
      if (current.registration_version !== input.registration_version) {
        throw new CitizenStoreError(
          "registration_version_conflict",
          "Citizen registration version is stale",
        );
      }
      if (input.heartbeat_sequence <= current.heartbeat_sequence) {
        throw new CitizenStoreError("stale_sequence", "close sequence is stale");
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
      this.updateSession(closed);
      this.session
        .prepare(
          "DELETE FROM network_citizen_active_sessions WHERE tenant_id = ? AND citizen_id = ? AND session_id = ?",
        )
        .run(input.tenant_id, input.citizen_id, input.session_id);
      return clone(closed);
    });
  }

  async getSession(
    tenantId: string,
    citizenId: string,
    sessionId: string,
  ): Promise<StoredCitizenSession | null> {
    return this.read(() => {
      const row = this.getSessionRow(tenantId, citizenId, sessionId);
      return row === undefined ? null : clone(parseSession(row));
    });
  }

  async getSessionByClientId(
    tenantId: string,
    citizenId: string,
    clientSessionId: string,
  ): Promise<StoredCitizenSession | null> {
    return this.read(() => {
      const row = this.session
        .prepare(
          "SELECT session_json FROM network_citizen_sessions WHERE tenant_id = ? AND citizen_id = ? AND client_session_id = ?",
        )
        .get(tenantId, citizenId, clientSessionId) as SessionRow | undefined;
      return row === undefined ? null : clone(parseSession(row));
    });
  }

  async bindSchemaDigests(
    tenantId: string,
    bindings: readonly CitizenSchemaDigestBinding[],
  ): Promise<void> {
    this.write(() => {
      for (const binding of bindings) {
        const existing = this.session
          .prepare(
            "SELECT schema_digest FROM network_citizen_schema_digests WHERE tenant_id = ? AND schema_uri = ?",
          )
          .get(tenantId, binding.uri) as
          | { schema_digest: string }
          | undefined;
        if (
          existing !== undefined &&
          existing.schema_digest !== binding.digest
        ) {
          throw new CitizenStoreError(
            "schema_digest_conflict",
            "Schema URI is already bound to a different digest",
          );
        }
      }
      for (const binding of bindings) {
        this.session
          .prepare(
            "INSERT OR IGNORE INTO network_citizen_schema_digests (tenant_id, schema_uri, schema_digest) VALUES (?, ?, ?)",
          )
          .run(tenantId, binding.uri, binding.digest);
      }
    });
  }

  async getProjectedCitizen(
    tenantId: string,
    citizenId: string,
    now: string,
  ): Promise<ProjectedCitizen | null> {
    return this.read(() => {
      const registrationRow = this.getProvisioningRow(tenantId, citizenId);
      if (registrationRow === undefined) return null;
      const registration = parseProvisioning(registrationRow);
      const active = this.session
        .prepare(
          "SELECT session_id FROM network_citizen_active_sessions WHERE tenant_id = ? AND citizen_id = ?",
        )
        .get(tenantId, citizenId) as { session_id: string } | undefined;
      const sessionRow = active === undefined
        ? (this.session
            .prepare(
              "SELECT session_json FROM network_citizen_sessions WHERE tenant_id = ? AND citizen_id = ? ORDER BY updated_at DESC, session_id DESC LIMIT 1",
            )
            .get(tenantId, citizenId) as SessionRow | undefined)
        : this.getSessionRow(tenantId, citizenId, active.session_id);
      if (sessionRow === undefined) return null;
      const stored = parseSession(sessionRow);
      const isActive =
        registration.administrative_state === "enabled" &&
        stored.state === "active" &&
        compare(stored.expires_at, now) > 0;
      return clone({
        descriptor: {
          ...stored.descriptor,
          availability: isActive
            ? stored.descriptor.availability
            : "unavailable",
        },
        declarations: isActive ? stored.declarations : [],
        lease: {
          session_id: stored.session_id,
          fencing_token: stored.fencing_token,
          declaration_version: stored.declaration_version,
          expires_at: stored.expires_at,
          renew_after: stored.renew_after,
        },
      });
    });
  }

  async discover(
    input: CitizenDiscoveryQuery,
  ): Promise<CitizenDiscoveryPage> {
    this.ensureOpen();
    const after = decodeCursor(input);
    const rows = this.session
      .prepare(
        "SELECT citizen_id FROM network_citizen_provisioning WHERE tenant_id = ? AND administrative_state = 'enabled' ORDER BY citizen_id ASC",
      )
      .all(input.tenant_id) as unknown as { citizen_id: string }[];
    const items: ProjectedCitizen[] = [];
    for (const row of rows) {
      if (after !== null && compare(row.citizen_id, after) <= 0) continue;
      const projected = await this.getProjectedCitizen(
        input.tenant_id,
        row.citizen_id,
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
          (candidate) =>
            candidate.declaration_id === input.declaration_id,
        )
      ) {
        continue;
      }
      items.push(projected);
    }
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
  }

  private getProvisioningRow(
    tenantId: string,
    citizenId: string,
  ): ProvisioningRow | undefined {
    return this.session
      .prepare(
        "SELECT registration_json FROM network_citizen_provisioning WHERE tenant_id = ? AND citizen_id = ?",
      )
      .get(tenantId, citizenId) as ProvisioningRow | undefined;
  }

  private getSessionRow(
    tenantId: string,
    citizenId: string,
    sessionId: string,
  ): SessionRow | undefined {
    return this.session
      .prepare(
        "SELECT session_json FROM network_citizen_sessions WHERE tenant_id = ? AND citizen_id = ? AND session_id = ?",
      )
      .get(tenantId, citizenId, sessionId) as SessionRow | undefined;
  }

  private maximumFencing(tenantId: string, citizenId: string): number {
    const row = this.session
      .prepare(
        "SELECT COALESCE(MAX(fencing_token), 0) AS fencing_token FROM network_citizen_sessions WHERE tenant_id = ? AND citizen_id = ?",
      )
      .get(tenantId, citizenId) as { fencing_token: number };
    return row.fencing_token;
  }

  private requireActive(input: {
    readonly tenant_id: string;
    readonly citizen_id: string;
    readonly session_id: string;
    readonly fencing_token: number;
  }): StoredCitizenSession {
    const row = this.getSessionRow(
      input.tenant_id,
      input.citizen_id,
      input.session_id,
    );
    if (row === undefined) {
      throw new CitizenStoreError(
        "session_not_found",
        "Citizen session was not found",
      );
    }
    const session = parseSession(row);
    const active = this.session
      .prepare(
        "SELECT session_id, fencing_token FROM network_citizen_active_sessions WHERE tenant_id = ? AND citizen_id = ?",
      )
      .get(input.tenant_id, input.citizen_id) as
      | { session_id: string; fencing_token: number }
      | undefined;
    if (
      session.state !== "active" ||
      session.fencing_token !== input.fencing_token ||
      active?.session_id !== input.session_id ||
      active.fencing_token !== input.fencing_token
    ) {
      throw new CitizenStoreError(
        "session_fenced",
        "Citizen session is fenced",
      );
    }
    return session;
  }

  private insertSession(session: StoredCitizenSession): void {
    this.session
      .prepare(`
        INSERT INTO network_citizen_sessions (
          tenant_id, citizen_id, session_id, client_session_id, state,
          availability, fencing_token, heartbeat_sequence,
          registration_version, declaration_version, declaration_digest,
          request_digest, expires_at, renew_after, opened_at, updated_at,
          session_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        session.tenant_id,
        session.citizen_id,
        session.session_id,
        session.client_session_id,
        session.state,
        session.descriptor.availability,
        session.fencing_token,
        session.heartbeat_sequence,
        session.registration_version,
        session.declaration_version,
        session.declaration_digest,
        session.request_digest,
        session.expires_at,
        session.renew_after,
        session.opened_at,
        session.updated_at,
        JSON.stringify(session),
      );
  }

  private updateSession(session: StoredCitizenSession): void {
    const result = this.session
      .prepare(`
        UPDATE network_citizen_sessions SET
          state = ?, availability = ?, fencing_token = ?,
          heartbeat_sequence = ?, registration_version = ?,
          declaration_version = ?, declaration_digest = ?,
          request_digest = ?, expires_at = ?, renew_after = ?,
          updated_at = ?, session_json = ?
        WHERE tenant_id = ? AND citizen_id = ? AND session_id = ?
      `)
      .run(
        session.state,
        session.descriptor.availability,
        session.fencing_token,
        session.heartbeat_sequence,
        session.registration_version,
        session.declaration_version,
        session.declaration_digest,
        session.request_digest,
        session.expires_at,
        session.renew_after,
        session.updated_at,
        JSON.stringify(session),
        session.tenant_id,
        session.citizen_id,
        session.session_id,
      );
    if (result.changes !== 1) {
      throw new CitizenStoreError(
        "session_not_found",
        "Citizen session was not found",
      );
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Network Citizen SQLite store is closed");
  }

  private read<T>(operation: () => T): T {
    this.ensureOpen();
    return operation();
  }

  private write<T>(operation: () => T): T {
    this.ensureOpen();
    return this.session.transaction(operation);
  }
}
