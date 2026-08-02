import { describe, expect, it } from "vitest";

import { GitHubProviderError } from "../src/index.js";

describe("GitHub provider errors", () => {
  it("exposes only the approved stable diagnostic fields", () => {
    const error = new GitHubProviderError("github_rate_limited", {
      retryable: false,
      retry_at: "2026-08-02T00:00:00.000Z",
      request_id: "request-123",
    });

    expect(error).toMatchObject({
      code: "github_rate_limited",
      retryable: false,
      retry_at: "2026-08-02T00:00:00.000Z",
      request_id: "request-123",
    });
    expect(JSON.stringify(error)).toBe(
      '{"code":"github_rate_limited","retryable":false,"retry_at":"2026-08-02T00:00:00.000Z","request_id":"request-123"}',
    );
  });
});
