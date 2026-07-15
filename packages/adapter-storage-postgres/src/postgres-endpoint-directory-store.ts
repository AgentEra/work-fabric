import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import type {
  PostgresClient,
  TenantSession,
} from "@work-fabric/adapter-postgres-common";
import {
  ENDPOINT_DIRECTORY_REQUIRED_CAPABILITIES,
  EndpointStoreError,
  compareUtcTimestamps,
  type CapabilityManifest,
  type CloseEndpointSession,
  type EndpointDescriptor,
  type EndpointDirectoryStore,
  type EndpointDiscoveryPage,
  type EndpointDiscoveryQuery,
  type HeartbeatEndpointSession,
  type OpenEndpointSession,
  type PutEndpointRegistration,
  type StoredEndpointRegistration,
  type StoredEndpointSession,
} from "@work-fabric/exchange-spi";

export const ENDPOINT_BOUNDARY_MIGRATION = {
  id: "004_endpoint_boundary",
  sql: readFileSync(
    new URL("../migrations/004_endpoint_boundary.sql", import.meta.url),
    "utf8",
  ),
} as const;

const manifest: CapabilityManifest = {
  profile: "exchange.endpoint-directory.v1",
  adapter: "postgres",
  capabilities: Object.fromEntries(
    ENDPOINT_DIRECTORY_REQUIRED_CAPABILITIES.map((capability) => [
      capability,
      true,
    ]),
  ),
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function json<T>(value: unknown): T {
  return typeof value === "string"
    ? (JSON.parse(value) as T)
    : clone(value as T);
}

function identity(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError(`${label} is invalid`);
  }
}

function safeInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError(`${label} is invalid`);
  return number;
}

function cursorSignature(query: EndpointDiscoveryQuery): unknown {
  const { cursor: _cursor, now: _now, limit: _limit, ...signature } = query;
  return signature;
}

function encodeCursor(query: EndpointDiscoveryQuery, endpointId: string): string {
  return Buffer.from(
    JSON.stringify({
      signature: cursorSignature(query),
      endpoint_id: endpointId,
    }),
  ).toString("base64url");
}

function decodeCursor(query: EndpointDiscoveryQuery): string | null {
  if (query.cursor === undefined) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(query.cursor, "base64url").toString("utf8"),
    ) as { signature: unknown; endpoint_id: unknown };
    if (
      !isDeepStrictEqual(decoded.signature, cursorSignature(query)) ||
      typeof decoded.endpoint_id !== "string"
    ) {
      throw new Error("cursor mismatch");
    }
    return decoded.endpoint_id;
  } catch {
    throw new TypeError("invalid cursor");
  }
}

function rowRegistration(row: Record<string, unknown>): StoredEndpointRegistration {
  return json<StoredEndpointRegistration>(row.payload);
}

function rowSession(row: Record<string, unknown>): StoredEndpointSession {
  return json<StoredEndpointSession>(row.payload);
}

function projected(
  registration: StoredEndpointRegistration,
  session: StoredEndpointSession | null,
  now: string,
): EndpointDescriptor {
  const active =
    registration.administrative_state === "enabled" &&
    session?.state === "active" &&
    compareUtcTimestamps(session.expires_at, now) > 0;
  return clone({
    endpoint_id: registration.endpoint_id,
    actor: registration.actor,
    endpoint_type: registration.endpoint_type,
    display_name: registration.display_name,
    protocol_versions: registration.protocol_versions,
    bindings: registration.bindings,
    capabilities: session?.capabilities ?? [],
    availability: active ? session.availability : "unavailable",
    lease: {
      expires_at: session?.expires_at ?? registration.updated_at,
      renew_after: session?.renew_after ?? registration.updated_at,
    },
    limits: registration.limits,
    ...(registration.extensions === undefined
      ? {}
      : { extensions: registration.extensions }),
  });
}

export class PostgresEndpointDirectoryStore implements EndpointDirectoryStore {
  readonly manifest = clone(manifest);
  private tenantContext: string | undefined;

  constructor(
    private readonly sessionFactory: (tenantId: string) => TenantSession,
    tenantId?: string,
  ) {
    if (tenantId !== undefined) identity(tenantId, "tenantId");
    this.tenantContext = tenantId;
  }

  private bind(tenantId: string): void {
    identity(tenantId, "tenantId");
    if (this.tenantContext === undefined) this.tenantContext = tenantId;
    if (this.tenantContext !== tenantId) {
      throw new Error("tenant context mismatch");
    }
  }

  private run<T>(
    tenantId: string,
    operation: (client: PostgresClient) => Promise<T>,
  ): Promise<T> {
    this.bind(tenantId);
    return this.sessionFactory(tenantId).withTransaction(operation);
  }

  async putRegistration(
    input: PutEndpointRegistration,
  ): Promise<StoredEndpointRegistration> {
    const candidate = clone(input.registration);
    return this.run(candidate.tenant_id, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        "SELECT payload FROM work_fabric_endpoint_registrations WHERE tenant_id=$1 AND endpoint_id=$2 FOR UPDATE",
        [candidate.tenant_id, candidate.endpoint_id],
      );
      const existing = result.rows[0] === undefined
        ? null
        : rowRegistration(result.rows[0]);
      if (existing === null) {
        if (
          input.expected_version !== null ||
          candidate.registration_version !== 1
        ) {
          throw new EndpointStoreError(
            "registration_version_conflict",
            "new registration must start at version 1",
          );
        }
      } else {
        if (
          input.expected_version !== existing.registration_version ||
          candidate.registration_version !== existing.registration_version + 1
        ) {
          throw new EndpointStoreError(
            "registration_version_conflict",
            "registration version is stale",
          );
        }
        if (!isDeepStrictEqual(existing.actor, candidate.actor)) {
          throw new EndpointStoreError(
            "immutable_binding",
            "Endpoint Actor binding is immutable",
          );
        }
      }
      await client.query(
        "INSERT INTO work_fabric_endpoint_registrations (tenant_id,endpoint_id,actor_id,actor_type,administrative_state,registration_version,payload) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (tenant_id,endpoint_id) DO UPDATE SET administrative_state=EXCLUDED.administrative_state,registration_version=EXCLUDED.registration_version,payload=EXCLUDED.payload",
        [
          candidate.tenant_id,
          candidate.endpoint_id,
          candidate.actor.actor_id,
          candidate.actor.actor_type,
          candidate.administrative_state,
          candidate.registration_version,
          JSON.stringify(candidate),
        ],
      );
      return clone(candidate);
    });
  }

  async getRegistration(
    tenantId: string,
    endpointId: string,
  ): Promise<StoredEndpointRegistration | null> {
    return this.run(tenantId, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        "SELECT payload FROM work_fabric_endpoint_registrations WHERE tenant_id=$1 AND endpoint_id=$2",
        [tenantId, endpointId],
      );
      return result.rows[0] === undefined
        ? null
        : rowRegistration(result.rows[0]);
    });
  }

  async openSession(input: OpenEndpointSession): Promise<StoredEndpointSession> {
    return this.run(input.tenant_id, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
        [input.tenant_id, input.endpoint_id],
      );
      const replay = await client.query<Record<string, unknown>>(
        "SELECT payload FROM work_fabric_endpoint_sessions WHERE tenant_id=$1 AND endpoint_id=$2 AND client_session_id=$3 FOR UPDATE",
        [input.tenant_id, input.endpoint_id, input.client_session_id],
      );
      if (replay.rows[0] !== undefined) {
        const stored = rowSession(replay.rows[0]);
        if (stored.request_digest !== input.request_digest) {
          throw new EndpointStoreError(
            "idempotency_conflict",
            "client_session_id was reused with different content",
          );
        }
        return stored;
      }

      const active = await client.query<{ session_id: string }>(
        "SELECT session_id FROM work_fabric_endpoint_active_sessions WHERE tenant_id=$1 AND endpoint_id=$2 FOR UPDATE",
        [input.tenant_id, input.endpoint_id],
      );
      const activeId = active.rows[0]?.session_id;
      if (activeId !== undefined) {
        const activeRow = await client.query<Record<string, unknown>>(
          "SELECT payload FROM work_fabric_endpoint_sessions WHERE tenant_id=$1 AND endpoint_id=$2 AND session_id=$3 FOR UPDATE",
          [input.tenant_id, input.endpoint_id, activeId],
        );
        if (activeRow.rows[0] !== undefined) {
          const old = rowSession(activeRow.rows[0]);
          const fenced: StoredEndpointSession = {
            ...old,
            state: "fenced",
            updated_at: input.opened_at,
          };
          await client.query(
            "UPDATE work_fabric_endpoint_sessions SET state='fenced',payload=$1::jsonb WHERE tenant_id=$2 AND endpoint_id=$3 AND session_id=$4",
            [JSON.stringify(fenced), input.tenant_id, input.endpoint_id, activeId],
          );
        }
      }

      const fencing = await client.query<{ fencing_token: number | string }>(
        "INSERT INTO work_fabric_endpoint_fencing (tenant_id,endpoint_id,fencing_token) VALUES ($1,$2,1) ON CONFLICT (tenant_id,endpoint_id) DO UPDATE SET fencing_token=work_fabric_endpoint_fencing.fencing_token+1 RETURNING fencing_token",
        [input.tenant_id, input.endpoint_id],
      );
      const fencingToken = safeInteger(
        fencing.rows[0]?.fencing_token,
        "fencing_token",
      );
      const session: StoredEndpointSession = {
        ...clone(input),
        fencing_token: fencingToken,
        heartbeat_sequence: 0,
        state: "active",
        updated_at: input.opened_at,
      };
      await client.query(
        "INSERT INTO work_fabric_endpoint_sessions (tenant_id,endpoint_id,session_id,client_session_id,fencing_token,heartbeat_sequence,state,availability,registration_version,request_digest,expires_at,payload) VALUES ($1,$2,$3,$4,$5,0,'active',$6,$7,$8,$9,$10::jsonb)",
        [input.tenant_id, input.endpoint_id, input.session_id, input.client_session_id, fencingToken, input.availability, input.registration_version, input.request_digest, input.expires_at, JSON.stringify(session)],
      );
      await client.query(
        "INSERT INTO work_fabric_endpoint_active_sessions (tenant_id,endpoint_id,session_id,fencing_token) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,endpoint_id) DO UPDATE SET session_id=EXCLUDED.session_id,fencing_token=EXCLUDED.fencing_token",
        [input.tenant_id, input.endpoint_id, input.session_id, fencingToken],
      );
      return clone(session);
    });
  }

  async heartbeat(input: HeartbeatEndpointSession): Promise<StoredEndpointSession> {
    return this.run(input.tenant_id, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
        [input.tenant_id, input.endpoint_id],
      );
      const result = await client.query<Record<string, unknown>>(
        "SELECT payload FROM work_fabric_endpoint_sessions WHERE tenant_id=$1 AND endpoint_id=$2 AND session_id=$3 FOR UPDATE",
        [input.tenant_id, input.endpoint_id, input.session_id],
      );
      if (result.rows[0] === undefined) {
        throw new EndpointStoreError(
          "session_not_found",
          "Endpoint session was not found",
        );
      }
      const current = rowSession(result.rows[0]);
      const active = await client.query<{ session_id: string; fencing_token: number | string }>(
        "SELECT session_id,fencing_token FROM work_fabric_endpoint_active_sessions WHERE tenant_id=$1 AND endpoint_id=$2",
        [input.tenant_id, input.endpoint_id],
      );
      if (
        current.state !== "active" ||
        active.rows[0]?.session_id !== input.session_id ||
        safeInteger(active.rows[0]?.fencing_token, "fencing_token") !==
          input.fencing_token
      ) {
        throw new EndpointStoreError(
          "session_fenced",
          "Endpoint session is fenced",
        );
      }
      if (current.registration_version !== input.registration_version) {
        throw new EndpointStoreError(
          "registration_version_conflict",
          "registration version is stale",
        );
      }
      if (input.heartbeat_sequence === current.heartbeat_sequence) {
        if (input.request_digest === current.request_digest) return current;
        throw new EndpointStoreError(
          "stale_sequence",
          "heartbeat sequence was reused with different content",
        );
      }
      if (input.heartbeat_sequence < current.heartbeat_sequence) {
        throw new EndpointStoreError(
          "stale_sequence",
          "heartbeat sequence is stale",
        );
      }
      const updated: StoredEndpointSession = {
        ...current,
        capabilities: clone(input.capabilities),
        availability: input.availability,
        heartbeat_sequence: input.heartbeat_sequence,
        request_digest: input.request_digest,
        expires_at: input.expires_at,
        renew_after: input.renew_after,
        updated_at: input.updated_at,
      };
      await client.query(
        "UPDATE work_fabric_endpoint_sessions SET heartbeat_sequence=$1,availability=$2,request_digest=$3,expires_at=$4,payload=$5::jsonb WHERE tenant_id=$6 AND endpoint_id=$7 AND session_id=$8",
        [input.heartbeat_sequence, input.availability, input.request_digest, input.expires_at, JSON.stringify(updated), input.tenant_id, input.endpoint_id, input.session_id],
      );
      return clone(updated);
    });
  }

  async closeSession(input: CloseEndpointSession): Promise<StoredEndpointSession> {
    return this.run(input.tenant_id, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
        [input.tenant_id, input.endpoint_id],
      );
      const result = await client.query<Record<string, unknown>>(
        "SELECT payload FROM work_fabric_endpoint_sessions WHERE tenant_id=$1 AND endpoint_id=$2 AND session_id=$3 FOR UPDATE",
        [input.tenant_id, input.endpoint_id, input.session_id],
      );
      if (result.rows[0] === undefined) throw new EndpointStoreError("session_not_found", "Endpoint session was not found");
      const current = rowSession(result.rows[0]);
      if (current.state === "closed" && current.heartbeat_sequence === input.heartbeat_sequence && current.request_digest === input.request_digest) return current;
      const active = await client.query<{ session_id: string; fencing_token: number | string }>(
        "SELECT session_id,fencing_token FROM work_fabric_endpoint_active_sessions WHERE tenant_id=$1 AND endpoint_id=$2",
        [input.tenant_id, input.endpoint_id],
      );
      if (current.state !== "active" || active.rows[0]?.session_id !== input.session_id || safeInteger(active.rows[0]?.fencing_token, "fencing_token") !== input.fencing_token) throw new EndpointStoreError("session_fenced", "Endpoint session is fenced");
      if (current.registration_version !== input.registration_version) throw new EndpointStoreError("registration_version_conflict", "registration version is stale");
      if (input.heartbeat_sequence <= current.heartbeat_sequence) throw new EndpointStoreError("stale_sequence", "close sequence is stale");
      const closed: StoredEndpointSession = { ...current, availability: "unavailable", state: "closed", heartbeat_sequence: input.heartbeat_sequence, request_digest: input.request_digest, updated_at: input.closed_at };
      await client.query(
        "UPDATE work_fabric_endpoint_sessions SET heartbeat_sequence=$1,state='closed',availability='unavailable',request_digest=$2,payload=$3::jsonb WHERE tenant_id=$4 AND endpoint_id=$5 AND session_id=$6",
        [input.heartbeat_sequence, input.request_digest, JSON.stringify(closed), input.tenant_id, input.endpoint_id, input.session_id],
      );
      await client.query(
        "DELETE FROM work_fabric_endpoint_active_sessions WHERE tenant_id=$1 AND endpoint_id=$2 AND session_id=$3 AND fencing_token=$4",
        [input.tenant_id, input.endpoint_id, input.session_id, input.fencing_token],
      );
      return clone(closed);
    });
  }

  getSessionByClientId(
    tenantId: string,
    endpointId: string,
    clientSessionId: string,
  ): Promise<StoredEndpointSession | null> {
    return this.readSession(
      tenantId,
      "client_session_id=$3",
      endpointId,
      clientSessionId,
    );
  }

  getSession(
    tenantId: string,
    endpointId: string,
    sessionId: string,
  ): Promise<StoredEndpointSession | null> {
    return this.readSession(
      tenantId,
      "session_id=$3",
      endpointId,
      sessionId,
    );
  }

  private readSession(
    tenantId: string,
    predicate: "client_session_id=$3" | "session_id=$3",
    endpointId: string,
    value: string,
  ): Promise<StoredEndpointSession | null> {
    return this.run(tenantId, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT payload FROM work_fabric_endpoint_sessions WHERE tenant_id=$1 AND endpoint_id=$2 AND ${predicate}`,
        [tenantId, endpointId, value],
      );
      return result.rows[0] === undefined ? null : rowSession(result.rows[0]);
    });
  }

  async getProjectedEndpoint(
    tenantId: string,
    endpointId: string,
    now: string,
  ): Promise<EndpointDescriptor | null> {
    return this.run(tenantId, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        "SELECT r.payload AS registration,s.payload AS session FROM work_fabric_endpoint_registrations r LEFT JOIN work_fabric_endpoint_active_sessions a ON a.tenant_id=r.tenant_id AND a.endpoint_id=r.endpoint_id LEFT JOIN work_fabric_endpoint_sessions s ON s.tenant_id=a.tenant_id AND s.endpoint_id=a.endpoint_id AND s.session_id=a.session_id WHERE r.tenant_id=$1 AND r.endpoint_id=$2",
        [tenantId, endpointId],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return projected(
        json<StoredEndpointRegistration>(row.registration),
        row.session === null || row.session === undefined
          ? null
          : json<StoredEndpointSession>(row.session),
        now,
      );
    });
  }

  async discover(input: EndpointDiscoveryQuery): Promise<EndpointDiscoveryPage> {
    const after = decodeCursor(input);
    return this.run(input.tenant_id, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT r.payload AS registration,s.payload AS session
           FROM work_fabric_endpoint_registrations r
           JOIN work_fabric_endpoint_active_sessions a ON a.tenant_id=r.tenant_id AND a.endpoint_id=r.endpoint_id
           JOIN work_fabric_endpoint_sessions s ON s.tenant_id=a.tenant_id AND s.endpoint_id=a.endpoint_id AND s.session_id=a.session_id
          WHERE r.tenant_id=$1
            AND r.administrative_state='enabled'
            AND r.endpoint_id > COALESCE($2,'')
            AND s.state='active'
            AND s.availability <> 'unavailable'
            AND s.expires_at::timestamptz > $3::timestamptz
            AND ($4::text[] IS NULL OR s.availability = ANY($4::text[]))
            AND (($5::text IS NULL AND $6::text IS NULL AND $7::text[] IS NULL AND $8::text[] IS NULL) OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(s.payload->'capabilities') capability
               WHERE ($5::text IS NULL OR capability->>'capability_id'=$5)
                 AND ($6::text IS NULL OR work_fabric_semver_satisfies(capability->>'version',$6))
                 AND ($7::text[] IS NULL OR capability->'input_media_types' @> to_jsonb($7::text[]))
                 AND ($8::text[] IS NULL OR capability->'output_media_types' @> to_jsonb($8::text[]))
            ))
          ORDER BY r.endpoint_id
          LIMIT $9`,
        [input.tenant_id, after, input.now, input.availability ?? null, input.capability_id ?? null, input.version_constraint ?? null, input.required_input_media_types ?? null, input.required_output_media_types ?? null, input.limit + 1],
      );
      const rows = result.rows.slice(0, input.limit);
      const items = rows.map((row) => projected(
        json<StoredEndpointRegistration>(row.registration),
        json<StoredEndpointSession>(row.session),
        input.now,
      ));
      return {
        items,
        ...(result.rows.length > input.limit
          ? { next_cursor: encodeCursor(input, items.at(-1)!.endpoint_id) }
          : {}),
      };
    });
  }

  async listActorEndpoints(
    tenantId: string,
    actorId: string,
    now: string,
  ): Promise<readonly EndpointDescriptor[]> {
    return this.run(tenantId, async (client) => {
      const result = await client.query<Record<string, unknown>>(
        `SELECT r.payload AS registration,s.payload AS session
           FROM work_fabric_endpoint_registrations r
           JOIN work_fabric_endpoint_active_sessions a ON a.tenant_id=r.tenant_id AND a.endpoint_id=r.endpoint_id
           JOIN work_fabric_endpoint_sessions s ON s.tenant_id=a.tenant_id AND s.endpoint_id=a.endpoint_id AND s.session_id=a.session_id
          WHERE r.tenant_id=$1 AND r.actor_id=$2 AND r.administrative_state='enabled'
            AND s.state='active' AND s.availability <> 'unavailable'
            AND s.expires_at::timestamptz > $3::timestamptz
          ORDER BY r.endpoint_id`,
        [tenantId, actorId, now],
      );
      return result.rows.map((row) => projected(
        json<StoredEndpointRegistration>(row.registration),
        json<StoredEndpointSession>(row.session),
        now,
      ));
    });
  }
}
