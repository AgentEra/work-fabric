import type { JsonObject } from "@work-fabric/exchange-spi";

import type { ActorRef, HandoffPackage } from "./handoff-types.js";

interface HandoffEventBase {
  readonly handoff_id: string;
  readonly occurred_at: string;
}

export interface HandoffOfferedEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.offered.v1";
  readonly thread_id: string;
  readonly initiator: ActorRef;
  readonly package: HandoffPackage;
  readonly parent_handoff_id: string | null;
}

export interface HandoffAcceptedEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.accepted.v1";
  readonly recipient: ActorRef;
}

export interface HandoffDeclinedEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.declined.v1";
}

export interface HandoffExpiredEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.expired.v1";
}

export interface HandoffCancelledEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.cancelled.v1";
  readonly reason: readonly JsonObject[];
}

export interface HandoffStatusReportedEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.status_reported.v1";
  readonly status: JsonObject;
}

export interface HandoffResultReturnedEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.result_returned.v1";
  readonly result: JsonObject;
}

export interface HandoffVerifiedEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.verified.v1";
  readonly satisfied_criterion_ids: readonly string[];
  readonly summary: readonly JsonObject[];
  readonly evidence: readonly JsonObject[];
}

export interface HandoffClosedEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.closed.v1";
}

export interface HandoffReworkRequestedEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.rework_requested.v1";
  readonly criterion_ids: readonly string[];
  readonly reason: readonly JsonObject[];
}

export interface HandoffTransferredEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.transferred.v1";
  readonly child_handoff_id: string;
}

export type HandoffEvent =
  | HandoffOfferedEvent
  | HandoffAcceptedEvent
  | HandoffDeclinedEvent
  | HandoffExpiredEvent
  | HandoffCancelledEvent
  | HandoffStatusReportedEvent
  | HandoffResultReturnedEvent
  | HandoffVerifiedEvent
  | HandoffClosedEvent
  | HandoffReworkRequestedEvent
  | HandoffTransferredEvent;
