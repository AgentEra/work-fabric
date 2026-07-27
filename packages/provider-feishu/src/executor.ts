import type { RuntimeJsonObject } from "@work-fabric/agent-runtime-spi";

import {
  FeishuProviderBackendError,
  type FeishuCapabilityBackend,
  type FeishuCapabilityExecutionRequest,
  type FeishuCapabilityExecutionStore,
  type FeishuCapabilityOutcome,
  type FeishuConfirmationVerifier,
  type FeishuConversationTargetResolver,
  type FeishuMessageTarget,
  type FeishuResourceOwnershipStore,
} from "./contracts.js";
import {
  inputDigest,
  normalizeFeishuInput,
  type NormalizedFeishuInput,
} from "./validation.js";

const STABLE_ERRORS = new Set([
  "invalid_input",
  "authority_denied",
  "confirmation_required",
  "confirmation_invalid",
  "target_not_allowed",
  "document_not_owned",
  "document_not_found",
  "revision_conflict",
  "unsupported_document_shape",
  "feishu_permission_denied",
  "feishu_rate_limited",
  "feishu_temporarily_unavailable",
  "external_outcome_unknown",
  "deadline_exceeded",
]);

export interface FeishuCapabilityExecutorDependencies {
  readonly citizen_id: string;
  readonly endpoint_id: string;
  readonly backend: FeishuCapabilityBackend;
  readonly executions: FeishuCapabilityExecutionStore;
  readonly ownership: FeishuResourceOwnershipStore;
  readonly confirmation: FeishuConfirmationVerifier;
  readonly targets: FeishuConversationTargetResolver;
  readonly now?: () => string;
}

function success(
  data: RuntimeJsonObject,
  artifacts: readonly RuntimeJsonObject[] = [],
): FeishuCapabilityOutcome {
  return { outcome: "succeeded", data, artifacts };
}

function rejected(code: string, message: string): FeishuCapabilityOutcome {
  return { outcome: "rejected", code, message, retryable: false };
}

function allowedDocument(
  request: FeishuCapabilityExecutionRequest,
  token: string,
): boolean {
  return request.authority.allowed_document_tokens.includes(token);
}

function targetRef(target: FeishuMessageTarget): string {
  return `feishu://${target.kind === "chat_id" ? "chat" : "open_id"}/${target.id}`;
}

function backendFailure(error: unknown): FeishuCapabilityOutcome {
  const source = error as {
    readonly code?: unknown;
    readonly retryable?: unknown;
    readonly retry_after?: unknown;
  };
  const code =
    typeof source.code === "string" && STABLE_ERRORS.has(source.code)
      ? source.code
      : "feishu_temporarily_unavailable";
  const retryable =
    error instanceof FeishuProviderBackendError
      ? error.retryable
      : source.retryable === true;
  return {
    outcome: "failed",
    code,
    message: retryable
      ? "Feishu operation is temporarily unavailable"
      : "Feishu operation could not be completed",
    retryable,
    ...(typeof source.retry_after === "string"
      ? { retry_after: source.retry_after }
      : {}),
  };
}

export class FeishuCapabilityExecutor {
  private readonly now: () => string;

  constructor(private readonly dependencies: FeishuCapabilityExecutorDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async execute(
    request: FeishuCapabilityExecutionRequest,
  ): Promise<FeishuCapabilityOutcome> {
    let input: NormalizedFeishuInput;
    try {
      input = normalizeFeishuInput(request);
    } catch (error) {
      return rejected(
        error instanceof Error &&
          error.message === "unsupported_document_shape"
          ? "unsupported_document_shape"
          : "invalid_input",
        "Capability input is invalid",
      );
    }
    const normalizedInputDigest = inputDigest(input);
    const execution = await this.dependencies.executions.begin({
      tenant_id: request.tenant_id,
      idempotency_key: request.idempotency_key,
      capability_id: request.capability_id,
      input_digest: normalizedInputDigest,
      created_at: this.now(),
    });
    if (!execution.created) {
      if (execution.record.outcome === null) {
        throw new Error("Feishu Provider execution is already in progress");
      }
      return execution.record.outcome;
    }

    let outcome: FeishuCapabilityOutcome;
    try {
      outcome = await this.executeNormalized(
        request,
        input,
        normalizedInputDigest,
      );
    } catch (error) {
      outcome = backendFailure(error);
    }
    await this.dependencies.executions.complete(
      request.tenant_id,
      request.idempotency_key,
      outcome,
      this.now(),
    );
    return outcome;
  }

  private async executeNormalized(
    request: FeishuCapabilityExecutionRequest,
    input: NormalizedFeishuInput,
    normalizedInputDigest: `sha256:${string}`,
  ): Promise<FeishuCapabilityOutcome> {
    switch (input.kind) {
      case "message_send": {
        const target = input.target.kind === "current_conversation"
          ? await this.dependencies.targets.resolveCurrentConversation({
              tenant_id: request.tenant_id,
              original_handoff_id: request.original_handoff_id,
              initiating_actor_id: request.initiating_actor_id,
            })
          : input.target;
        if (!request.authority.allowed_target_refs.includes(targetRef(target))) {
          return rejected("target_not_allowed", "Message target is not authorized");
        }
        const result = await this.dependencies.backend.sendMessage({
          target,
          content: input.content,
          idempotency_key: request.idempotency_key,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        return success(result);
      }
      case "document_create": {
        if (
          input.folder_token !== undefined &&
          !request.authority.allowed_target_refs.includes(
            `feishu://folder/${input.folder_token}`,
          )
        ) {
          return rejected("target_not_allowed", "Document folder is not authorized");
        }
        const result = await this.dependencies.backend.createDocument({
          title: input.title,
          content: input.content,
          ...(input.folder_token === undefined
            ? {}
            : { folder_token: input.folder_token }),
          idempotency_key: request.idempotency_key,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        await this.dependencies.ownership.putOwnership({
          tenant_id: request.tenant_id,
          document_token: result.document_token,
          citizen_id: this.dependencies.citizen_id,
          endpoint_id: this.dependencies.endpoint_id,
          original_handoff_id: request.original_handoff_id,
          initiating_actor_id: request.initiating_actor_id,
          create_idempotency_key: request.idempotency_key,
          created_at: this.now(),
          last_known_revision: result.revision,
          deleted_at: null,
        });
        return success(result, [{
          uri: `feishu://docx/${result.document_token}`,
          media_type: "application/vnd.feishu.docx",
        }]);
      }
      case "document_read": {
        const ownership = await this.dependencies.ownership.getOwnership(
          request.tenant_id,
          input.document_token,
        );
        if (
          !allowedDocument(request, input.document_token) &&
          (ownership === null || ownership.deleted_at !== null)
        ) {
          return rejected("authority_denied", "Document read is not authorized");
        }
        const result = await this.dependencies.backend.readDocument({
          document_token: input.document_token,
          max_bytes: input.max_bytes,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        return success({
          document_token: result.document_token,
          title: result.title,
          content: {
            media_type: result.content.media_type,
            text: result.content.text,
          },
          revision: result.revision,
          provenance: {
            citizen_kind: "capability-provider",
            source: "feishu.docx",
          },
        });
      }
      case "document_update":
      case "document_append": {
        const ownership = await this.dependencies.ownership.getOwnership(
          request.tenant_id,
          input.document_token,
        );
        if (
          !allowedDocument(request, input.document_token) &&
          (ownership === null || ownership.deleted_at !== null)
        ) {
          return rejected("authority_denied", "Document mutation is not authorized");
        }
        const common = {
          document_token: input.document_token,
          expected_revision: input.expected_revision,
          content: input.content,
          idempotency_key: request.idempotency_key,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        };
        const result = input.kind === "document_update"
          ? await this.dependencies.backend.replaceDocument({
              ...common,
              ...(input.title === undefined ? {} : { title: input.title }),
            })
          : await this.dependencies.backend.appendDocument(common);
        await this.dependencies.ownership.updateRevision(
          request.tenant_id,
          input.document_token,
          result.revision,
        );
        return success(result);
      }
      case "document_delete": {
        const ownership = await this.dependencies.ownership.getOwnership(
          request.tenant_id,
          input.document_token,
        );
        if (
          ownership === null ||
          ownership.citizen_id !== this.dependencies.citizen_id ||
          ownership.endpoint_id !== this.dependencies.endpoint_id ||
          ownership.deleted_at !== null
        ) {
          return rejected(
            "document_not_owned",
            "Only same-tenant Provider-owned documents may be deleted",
          );
        }
        if (ownership.last_known_revision !== input.expected_revision) {
          return rejected("revision_conflict", "Document revision has changed");
        }
        if (
          !request.authority.confirmation_proof_refs.includes(
            input.confirmation_proof,
          )
        ) {
          return rejected(
            "confirmation_required",
            "Explicit delete confirmation is required",
          );
        }
        const confirmed = await this.dependencies.confirmation.consume({
          tenant_id: request.tenant_id,
          human_actor_id: request.initiating_actor_id,
          capability_id: "feishu.document.delete",
          document_token: input.document_token,
          normalized_input_digest: normalizedInputDigest,
          proof_reference: input.confirmation_proof,
        });
        if (!confirmed) {
          return rejected(
            "confirmation_invalid",
            "Delete confirmation is invalid or expired",
          );
        }
        const result = await this.dependencies.backend.deleteDocument({
          document_token: input.document_token,
          expected_revision: input.expected_revision,
          idempotency_key: request.idempotency_key,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        await this.dependencies.ownership.markDeleted(
          request.tenant_id,
          input.document_token,
          this.now(),
        );
        return success(result);
      }
    }
  }
}
