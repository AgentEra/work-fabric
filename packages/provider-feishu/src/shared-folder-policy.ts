import type { FeishuTenantTokenProvider } from "@work-fabric/connector-feishu";

import {
  FeishuOpenApiRequestClient,
  type FeishuOpenApiRequestClientOptions,
} from "./openapi-backend.js";
import { FeishuProviderBackendError } from "./contracts.js";

export type FeishuSharedFolderPolicyErrorCode =
  | "shared_folder_inaccessible"
  | "shared_folder_not_editable"
  | "shared_folder_visibility_invalid"
  | "shared_folder_authentication_failed"
  | "shared_folder_response_invalid"
  | "shared_folder_temporarily_unavailable";

export class FeishuSharedFolderPolicyError extends Error {
  readonly name = "FeishuSharedFolderPolicyError";

  constructor(readonly code: FeishuSharedFolderPolicyErrorCode) {
    super(code);
  }
}

export interface FeishuSharedFolderPolicyVerifierOptions
  extends Omit<FeishuOpenApiRequestClientOptions, "token_provider"> {
  readonly token_provider: FeishuTenantTokenProvider;
  readonly folder_token: string;
  readonly policy_ref: string;
  readonly visibility: "tenant_readable";
}

function object(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new FeishuSharedFolderPolicyError(
      "shared_folder_response_invalid",
    );
  }
  return value as Record<string, unknown>;
}

function mapProbeFailure(error: unknown): FeishuSharedFolderPolicyError {
  if (error instanceof FeishuSharedFolderPolicyError) return error;
  if (error instanceof FeishuProviderBackendError) {
    switch (error.code) {
      case "document_not_found":
        return new FeishuSharedFolderPolicyError(
          "shared_folder_inaccessible",
        );
      case "feishu_permission_denied":
        return new FeishuSharedFolderPolicyError(
          "shared_folder_not_editable",
        );
      case "feishu_authentication_failed":
        return new FeishuSharedFolderPolicyError(
          "shared_folder_authentication_failed",
        );
      case "feishu_response_invalid":
        return new FeishuSharedFolderPolicyError(
          "shared_folder_response_invalid",
        );
      default:
        return new FeishuSharedFolderPolicyError(
          "shared_folder_temporarily_unavailable",
        );
    }
  }
  return new FeishuSharedFolderPolicyError(
    "shared_folder_temporarily_unavailable",
  );
}

export class FeishuSharedFolderPolicyVerifier {
  private readonly requests: FeishuOpenApiRequestClient;

  constructor(
    private readonly options: FeishuSharedFolderPolicyVerifierOptions,
  ) {
    if (
      options.folder_token.length === 0 ||
      options.folder_token.length > 512 ||
      options.policy_ref.length === 0 ||
      options.policy_ref.length > 256 ||
      options.visibility !== "tenant_readable"
    ) {
      throw new TypeError("Feishu shared folder policy is invalid");
    }
    this.requests = new FeishuOpenApiRequestClient(options);
  }

  async verify(signal: AbortSignal): Promise<{
    readonly policy_ref: string;
    readonly status: "ready";
  }> {
    try {
      const listing = object(await this.requests.request(
        "GET",
        `/open-apis/drive/v1/files?folder_token=${encodeURIComponent(
          this.options.folder_token,
        )}&page_size=1`,
        undefined,
        signal,
      ));
      const listingData = object(listing.data);
      if (
        !Array.isArray(listingData.files) ||
        (listingData.has_more !== undefined &&
          typeof listingData.has_more !== "boolean")
      ) {
        throw new FeishuSharedFolderPolicyError(
          "shared_folder_response_invalid",
        );
      }

      const permission = object(await this.requests.request(
        "GET",
        `/open-apis/drive/v1/permissions/${encodeURIComponent(
          this.options.folder_token,
        )}/public?type=folder`,
        undefined,
        signal,
      ));
      const permissionData = object(permission.data);
      const publicPolicy = object(permissionData.permission_public);
      const linkShare = publicPolicy.link_share_entity;
      if (typeof linkShare !== "string") {
        throw new FeishuSharedFolderPolicyError(
          "shared_folder_response_invalid",
        );
      }
      if (
        linkShare !== "tenant_readable" &&
        linkShare !== "tenant_editable"
      ) {
        throw new FeishuSharedFolderPolicyError(
          "shared_folder_visibility_invalid",
        );
      }
      return Object.freeze({
        policy_ref: this.options.policy_ref,
        status: "ready" as const,
      });
    } catch (error) {
      throw mapProbeFailure(error);
    }
  }
}
