import type { GitHubRepositoryRef } from "./contracts.js";
import { GitHubProviderError } from "./errors.js";

export interface GitHubProviderPolicy {
  readonly allowed_owners: readonly string[];
  readonly allowed_repositories: readonly GitHubRepositoryRef[];
  readonly maximum_page_size: number;
  readonly maximum_aggregate_repositories: number;
}

export type GitHubAuthorizedOwnerTarget =
  | { readonly owner: string }
  | { readonly repositories: readonly GitHubRepositoryRef[] };

function invalid(): never {
  throw new GitHubProviderError("github_invalid_request");
}

function forbidden(): never {
  throw new GitHubProviderError("github_forbidden");
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) invalid();
  return normalized;
}

function repository(value: GitHubRepositoryRef): GitHubRepositoryRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return Object.freeze({ owner: text(value.owner, 100), name: text(value.name, 100) });
}

function equal(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function compareRepositories(left: GitHubRepositoryRef, right: GitHubRepositoryRef): number {
  const leftName = left.name.toLowerCase();
  const rightName = right.name.toLowerCase();
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

function positiveInteger(value: unknown, maximum: number): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < 1 || value > maximum
  ) invalid();
  return value;
}

/**
 * Enforces the provider-owned visibility ceiling. It deliberately has no
 * mechanism to expand visibility beyond the supplied policy.
 */
export class GitHubPolicyEvaluator {
  private readonly allowedOwners: readonly string[];
  private readonly allowedRepositories: readonly GitHubRepositoryRef[];
  readonly maximum_page_size: number;
  readonly maximum_aggregate_repositories: number;

  constructor(policy: GitHubProviderPolicy) {
    if (policy === null || typeof policy !== "object") invalid();
    if (!Array.isArray(policy.allowed_owners) || !Array.isArray(policy.allowed_repositories)) {
      invalid();
    }
    this.allowedOwners = Object.freeze(policy.allowed_owners.map((owner) => text(owner, 100)));
    this.allowedRepositories = Object.freeze(policy.allowed_repositories.map(repository));
    this.maximum_page_size = positiveInteger(policy.maximum_page_size, 100);
    this.maximum_aggregate_repositories = positiveInteger(
      policy.maximum_aggregate_repositories,
      Number.MAX_SAFE_INTEGER,
    );
    if (this.allowedRepositories.some((item) =>
      !this.allowedOwners.some((owner) => equal(owner, item.owner))
    )) invalid();
  }

  authorizeOwner(owner: string): string {
    const normalized = text(owner, 100);
    if (!this.allowedOwners.some((allowed) => equal(allowed, normalized))) forbidden();
    return normalized;
  }

  authorizeOwnerTarget(owner: string): GitHubAuthorizedOwnerTarget {
    const normalized = this.authorizeOwner(owner);
    if (this.allowedRepositories.length === 0) {
      return Object.freeze({ owner: normalized });
    }
    const repositories = this.allowedRepositories
      .filter((repository) => equal(repository.owner, normalized))
      .slice()
      .sort(compareRepositories);
    if (repositories.length === 0) forbidden();
    return Object.freeze({ repositories: this.authorizeRepositories(repositories) });
  }

  authorizeRepository(value: GitHubRepositoryRef): GitHubRepositoryRef {
    const normalized = repository(value);
    this.authorizeOwner(normalized.owner);
    if (
      this.allowedRepositories.length > 0 &&
      !this.allowedRepositories.some((allowed) =>
        equal(allowed.owner, normalized.owner) && equal(allowed.name, normalized.name)
      )
    ) forbidden();
    return normalized;
  }

  authorizeRepositories(values: readonly GitHubRepositoryRef[]): readonly GitHubRepositoryRef[] {
    if (!Array.isArray(values) || values.length === 0 || values.length > this.maximum_aggregate_repositories) {
      forbidden();
    }
    return Object.freeze(values.map((value) => this.authorizeRepository(value)));
  }

  authorizePageSize(value: number): number {
    positiveInteger(value, 100);
    if (value > this.maximum_page_size) forbidden();
    return value;
  }
}
