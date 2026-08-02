import {
  canonicalCitizenDigest,
  type CapabilityExecutionContext,
  type CapabilityExecutionRequest,
  type CapabilityExecutionResult,
  type CapabilityExecutor,
  type CitizenDeclaration,
  type CitizenJsonObject,
} from "@work-fabric/network-citizen-spi";

import { GITHUB_READ_CAPABILITY_IDS, githubReadCapabilityDeclarations } from "./declarations.js";
import { GitHubProviderError, type GitHubProviderErrorCode } from "./errors.js";

type GitHubCapabilityId = (typeof GITHUB_READ_CAPABILITY_IDS)[number];

export interface GitHubQueryServicePort {
  execute(
    capabilityId: GitHubCapabilityId,
    input: CitizenJsonObject,
    context: {
      readonly tenant_id: string;
      readonly installation_id_hash: string;
      readonly signal: AbortSignal;
    },
  ): Promise<CapabilityExecutionResult>;
}

export interface GitHubCapabilityExecutorOptions {
  readonly query_service: GitHubQueryServicePort;
  readonly installation_id_hash: string;
  readonly declarations?: () => readonly CitizenDeclaration[];
  readonly now?: () => string;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REJECTED_CODES = new Set<GitHubProviderErrorCode>([
  "github_invalid_request",
  "github_forbidden",
  "github_repository_not_found",
  "github_pull_request_not_found",
]);

function rejected(code: GitHubProviderErrorCode): CapabilityExecutionResult {
  return { outcome: "rejected", code, message: code, retryable: false };
}

function failed(
  code: GitHubProviderErrorCode,
  retryable: boolean,
  retryAfter?: string,
): CapabilityExecutionResult {
  return {
    outcome: "failed",
    code,
    message: code,
    retryable,
    ...(retryAfter === undefined ? {} : { retry_after: retryAfter }),
  };
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as Record<string, unknown>;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function validAuthority(
  value: unknown,
  request: CapabilityExecutionRequest,
  declaration: CitizenDeclaration,
  now: string,
): boolean {
  const source = object(value);
  if (source === undefined) return false;
  if (
    !identifier(source.original_handoff_id) ||
    !identifier(source.represented_actor_id) ||
    !identifier(source.delegation_id) ||
    !Array.isArray(source.delegation_scopes) ||
    source.delegation_scopes.length === 0 ||
    source.delegation_scopes.some((scope) => !identifier(scope)) ||
    !source.delegation_scopes.includes("github:read") ||
    !identifier(source.delegation_expires_at) ||
    source.capability_version !== "1.0.0" ||
    typeof source.contract_digest !== "string" ||
    !DIGEST.test(source.contract_digest)
  ) return false;
  const expiresAt = Date.parse(source.delegation_expires_at);
  const nowAt = Date.parse(now);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nowAt) || expiresAt <= nowAt) return false;
  const declarationDigest = canonicalCitizenDigest(declaration);
  return request.capability_version === "1.0.0" &&
    request.capability_version === source.capability_version &&
    declaration.version === source.capability_version &&
    request.contract_digest === source.contract_digest &&
    declarationDigest === source.contract_digest;
}

function providerFailure(error: unknown): CapabilityExecutionResult {
  if (!(error instanceof GitHubProviderError)) {
    return failed("github_upstream_unavailable", true);
  }
  if (REJECTED_CODES.has(error.code)) return rejected(error.code);
  return failed(error.code, error.retryable, error.retry_at);
}

/** Verifies the complete bound Authority before invoking any GitHub query. */
export class GitHubCapabilityExecutor implements CapabilityExecutor {
  private readonly declarations: () => readonly CitizenDeclaration[];
  private readonly now: () => string;

  constructor(private readonly options: GitHubCapabilityExecutorOptions) {
    if (!identifier(options.installation_id_hash)) {
      throw new TypeError("GitHub installation identity hash is invalid");
    }
    this.declarations = options.declarations ?? githubReadCapabilityDeclarations;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  describeCapabilities(): readonly CitizenDeclaration[] {
    return this.declarations();
  }

  async execute(
    request: CapabilityExecutionRequest,
    context: CapabilityExecutionContext,
  ): Promise<CapabilityExecutionResult> {
    const declaration = this.describeCapabilities().find((candidate) =>
      candidate.declaration_id === request.capability_id
    );
    if (
      declaration === undefined ||
      !GITHUB_READ_CAPABILITY_IDS.includes(request.capability_id as GitHubCapabilityId) ||
      !validAuthority(context.authority_evidence, request, declaration, this.now())
    ) return rejected("github_forbidden");
    try {
      return await this.options.query_service.execute(
        request.capability_id as GitHubCapabilityId,
        request.input,
        {
          tenant_id: context.tenant_id,
          installation_id_hash: this.options.installation_id_hash,
          signal: context.signal,
        },
      );
    } catch (error) {
      return providerFailure(error);
    }
  }
}
