import { createHash } from "node:crypto";

import type {
  AtomicCommitResult,
  ContextReference,
  EventRecord,
  JsonObject,
  NormalizedOperationOutcome,
  ProposedEvent,
} from "@work-fabric/exchange-spi";

import type { DomainError } from "../domain/domain-error.js";
import { decideHandoff } from "../domain/handoff-decider.js";
import type { HandoffEvent } from "../domain/handoff-events.js";
import { replayHandoff } from "../domain/handoff-reducer.js";
import { handoffEventFromJson } from "../domain/handoff-state-codec.js";
import type { ActorRef, HandoffState } from "../domain/handoff-types.js";
import type { ExchangeApplicationDependencies } from "./application-dependencies.js";
import { canonicalJson, idempotencyDigest } from "./canonical-json.js";
import { decodeHandoffCommand, encodeHandoffEvents } from "./handoff-codec.js";
import { protocolError } from "./protocol-error.js";
import type { CommandEnvelope, OperationResult } from "./protocol-types.js";

const MULTI_STREAM_MESSAGE_TYPES = new Set([
  "workfabric.handoff.transfer.v1",
  "workfabric.handoff.child_accepted.v1",
]);

class StoredStreamScopeError extends Error {}

function toOperationResult(
  requestMessageId: string,
  outcome: NormalizedOperationOutcome,
): OperationResult {
  return {
    spec_version: "1.0",
    request_message_id: requestMessageId,
    ...outcome,
  };
}

function rejected(
  code: Parameters<typeof protocolError>[0],
  message: string,
  options?: Parameters<typeof protocolError>[3],
): NormalizedOperationOutcome {
  return {
    operation_status: "rejected",
    resource: null,
    receipt: null,
    error: protocolError(code, message, false, options),
  };
}

function conflict(
  code: "idempotency_key_reused" | "version_conflict",
  message: string,
  options?: Parameters<typeof protocolError>[3],
): NormalizedOperationOutcome {
  return {
    operation_status: "conflict",
    resource: null,
    receipt: null,
    error: protocolError(code, message, code === "version_conflict", options),
  };
}

function temporaryFailure(): NormalizedOperationOutcome {
  return {
    operation_status: "temporarily_unavailable",
    resource: null,
    receipt: null,
    error: protocolError(
      "temporarily_unavailable",
      "The Exchange is temporarily unavailable",
      true,
    ),
  };
}

function rootPartitionId(tenantId: string, rootHandoffId: string): string {
  const material = canonicalJson({
    tenant_id: tenantId,
    root_handoff_id: rootHandoffId,
  });
  return `partition:${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

function jsonObject(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as JsonObject;
}

function receiptRequired(event: HandoffEvent): boolean {
  return [
    "workfabric.handoff.accepted.v1",
    "workfabric.handoff.result_returned.v1",
    "workfabric.handoff.verified.v1",
  ].includes(event.event_type);
}

function acceptedOutcome(
  handoffId: string,
  resourceVersion: number,
  receipt: JsonObject | null,
): NormalizedOperationOutcome {
  return {
    operation_status: "accepted",
    resource: {
      resource_type: "handoff",
      resource_id: handoffId,
      resource_version: resourceVersion,
    },
    receipt,
    error: null,
  };
}

function domainRejection(error: DomainError): NormalizedOperationOutcome {
  return {
    operation_status: "rejected",
    resource: null,
    receipt: null,
    error: protocolError(error.code, error.message, false),
  };
}

function resourceId(envelope: CommandEnvelope): string | null {
  if (envelope.message_type === "workfabric.handoff.offer.v1") {
    return null;
  }
  const handoffId = MULTI_STREAM_MESSAGE_TYPES.has(envelope.message_type)
    ? envelope.payload.parent_handoff_id
    : envelope.payload.handoff_id;
  if (typeof handoffId !== "string") {
    throw new TypeError("payload.handoff_id must be a string");
  }
  return handoffId;
}

function replayExistingStream(
  records: readonly EventRecord[],
  envelope: CommandEnvelope,
  streamId: string,
): { readonly state: HandoffState | null; readonly partitionId: string } {
  if (records.length === 0) {
    return {
      state: null,
      partitionId: rootPartitionId(envelope.tenant_id, streamId),
    };
  }
  const partitionId = records[0]?.partition_id;
  if (partitionId === undefined) {
    throw new Error("Stored Handoff stream has no Partition");
  }
  for (const record of records) {
    if (
      record.tenant_id !== envelope.tenant_id ||
      record.exchange_id !== envelope.exchange_id ||
      record.partition_id !== partitionId ||
      record.stream_id !== streamId ||
      record.schema_version !== "1.0"
    ) {
      throw new StoredStreamScopeError();
    }
  }
  return {
    state: replayHandoff(
      records.map((record) => ({
        stream_version: record.stream_version,
        event: handoffEventFromJson(record.domain_data),
      })),
    ),
    partitionId,
  };
}

function resultFromCommit(
  requestMessageId: string,
  streamId: string,
  proposedOutcome: NormalizedOperationOutcome,
  result: AtomicCommitResult,
): OperationResult {
  switch (result.kind) {
    case "committed":
      return toOperationResult(requestMessageId, proposedOutcome);
    case "replayed":
      return toOperationResult(requestMessageId, result.outcome);
    case "idempotency_key_reused":
      return toOperationResult(
        requestMessageId,
        conflict(
          "idempotency_key_reused",
          "The same idempotency key was used with different command data",
        ),
      );
    case "version_conflict": {
      const currentVersion = result.current_versions[streamId] ?? null;
      return toOperationResult(
        requestMessageId,
        conflict("version_conflict", "The Handoff version has changed", {
          current_resource_version: currentVersion,
        }),
      );
    }
  }
}

export class ExchangeApplication {
  constructor(private readonly dependencies: ExchangeApplicationDependencies) {}

  async handle(
    envelope: CommandEnvelope,
    authenticationEvidence: JsonObject,
  ): Promise<OperationResult> {
    const validation = this.dependencies.validator.validate(envelope);
    if (!validation.valid) {
      return toOperationResult(
        envelope.message_id,
        rejected("invalid_argument", "The command is invalid", {
          field_violations: validation.errors,
        }),
      );
    }

    try {
      const principal = await this.dependencies.identity.resolve(
        authenticationEvidence,
      );
      if (principal === null || principal.tenant_id !== envelope.tenant_id) {
        return toOperationResult(
          envelope.message_id,
          rejected("unauthenticated", "Authentication evidence was not accepted"),
        );
      }
      const actorClaim = principal.actor_claims.find(
        (claim) =>
          claim.actor_id === envelope.actor_id &&
          claim.endpoint_ids.includes(envelope.endpoint_id),
      );
      if (actorClaim === undefined) {
        return toOperationResult(
          envelope.message_id,
          rejected(
            "permission_denied",
            "The Principal cannot represent this Actor and Endpoint",
          ),
        );
      }
      const actor: ActorRef = {
        actor_id: actorClaim.actor_id,
        actor_type: actorClaim.actor_type,
      };
      const authorizedResourceId = resourceId(envelope);
      const authority = await this.dependencies.authority.authorize({
        principal,
        actor_id: actor.actor_id,
        actor_type: actor.actor_type,
        endpoint_id: envelope.endpoint_id,
        delegation_id: envelope.delegation_id ?? null,
        action: envelope.message_type,
        resource_id: authorizedResourceId,
      });
      if (authority.kind === "deny") {
        return toOperationResult(
          envelope.message_id,
          rejected("permission_denied", "The operation is not authorized"),
        );
      }

      if (MULTI_STREAM_MESSAGE_TYPES.has(envelope.message_type)) {
        return toOperationResult(
          envelope.message_id,
          rejected(
            "invalid_argument",
            "This interaction requires the multi-stream coordinator",
          ),
        );
      }

      const payloadDigest = idempotencyDigest(envelope);
      const saved = await this.dependencies.persistence.findCommand(
        envelope.tenant_id,
        envelope.idempotency_key,
      );
      if (saved !== null) {
        if (saved.payload_digest === payloadDigest) {
          return toOperationResult(envelope.message_id, saved.outcome);
        }
        return toOperationResult(
          envelope.message_id,
          conflict(
            "idempotency_key_reused",
            "The same idempotency key was used with different command data",
          ),
        );
      }

      const isOffer = envelope.message_type === "workfabric.handoff.offer.v1";
      const handoffId = isOffer
        ? this.dependencies.ids.nextId("handoff")
        : authorizedResourceId;
      if (handoffId === null) {
        throw new Error("Existing-resource command has no Handoff ID");
      }
      let contextReference: ContextReference | null = null;
      if (isOffer) {
        const contextValue = envelope.payload.context_bundle;
        if (contextValue !== undefined) {
          contextReference = await this.dependencies.context.putBundle(
            envelope.tenant_id,
            jsonObject(contextValue, "payload.context_bundle"),
          );
        }
      }
      const command = decodeHandoffCommand(
        envelope,
        actor,
        handoffId,
        contextReference,
      );
      const currentRecords = await this.dependencies.persistence.readStream(
        handoffId,
      );
      const replayed = replayExistingStream(currentRecords, envelope, handoffId);
      const currentState = replayed.state;
      if (
        !isOffer &&
        envelope.expected_version !== currentState?.resource_version
      ) {
        const currentVersion = currentState?.resource_version ?? null;
        return toOperationResult(
          envelope.message_id,
          conflict("version_conflict", "The Handoff version has changed", {
            current_resource_version: currentVersion,
            details: {
              expected_version: envelope.expected_version ?? null,
            },
          }),
        );
      }

      let contextAvailable = true;
      if (
        command.kind === "accept" &&
        currentState?.package.context !== null &&
        currentState?.package.context !== undefined
      ) {
        const availability = await this.dependencies.context.checkAvailability({
          tenant_id: envelope.tenant_id,
          actor_id: actor.actor_id,
          endpoint_id: envelope.endpoint_id,
          reference: currentState.package.context,
        });
        contextAvailable = availability.kind === "available";
        if (!contextAvailable) {
          return toOperationResult(
            envelope.message_id,
            rejected(
              "context_unavailable",
              "Referenced Handoff Context is unavailable",
            ),
          );
        }
      }
      const now = this.dependencies.clock.now();
      const decision = decideHandoff(currentState, command, {
        now,
        recipient_authorized: true,
        verifier_authorized: true,
        policy_allows_cancel: true,
        context_available: contextAvailable,
        authority_valid: true,
      });
      let outcome: NormalizedOperationOutcome;
      let appends: readonly {
        readonly stream_id: string;
        readonly expected_version: number;
        readonly events: readonly ProposedEvent[];
      }[];
      if (decision.kind === "rejected") {
        outcome = domainRejection(decision.error);
        appends = [];
      } else {
        const eventIds = decision.events.map(() =>
          this.dependencies.ids.nextId("event"),
        );
        const receiptIds = decision.events.map((event) =>
          receiptRequired(event)
            ? this.dependencies.ids.nextId("receipt")
            : null,
        );
        const currentVersion = currentState?.resource_version ?? 0;
        const encoded = encodeHandoffEvents({
          current_state: currentState,
          events: decision.events,
          current_stream_version: currentVersion,
          envelope,
          event_ids: eventIds,
          receipt_ids: receiptIds,
          authorized_endpoint_ids: actorClaim.endpoint_ids,
          now,
        });
        outcome = acceptedOutcome(
          handoffId,
          currentVersion + encoded.events.length,
          encoded.receipt,
        );
        appends = [
          {
            stream_id: handoffId,
            expected_version: currentVersion,
            events: encoded.events,
          },
        ];
      }
      const commitResult = await this.dependencies.persistence.commitAtomically({
        tenant_id: envelope.tenant_id,
        partition_id: replayed.partitionId,
        commit_id: this.dependencies.ids.nextId("commit"),
        idempotency_key: envelope.idempotency_key,
        payload_digest: payloadDigest,
        request_message_id: envelope.message_id,
        outcome,
        appends,
      });
      return resultFromCommit(
        envelope.message_id,
        handoffId,
        outcome,
        commitResult,
      );
    } catch (error: unknown) {
      if (error instanceof StoredStreamScopeError) {
        return toOperationResult(
          envelope.message_id,
          rejected("not_found", "The Handoff was not found"),
        );
      }
      return toOperationResult(envelope.message_id, temporaryFailure());
    }
  }
}
