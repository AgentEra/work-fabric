import type { ExplicitHandoffTarget, JsonObject } from "@work-fabric/exchange-spi";

import type { ActorRef, HandoffPackage } from "./handoff-types.js";

export type HandoffCommand =
  | {
      readonly kind: "offer";
      readonly handoff_id: string;
      readonly thread_id: string;
      readonly actor: ActorRef;
      readonly package: HandoffPackage;
      readonly parent_handoff_id: string | null;
    }
  | {
      readonly kind: "resolve_target";
      readonly handoff_id: string;
      readonly actor: ActorRef;
      readonly resolver_endpoint_id: string;
      readonly delegation_id: string | null;
      readonly resolved_target: ExplicitHandoffTarget;
      readonly evidence: readonly JsonObject[];
    }
  | {
      readonly kind: "report_target_unavailable";
      readonly handoff_id: string;
      readonly actor: ActorRef;
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
  | {
      readonly kind: "accept";
      readonly handoff_id: string;
      readonly actor: ActorRef;
    }
  | {
      readonly kind: "decline";
      readonly handoff_id: string;
      readonly actor: ActorRef;
    }
  | {
      readonly kind: "expire";
      readonly handoff_id: string;
      readonly actor: ActorRef;
    }
  | {
      readonly kind: "cancel";
      readonly handoff_id: string;
      readonly actor: ActorRef;
      readonly reason: readonly JsonObject[];
    }
  | {
      readonly kind: "report_status";
      readonly handoff_id: string;
      readonly actor: ActorRef;
      readonly status: JsonObject;
    }
  | {
      readonly kind: "return_result";
      readonly handoff_id: string;
      readonly actor: ActorRef;
      readonly result: JsonObject;
    }
  | {
      readonly kind: "verify";
      readonly handoff_id: string;
      readonly actor: ActorRef;
      readonly satisfied_criterion_ids: readonly string[];
      readonly summary: readonly JsonObject[];
      readonly evidence: readonly JsonObject[];
    }
  | {
      readonly kind: "close";
      readonly handoff_id: string;
      readonly actor: ActorRef;
    }
  | {
      readonly kind: "request_rework";
      readonly handoff_id: string;
      readonly actor: ActorRef;
      readonly criterion_ids: readonly string[];
      readonly reason: readonly JsonObject[];
    };

export interface HandoffDecisionContext {
  readonly now: string;
  readonly recipient_authorized: boolean;
  readonly verifier_authorized: boolean;
  readonly policy_allows_cancel: boolean;
  readonly context_available: boolean;
  readonly authority_valid: boolean;
  readonly resolver_authorized?: boolean;
  readonly target_eligible?: boolean;
}
