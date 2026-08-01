import type {
  CitizenAvailability,
  CitizenDeclaration,
  CitizenProvisioning,
  NetworkCitizenDescriptor,
  NetworkCitizenKind,
  PublicCitizenSession,
} from "./contracts.js";

export interface CitizenStoreManifest {
  readonly profile: "network-citizen.store.v1";
  readonly adapter: string;
  readonly capabilities: {
    readonly tenant_isolation: true;
    readonly optimistic_registration: true;
    readonly idempotent_session_open: true;
    readonly monotonic_fencing: true;
    readonly declaration_cas: true;
    readonly deterministic_pagination: true;
  };
}

export type StoredCitizenProvisioning = CitizenProvisioning & {
  readonly tenant_id: string;
  readonly created_at: string;
  readonly updated_at: string;
};

export interface PutCitizenProvisioning {
  readonly tenant_id: string;
  readonly provisioning: CitizenProvisioning;
  readonly expected_registration_version: number | null;
  readonly recorded_at: string;
}

export interface OpenCitizenSession {
  readonly tenant_id: string;
  readonly citizen_id: string;
  readonly session_id: string;
  readonly client_session_id: string;
  readonly descriptor: NetworkCitizenDescriptor;
  readonly declarations: readonly CitizenDeclaration[];
  readonly accepted_lease_seconds: number;
  readonly registration_version: number;
  readonly request_digest: string;
  readonly expires_at: string;
  readonly renew_after: string;
  readonly opened_at: string;
}

export interface HeartbeatCitizenSession {
  readonly tenant_id: string;
  readonly citizen_id: string;
  readonly session_id: string;
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly availability: CitizenAvailability;
  readonly request_digest: string;
  readonly expires_at: string;
  readonly renew_after: string;
  readonly updated_at: string;
}

export interface ReplaceCitizenDeclarations {
  readonly tenant_id: string;
  readonly citizen_id: string;
  readonly session_id: string;
  readonly fencing_token: number;
  readonly registration_version: number;
  readonly expected_declaration_version: number;
  readonly declarations: readonly CitizenDeclaration[];
  readonly declaration_digest: `sha256:${string}`;
  readonly request_digest: string;
  readonly updated_at: string;
}

export interface CloseCitizenSession {
  readonly tenant_id: string;
  readonly citizen_id: string;
  readonly session_id: string;
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly registration_version: number;
  readonly request_digest: string;
  readonly closed_at: string;
}

export interface StoredCitizenSession extends PublicCitizenSession {
  readonly tenant_id: string;
  readonly request_digest: string;
  readonly opened_at: string;
  readonly updated_at: string;
}

export interface ProjectedCitizen {
  readonly descriptor: NetworkCitizenDescriptor;
  readonly declarations: readonly CitizenDeclaration[];
  readonly lease: {
    readonly session_id: string;
    readonly fencing_token: number;
    readonly declaration_version: number;
    readonly expires_at: string;
    readonly renew_after: string;
  } | null;
}

export interface CitizenDiscoveryQuery {
  readonly tenant_id: string;
  readonly citizen_kind?: NetworkCitizenKind;
  readonly declaration_id?: string;
  readonly availability?: readonly CitizenAvailability[];
  readonly executable_only?: boolean;
  readonly cursor?: string;
  readonly limit: number;
  readonly now: string;
}

export interface CitizenDiscoveryPage {
  readonly items: readonly ProjectedCitizen[];
  readonly next_cursor?: string;
}

export interface CitizenSchemaDigestBinding {
  readonly uri: string;
  readonly digest: `sha256:${string}`;
}

export type CitizenStoreErrorCode =
  | "registration_version_conflict"
  | "immutable_binding"
  | "idempotency_conflict"
  | "session_fenced"
  | "stale_sequence"
  | "session_not_found"
  | "declaration_version_conflict"
  | "schema_digest_conflict";

export class CitizenStoreError extends Error {
  constructor(
    readonly code: CitizenStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CitizenStoreError";
  }
}

export interface NetworkCitizenStore {
  readonly manifest: CitizenStoreManifest;
  putProvisioning(input: PutCitizenProvisioning): Promise<StoredCitizenProvisioning>;
  getProvisioning(tenantId: string, citizenId: string): Promise<StoredCitizenProvisioning | null>;
  openSession(input: OpenCitizenSession): Promise<StoredCitizenSession>;
  heartbeat(input: HeartbeatCitizenSession): Promise<StoredCitizenSession>;
  replaceDeclarations(input: ReplaceCitizenDeclarations): Promise<StoredCitizenSession>;
  closeSession(input: CloseCitizenSession): Promise<StoredCitizenSession>;
  getSession(tenantId: string, citizenId: string, sessionId: string): Promise<StoredCitizenSession | null>;
  getSessionByClientId(tenantId: string, citizenId: string, clientSessionId: string): Promise<StoredCitizenSession | null>;
  bindSchemaDigests(tenantId: string, bindings: readonly CitizenSchemaDigestBinding[]): Promise<void>;
  getProjectedCitizen(tenantId: string, citizenId: string, now: string): Promise<ProjectedCitizen | null>;
  discover(input: CitizenDiscoveryQuery): Promise<CitizenDiscoveryPage>;
}
