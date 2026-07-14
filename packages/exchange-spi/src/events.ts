import type { JsonObject } from "./json.js";

export interface ProposedEvent {
  readonly event_id: string;
  readonly event_type: string;
  readonly schema_version: "1.0";
  readonly exchange_id: string;
  readonly request_message_id: string;
  readonly idempotency_key: string;
  readonly correlation_id?: string;
  readonly causation_id?: string;
  readonly thread_id: string;
  readonly handoff_id: string;
  readonly actor_id: string;
  readonly endpoint_id: string;
  readonly visibility: "tenant" | "participants" | "restricted" | "public";
  readonly visible_actor_ids: readonly string[];
  readonly visible_endpoint_ids: readonly string[];
  readonly occurred_at: string;
  /** Internal domain data used to replay domain state. */
  readonly domain_data: JsonObject;
  /** Public protocol projection data exposed to protocol consumers. */
  readonly protocol_data: JsonObject;
}

export interface EventRecord extends ProposedEvent {
  readonly tenant_id: string;
  readonly partition_id: string;
  /** Internal journal order within the partition. */
  readonly partition_position: number;
  readonly stream_id: string;
  /** Event order within the individual stream. */
  readonly stream_version: number;
  readonly commit_id: string;
  readonly commit_ordinal: number;
}
