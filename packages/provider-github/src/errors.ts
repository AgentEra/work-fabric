export type GitHubProviderErrorCode =
  | "github_invalid_request"
  | "github_forbidden";

/** A stable, safe diagnostic for callers of the GitHub capability provider. */
export class GitHubProviderError extends Error {
  constructor(readonly code: GitHubProviderErrorCode) {
    super(code);
    this.name = "GitHubProviderError";
  }
}
