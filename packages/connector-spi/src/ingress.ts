import type {
  CapabilityManifest,
  ExchangeAdapter,
  JsonObject,
} from "@work-fabric/exchange-spi";

export const CONNECTOR_INGRESS_REQUIRED_CAPABILITIES = [
  "atomic_deduplication",
  "tenant_isolation",
  "fenced_claims",
  "lease_recovery",
  "retry_scheduling",
  "dead_letter_requeue",
  "deterministic_pagination",
  "payload_isolation",
] as const;

export type ConnectorIngressState =
  | "pending"
  | "processing"
  | "retry_wait"
  | "completed"
  | "dead_letter";

export interface ConnectorIngressEnvelope {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly source_system: string;
  readonly external_tenant_id: string;
  readonly external_event_id: string;
  readonly dedupe_key: string;
  readonly event_type: string;
  readonly partition_key?: string;
  readonly occurred_at: string;
  readonly received_at: string;
  readonly payload: JsonObject;
  readonly trace_context?: JsonObject;
}

export interface ConnectorIngressRecord {
  readonly ingress_id: string;
  readonly envelope: ConnectorIngressEnvelope;
  readonly state: ConnectorIngressState;
  readonly attempt: number;
  readonly available_at: string;
  readonly accepted_at: string;
  readonly updated_at: string;
  readonly completed_at?: string;
  readonly last_error_code?: string;
  readonly last_error_detail?: string;
}

export interface ConnectorIngressClaim extends ConnectorIngressRecord {
  readonly state: "processing";
  readonly claim_owner: string;
  readonly claim_token: string;
  readonly fencing_token: number;
  readonly lease_expires_at: string;
}

export type AcceptConnectorIngressResult =
  | {
      readonly kind: "accepted";
      readonly record: ConnectorIngressRecord;
    }
  | {
      readonly kind: "duplicate";
      readonly record: ConnectorIngressRecord;
    };

export interface ClaimConnectorIngress {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly worker_id: string;
  readonly now: string;
  readonly lease_seconds: number;
  readonly limit: number;
}

export interface ConnectorIngressClaimMutation {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly ingress_id: string;
  readonly claim_token: string;
  readonly fencing_token: number;
  readonly now: string;
}

export interface RetryConnectorIngress extends ConnectorIngressClaimMutation {
  readonly available_at: string;
  readonly error_code: string;
  readonly error_detail?: string;
}

export interface DeadLetterConnectorIngress
  extends ConnectorIngressClaimMutation {
  readonly error_code: string;
  readonly error_detail?: string;
}

export interface RequeueConnectorIngress {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly ingress_id: string;
  readonly now: string;
  readonly available_at: string;
  readonly reason: string;
}

export interface GetConnectorIngress {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly ingress_id: string;
}

export interface ListConnectorIngress {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly states?: readonly ConnectorIngressState[];
  readonly cursor?: string;
  readonly limit: number;
}

export interface ConnectorIngressPage {
  readonly items: readonly ConnectorIngressRecord[];
  readonly next_cursor?: string;
}

export interface ConnectorIngressStore extends ExchangeAdapter {
  readonly manifest: CapabilityManifest;
  accept(envelope: ConnectorIngressEnvelope): Promise<AcceptConnectorIngressResult>;
  claim(input: ClaimConnectorIngress): Promise<readonly ConnectorIngressClaim[]>;
  complete(input: ConnectorIngressClaimMutation): Promise<ConnectorIngressRecord>;
  retry(input: RetryConnectorIngress): Promise<ConnectorIngressRecord>;
  deadLetter(input: DeadLetterConnectorIngress): Promise<ConnectorIngressRecord>;
  requeue(input: RequeueConnectorIngress): Promise<ConnectorIngressRecord>;
  get(input: GetConnectorIngress): Promise<ConnectorIngressRecord | null>;
  list(input: ListConnectorIngress): Promise<ConnectorIngressPage>;
}

export interface ConnectorIngressLimits {
  readonly max_id_length: number;
  readonly max_event_type_length: number;
  readonly max_payload_bytes: number;
  readonly max_json_depth: number;
  readonly max_trace_fields: number;
  readonly max_error_detail_length: number;
  readonly max_page_limit: number;
  readonly max_claim_limit: number;
  readonly max_lease_seconds: number;
}

export class ConnectorContractError extends TypeError {
  constructor(
    readonly code: "invalid_field" | "limit_exceeded" | "forbidden_field",
    message: string,
  ) {
    super(message);
  }
}

export function assertBoundedConnectorId(
  value: unknown,
  label: string,
  maxLength: number,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConnectorContractError("invalid_field", `${label} is required`);
  }
  if (value.length > maxLength) {
    throw new ConnectorContractError(
      "limit_exceeded",
      `${label} exceeds its configured limit`,
    );
  }
}
