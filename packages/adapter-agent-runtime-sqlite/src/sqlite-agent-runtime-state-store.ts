import type {
  AgentCapabilityInvocationStore,
  AgentPrivateStateRecord,
  AgentPrivateStateStore,
  AgentRuntimeStateStore,
  CapabilityInvocationRecord,
  CapabilityInvocationState,
  RuntimeCommandRecord,
  RuntimeDeliveryRecord,
  RuntimeDriverResult,
  RuntimeJsonObject,
  RuntimeJsonValue,
  RuntimeRunRecord,
  RuntimeRunState,
} from "@work-fabric/agent-runtime-spi";
import {
  AgentPrivateStateConflictError,
  validateAgentPrivateStateIdentity,
  validateAgentPrivateStatePut,
  validateAgentPrivateStateRecord,
  validateCapabilityCandidate,
  validateCapabilityInvocationRequest,
  validateCapabilityInvocationResult,
} from "@work-fabric/agent-runtime-spi";

import { migrateAgentRuntimeSqlite } from "./migrations.js";
import { SqliteSession, type CallerOwnedSqliteSessionOptions, type SqliteSessionOptions } from "./sqlite-session.js";

type RunRow = Omit<RuntimeRunRecord, "result"> & { result_json: string | null };
type DeliveryRow = RuntimeDeliveryRecord;
type CommandRow = RuntimeCommandRecord;
interface InvocationRow {
  readonly tenant_id: string;
  readonly original_handoff_id: string;
  readonly invocation_id: string;
  readonly state: CapabilityInvocationState;
  readonly request_digest: `sha256:${string}`;
  readonly owner: string | null;
  readonly fencing_token: number;
  readonly lease_expires_at: string | null;
  readonly updated_at: string;
  readonly record_json: string;
}
interface PrivateStateRow {
  readonly tenant_id: string;
  readonly namespace: string;
  readonly state_key: string;
  readonly version: number;
  readonly value_json: string;
  readonly updated_at: string;
}

const RUN_STATES = new Set<RuntimeRunState>(["received", "accepted", "running", "result_ready", "succeeded", "failed", "cancelled"]);
const TRANSITIONS: Readonly<Record<RuntimeRunState, readonly RuntimeRunState[]>> = {
  received: ["accepted", "failed", "cancelled"],
  accepted: ["running", "failed", "cancelled"],
  running: ["result_ready", "failed", "cancelled"],
  result_ready: ["succeeded", "failed", "cancelled"],
  succeeded: [], failed: [], cancelled: [],
};
const INVOCATION_TERMINAL = new Set<CapabilityInvocationState>([
  "succeeded", "rejected", "failed", "cancelled",
]);
const INVOCATION_TRANSITIONS: Readonly<
  Record<CapabilityInvocationState, readonly CapabilityInvocationState[]>
> = {
  requested: ["offered", "rejected", "failed", "cancelled"],
  offered: ["waiting", "succeeded", "rejected", "failed", "cancelled"],
  waiting: ["succeeded", "rejected", "failed", "cancelled"],
  succeeded: [], rejected: [], failed: [], cancelled: [],
};

function clone<T>(value: T): T { return structuredClone(value); }

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/;

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function timestamp(value: string, field: string): string {
  const match = RFC3339.exec(value);
  if (match === null) throw new TypeError(`${field} must be RFC3339`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[7] ?? 0);
  const offsetMinute = Number(match[8] ?? 0);
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new TypeError(`${field} must be RFC3339`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be RFC3339`);
  return new Date(parsed).toISOString();
}

function leaseExpiry(now: string, seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86_400) throw new RangeError("lease_seconds must be between 1 and 86400");
  return new Date(Date.parse(timestamp(now, "now")) + seconds * 1_000).toISOString();
}

function countJsonNode(counter: { value: number }): void {
  counter.value += 1;
  if (counter.value > 10_000) throw new RangeError("Runtime driver result is too deeply nested or large");
}

function validateJson(value: unknown, depth = 0, counter = { value: 0 }): RuntimeJsonValue {
  countJsonNode(counter);
  if (depth > 20) throw new RangeError("Runtime driver result is too deeply nested or large");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 100_000) throw new RangeError("Runtime driver result string is too large");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Runtime driver result must be JSON serializable");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => validateJson(item, depth + 1, counter));
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("Runtime driver result must contain plain JSON values");
  const output: Record<string, RuntimeJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 256) throw new RangeError("Runtime driver result key is too large");
    output[key] = validateJson(item, depth + 1, counter);
  }
  return output;
}

function validateJsonObject(value: unknown, field: string, counter: { value: number }): RuntimeJsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${field} must be an object`);
  }
  return validateJson(value, 0, counter) as RuntimeJsonObject;
}

function validateJsonObjectArray(value: readonly unknown[], field: string, counter: { value: number }): readonly RuntimeJsonObject[] {
  countJsonNode(counter);
  return value.map((item) => validateJsonObject(item, field, counter));
}

function serializeResult(value: RuntimeDriverResult): string {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 4 || !("summary" in value) || !("artifacts" in value) || !("evidence" in value) || !("extensions" in value)) throw new TypeError("Runtime driver result has invalid fields");
  if (!Array.isArray(value.summary) || !Array.isArray(value.artifacts) || !Array.isArray(value.evidence)) throw new TypeError("Runtime driver result collections must be arrays");
  const counter = { value: 0 };
  countJsonNode(counter);
  const result: RuntimeDriverResult = {
    summary: validateJsonObjectArray(value.summary, "summary entry", counter),
    artifacts: validateJsonObjectArray(value.artifacts, "artifact entry", counter),
    evidence: validateJsonObjectArray(value.evidence, "evidence entry", counter),
    extensions: validateJsonObject(value.extensions, "extensions", counter),
  };
  const serialized = JSON.stringify(result);
  if (serialized.length > 1_000_000) throw new RangeError("Runtime driver result is too large");
  return serialized;
}

function runRecord(row: RunRow): RuntimeRunRecord {
  const result = row.result_json === null ? null : JSON.parse(row.result_json) as RuntimeDriverResult;
  return clone({
    tenant_id: row.tenant_id, handoff_id: row.handoff_id, state: row.state, attempt: row.attempt,
    owner: row.owner, fencing_token: row.fencing_token, lease_expires_at: row.lease_expires_at,
    last_progress_sequence: row.last_progress_sequence, result_digest: row.result_digest, result,
    failure_code: row.failure_code, updated_at: row.updated_at,
  });
}

function invocationRecord(row: InvocationRow): CapabilityInvocationRecord {
  return clone(JSON.parse(row.record_json) as CapabilityInvocationRecord);
}

function serializeInvocation(record: CapabilityInvocationRecord): string {
  validateCapabilityInvocationRequest(record.request);
  if (record.candidate !== null) validateCapabilityCandidate(record.candidate);
  if (record.result !== null) validateCapabilityInvocationResult(record.result);
  return JSON.stringify(record);
}

function privateStateRecord(row: PrivateStateRow): AgentPrivateStateRecord {
  return clone(validateAgentPrivateStateRecord({
    tenant_id: row.tenant_id,
    namespace: row.namespace,
    key: row.state_key,
    version: row.version,
    value: JSON.parse(row.value_json) as RuntimeJsonObject,
    updated_at: row.updated_at,
  }));
}

export class SqliteAgentRuntimeStateStore
  implements
    AgentRuntimeStateStore,
    AgentCapabilityInvocationStore,
    AgentPrivateStateStore {
  private readonly session: SqliteSession;
  private closed = false;

  constructor(options: SqliteSessionOptions | CallerOwnedSqliteSessionOptions) {
    this.session = new SqliteSession(options);
    migrateAgentRuntimeSqlite(this.session);
  }

  async recordDelivery(input: RuntimeDeliveryRecord): Promise<{ readonly created: boolean; readonly record: RuntimeDeliveryRecord }> {
    const candidate = clone(input);
    const receivedAt = timestamp(candidate.received_at, "received_at");
    const acknowledgedAt = candidate.acknowledged_at === null ? null : timestamp(candidate.acknowledged_at, "acknowledged_at");
    const record = { ...candidate, received_at: receivedAt, acknowledged_at: acknowledgedAt };
    return this.write(() => {
      const existing = this.session.prepare("SELECT * FROM agent_runtime_deliveries WHERE tenant_id = ? AND delivery_id = ?").get(record.tenant_id, record.delivery_id) as DeliveryRow | undefined;
      if (existing !== undefined) return { created: false, record: clone(existing) };
      this.session.prepare("INSERT INTO agent_runtime_deliveries (tenant_id, delivery_id, handoff_id, partition_id, event_id, received_at, acknowledged_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(record.tenant_id, record.delivery_id, record.handoff_id, record.partition_id, record.event_id, record.received_at, record.acknowledged_at);
      return { created: true, record };
    });
  }

  async markDeliveryAcknowledged(tenantId: string, deliveryId: string, acknowledgedAt: string): Promise<boolean> {
    const normalizedAcknowledgedAt = timestamp(acknowledgedAt, "acknowledgedAt");
    return this.write(() => this.session.prepare("UPDATE agent_runtime_deliveries SET acknowledged_at = ? WHERE tenant_id = ? AND delivery_id = ? AND acknowledged_at IS NULL").run(normalizedAcknowledgedAt, tenantId, deliveryId).changes === 1);
  }

  async createRunIfAbsent(tenantId: string, handoffId: string, now: string): Promise<{ readonly created: boolean; readonly run: RuntimeRunRecord }> {
    const normalizedNow = timestamp(now, "now");
    return this.write(() => {
      const existing = this.getRunRow(tenantId, handoffId);
      if (existing !== undefined) return { created: false, run: runRecord(existing) };
      this.session.prepare("INSERT INTO agent_runtime_runs (tenant_id, handoff_id, state, attempt, owner, fencing_token, lease_expires_at, last_progress_sequence, result_digest, result_json, failure_code, updated_at) VALUES (?, ?, 'received', 0, NULL, 0, NULL, 0, NULL, NULL, NULL, ?)").run(tenantId, handoffId, normalizedNow);
      const row = this.getRunRow(tenantId, handoffId);
      if (row === undefined) throw new Error("failed to create runtime run");
      return { created: true, run: runRecord(row) };
    });
  }

  async claimRun(input: Parameters<AgentRuntimeStateStore["claimRun"]>[0]): Promise<RuntimeRunRecord | null> {
    const candidate = clone(input);
    if (candidate.allowed_states.length === 0 || candidate.allowed_states.some((state) => !RUN_STATES.has(state))) return null;
    const now = timestamp(candidate.now, "now");
    const expiresAt = leaseExpiry(now, candidate.lease_seconds);
    const states = candidate.allowed_states.map(() => "?").join(", ");
    return this.write(() => {
      const row = this.session.prepare(`UPDATE agent_runtime_runs SET owner = ?, fencing_token = fencing_token + 1, lease_expires_at = ?, attempt = attempt + 1, updated_at = ? WHERE tenant_id = ? AND handoff_id = ? AND state IN (${states}) AND state NOT IN ('succeeded', 'failed', 'cancelled') AND (owner IS NULL OR lease_expires_at <= ?) RETURNING *`).get(candidate.owner, expiresAt, now, candidate.tenant_id, candidate.handoff_id, ...candidate.allowed_states, now) as RunRow | undefined;
      return row === undefined ? null : runRecord(row);
    });
  }

  async renewRun(tenantId: string, handoffId: string, owner: string, fencingToken: number, now: string, leaseSeconds: number): Promise<boolean> {
    const normalizedNow = timestamp(now, "now");
    const expiresAt = leaseExpiry(normalizedNow, leaseSeconds);
    return this.write(() => this.session.prepare("UPDATE agent_runtime_runs SET lease_expires_at = ?, updated_at = ? WHERE tenant_id = ? AND handoff_id = ? AND owner = ? AND fencing_token = ? AND lease_expires_at > ?").run(expiresAt, normalizedNow, tenantId, handoffId, owner, fencingToken, normalizedNow).changes === 1);
  }

  async transitionRun(input: Parameters<AgentRuntimeStateStore["transitionRun"]>[0]): Promise<boolean> {
    const candidate = clone(input);
    if (!TRANSITIONS[candidate.expected_state].includes(candidate.next_state) || (candidate.next_state === "result_ready" && candidate.result === undefined) || (candidate.next_state !== "result_ready" && candidate.result !== undefined)) return false;
    const now = timestamp(candidate.now, "now");
    const resultJson = candidate.result === undefined ? undefined : serializeResult(candidate.result);
    return this.write(() => this.session.prepare("UPDATE agent_runtime_runs SET state = ?, updated_at = ?, result_digest = COALESCE(?, result_digest), result_json = COALESCE(?, result_json), failure_code = COALESCE(?, failure_code) WHERE tenant_id = ? AND handoff_id = ? AND owner = ? AND fencing_token = ? AND state = ? AND lease_expires_at > ?").run(candidate.next_state, now, candidate.result_digest ?? null, resultJson ?? null, candidate.failure_code ?? null, candidate.tenant_id, candidate.handoff_id, candidate.owner, candidate.fencing_token, candidate.expected_state, now).changes === 1);
  }

  async checkpointProgress(input: Parameters<AgentRuntimeStateStore["checkpointProgress"]>[0]): Promise<boolean> {
    const candidate = clone(input);
    const now = timestamp(candidate.now, "now");
    return this.write(() => this.session.prepare("UPDATE agent_runtime_runs SET last_progress_sequence = ?, updated_at = ? WHERE tenant_id = ? AND handoff_id = ? AND owner = ? AND fencing_token = ? AND lease_expires_at > ? AND last_progress_sequence < ?").run(candidate.sequence, now, candidate.tenant_id, candidate.handoff_id, candidate.owner, candidate.fencing_token, now, candidate.sequence).changes === 1);
  }

  async recordCommand(input: RuntimeCommandRecord): Promise<{ readonly created: boolean; readonly record: RuntimeCommandRecord }> {
    const candidate = clone(input);
    const recordedAt = timestamp(candidate.recorded_at, "recorded_at");
    const record = { ...candidate, recorded_at: recordedAt };
    return this.write(() => {
      const existing = this.session.prepare("SELECT * FROM agent_runtime_commands WHERE tenant_id = ? AND handoff_id = ? AND idempotency_key = ?").get(record.tenant_id, record.handoff_id, record.idempotency_key) as CommandRow | undefined;
      if (existing !== undefined) {
        if (existing.command !== record.command || existing.resource_version !== record.resource_version) throw new Error("Runtime command idempotency conflict");
        return { created: false, record: clone(existing) };
      }
      this.session.prepare("INSERT INTO agent_runtime_commands (tenant_id, handoff_id, command, idempotency_key, resource_version, recorded_at) VALUES (?, ?, ?, ?, ?, ?)").run(record.tenant_id, record.handoff_id, record.command, record.idempotency_key, record.resource_version, record.recorded_at);
      return { created: true, record };
    });
  }

  async listCommands(tenantId: string, handoffId: string): Promise<readonly RuntimeCommandRecord[]> {
    return this.read(() => (this.session.prepare("SELECT * FROM agent_runtime_commands WHERE tenant_id = ? AND handoff_id = ? ORDER BY recorded_at ASC, idempotency_key ASC").all(tenantId, handoffId) as unknown as CommandRow[]).map(clone));
  }

  async getRun(tenantId: string, handoffId: string): Promise<RuntimeRunRecord | null> {
    return this.read(() => { const row = this.getRunRow(tenantId, handoffId); return row === undefined ? null : runRecord(row); });
  }

  async listRecoverable(tenantId: string, now: string, limit: number): Promise<readonly RuntimeRunRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1_000) throw new RangeError("limit must be between 0 and 1000");
    const normalizedNow = timestamp(now, "now");
    return this.read(() => (this.session.prepare("SELECT * FROM agent_runtime_runs WHERE tenant_id = ? AND state NOT IN ('succeeded', 'failed', 'cancelled') AND (owner IS NULL OR lease_expires_at <= ?) ORDER BY updated_at ASC, handoff_id ASC LIMIT ?").all(tenantId, normalizedNow, limit) as RunRow[]).map(runRecord));
  }

  async createInvocationIfAbsent(
    input: Parameters<AgentCapabilityInvocationStore["createInvocationIfAbsent"]>[0],
  ): Promise<{
    readonly created: boolean;
    readonly record: CapabilityInvocationRecord;
  }> {
    const request = validateCapabilityInvocationRequest(input.request);
    if (!/^sha256:[a-f0-9]{64}$/.test(input.request_digest)) {
      throw new TypeError("request_digest is invalid");
    }
    const now = timestamp(input.now, "now");
    return this.write(() => {
      const existing = this.getInvocationRow(
        input.tenant_id,
        request.original_handoff_id,
        request.invocation_id,
      );
      if (existing !== undefined) {
        if (existing.request_digest !== input.request_digest) {
          throw new Error("Capability invocation idempotency conflict");
        }
        return { created: false, record: invocationRecord(existing) };
      }
      const record: CapabilityInvocationRecord = {
        tenant_id: input.tenant_id,
        original_handoff_id: request.original_handoff_id,
        invocation_id: request.invocation_id,
        state: "requested",
        request_digest: input.request_digest,
        request,
        candidate: null,
        auxiliary_handoff_id: null,
        result: null,
        attempt: 0,
        owner: null,
        fencing_token: 0,
        lease_expires_at: null,
        created_at: now,
        updated_at: now,
      };
      this.session.prepare(`
        INSERT INTO agent_capability_invocations (
          tenant_id, original_handoff_id, invocation_id, state,
          request_digest, owner, fencing_token, lease_expires_at,
          updated_at, record_json
        ) VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)
      `).run(
        record.tenant_id,
        record.original_handoff_id,
        record.invocation_id,
        record.state,
        record.request_digest,
        record.updated_at,
        serializeInvocation(record),
      );
      return { created: true, record: clone(record) };
    });
  }

  async claimInvocation(
    input: Parameters<AgentCapabilityInvocationStore["claimInvocation"]>[0],
  ): Promise<CapabilityInvocationRecord | null> {
    const now = timestamp(input.now, "now");
    const expiresAt = leaseExpiry(now, input.lease_seconds);
    return this.write(() => {
      const row = this.getInvocationRow(
        input.tenant_id,
        input.original_handoff_id,
        input.invocation_id,
      );
      if (
        row === undefined ||
        INVOCATION_TERMINAL.has(row.state) ||
        !input.allowed_states.includes(row.state) ||
        (row.lease_expires_at !== null && row.lease_expires_at > now)
      ) return null;
      const current = invocationRecord(row);
      const claimed: CapabilityInvocationRecord = {
        ...current,
        owner: input.owner,
        fencing_token: current.fencing_token + 1,
        lease_expires_at: expiresAt,
        attempt: current.attempt + 1,
        updated_at: now,
      };
      const changed = this.session.prepare(`
        UPDATE agent_capability_invocations
        SET owner = ?, fencing_token = ?, lease_expires_at = ?,
            updated_at = ?, record_json = ?
        WHERE tenant_id = ? AND original_handoff_id = ? AND invocation_id = ?
          AND fencing_token = ?
      `).run(
        claimed.owner,
        claimed.fencing_token,
        claimed.lease_expires_at,
        claimed.updated_at,
        serializeInvocation(claimed),
        claimed.tenant_id,
        claimed.original_handoff_id,
        claimed.invocation_id,
        current.fencing_token,
      ).changes;
      return changed === 1 ? clone(claimed) : null;
    });
  }

  async transitionInvocation(
    input: Parameters<AgentCapabilityInvocationStore["transitionInvocation"]>[0],
  ): Promise<boolean> {
    const now = timestamp(input.now, "now");
    return this.write(() => {
      const row = this.getInvocationRow(
        input.tenant_id,
        input.original_handoff_id,
        input.invocation_id,
      );
      if (
        row === undefined ||
        row.owner !== input.owner ||
        row.fencing_token !== input.fencing_token ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= now ||
        row.state !== input.expected_state ||
        !INVOCATION_TRANSITIONS[input.expected_state].includes(input.next_state)
      ) return false;
      const current = invocationRecord(row);
      let boundCandidate = current.candidate;
      let auxiliaryHandoffId = current.auxiliary_handoff_id;
      if (input.next_state === "offered") {
        if (
          input.candidate === undefined ||
          input.auxiliary_handoff_id === undefined ||
          input.result !== undefined
        ) return false;
        boundCandidate = validateCapabilityCandidate(input.candidate);
        auxiliaryHandoffId = input.auxiliary_handoff_id;
      } else if (
        input.candidate !== undefined ||
        input.auxiliary_handoff_id !== undefined
      ) return false;
      let result = current.result;
      if (INVOCATION_TERMINAL.has(input.next_state)) {
        if (input.next_state === "cancelled") {
          if (input.result !== undefined) return false;
        } else {
          if (input.result === undefined) return false;
          result = validateCapabilityInvocationResult(input.result);
          if (
            result.invocation_id !== current.invocation_id ||
            result.outcome !== input.next_state ||
            result.auxiliary_handoff_id !== auxiliaryHandoffId
          ) return false;
        }
      } else if (input.result !== undefined) return false;
      if (
        input.next_state === "waiting" &&
        (boundCandidate === null || auxiliaryHandoffId === null)
      ) return false;
      const next: CapabilityInvocationRecord = {
        ...current,
        state: input.next_state,
        candidate: boundCandidate,
        auxiliary_handoff_id: auxiliaryHandoffId,
        result,
        updated_at: now,
      };
      return this.session.prepare(`
        UPDATE agent_capability_invocations
        SET state = ?, updated_at = ?, record_json = ?
        WHERE tenant_id = ? AND original_handoff_id = ? AND invocation_id = ?
          AND owner = ? AND fencing_token = ? AND state = ?
          AND lease_expires_at > ?
      `).run(
        next.state,
        next.updated_at,
        serializeInvocation(next),
        next.tenant_id,
        next.original_handoff_id,
        next.invocation_id,
        input.owner,
        input.fencing_token,
        input.expected_state,
        now,
      ).changes === 1;
    });
  }

  async getInvocation(
    tenantId: string,
    originalHandoffId: string,
    invocationId: string,
  ): Promise<CapabilityInvocationRecord | null> {
    return this.read(() => {
      const row = this.getInvocationRow(
        tenantId,
        originalHandoffId,
        invocationId,
      );
      return row === undefined ? null : invocationRecord(row);
    });
  }

  async listRecoverableInvocations(
    tenantId: string,
    now: string,
    limit: number,
  ): Promise<readonly CapabilityInvocationRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1_000) {
      throw new RangeError("limit must be between 0 and 1000");
    }
    const normalizedNow = timestamp(now, "now");
    return this.read(() => (this.session.prepare(`
      SELECT * FROM agent_capability_invocations
      WHERE tenant_id = ?
        AND state NOT IN ('succeeded','rejected','failed','cancelled')
        AND (owner IS NULL OR lease_expires_at <= ?)
      ORDER BY updated_at ASC, invocation_id ASC
      LIMIT ?
    `).all(tenantId, normalizedNow, limit) as unknown as InvocationRow[])
      .map(invocationRecord));
  }

  async getPrivateState(
    tenantId: string,
    namespace: string,
    key: string,
  ): Promise<AgentPrivateStateRecord | null> {
    const identity = validateAgentPrivateStateIdentity(
      tenantId,
      namespace,
      key,
    );
    return this.read(() => {
      const row = this.getPrivateStateRow(
        identity.tenant_id,
        identity.namespace,
        identity.key,
      );
      return row === undefined ? null : privateStateRecord(row);
    });
  }

  async putPrivateState(
    input: Parameters<AgentPrivateStateStore["putPrivateState"]>[0],
  ): Promise<AgentPrivateStateRecord> {
    const candidate = validateAgentPrivateStatePut(input);
    const valueJson = JSON.stringify(candidate.value);
    return this.write(() => {
      const current = this.getPrivateStateRow(
        candidate.tenant_id,
        candidate.namespace,
        candidate.key,
      );
      if (current === undefined) {
        if (candidate.expected_version !== 0) {
          throw new AgentPrivateStateConflictError();
        }
        this.session.prepare(`
          INSERT INTO agent_private_state
            (tenant_id, namespace, state_key, version, value_json, updated_at)
          VALUES (?, ?, ?, 1, ?, ?)
        `).run(
          candidate.tenant_id,
          candidate.namespace,
          candidate.key,
          valueJson,
          candidate.updated_at,
        );
      } else {
        if (current.version !== candidate.expected_version) {
          throw new AgentPrivateStateConflictError();
        }
        const changed = this.session.prepare(`
          UPDATE agent_private_state
          SET version = version + 1, value_json = ?, updated_at = ?
          WHERE tenant_id = ? AND namespace = ? AND state_key = ?
            AND version = ?
        `).run(
          valueJson,
          candidate.updated_at,
          candidate.tenant_id,
          candidate.namespace,
          candidate.key,
          candidate.expected_version,
        ).changes;
        if (changed !== 1) throw new AgentPrivateStateConflictError();
      }
      const record = this.getPrivateStateRow(
        candidate.tenant_id,
        candidate.namespace,
        candidate.key,
      );
      if (record === undefined) {
        throw new Error("failed to persist Agent private state");
      }
      return privateStateRecord(record);
    });
  }

  async close(): Promise<void> { if (!this.closed) { this.closed = true; this.session.close(); } }

  private getRunRow(tenantId: string, handoffId: string): RunRow | undefined { return this.session.prepare("SELECT * FROM agent_runtime_runs WHERE tenant_id = ? AND handoff_id = ?").get(tenantId, handoffId) as RunRow | undefined; }
  private getInvocationRow(
    tenantId: string,
    originalHandoffId: string,
    invocationId: string,
  ): InvocationRow | undefined {
    return this.session.prepare(`
      SELECT * FROM agent_capability_invocations
      WHERE tenant_id = ? AND original_handoff_id = ? AND invocation_id = ?
    `).get(tenantId, originalHandoffId, invocationId) as InvocationRow | undefined;
  }
  private getPrivateStateRow(
    tenantId: string,
    namespace: string,
    key: string,
  ): PrivateStateRow | undefined {
    return this.session.prepare(`
      SELECT tenant_id, namespace, state_key, version, value_json, updated_at
      FROM agent_private_state
      WHERE tenant_id = ? AND namespace = ? AND state_key = ?
    `).get(tenantId, namespace, key) as PrivateStateRow | undefined;
  }
  private read<T>(operation: () => T): T { this.ensureOpen(); return operation(); }
  private write<T>(operation: () => T): T { this.ensureOpen(); return this.session.transaction(operation, "IMMEDIATE"); }
  private ensureOpen(): void { if (this.closed) throw new Error("Runtime state store is closed"); }
}
