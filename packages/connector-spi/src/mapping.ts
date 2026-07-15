import type {
  CapabilityManifest,
  ExchangeAdapter,
  JsonObject,
} from "@work-fabric/exchange-spi";

import type { ConnectorIngressClaim } from "./ingress.js";
import type { ConnectorExternalReference } from "./resource.js";

export interface ConnectorResolvedIdentity {
  readonly actor_id: string;
  readonly endpoint_id?: string;
  readonly delegation_id?: string;
}

export interface ConnectorIdentityQuery {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly source_system: string;
  readonly external_tenant_id: string;
  readonly external_subject_type: string;
  readonly external_subject_id: string;
}

export interface ConnectorIdentityResolver extends ExchangeAdapter {
  readonly manifest: CapabilityManifest;
  resolve(
    query: ConnectorIdentityQuery,
  ): Promise<ConnectorResolvedIdentity | null>;
}

export interface ConnectorCommandDescriptor {
  readonly operation: string;
  readonly idempotency_key: string;
  readonly expected_version?: number;
  readonly identity: ConnectorResolvedIdentity;
  readonly input: JsonObject;
}

export interface ConnectorReconciliationObservation {
  readonly external_object_id: string;
  readonly observed_state: string;
  readonly observed_at: string;
  readonly metadata: JsonObject;
}

export type ConnectorMappingOutcome =
  | { readonly kind: "ignored"; readonly reason_code: string }
  | {
      readonly kind: "reference_observed";
      readonly reference: ConnectorExternalReference;
    }
  | { readonly kind: "command"; readonly command: ConnectorCommandDescriptor }
  | {
      readonly kind: "reconciliation_observation";
      readonly observation: ConnectorReconciliationObservation;
    }
  | {
      readonly kind: "rejected";
      readonly reason_code: string;
      readonly retryable: boolean;
      readonly detail?: string;
    };

export interface ConnectorEventMapper extends ExchangeAdapter {
  readonly manifest: CapabilityManifest;
  map(claim: ConnectorIngressClaim): Promise<ConnectorMappingOutcome>;
}

export interface ConnectorCommandExecution {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly ingress_id: string;
  readonly command: ConnectorCommandDescriptor;
}

export type ConnectorCommandResult =
  | {
      readonly kind: "accepted";
      readonly receipt_id: string;
      readonly event_ids: readonly string[];
    }
  | {
      readonly kind: "retryable_failure";
      readonly error_code: string;
      readonly detail?: string;
    }
  | {
      readonly kind: "permanent_failure";
      readonly error_code: string;
      readonly detail?: string;
    };

export interface ConnectorCommandSink extends ExchangeAdapter {
  readonly manifest: CapabilityManifest;
  execute(input: ConnectorCommandExecution): Promise<ConnectorCommandResult>;
}
