export type GitHubProviderErrorCode =
  | "github_invalid_request"
  | "github_authentication_failed"
  | "github_forbidden"
  | "github_repository_not_found"
  | "github_pull_request_not_found"
  | "github_rate_limited"
  | "github_upstream_unavailable"
  | "github_response_invalid"
  | "github_result_truncated";

export interface GitHubProviderErrorMetadata {
  readonly retryable?: boolean;
  readonly retry_at?: string;
  readonly request_id?: string;
}

/** A stable, safe diagnostic for callers of the GitHub capability provider. */
export class GitHubProviderError extends Error {
  readonly retryable: boolean;
  readonly retry_at?: string;
  readonly request_id?: string;

  constructor(
    readonly code: GitHubProviderErrorCode,
    metadata: GitHubProviderErrorMetadata = {},
  ) {
    super(code);
    Object.defineProperty(this, "name", { value: "GitHubProviderError" });
    this.retryable = metadata.retryable ?? false;
    if (metadata.retry_at !== undefined) this.retry_at = metadata.retry_at;
    if (metadata.request_id !== undefined) this.request_id = metadata.request_id;
  }
}
