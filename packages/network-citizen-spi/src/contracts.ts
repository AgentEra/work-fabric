import type { CitizenJsonObject } from "./json.js";

export const NETWORK_CITIZEN_KINDS = [
  "decision-body",
  "capability-provider",
  "channel",
  "context-provider",
  "governance-provider",
  "observer",
] as const;

export type NetworkCitizenKind = (typeof NETWORK_CITIZEN_KINDS)[number];

export type CitizenAvailability =
  | "available"
  | "degraded"
  | "draining"
  | "unavailable";

export interface CitizenActorReference {
  readonly actor_id: string;
  readonly actor_type: "human" | "agent" | "system";
}

export interface CitizenIdentity {
  readonly principal_id: string;
  readonly actor?: CitizenActorReference;
  readonly endpoint_id?: string;
}

export interface CitizenSchemaReference {
  readonly uri: string;
  readonly digest: `sha256:${string}`;
}

export type CitizenDeclarationKind =
  | "capability"
  | "context"
  | "channel"
  | "policy";

export type CitizenRisk = "low" | "medium" | "high" | "destructive";

export interface CitizenDeclarationSummary {
  readonly declaration_id: string;
  readonly declaration_kind: CitizenDeclarationKind;
  readonly version: string;
  readonly name: string;
  readonly description: string;
}

export interface CitizenDeclaration extends CitizenDeclarationSummary {
  readonly input_schema?: CitizenSchemaReference;
  readonly output_schema?: CitizenSchemaReference;
  readonly interaction_modes: readonly (
    | "synchronous"
    | "asynchronous"
    | "status-updates"
  )[];
  readonly risk: CitizenRisk;
  readonly confirmation: "none" | "explicit";
  readonly constraints: CitizenJsonObject;
  readonly extensions: CitizenJsonObject;
}

export interface NetworkCitizenDescriptor {
  readonly citizen_id: string;
  readonly citizen_kind: NetworkCitizenKind;
  readonly version: string;
  readonly identity: CitizenIdentity | null;
  readonly protocol: {
    readonly versions: readonly string[];
    readonly bindings: readonly string[];
  };
  readonly declarations: {
    readonly count: number;
    readonly digest: `sha256:${string}`;
  };
  readonly availability: CitizenAvailability;
  readonly extensions: CitizenJsonObject;
}

export interface CitizenProvisioning {
  readonly citizen_id: string;
  readonly citizen_kind: NetworkCitizenKind;
  readonly principal_id: string;
  readonly allowed_actor?: CitizenActorReference;
  readonly allowed_endpoint_id?: string;
  readonly allowed_declaration_namespaces: readonly string[];
  readonly maximum_risk: CitizenRisk;
  readonly administrative_state: "enabled" | "disabled";
  readonly registration_version: number;
}

export interface CitizenSessionOpenInput {
  readonly client_session_id: string;
  readonly descriptor: NetworkCitizenDescriptor;
  readonly declarations: readonly CitizenDeclaration[];
  readonly requested_lease_seconds?: number;
  readonly expected_registration_version: number;
}

export interface CitizenHeartbeatInput {
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly availability: CitizenAvailability;
  readonly expected_registration_version: number;
}

export interface CitizenDeclarationReplaceInput {
  readonly fencing_token: number;
  readonly expected_registration_version: number;
  readonly expected_declaration_version: number;
  readonly declarations: readonly CitizenDeclaration[];
}

export interface CitizenSessionCloseInput {
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly expected_registration_version: number;
}

export interface PublicCitizenSession {
  readonly citizen_id: string;
  readonly session_id: string;
  readonly client_session_id: string;
  readonly descriptor: NetworkCitizenDescriptor;
  readonly declarations: readonly CitizenDeclaration[];
  readonly declaration_version: number;
  readonly declaration_digest: `sha256:${string}`;
  readonly accepted_lease_seconds: number;
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
  readonly state: "active" | "closed" | "fenced";
  readonly expires_at: string;
  readonly renew_after: string;
  readonly registration_version: number;
}

export interface CitizenCardPage {
  readonly items: readonly NetworkCitizenDescriptor[];
  readonly next_cursor?: string;
}

export interface CitizenDeclarationSummaryPage {
  readonly items: readonly CitizenDeclarationSummary[];
}

export interface CitizenDeclarationContract {
  readonly citizen_id: string;
  readonly citizen_kind: NetworkCitizenKind;
  readonly availability: CitizenAvailability;
  readonly declaration: CitizenDeclaration;
  readonly declaration_version: number;
  readonly fencing_token: number;
}
