import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  CONNECTOR_INGRESS_REQUIRED_CAPABILITIES,
  assertBoundedConnectorId,
  assertSafeConnectorJson,
  resolveConnectorIngressLimits,
  type AcceptConnectorIngressResult,
  type ClaimConnectorIngress,
  type ConnectorIngressClaim,
  type ConnectorIngressClaimMutation,
  type ConnectorIngressEnvelope,
  type ConnectorIngressPage,
  type ConnectorIngressLimits,
  type ConnectorIngressRecord,
  type ConnectorIngressStore,
  type DeadLetterConnectorIngress,
  type GetConnectorIngress,
  type ListConnectorIngress,
  type RequeueConnectorIngress,
  type RetryConnectorIngress,
} from "@work-fabric/connector-spi";
import {
  addUtcTimestampSeconds,
  assertCapabilities,
  compareUtcTimestamps,
  parseUtcTimestamp,
  type CapabilityManifest,
} from "@work-fabric/exchange-spi";

const baseManifest: CapabilityManifest = {
  profile: "connector.ingress.v1",
  adapter: "memory",
  capabilities: Object.fromEntries(
    CONNECTOR_INGRESS_REQUIRED_CAPABILITIES.map((capability) => [
      capability,
      true,
    ]),
  ),
};

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

interface StoredConnectorIngress
  extends Omit<Mutable<ConnectorIngressRecord>, "state"> {
  state:
    | "pending"
    | "processing"
    | "retry_wait"
    | "completed"
    | "dead_letter";
  attempt: number;
  available_at: string;
  updated_at: string;
  fencing_token: number;
  claim_owner?: string;
  claim_token?: string;
  lease_expires_at?: string;
}

export interface MemoryConnectorIngressStoreOptions {
  readonly id_factory?: () => string;
  readonly claim_token_factory?: () => string;
  readonly limits?: Partial<ConnectorIngressLimits>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function dedupeKey(envelope: ConnectorIngressEnvelope): string {
  return JSON.stringify([
    envelope.tenant_id,
    envelope.connector_id,
    envelope.source_system,
    envelope.dedupe_key,
  ]);
}

function validateEnvelope(
  envelope: ConnectorIngressEnvelope,
  limits: ConnectorIngressLimits,
): void {
  for (const [label, value] of [
    ["tenant_id", envelope.tenant_id],
    ["connector_id", envelope.connector_id],
    ["source_system", envelope.source_system],
    ["external_tenant_id", envelope.external_tenant_id],
    ["external_event_id", envelope.external_event_id],
    ["dedupe_key", envelope.dedupe_key],
    ["event_type", envelope.event_type],
  ] as const) {
    assertBoundedConnectorId(value, label, limits.max_id_length);
  }
  if (envelope.partition_key !== undefined) {
    assertBoundedConnectorId(
      envelope.partition_key,
      "partition_key",
      limits.max_id_length,
    );
  }
  parseUtcTimestamp(envelope.occurred_at, "occurred_at");
  parseUtcTimestamp(envelope.received_at, "received_at");
  assertSafeConnectorJson(envelope.payload, "payload", limits);
  if (envelope.trace_context !== undefined) {
    if (Object.keys(envelope.trace_context).length > limits.max_trace_fields) {
      throw new RangeError("trace_context exceeds its configured field limit");
    }
    assertSafeConnectorJson(envelope.trace_context, "trace_context", limits);
  }
}

function validateScope(
  tenantId: string,
  connectorId: string,
  limits: ConnectorIngressLimits,
): void {
  assertBoundedConnectorId(tenantId, "tenant_id", limits.max_id_length);
  assertBoundedConnectorId(connectorId, "connector_id", limits.max_id_length);
}

function validateLimit(limit: number, maximum: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maximum) {
    throw new RangeError(`limit must be between 1 and ${maximum}`);
  }
}

function publicRecord(record: StoredConnectorIngress): ConnectorIngressRecord {
  const {
    claim_owner: _claimOwner,
    claim_token: _claimToken,
    lease_expires_at: _leaseExpiresAt,
    fencing_token: _fencingToken,
    ...value
  } = record;
  return clone(value);
}

function publicClaim(record: StoredConnectorIngress): ConnectorIngressClaim {
  if (
    record.state !== "processing" ||
    record.claim_owner === undefined ||
    record.claim_token === undefined ||
    record.lease_expires_at === undefined
  ) {
    throw new Error("Connector ingress record does not hold an active claim");
  }
  return clone({
    ...publicRecord(record),
    state: "processing" as const,
    claim_owner: record.claim_owner,
    claim_token: record.claim_token,
    fencing_token: record.fencing_token,
    lease_expires_at: record.lease_expires_at,
  });
}

function clearClaim(record: StoredConnectorIngress): void {
  delete record.claim_owner;
  delete record.claim_token;
  delete record.lease_expires_at;
}

function encodeCursor(
  input: ListConnectorIngress,
  record: ConnectorIngressRecord,
): string {
  return Buffer.from(
    JSON.stringify({
      tenant_id: input.tenant_id,
      connector_id: input.connector_id,
      accepted_at: record.accepted_at,
      ingress_id: record.ingress_id,
    }),
  ).toString("base64url");
}

function decodeCursor(input: ListConnectorIngress): {
  readonly accepted_at: string;
  readonly ingress_id: string;
} | null {
  if (input.cursor === undefined) return null;
  try {
    const value = JSON.parse(
      Buffer.from(input.cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      value.tenant_id !== input.tenant_id ||
      value.connector_id !== input.connector_id ||
      typeof value.accepted_at !== "string" ||
      typeof value.ingress_id !== "string"
    ) {
      throw new Error("cursor scope mismatch");
    }
    parseUtcTimestamp(value.accepted_at, "cursor accepted_at");
    return {
      accepted_at: value.accepted_at,
      ingress_id: value.ingress_id,
    };
  } catch {
    throw new TypeError("invalid Connector ingress cursor");
  }
}

function compareRecordOrder(
  left: ConnectorIngressRecord,
  right: ConnectorIngressRecord,
): number {
  const time = compareUtcTimestamps(left.accepted_at, right.accepted_at);
  if (time !== 0) return time;
  return left.ingress_id < right.ingress_id
    ? -1
    : left.ingress_id > right.ingress_id
      ? 1
      : 0;
}

export class MemoryConnectorIngressStore implements ConnectorIngressStore {
  private readonly records = new Map<string, StoredConnectorIngress>();
  private readonly dedupe = new Map<string, string>();
  private readonly idFactory: () => string;
  private readonly claimTokenFactory: () => string;
  private readonly limits: ConnectorIngressLimits;

  constructor(options: MemoryConnectorIngressStoreOptions = {}) {
    this.idFactory = options.id_factory ?? randomUUID;
    this.claimTokenFactory = options.claim_token_factory ?? randomUUID;
    this.limits = resolveConnectorIngressLimits(options.limits);
  }

  get manifest(): CapabilityManifest {
    const value = clone(baseManifest);
    assertCapabilities(value, CONNECTOR_INGRESS_REQUIRED_CAPABILITIES);
    return value;
  }

  async accept(
    envelope: ConnectorIngressEnvelope,
  ): Promise<AcceptConnectorIngressResult> {
    validateEnvelope(envelope, this.limits);
    const candidate = clone(envelope);
    const key = dedupeKey(candidate);
    const existingId = this.dedupe.get(key);
    if (existingId !== undefined) {
      const existing = this.records.get(existingId);
      if (existing === undefined) throw new Error("dedupe index is inconsistent");
      if (!isDeepStrictEqual(existing.envelope, candidate)) {
        throw new Error("Connector ingress dedupe key conflicts with payload");
      }
      return { kind: "duplicate", record: publicRecord(existing) };
    }

    const ingressId = this.idFactory();
    assertBoundedConnectorId(
      ingressId,
      "ingress_id",
      this.limits.max_id_length,
    );
    if (this.records.has(ingressId)) {
      throw new Error("Connector ingress ID already exists");
    }
    const record: StoredConnectorIngress = {
      ingress_id: ingressId,
      envelope: candidate,
      state: "pending",
      attempt: 0,
      available_at: candidate.received_at,
      accepted_at: candidate.received_at,
      updated_at: candidate.received_at,
      fencing_token: 0,
    };
    this.records.set(ingressId, record);
    this.dedupe.set(key, ingressId);
    return { kind: "accepted", record: publicRecord(record) };
  }

  async claim(
    input: ClaimConnectorIngress,
  ): Promise<readonly ConnectorIngressClaim[]> {
    validateScope(input.tenant_id, input.connector_id, this.limits);
    assertBoundedConnectorId(
      input.worker_id,
      "worker_id",
      this.limits.max_id_length,
    );
    validateLimit(input.limit, this.limits.max_claim_limit);
    parseUtcTimestamp(input.now, "now");
    if (
      !Number.isSafeInteger(input.lease_seconds) ||
      input.lease_seconds <= 0 ||
      input.lease_seconds > this.limits.max_lease_seconds
    ) {
      throw new RangeError(
        `lease_seconds must be between 1 and ${this.limits.max_lease_seconds}`,
      );
    }

    const eligible = [...this.records.values()]
      .filter((record) => {
        if (
          record.envelope.tenant_id !== input.tenant_id ||
          record.envelope.connector_id !== input.connector_id
        ) {
          return false;
        }
        if (
          (record.state === "pending" || record.state === "retry_wait") &&
          compareUtcTimestamps(record.available_at, input.now) <= 0
        ) {
          return true;
        }
        return (
          record.state === "processing" &&
          record.lease_expires_at !== undefined &&
          compareUtcTimestamps(record.lease_expires_at, input.now) <= 0
        );
      })
      .sort((left, right) => {
        const availability = compareUtcTimestamps(
          left.available_at,
          right.available_at,
        );
        if (availability !== 0) return availability;
        const received = compareUtcTimestamps(
          left.envelope.received_at,
          right.envelope.received_at,
        );
        if (received !== 0) return received;
        return left.ingress_id < right.ingress_id
          ? -1
          : left.ingress_id > right.ingress_id
            ? 1
            : 0;
      })
      .slice(0, input.limit);

    return eligible.map((record) => {
      record.state = "processing";
      record.attempt += 1;
      record.fencing_token += 1;
      record.claim_owner = input.worker_id;
      record.claim_token = this.claimTokenFactory();
      assertBoundedConnectorId(
        record.claim_token,
        "claim_token",
        this.limits.max_id_length,
      );
      record.lease_expires_at = addUtcTimestampSeconds(
        input.now,
        input.lease_seconds,
      );
      record.updated_at = input.now;
      return publicClaim(record);
    });
  }

  async complete(
    input: ConnectorIngressClaimMutation,
  ): Promise<ConnectorIngressRecord> {
    const record = this.requireClaim(input);
    record.state = "completed";
    record.updated_at = input.now;
    record.completed_at = input.now;
    delete record.last_error_code;
    delete record.last_error_detail;
    clearClaim(record);
    return publicRecord(record);
  }

  async retry(input: RetryConnectorIngress): Promise<ConnectorIngressRecord> {
    const record = this.requireClaim(input);
    parseUtcTimestamp(input.available_at, "available_at");
    assertBoundedConnectorId(
      input.error_code,
      "error_code",
      this.limits.max_id_length,
    );
    this.validateErrorDetail(input.error_detail);
    record.state = "retry_wait";
    record.available_at = input.available_at;
    record.updated_at = input.now;
    record.last_error_code = input.error_code;
    if (input.error_detail === undefined) delete record.last_error_detail;
    else record.last_error_detail = input.error_detail;
    clearClaim(record);
    return publicRecord(record);
  }

  async deadLetter(
    input: DeadLetterConnectorIngress,
  ): Promise<ConnectorIngressRecord> {
    const record = this.requireClaim(input);
    assertBoundedConnectorId(
      input.error_code,
      "error_code",
      this.limits.max_id_length,
    );
    this.validateErrorDetail(input.error_detail);
    record.state = "dead_letter";
    record.updated_at = input.now;
    record.last_error_code = input.error_code;
    if (input.error_detail === undefined) delete record.last_error_detail;
    else record.last_error_detail = input.error_detail;
    clearClaim(record);
    return publicRecord(record);
  }

  async requeue(
    input: RequeueConnectorIngress,
  ): Promise<ConnectorIngressRecord> {
    validateScope(input.tenant_id, input.connector_id, this.limits);
    parseUtcTimestamp(input.now, "now");
    parseUtcTimestamp(input.available_at, "available_at");
    assertBoundedConnectorId(
      input.reason,
      "reason",
      this.limits.max_error_detail_length,
    );
    const record = this.requireScopedRecord(input);
    if (record.state !== "dead_letter") {
      throw new Error("Only a dead-letter Connector ingress can be requeued");
    }
    record.state = "retry_wait";
    record.available_at = input.available_at;
    record.updated_at = input.now;
    record.last_requeue_reason = input.reason;
    record.last_requeued_at = input.now;
    delete record.last_error_code;
    delete record.last_error_detail;
    return publicRecord(record);
  }

  async get(
    input: GetConnectorIngress,
  ): Promise<ConnectorIngressRecord | null> {
    validateScope(input.tenant_id, input.connector_id, this.limits);
    const record = this.records.get(input.ingress_id);
    return record !== undefined &&
      record.envelope.tenant_id === input.tenant_id &&
      record.envelope.connector_id === input.connector_id
      ? publicRecord(record)
      : null;
  }

  async list(input: ListConnectorIngress): Promise<ConnectorIngressPage> {
    validateScope(input.tenant_id, input.connector_id, this.limits);
    validateLimit(input.limit, this.limits.max_page_limit);
    const after = decodeCursor(input);
    const states = input.states === undefined ? null : new Set(input.states);
    const values = [...this.records.values()]
      .filter((record) => {
        if (
          record.envelope.tenant_id !== input.tenant_id ||
          record.envelope.connector_id !== input.connector_id ||
          (states !== null && !states.has(record.state))
        ) {
          return false;
        }
        if (after === null) return true;
        const time = compareUtcTimestamps(record.accepted_at, after.accepted_at);
        return time > 0 || (time === 0 && record.ingress_id > after.ingress_id);
      })
      .sort(compareRecordOrder);
    const items = values.slice(0, input.limit).map(publicRecord);
    return {
      items,
      ...(values.length > input.limit
        ? { next_cursor: encodeCursor(input, items.at(-1)!) }
        : {}),
    };
  }

  private requireClaim(
    input: ConnectorIngressClaimMutation,
  ): StoredConnectorIngress {
    validateScope(input.tenant_id, input.connector_id, this.limits);
    parseUtcTimestamp(input.now, "now");
    const record = this.requireScopedRecord(input);
    if (
      record.state !== "processing" ||
      record.claim_token !== input.claim_token ||
      record.fencing_token !== input.fencing_token ||
      record.lease_expires_at === undefined ||
      compareUtcTimestamps(record.lease_expires_at, input.now) <= 0
    ) {
      throw new Error("Connector ingress claim is stale or invalid");
    }
    return record;
  }

  private requireScopedRecord(input: {
    readonly tenant_id: string;
    readonly connector_id: string;
    readonly ingress_id: string;
  }): StoredConnectorIngress {
    const record = this.records.get(input.ingress_id);
    if (
      record === undefined ||
      record.envelope.tenant_id !== input.tenant_id ||
      record.envelope.connector_id !== input.connector_id
    ) {
      throw new Error("Connector ingress record was not found");
    }
    return record;
  }

  private validateErrorDetail(detail: string | undefined): void {
    if (
      detail !== undefined &&
      detail.length > this.limits.max_error_detail_length
    ) {
      throw new RangeError("error_detail exceeds its configured limit");
    }
  }
}
