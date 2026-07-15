import type { CapabilityManifest } from "./capabilities.js";
import type { EventRecord, ProposedEvent } from "./events.js";
import type { JsonObject } from "./json.js";

export interface StreamAppend {
  readonly stream_id: string;
  readonly expected_version: number;
  readonly events: readonly ProposedEvent[];
}

export interface StreamVersionCheck {
  readonly stream_id: string;
  readonly expected_version: number;
}

export interface NormalizedOperationOutcome {
  readonly operation_status:
    | "accepted"
    | "rejected"
    | "conflict"
    | "temporarily_unavailable";
  readonly resource: JsonObject | null;
  readonly receipt: JsonObject | null;
  readonly error: JsonObject | null;
}

export interface AtomicCommitRequest {
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly commit_id: string;
  readonly idempotency_key: string;
  readonly payload_digest: string;
  readonly request_message_id: string;
  /** A temporarily_unavailable outcome must never be persisted. */
  readonly outcome: NormalizedOperationOutcome;
  /** Read-only optimistic preconditions evaluated atomically with appends. */
  readonly version_checks: readonly StreamVersionCheck[];
  /** Empty only when persisting a deterministic eventless outcome. */
  readonly appends: readonly StreamAppend[];
}

export type AtomicCommitResult =
  | { readonly kind: "committed"; readonly events: readonly EventRecord[] }
  | { readonly kind: "replayed"; readonly outcome: NormalizedOperationOutcome }
  | { readonly kind: "idempotency_key_reused" }
  | {
      readonly kind: "version_conflict";
      readonly current_versions: Readonly<Record<string, number>>;
    };

export const PERSISTENCE_REQUIRED_CAPABILITIES = [
  "expected_stream_version",
  "ordered_streams",
  "atomic_multi_stream_append",
  "transactional_idempotency",
  "partitioned_journal",
  "immutable_events",
  "active_delivery_cas",
  "atomic_delivery_settlement",
  "idempotent_dead_letters",
] as const;

export interface CommandRecord {
  readonly tenant_id: string;
  readonly idempotency_key: string;
  readonly payload_digest: string;
  readonly first_request_message_id: string;
  readonly outcome: NormalizedOperationOutcome;
}

export interface EventJournal {
  readStream(
    streamId: string,
    fromVersion?: number,
  ): Promise<readonly EventRecord[]>;
  readPartition(
    partitionId: string,
    afterPosition: number,
    limit: number,
  ): Promise<readonly EventRecord[]>;
}

export interface CommandDeduplication {
  findCommand(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<CommandRecord | null>;
}

export interface ExchangeTransaction {
  commitAtomically(request: AtomicCommitRequest): Promise<AtomicCommitResult>;
}

export interface SnapshotRecord {
  readonly stream_id: string;
  readonly stream_version: number;
  readonly schema_version: string;
  readonly state: JsonObject;
}

export interface SnapshotRepository {
  loadSnapshot(streamId: string): Promise<SnapshotRecord | null>;
  saveSnapshot(snapshot: SnapshotRecord): Promise<void>;
  deleteSnapshot(streamId: string): Promise<void>;
}

export interface ExchangePersistence
  extends EventJournal,
    CommandDeduplication,
    ExchangeTransaction,
    SnapshotRepository {
  readonly manifest: CapabilityManifest;
}
