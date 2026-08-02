import {
  GitHubProviderError,
  type GitHubProviderErrorCode,
} from "@work-fabric/provider-github";

type GitHubNotFoundErrorCode =
  | "github_repository_not_found"
  | "github_pull_request_not_found";

interface GitHubApiFailure {
  readonly status: number;
  readonly headers: Record<string, string>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function headers(value: unknown): Record<string, string> {
  const source = record(value);
  if (source === undefined) return {};
  const result: Record<string, string> = {};
  for (const [key, header] of Object.entries(source)) {
    if (typeof header === "string") result[key.toLowerCase()] = header;
  }
  return result;
}

function apiFailure(value: unknown): GitHubApiFailure | undefined {
  const source = record(value);
  if (source === undefined || typeof source.status !== "number" || !Number.isInteger(source.status)) {
    return undefined;
  }
  const response = record(source.response);
  return { status: source.status, headers: headers(response?.headers) };
}

function isoAt(time: number): string | undefined {
  if (!Number.isFinite(time)) return undefined;
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function retryAt(headers: Record<string, string>): string | undefined {
  const retryAfter = headers["retry-after"];
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return isoAt(Date.now() + seconds * 1_000);
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return isoAt(date);
  }
  const reset = headers["x-ratelimit-reset"];
  if (reset !== undefined && /^\d+$/.test(reset)) {
    return isoAt(Number(reset) * 1_000);
  }
  return undefined;
}

function metadata(headers: Record<string, string>, retryable: boolean) {
  const request_id = headers["x-github-request-id"];
  const retry_at = retryAt(headers);
  return {
    retryable,
    ...(retry_at === undefined ? {} : { retry_at }),
    ...(request_id === undefined ? {} : { request_id }),
  };
}

function mapped(
  code: GitHubProviderErrorCode,
  headers: Record<string, string>,
  retryable = false,
): GitHubProviderError {
  return new GitHubProviderError(code, metadata(headers, retryable));
}

export function mapGitHubApiError(
  error: unknown,
  notFoundCode: GitHubNotFoundErrorCode,
): GitHubProviderError {
  const failure = apiFailure(error);
  if (failure === undefined) {
    return error instanceof Error
      ? mapped("github_upstream_unavailable", {}, true)
      : mapped("github_response_invalid", {});
  }

  const { status, headers } = failure;
  if (status === 401) return mapped("github_authentication_failed", headers);
  if (status === 403) {
    return headers["x-ratelimit-remaining"] === "0"
      ? mapped("github_rate_limited", headers)
      : mapped("github_forbidden", headers);
  }
  if (status === 404) return mapped(notFoundCode, headers);
  if (status === 422) return mapped("github_invalid_request", headers);
  if (status === 429) return mapped("github_rate_limited", headers);
  if (status >= 500 && status <= 599) {
    return mapped("github_upstream_unavailable", headers, true);
  }
  return mapped("github_response_invalid", headers);
}
