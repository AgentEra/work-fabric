import type { AgentRoleProfile } from "@work-fabric/agent-runtime-spi";

export interface AgentRuntimeServiceConfiguration {
  readonly runtime_id: string;
  readonly work_fabric: {
    readonly base_url: string;
    readonly tenant_id: string;
    readonly exchange_id: string;
    readonly actor_id: string;
    readonly endpoint_id: string;
    readonly subscription_id: string;
    readonly access_token: string;
  };
  readonly acceptance: {
    readonly mode: "accept_all_targeted";
    readonly allowed_capability_ids: readonly string[];
  };
  readonly concurrency: { readonly max_active_runs: number; readonly queue_capacity: number };
  readonly state: { readonly provider: "sqlite"; readonly location: string };
}

export interface AgentRuntimeParticipant {
  readonly actor_id: string;
  readonly actor_type: "agent";
  readonly endpoint_id: string;
}

export interface AgentlyDriverConfiguration {
  readonly python: { readonly executable: string; readonly module: string };
  readonly workspace_root: string;
  readonly execution_timeout_seconds: number;
  readonly cancellation_grace_seconds: number;
  readonly provider: { readonly type: string; readonly model: string; readonly base_url: string; readonly api_key: string };
}

export interface LoadedAgentRuntimeConfiguration {
  readonly service: AgentRuntimeServiceConfiguration;
  readonly role: AgentRoleProfile;
  readonly participant: AgentRuntimeParticipant;
  readonly driver: { readonly instance_id: string; readonly config: AgentlyDriverConfiguration };
}
