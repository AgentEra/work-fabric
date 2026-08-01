import type { JsonObject } from "@work-fabric/exchange-spi";

import type {
  ActorRef,
  HandoffClaim,
  HandoffPackage,
  TargetBinding,
} from "./handoff-types.js";

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

export interface HandoffTargetResolutionRequestedEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.target_resolution_requested.v1";
  readonly thread_id: string;
  readonly initiator: ActorRef;
  readonly package: HandoffPackage;
  readonly parent_handoff_id: string | null;
}

export interface HandoffClaimPoolOpenedEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.claim_pool_opened.v1";
  readonly thread_id: string;
  readonly initiator: ActorRef;
  readonly package: HandoffPackage;
  readonly parent_handoff_id: string | null;
}

export interface HandoffTargetResolvedEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.target_resolved.v1";
  readonly binding: TargetBinding;
}

export interface HandoffTargetUnavailableEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.target_unavailable.v1";
  readonly resolved_by: ActorRef;
  readonly resolver_endpoint_id: string;
  readonly delegation_id: string | null;
  readonly reason_code:
    | "no_candidate"
    | "no_eligible_target"
    | "policy_rejected"
    | "resolver_unavailable";
  readonly reason: readonly JsonObject[];
  readonly evidence: readonly JsonObject[];
}

export interface HandoffClaimedEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.claimed.v1";
  readonly claim: HandoffClaim;
}

export interface HandoffClaimRenewedEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.claim_renewed.v1";
  readonly claim: HandoffClaim;
}

export interface HandoffClaimReleasedEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.claim_released.v1";
  readonly claim_id: string;
  readonly actor: ActorRef;
  readonly endpoint_id: string;
  readonly fencing_token: number;
  readonly heartbeat_sequence: number;
}

export interface HandoffClaimExpiredEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.claim_expired.v1";
  readonly claim_id: string;
  readonly actor: ActorRef;
  readonly endpoint_id: string;
  readonly fencing_token: number;
}

export interface HandoffAcceptedEvent extends HandoffEventBase {
  readonly event_type: "workfabric.handoff.accepted.v1";
  readonly recipient: ActorRef;
  readonly binding?: TargetBinding;
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
  | HandoffTargetResolutionRequestedEvent
  | HandoffClaimPoolOpenedEvent
  | HandoffTargetResolvedEvent
  | HandoffTargetUnavailableEvent
  | HandoffClaimedEvent
  | HandoffClaimRenewedEvent
  | HandoffClaimReleasedEvent
  | HandoffClaimExpiredEvent
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
