import {
  validateDocumentAccessRequest,
  validateDocumentResourceReference,
  type DocumentAccessAuthorizer,
  type DocumentResourceReference,
} from "@work-fabric/document-provider-spi";

import type { FeishuCapabilityBackend } from "./contracts.js";
import { FeishuDocumentResourceAdapter } from "./document-resource-adapter.js";

export interface FeishuDocumentContextProviderDependencies {
  readonly backend: FeishuCapabilityBackend;
  readonly document_access: DocumentAccessAuthorizer;
  readonly resources?: FeishuDocumentResourceAdapter;
  readonly now?: () => string;
}

export class FeishuDocumentContextProvider {
  private readonly resources: FeishuDocumentResourceAdapter;
  private readonly now: () => string;

  constructor(
    private readonly dependencies: FeishuDocumentContextProviderDependencies,
  ) {
    this.resources =
      dependencies.resources ?? new FeishuDocumentResourceAdapter();
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async read(input: {
    readonly tenant_id: string;
    readonly document: DocumentResourceReference;
    readonly max_bytes: number;
    readonly represented_actor_id: string;
    readonly delegation_id: string;
    readonly delegation_scopes: readonly string[];
    readonly delegation_expires_at: string;
    readonly signal?: AbortSignal;
  }) {
    const document = validateDocumentResourceReference(input.document);
    const resolved = this.resources.resolve(document);
    if (resolved.kind !== "document") {
      throw new TypeError("unsupported_resource_type");
    }
    const now = Date.parse(this.now());
    const delegationExpiry = Date.parse(input.delegation_expires_at);
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(delegationExpiry) ||
      delegationExpiry <= now ||
      !input.delegation_scopes.includes("document:read")
    ) {
      throw new Error("Feishu document context Authority denied");
    }
    const decision = await this.dependencies.document_access.authorize(
      validateDocumentAccessRequest({
        tenant_id: input.tenant_id,
        represented_actor_id: input.represented_actor_id,
        delegation_id: input.delegation_id,
        operation: "read",
        resource: document,
        scopes: input.delegation_scopes,
        expires_at: input.delegation_expires_at,
      }),
      input.signal,
    );
    if (decision.decision !== "allow") {
      throw new Error("Feishu document context Authority denied");
    }
    if (
      !Number.isFinite(Date.parse(decision.valid_until)) ||
      Date.parse(decision.valid_until) <= now ||
      Date.parse(decision.valid_until) >
        delegationExpiry
    ) {
      throw new Error("Feishu document context Authority denied");
    }
    if (
      !Number.isSafeInteger(input.max_bytes) ||
      input.max_bytes < 1 ||
      input.max_bytes > 131_072
    ) throw new RangeError("max_bytes is invalid");
    const result = await this.dependencies.backend.readDocument({
      document_token: resolved.document_token,
      max_bytes: input.max_bytes,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (new TextEncoder().encode(result.content.text).byteLength > input.max_bytes) {
      throw new RangeError("Feishu document context exceeds max_bytes");
    }
    return Object.freeze({
      ...result,
      provenance: Object.freeze({
        citizen_kind: "context-provider",
        source: "feishu.docx",
        tenant_id: input.tenant_id,
      }),
    });
  }
}
