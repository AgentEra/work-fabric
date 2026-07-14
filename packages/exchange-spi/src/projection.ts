import type { ExchangeAdapter } from "./capabilities.js";
import type { JsonObject } from "./json.js";

export const PROJECTION_REQUIRED_CAPABILITIES = [
  "idempotent_upsert",
  "partition_reset",
  "immutable_reads",
] as const;

export interface HandoffReadModel {
  readonly tenant_id: string;
  readonly partition_id: string;
  readonly handoff_id: string;
  readonly stream_version: number;
  readonly state: JsonObject;
  readonly latest_status: JsonObject | null;
}

export interface AssignmentView {
  readonly tenant_id: string;
  readonly handoff_id: string;
  readonly work_reference: JsonObject;
  readonly responsible_actor: JsonObject;
  readonly lifecycle_state: string;
  readonly accept_by: string;
  readonly result_due_at: string;
  readonly latest_status: JsonObject | null;
}

export interface HandoffReadModelStore extends ExchangeAdapter {
  getHandoff(handoffId: string): Promise<HandoffReadModel | null>;
  putHandoff(model: HandoffReadModel): Promise<void>;
  listHandoffs(partitionId: string): Promise<readonly HandoffReadModel[]>;
  clearPartition(partitionId: string): Promise<void>;
}
