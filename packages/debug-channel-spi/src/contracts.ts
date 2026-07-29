import type {
  CapabilityManifest,
  ExchangeAdapter,
  ProtocolEvent,
} from "@work-fabric/exchange-spi";

export const DEBUG_CHANNEL_STORE_REQUIRED_CAPABILITIES = [
  "tenant_isolation",
  "plugin_instance_isolation",
  "submission_idempotency",
  "correlation_linking",
  "capture_idempotency",
  "deterministic_pagination",
  "bounded_retention",
  "payload_isolation",
] as const;

export interface DebugSubmission {
  readonly tenant_id: string;
  readonly plugin_instance_id: string;
  readonly submission_id: string;
  readonly conversation_id: string;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly ingress_id?: string;
  readonly handoff_id?: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string;
}

export interface DebugSubmissionScope {
  readonly tenant_id: string;
  readonly plugin_instance_id: string;
  readonly submission_id: string;
}

export interface CreateDebugSubmission {
  readonly submission: DebugSubmission;
}

export interface LinkDebugIngress extends DebugSubmissionScope {
  readonly ingress_id: string;
  readonly updated_at: string;
}

export interface LinkDebugHandoff extends DebugSubmissionScope {
  readonly handoff_id: string;
  readonly updated_at: string;
}

export interface DebugCapture {
  readonly tenant_id: string;
  readonly plugin_instance_id: string;
  readonly capture_id: string;
  readonly conversation_id: string;
  readonly event_id: string;
  readonly destination_id: string;
  readonly event: ProtocolEvent;
  readonly captured_at: string;
  readonly expires_at: string;
}

export interface DebugCaptureScope {
  readonly tenant_id: string;
  readonly plugin_instance_id: string;
  readonly capture_id: string;
}

export interface AppendDebugCapture {
  readonly capture: DebugCapture;
}

export interface ListDebugCaptures {
  readonly tenant_id: string;
  readonly plugin_instance_id: string;
  readonly conversation_id: string;
  readonly after_captured_at?: string;
  readonly after_capture_id?: string;
  readonly limit: number;
}

export interface DebugCapturePage {
  readonly items: readonly DebugCapture[];
}

export interface PruneExpiredDebugRecords {
  readonly tenant_id: string;
  readonly plugin_instance_id: string;
  readonly now: string;
  readonly limit: number;
}

export type CreateDebugSubmissionResult =
  | { readonly kind: "created"; readonly submission: DebugSubmission }
  | { readonly kind: "existing"; readonly submission: DebugSubmission }
  | { readonly kind: "conflict"; readonly submission: DebugSubmission };

export interface DebugChannelStore extends ExchangeAdapter {
  readonly manifest: CapabilityManifest;
  createSubmission(input: CreateDebugSubmission): Promise<CreateDebugSubmissionResult>;
  linkIngress(input: LinkDebugIngress): Promise<DebugSubmission>;
  linkHandoff(input: LinkDebugHandoff): Promise<DebugSubmission>;
  getSubmission(scope: DebugSubmissionScope): Promise<DebugSubmission | null>;
  appendCapture(input: AppendDebugCapture): Promise<{
    readonly kind: "created" | "existing";
    readonly capture: DebugCapture;
  }>;
  getCapture(scope: DebugCaptureScope): Promise<DebugCapture | null>;
  listCaptures(query: ListDebugCaptures): Promise<DebugCapturePage>;
  pruneExpired(input: PruneExpiredDebugRecords): Promise<{
    readonly submissions: number;
    readonly captures: number;
  }>;
}

export type DebugChannelStoreErrorCode =
  | "idempotency_conflict"
  | "ingress_conflict"
  | "handoff_conflict"
  | "capture_conflict"
  | "submission_not_found"
  | "invalid_cursor";

export class DebugChannelStoreError extends Error {
  constructor(readonly code: DebugChannelStoreErrorCode) {
    super(code);
    this.name = "DebugChannelStoreError";
  }
}

export function debugChannelStoreManifest(adapter: string): CapabilityManifest {
  if (
    typeof adapter !== "string"
    || adapter.length === 0
    || adapter.length > 128
    || adapter.trim() !== adapter
  ) {
    throw new TypeError("adapter is invalid");
  }
  return {
    profile: "debug.channel-store.v1",
    adapter,
    capabilities: Object.fromEntries(
      DEBUG_CHANNEL_STORE_REQUIRED_CAPABILITIES.map((capability) => [
        capability,
        true,
      ]),
    ),
  };
}
