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
  readonly last_requeue_reason?: string;
  readonly last_requeued_at?: string;
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

export const DEFAULT_CONNECTOR_INGRESS_LIMITS: ConnectorIngressLimits = {
  max_id_length: 255,
  max_event_type_length: 255,
  max_payload_bytes: 262_144,
  max_json_depth: 32,
  max_trace_fields: 16,
  max_error_detail_length: 1_024,
  max_page_limit: 1_000,
  max_claim_limit: 1_000,
  max_lease_seconds: 86_400,
};

const SECRET_PROPERTY =
  /(?:secret|password|token|private[_-]?key|credential)/i;

export class ConnectorContractError extends TypeError {
  constructor(
    readonly code: "invalid_field" | "limit_exceeded" | "forbidden_field",
    message: string,
  ) {
    super(message);
  }
}

export class ConnectorIngressStoreError extends Error {
  constructor(
    readonly code:
      | "dedupe_conflict"
      | "not_found"
      | "invalid_state"
      | "claim_lost",
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

export function resolveConnectorIngressLimits(
  overrides: Partial<ConnectorIngressLimits> = {},
): ConnectorIngressLimits {
  const limits = { ...DEFAULT_CONNECTOR_INGRESS_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  return limits;
}

export function assertSafeConnectorJson(
  value: JsonObject,
  label: string,
  limits: Pick<
    ConnectorIngressLimits,
    "max_payload_bytes" | "max_json_depth"
  >,
): void {
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > limits.max_json_depth) {
      throw new ConnectorContractError(
        "limit_exceeded",
        `${label} exceeds its configured nesting limit`,
      );
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (candidate !== null && typeof candidate === "object") {
      for (const [key, item] of Object.entries(candidate)) {
        if (SECRET_PROPERTY.test(key)) {
          throw new ConnectorContractError(
            "forbidden_field",
            `${label} contains a credential-shaped property`,
          );
        }
        visit(item, depth + 1);
      }
    }
  };

  visit(value, 1);
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.byteLength > limits.max_payload_bytes) {
    throw new ConnectorContractError(
      "limit_exceeded",
      `${label} exceeds its configured byte limit`,
    );
  }
}
