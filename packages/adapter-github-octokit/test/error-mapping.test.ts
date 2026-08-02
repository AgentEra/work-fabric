import { describe, expect, it } from "vitest";

import { mapGitHubApiError } from "../src/index.js";

describe("GitHub API error mapping", () => {
  it.each([
    [{ status: 401 }, "github_authentication_failed", false],
    [{ status: 403 }, "github_forbidden", false],
    [{ status: 404 }, "github_repository_not_found", false],
    [{ status: 422 }, "github_invalid_request", false],
    [{ status: 429 }, "github_rate_limited", false],
    [{ status: 503 }, "github_upstream_unavailable", true],
    [new TypeError("socket closed"), "github_upstream_unavailable", true],
    [null, "github_response_invalid", false],
  ] as const)("maps %o to the stable %s diagnostic", (upstream, code, retryable) => {
    const result = mapGitHubApiError(upstream, "github_repository_not_found");

    expect(result).toMatchObject({ code, retryable });
  });

  it("uses the supplied stable not-found code", () => {
    expect(mapGitHubApiError({ status: 404 }, "github_pull_request_not_found"))
      .toMatchObject({ code: "github_pull_request_not_found", retryable: false });
  });

  it("maps non-not-found statuses without a not-found override", () => {
    expect(mapGitHubApiError({ status: 401 }))
      .toMatchObject({ code: "github_authentication_failed", retryable: false });
  });

  it("rejects an unclassified not-found response without a not-found override", () => {
    expect(mapGitHubApiError({ status: 404 }))
      .toMatchObject({ code: "github_response_invalid", retryable: false });
  });

  it("maps exhausted secondary rate limits and preserves only safe metadata", () => {
    const secret = "-----BEGIN PRIVATE KEY-----\ndo-not-leak\n-----END PRIVATE KEY-----";
    const result = mapGitHubApiError({
      status: 403,
      message: `authorization: Bearer token ${secret}`,
      response: {
        data: { private_key: secret, access_token: "token" },
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1",
          "x-github-request-id": "request-123",
          authorization: `Bearer ${secret}`,
        },
      },
    }, "github_repository_not_found");

    expect(result).toMatchObject({
      code: "github_rate_limited",
      retryable: false,
      retry_at: "1970-01-01T00:00:01.000Z",
      request_id: "request-123",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("access_token");
    expect(JSON.stringify(result)).not.toContain("authorization");
  });

  it("uses retry-after metadata for rate limits", () => {
    const before = Date.now();
    const result = mapGitHubApiError({
      status: 429,
      response: { headers: { "retry-after": "60" } },
    }, "github_repository_not_found");

    expect(result.code).toBe("github_rate_limited");
    expect(result.retry_at).toBeDefined();
    expect(Date.parse(result.retry_at!)).toBeGreaterThanOrEqual(before + 59_000);
  });

  it("drops invalid rate-limit timing metadata without changing the stable error", () => {
    const result = mapGitHubApiError({
      status: 429,
      response: { headers: { "x-ratelimit-reset": "999999999999999999999" } },
    }, "github_repository_not_found");

    expect(result).toMatchObject({ code: "github_rate_limited", retryable: false });
    expect(result.retry_at).toBeUndefined();
  });
});
