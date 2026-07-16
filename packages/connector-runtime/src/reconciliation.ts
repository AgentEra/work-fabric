import { createHash } from "node:crypto";

import {
  assertSafeConnectorJson,
  resolveConnectorIngressLimits,
  type ConnectorIngressLimits,
} from "@work-fabric/connector-spi";
import type { JsonObject } from "@work-fabric/exchange-spi";
import { parseUtcTimestamp } from "@work-fabric/exchange-spi";

export interface ConnectorReconciliationObservation {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly external_object_id: string;
  readonly observed_state: string;
  readonly observed_at: string;
  readonly metadata: JsonObject;
}

export interface ConnectorExpectedState {
  readonly resource_id: string;
  readonly state: string;
  readonly version: number;
}

export interface ConnectorExpectedStateProvider {
  getExpectedState(
    observation: ConnectorReconciliationObservation,
  ): Promise<ConnectorExpectedState | null>;
}

export interface ConnectorDiscrepancy {
  readonly discrepancy_id: string;
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly external_object_id: string;
  readonly resource_id: string | null;
  readonly expected_state: string | null;
  readonly expected_version: number | null;
  readonly observed_state: string;
  readonly observed_at: string;
  readonly metadata: JsonObject;
  readonly status: "open" | "acknowledged";
  readonly version: number;
  readonly acknowledged_at: string | null;
  readonly acknowledged_by: string | null;
  readonly acknowledgement_reason: string | null;
}

export interface ConnectorDiscrepancyWriter {
  put(discrepancy: ConnectorDiscrepancy): Promise<void>;
}

export interface ConnectorDiscrepancyStore extends ConnectorDiscrepancyWriter {
  get(tenantId: string, discrepancyId: string): Promise<ConnectorDiscrepancy | null>;
  list(input: ListConnectorDiscrepancies): Promise<ConnectorDiscrepancyPage>;
  acknowledge(input: AcknowledgeConnectorDiscrepancy): Promise<AcknowledgeDiscrepancyResult>;
}

export interface ListConnectorDiscrepancies {
  readonly tenant_id: string;
  readonly connector_id?: string;
  readonly statuses?: readonly ConnectorDiscrepancy["status"][];
  readonly cursor?: string;
  readonly limit: number;
}

export interface ConnectorDiscrepancyPage {
  readonly items: readonly ConnectorDiscrepancy[];
  readonly next_cursor: string | null;
}

export interface AcknowledgeConnectorDiscrepancy {
  readonly tenant_id: string;
  readonly discrepancy_id: string;
  readonly expected_version: number;
  readonly acknowledged_at: string;
  readonly acknowledged_by: string;
  readonly reason: string;
}

export type AcknowledgeDiscrepancyResult =
  | { readonly kind: "acknowledged" | "replayed"; readonly discrepancy: ConnectorDiscrepancy }
  | { readonly kind: "conflict"; readonly current_version: number }
  | { readonly kind: "not_found" };

export interface ConnectorReconciliationServiceOptions {
  readonly expected_state: ConnectorExpectedStateProvider;
  readonly discrepancies: ConnectorDiscrepancyWriter;
  readonly metadata_limits?: Partial<
    Pick<ConnectorIngressLimits, "max_payload_bytes" | "max_json_depth">
  >;
}

export type ConnectorReconciliationResult =
  | { readonly kind: "matched" }
  | { readonly kind: "discrepancy"; readonly discrepancy: ConnectorDiscrepancy };

function bounded(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value
  ) throw new TypeError(`${label} is invalid`);
}

function discrepancyId(
  observation: ConnectorReconciliationObservation,
  expected: ConnectorExpectedState | null,
): string {
  return `discrepancy_${createHash("sha256")
    .update(observation.tenant_id)
    .update("\0")
    .update(observation.connector_id)
    .update("\0")
    .update(observation.external_object_id)
    .update("\0")
    .update(observation.observed_state)
    .update("\0")
    .update(observation.observed_at)
    .update("\0")
    .update(expected?.resource_id ?? "")
    .update("\0")
    .update(expected?.state ?? "")
    .update("\0")
    .update(String(expected?.version ?? ""))
    .digest("base64url")}`;
}

export class ConnectorReconciliationService {
  private readonly metadataLimits: Pick<
    ConnectorIngressLimits,
    "max_payload_bytes" | "max_json_depth"
  >;

  constructor(private readonly options: ConnectorReconciliationServiceOptions) {
    const limits = resolveConnectorIngressLimits(options.metadata_limits);
    this.metadataLimits = {
      max_payload_bytes: limits.max_payload_bytes,
      max_json_depth: limits.max_json_depth,
    };
  }

  async reconcile(
    input: ConnectorReconciliationObservation,
  ): Promise<ConnectorReconciliationResult> {
    bounded(input.tenant_id, "tenant_id");
    bounded(input.connector_id, "connector_id");
    bounded(input.external_object_id, "external_object_id");
    bounded(input.observed_state, "observed_state");
    parseUtcTimestamp(input.observed_at, "observed_at");
    assertSafeConnectorJson(input.metadata, "reconciliation metadata", this.metadataLimits);
    const observation = structuredClone(input);
    const loaded = await this.options.expected_state.getExpectedState(
      structuredClone(observation),
    );
    const expected = loaded === null ? null : structuredClone(loaded);
    if (expected !== null) {
      bounded(expected.resource_id, "resource_id");
      bounded(expected.state, "expected state");
      if (!Number.isSafeInteger(expected.version) || expected.version <= 0) {
        throw new TypeError("expected version is invalid");
      }
      if (expected.state === observation.observed_state) {
        return { kind: "matched" };
      }
    }
    const discrepancy: ConnectorDiscrepancy = {
      discrepancy_id: discrepancyId(observation, expected),
      tenant_id: observation.tenant_id,
      connector_id: observation.connector_id,
      external_object_id: observation.external_object_id,
      resource_id: expected?.resource_id ?? null,
      expected_state: expected?.state ?? null,
      expected_version: expected?.version ?? null,
      observed_state: observation.observed_state,
      observed_at: observation.observed_at,
      metadata: structuredClone(observation.metadata),
      status: "open",
      version: 1,
      acknowledged_at: null,
      acknowledged_by: null,
      acknowledgement_reason: null,
    };
    await this.options.discrepancies.put(structuredClone(discrepancy));
    return { kind: "discrepancy", discrepancy: structuredClone(discrepancy) };
  }
}
