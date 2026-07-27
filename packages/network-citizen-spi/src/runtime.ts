import type {
  CitizenDeclaration,
  CitizenDeclarationReplaceInput,
  CitizenHeartbeatInput,
  CitizenSessionCloseInput,
  CitizenSessionOpenInput,
  NetworkCitizenDescriptor,
  NetworkCitizenKind,
  PublicCitizenSession,
} from "./contracts.js";
import type { CitizenJsonObject } from "./json.js";

export interface CitizenHealth {
  readonly status:
    | "starting"
    | "available"
    | "degraded"
    | "unavailable"
    | "closed";
  readonly session_id: string | null;
  readonly fencing_token: number | null;
  readonly declaration_version: number | null;
  readonly checked_at: string;
  readonly detail_code?: string;
}

export interface CitizenSessionClient {
  openSession(citizenId: string, input: CitizenSessionOpenInput): Promise<PublicCitizenSession>;
  heartbeat(citizenId: string, sessionId: string, input: CitizenHeartbeatInput): Promise<PublicCitizenSession>;
  replaceDeclarations(citizenId: string, sessionId: string, input: CitizenDeclarationReplaceInput): Promise<PublicCitizenSession>;
  closeSession(citizenId: string, sessionId: string, input: CitizenSessionCloseInput): Promise<PublicCitizenSession>;
}

export interface CitizenRuntimeContext {
  readonly tenant_id: string;
  readonly client: CitizenSessionClient;
  readonly clock: {
    now(): string;
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  readonly requested_lease_seconds: number;
  readonly heartbeat_safety_margin_ms: number;
  readonly signal: AbortSignal;
}

export interface NetworkCitizenRuntime {
  readonly citizen_kind: NetworkCitizenKind;
  start(context: CitizenRuntimeContext): Promise<void>;
  health(): Promise<CitizenHealth>;
  close(): Promise<void>;
}

export interface NetworkCitizenFactory<TConfig = unknown> {
  readonly type: string;
  readonly citizen_kind: NetworkCitizenKind;
  validate(value: unknown, path: string): TConfig;
  create(config: TConfig): Promise<NetworkCitizenRuntime>;
}

export interface CapabilityExecutionRequest {
  readonly invocation_id: string;
  readonly capability_id: string;
  readonly capability_version: string;
  readonly contract_digest: `sha256:${string}`;
  readonly input: CitizenJsonObject;
}

export interface CapabilityExecutionContext {
  readonly tenant_id: string;
  readonly citizen_id: string;
  readonly endpoint_id: string;
  readonly fencing_token: number;
  readonly authority_evidence: CitizenJsonObject;
  readonly signal: AbortSignal;
}

export type CapabilityExecutionResult =
  | { readonly outcome: "succeeded"; readonly data: CitizenJsonObject; readonly artifacts: readonly CitizenJsonObject[] }
  | { readonly outcome: "rejected"; readonly code: string; readonly message: string; readonly retryable: false }
  | { readonly outcome: "failed"; readonly code: string; readonly message: string; readonly retryable: boolean; readonly retry_after?: string };

export interface CapabilityExecutor {
  describeCapabilities(): readonly CitizenDeclaration[];
  execute(
    request: CapabilityExecutionRequest,
    context: CapabilityExecutionContext,
  ): Promise<CapabilityExecutionResult>;
}

export interface CapabilityProviderRuntimePort extends NetworkCitizenRuntime {
  readonly citizen_kind: "capability-provider";
  readonly executor: CapabilityExecutor;
}

export interface ContextProviderRuntimePort extends NetworkCitizenRuntime {
  readonly citizen_kind: "context-provider";
  resolve(request: CitizenJsonObject, signal: AbortSignal): Promise<CitizenJsonObject>;
}

export interface ChannelRuntimePort extends NetworkCitizenRuntime {
  readonly citizen_kind: "channel";
}

export interface GovernanceRuntimePort extends NetworkCitizenRuntime {
  readonly citizen_kind: "governance-provider";
  evaluate(request: CitizenJsonObject, signal: AbortSignal): Promise<CitizenJsonObject>;
}

export interface ObserverRuntimePort extends NetworkCitizenRuntime {
  readonly citizen_kind: "observer";
}

export interface DecisionBodyRuntimePort extends NetworkCitizenRuntime {
  readonly citizen_kind: "decision-body";
}

export interface CitizenRuntimeDeclarationSource {
  currentDescriptor(): NetworkCitizenDescriptor;
  currentDeclarations(): readonly CitizenDeclaration[];
}
