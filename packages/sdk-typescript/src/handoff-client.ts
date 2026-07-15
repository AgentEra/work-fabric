import type {
  NormalizedClientOptions,
  RepresentationContext,
} from "./config.js";
import type { CommandClient } from "./command-client.js";
import type {
  CommandEnvelope,
  JsonObject,
  OperationResult,
} from "./protocol-types.js";

export interface NewCommandOptions {
  readonly idempotencyKey: string;
  readonly messageId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly signal?: AbortSignal;
}

export interface ExistingHandoffCommandOptions extends NewCommandOptions {
  readonly expectedVersion: number;
}

export type HandoffOfferPayload = JsonObject & {
  readonly thread_id?: string;
  readonly work_reference: JsonObject;
  readonly target: JsonObject;
  readonly intent: readonly JsonObject[];
  readonly authority_scope: JsonObject;
  readonly acceptance_criteria: readonly JsonObject[];
  readonly verifier: JsonObject;
  readonly priority: "low" | "normal" | "high" | "critical";
  readonly accept_by: string;
  readonly result_due_at: string;
};

export type HandoffReferencePayload = JsonObject & {
  readonly handoff_id: string;
};

export type HandoffTargetResolutionPayload = HandoffReferencePayload & {
  readonly resolved_target: JsonObject;
  readonly evidence?: readonly JsonObject[];
};

export type HandoffTargetUnavailablePayload = HandoffReferencePayload & {
  readonly reason_code:
    | "no_candidate"
    | "no_eligible_target"
    | "policy_rejected"
    | "resolver_unavailable";
  readonly reason: readonly JsonObject[];
  readonly evidence: readonly JsonObject[];
};

export type HandoffCancelPayload = HandoffReferencePayload & {
  readonly reason?: readonly JsonObject[];
};

export type HandoffStatusPayload = HandoffReferencePayload & {
  readonly status: JsonObject;
};

export type HandoffResultPayload = HandoffReferencePayload & {
  readonly result: JsonObject;
};

export type HandoffVerificationPayload = HandoffReferencePayload & {
  readonly satisfied_criterion_ids: readonly string[];
  readonly summary: readonly JsonObject[];
  readonly evidence: readonly JsonObject[];
};

export type HandoffReworkPayload = HandoffReferencePayload & {
  readonly criterion_ids: readonly string[];
  readonly reason: readonly JsonObject[];
};

export type HandoffTransferPayload = JsonObject & {
  readonly parent_handoff_id: string;
  readonly child_offer: HandoffOfferPayload;
};

function bounded(value: string, field: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value
  ) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }
  return value;
}

function version(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("expectedVersion must be a positive safe integer");
  }
  return value;
}

function handoffId(payload: HandoffReferencePayload): void {
  bounded(payload.handoff_id, "handoff_id", 128);
}

export class HandoffClient {
  constructor(
    private readonly config: NormalizedClientOptions,
    private readonly commands: CommandClient,
    private readonly representation: RepresentationContext = config.representation,
  ) {}

  offer(
    payload: HandoffOfferPayload,
    options: NewCommandOptions,
  ): Promise<OperationResult> {
    if (payload.thread_id !== undefined) bounded(payload.thread_id, "thread_id", 128);
    return this.send("offer", payload, options);
  }

  resolveTarget(
    payload: HandoffTargetResolutionPayload,
    options: ExistingHandoffCommandOptions,
  ): Promise<OperationResult> {
    handoffId(payload);
    return this.send(
      "resolve_target",
      { ...payload, evidence: payload.evidence ?? [] },
      options,
    );
  }

  reportTargetUnavailable(
    payload: HandoffTargetUnavailablePayload,
    options: ExistingHandoffCommandOptions,
  ): Promise<OperationResult> {
    handoffId(payload);
    return this.send("report_target_unavailable", payload, options);
  }

  accept(payload: HandoffReferencePayload, options: ExistingHandoffCommandOptions) {
    return this.existing("accept", payload, options);
  }

  decline(payload: HandoffReferencePayload, options: ExistingHandoffCommandOptions) {
    return this.existing("decline", payload, options);
  }

  expire(payload: HandoffReferencePayload, options: ExistingHandoffCommandOptions) {
    return this.existing("expire", payload, options);
  }

  cancel(payload: HandoffCancelPayload, options: ExistingHandoffCommandOptions) {
    return this.existing("cancel", payload, options);
  }

  reportStatus(payload: HandoffStatusPayload, options: ExistingHandoffCommandOptions) {
    return this.existing("report_status", payload, options);
  }

  returnResult(payload: HandoffResultPayload, options: ExistingHandoffCommandOptions) {
    return this.existing("return_result", payload, options);
  }

  verify(payload: HandoffVerificationPayload, options: ExistingHandoffCommandOptions) {
    return this.existing("verify", payload, options);
  }

  close(payload: HandoffReferencePayload, options: ExistingHandoffCommandOptions) {
    return this.existing("close", payload, options);
  }

  requestRework(payload: HandoffReworkPayload, options: ExistingHandoffCommandOptions) {
    return this.existing("request_rework", payload, options);
  }

  transfer(payload: HandoffTransferPayload, options: ExistingHandoffCommandOptions) {
    bounded(payload.parent_handoff_id, "parent_handoff_id", 128);
    return this.send("transfer", payload, options);
  }

  private existing(
    interaction: string,
    payload: HandoffReferencePayload,
    options: ExistingHandoffCommandOptions,
  ): Promise<OperationResult> {
    handoffId(payload);
    return this.send(interaction, payload, options);
  }

  private send(
    interaction: string,
    payload: JsonObject,
    options: NewCommandOptions | ExistingHandoffCommandOptions,
  ): Promise<OperationResult> {
    const messageId = bounded(
      options.messageId ?? this.config.messageIdGenerator.nextMessageId(),
      "messageId",
      128,
    );
    const envelope: CommandEnvelope = {
      spec_version: "1.0",
      message_id: messageId,
      message_type: `workfabric.handoff.${interaction}.v1`,
      sent_at: this.config.clock.now(),
      tenant_id: this.config.tenantId,
      exchange_id: this.config.exchangeId,
      actor_id: this.representation.actorId,
      endpoint_id: this.representation.endpointId,
      ...(this.representation.delegationId === undefined
        ? {}
        : { delegation_id: this.representation.delegationId }),
      ...(options.correlationId === undefined
        ? {}
        : { correlation_id: bounded(options.correlationId, "correlationId", 128) }),
      ...(options.causationId === undefined
        ? {}
        : { causation_id: bounded(options.causationId, "causationId", 128) }),
      idempotency_key: bounded(options.idempotencyKey, "idempotencyKey", 256),
      ...("expectedVersion" in options
        ? { expected_version: version(options.expectedVersion) }
        : {}),
      payload,
    };
    return this.commands.send(envelope, {
      representation: this.representation,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
}
