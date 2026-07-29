import type { RuntimeJsonObject } from "@work-fabric/agent-runtime-spi";
import type {
  DocumentPlacementRequest,
  DocumentResourceReference,
} from "@work-fabric/document-provider-spi";

export interface SimpleDocumentContent {
  readonly media_type: "text/plain" | "text/markdown";
  readonly text: string;
}

export type FeishuMessageTarget =
  | { readonly kind: "open_id"; readonly id: string }
  | { readonly kind: "chat_id"; readonly id: string };

export interface FeishuCapabilityBackend {
  sendMessage(input: {
    readonly target: FeishuMessageTarget;
    readonly content: SimpleDocumentContent;
    readonly idempotency_key: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly message_id: string;
    readonly target: FeishuMessageTarget;
    readonly sent_at: string;
  }>;
  createDocument(input: {
    readonly title: string;
    readonly content: SimpleDocumentContent;
    readonly placement: DocumentResourceReference;
    readonly idempotency_key: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly document_token: string;
    readonly url: string;
    readonly title: string;
    readonly revision: string;
  }>;
  readDocument(input: {
    readonly document_token: string;
    readonly max_bytes: number;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly document_token: string;
    readonly title: string;
    readonly content: SimpleDocumentContent;
    readonly revision: string;
  }>;
  replaceDocument(input: {
    readonly document_token: string;
    readonly expected_revision: string;
    readonly title?: string;
    readonly content: SimpleDocumentContent;
    readonly idempotency_key: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly document_token: string;
    readonly title: string;
    readonly revision: string;
  }>;
  appendDocument(input: {
    readonly document_token: string;
    readonly expected_revision: string;
    readonly content: SimpleDocumentContent;
    readonly idempotency_key: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly document_token: string;
    readonly title: string;
    readonly revision: string;
  }>;
  deleteDocument(input: {
    readonly document_token: string;
    readonly expected_revision: string;
    readonly idempotency_key: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly document_token: string;
    readonly deleted_at: string;
  }>;
}

export type FeishuCapabilityOutcome =
  | {
      readonly outcome: "succeeded";
      readonly data: RuntimeJsonObject;
      readonly artifacts: readonly RuntimeJsonObject[];
    }
  | {
      readonly outcome: "rejected";
      readonly code: string;
      readonly message: string;
      readonly retryable: false;
    }
  | {
      readonly outcome: "failed";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly retry_after?: string;
    };

export interface FeishuInvocationAuthority {
  readonly allowed_resource_refs?: readonly string[];
  readonly allowed_target_refs: readonly string[];
  readonly confirmation_proof_refs: readonly string[];
  readonly source_reference?: RuntimeJsonObject;
}

export interface FeishuCapabilityExecutionRequest {
  readonly tenant_id: string;
  readonly original_handoff_id: string;
  readonly represented_actor_id: string;
  readonly delegation_id: string;
  readonly delegation_scopes: readonly string[];
  readonly delegation_expires_at: string;
  readonly invocation_id: string;
  readonly idempotency_key: string;
  readonly capability_id: string;
  readonly input: Record<string, unknown>;
  readonly authority: FeishuInvocationAuthority;
  readonly signal?: AbortSignal;
}

export type FeishuDocumentPlacementRequest =
  | DocumentPlacementRequest
  | null;

export interface FeishuExecutionRecord {
  readonly tenant_id: string;
  readonly idempotency_key: string;
  readonly capability_id: string;
  readonly input_digest: `sha256:${string}`;
  readonly outcome: FeishuCapabilityOutcome | null;
  readonly created_at: string;
  readonly completed_at: string | null;
}

export interface FeishuCapabilityExecutionStore {
  begin(input: Omit<FeishuExecutionRecord, "outcome" | "completed_at">): Promise<{
    readonly created: boolean;
    readonly record: FeishuExecutionRecord;
  }>;
  complete(
    tenantId: string,
    idempotencyKey: string,
    outcome: FeishuCapabilityOutcome,
    completedAt: string,
  ): Promise<void>;
}

export interface FeishuResourceOwnership {
  readonly tenant_id: string;
  readonly document_token: string;
  readonly citizen_id: string;
  readonly endpoint_id: string;
  readonly original_handoff_id: string;
  readonly initiating_actor_id: string;
  readonly create_idempotency_key: string;
  readonly created_at: string;
  readonly last_known_revision: string;
  readonly deleted_at: string | null;
}

export interface FeishuResourceOwnershipStore {
  putOwnership(input: FeishuResourceOwnership): Promise<void>;
  getOwnership(
    tenantId: string,
    documentToken: string,
  ): Promise<FeishuResourceOwnership | null>;
  updateRevision(
    tenantId: string,
    documentToken: string,
    revision: string,
  ): Promise<void>;
  markDeleted(
    tenantId: string,
    documentToken: string,
    deletedAt: string,
  ): Promise<void>;
}

export interface FeishuConfirmationVerifier {
  consume(input: {
    readonly tenant_id: string;
    readonly human_actor_id: string;
    readonly capability_id: "feishu.document.delete";
    readonly document_token: string;
    readonly normalized_input_digest: `sha256:${string}`;
    readonly proof_reference: string;
  }): Promise<boolean>;
}

export interface FeishuConversationTargetResolver {
  resolveCurrentConversation(input: {
    readonly tenant_id: string;
    readonly original_handoff_id: string;
    readonly initiating_actor_id: string;
  }): Promise<FeishuMessageTarget>;
}

export class FeishuProviderBackendError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retry_after?: string,
  ) {
    super(code);
    this.name = "FeishuProviderBackendError";
  }
}
