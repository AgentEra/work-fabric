import { describe, expect, it } from "vitest";

import { GitHubProviderError } from "@work-fabric/provider-github";

import {
  OctokitGitHubReadApi,
  type OctokitRequestClient,
} from "../src/index.js";

const repository = { owner: "AgentEra", name: "work-fabric" } as const;
const signal = new AbortController().signal;

interface RecordedRequest {
  readonly route: string;
  readonly parameters: Record<string, unknown>;
}

function baseRepository() {
  return {
    name: "work-fabric",
    owner: { login: "AgentEra" },
    html_url: "https://github.com/AgentEra/work-fabric",
    description: "Fabric",
    visibility: "private",
    private: true,
    archived: false,
    default_branch: "main",
    topics: ["agents"],
    pushed_at: "2026-08-01T09:00:00Z",
    updated_at: "2026-08-01T10:00:00Z",
    authorization: "Bearer installation-secret",
    private_key: "-----BEGIN PRIVATE KEY-----raw-secret",
    token: "installation-token",
    raw_headers: { authorization: "Bearer raw-header-secret" },
    raw_body: "raw-body-secret",
  };
}

function basePullRequest(number = 7) {
  return {
    number,
    title: "Bounded GitHub reads",
    html_url: `https://github.com/AgentEra/work-fabric/pull/${number}`,
    user: { login: "octo" },
    draft: false,
    base: { ref: "main" },
    head: { ref: "feature/github" },
    assignees: [{ login: "owner" }],
    requested_reviewers: [{ login: "reviewer" }],
    labels: [{ name: "github" }],
    mergeable: true,
    created_at: "2026-08-01T09:00:00Z",
    updated_at: "2026-08-01T10:00:00Z",
    body: "A bounded body",
  };
}

function baseCommit() {
  return {
    sha: "abc123",
    html_url: "https://github.com/AgentEra/work-fabric/commit/abc123",
    author: { login: "octo" },
    commit: {
      message: "Bound the adapter\n\nFull commit body must not escape.",
      author: { name: "Octo Cat", date: "2026-08-01T09:00:00Z" },
      committer: { name: "Octo Cat", date: "2026-08-01T09:01:00Z" },
      verification: { verified: true },
    },
  };
}

function response(route: string): { data: unknown; headers: Record<string, string> } {
  switch (route) {
    case "GET /app":
      return { data: {
        id: 42,
        slug: "work-fabric",
        name: "Work Fabric",
        html_url: "https://github.com/apps/work-fabric",
        owner: { login: "AgentEra" },
      }, headers: {} };
    case "GET /installation/repositories":
      return { data: { total_count: 1, repositories: [baseRepository()] }, headers: {} };
    case "GET /repos/{owner}/{repo}":
      return { data: baseRepository(), headers: { authorization: "Bearer response-header-secret" } };
    case "GET /repos/{owner}/{repo}/pulls":
      return { data: [basePullRequest()], headers: {} };
    case "GET /search/issues":
      return { data: { total_count: 0, incomplete_results: false, items: [] }, headers: {} };
    case "GET /repos/{owner}/{repo}/pulls/{pull_number}":
      return { data: basePullRequest(), headers: {} };
    case "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews":
      return { data: [{
        id: 11,
        user: null,
        state: "APPROVED",
        submitted_at: "2026-08-01T10:00:00Z",
        body: null,
        html_url: "https://github.com/AgentEra/work-fabric/pull/7#pullrequestreview-11",
      }], headers: {} };
    case "GET /repos/{owner}/{repo}/issues/{issue_number}/comments":
      return { data: [{
        id: 12,
        user: { login: "octo" },
        created_at: "2026-08-01T10:01:00Z",
        updated_at: "2026-08-01T10:02:00Z",
        body: "Issue comment",
        html_url: "https://github.com/AgentEra/work-fabric/pull/7#issuecomment-12",
      }], headers: {} };
    case "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments":
      return { data: [{
        id: 13,
        user: { login: "reviewer" },
        created_at: "2026-08-01T10:03:00Z",
        updated_at: "2026-08-01T10:04:00Z",
        body: "Review comment",
        html_url: "https://github.com/AgentEra/work-fabric/pull/7#discussion_r13",
      }], headers: {} };
    case "GET /repos/{owner}/{repo}/pulls/{pull_number}/files":
      return { data: [{
        filename: "src/index.ts",
        status: "modified",
        additions: 4,
        deletions: 2,
        changes: 6,
        blob_url: "https://github.com/AgentEra/work-fabric/blob/abc/src/index.ts",
        patch: "PRIVATE PATCH",
      }], headers: {} };
    case "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits":
    case "GET /repos/{owner}/{repo}/commits":
      return { data: [baseCommit()], headers: {} };
    case "GET /repos/{owner}/{repo}/commits/{ref}/status":
      return { data: {
        state: "success",
        statuses: [{
          context: "legacy/status",
          state: "success",
          target_url: "https://ci.example.test/status/1",
          created_at: "2026-08-01T09:00:00Z",
          updated_at: "2026-08-01T09:01:00Z",
        }],
      }, headers: {} };
    case "GET /repos/{owner}/{repo}/commits/{ref}/check-runs":
      return { data: { total_count: 1, check_runs: [{
        name: "test",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-01T09:00:00Z",
        completed_at: "2026-08-01T09:01:00Z",
        html_url: "https://github.com/AgentEra/work-fabric/runs/1",
      }] }, headers: {} };
    case "GET /repos/{owner}/{repo}/actions/runs":
      return { data: { total_count: 1, workflow_runs: [{
        id: 14,
        name: "CI",
        display_title: "PRIVATE FULL TITLE",
        run_number: 3,
        event: "pull_request",
        head_branch: "feature/github",
        head_sha: "abc123",
        actor: null,
        status: "completed",
        conclusion: "success",
        created_at: "2026-08-01T09:00:00Z",
        updated_at: "2026-08-01T09:01:00Z",
        html_url: "https://github.com/AgentEra/work-fabric/actions/runs/14",
        logs_url: "PRIVATE LOGS",
        artifacts_url: "PRIVATE ARTIFACTS",
      }] }, headers: {} };
    default:
      throw new Error(`unexpected route ${route}`);
  }
}

function recordingClient(
  recorded: RecordedRequest[],
  responder: (route: string) =>
    | { data: unknown; headers: Record<string, string> }
    | Promise<{ data: unknown; headers: Record<string, string> }> = response,
): OctokitRequestClient {
  return {
    request: (async (route: string, parameters: Record<string, unknown>) => {
      recorded.push({ route, parameters });
      return responder(route);
    }) as OctokitRequestClient["request"],
  };
}

describe("OctokitGitHubReadApi", () => {
  it("uses only the approved GET routes and returns provider-owned records", async () => {
    const recorded: RecordedRequest[] = [];
    const api = new OctokitGitHubReadApi(recordingClient(recorded));
    const page = { page_size: 30 };
    const pullPage = { ...page, repository, pull_request_number: 7 };

    const results = [];
    results.push(await api.getIdentity(signal));
    results.push(await api.listRepositories(page, signal));
    results.push(await api.getRepository(repository, signal));
    results.push(await api.listPullRequests({ ...page, target: { repository } }, signal));
    results.push(await api.searchPullRequests({
      ...page,
      target: { repositories: [repository] },
      state: "open",
    }, signal));
    results.push(await api.getPullRequest(repository, 7, signal));
    results.push(await api.listReviews(pullPage, signal));
    results.push(await api.listIssueComments(pullPage, signal));
    results.push(await api.listReviewComments(pullPage, signal));
    results.push(await api.listFiles(pullPage, signal));
    results.push(await api.listPullRequestCommits(pullPage, signal));
    results.push(await api.getChecks(repository, "abc123", signal));
    results.push(await api.listWorkflowRuns({ ...page, repository }, signal));
    results.push(await api.listCommits({ ...page, repository }, signal));

    expect(recorded.map((item) => item.route)).toEqual([
      "GET /app",
      "GET /installation/repositories",
      "GET /repos/{owner}/{repo}",
      "GET /repos/{owner}/{repo}/pulls",
      "GET /search/issues",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
      "GET /repos/{owner}/{repo}/commits/{ref}/status",
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      "GET /repos/{owner}/{repo}/actions/runs",
      "GET /repos/{owner}/{repo}/commits",
    ]);
    expect(recorded.every((item) =>
      (item.parameters.request as { signal?: AbortSignal }).signal === signal
    )).toBe(true);
    expect(results).toMatchObject([
      { app_id: "42", slug: "work-fabric", owner: "AgentEra" },
      { items: [{ repository, visibility: "private" }] },
      { repository, default_branch: "main" },
      { items: [{ repository, number: 7, author: "octo" }] },
      { items: [] },
      { repository, number: 7, body_preview: "A bounded body", body_truncated: false },
      { items: [{ actor: null, body_preview: "" }] },
      { items: [{ id: "12", comment_type: "issue" }] },
      { items: [{ id: "13", comment_type: "review" }] },
      { items: [{ path: "src/index.ts", changes: 6 }] },
      { items: [{ sha: "abc123", subject: "Bound the adapter", verified: true }] },
      { aggregate_state: "success", checks: [{ name: "legacy/status" }, { name: "test" }] },
      { items: [{ id: "14", workflow_name: "CI" }] },
      { items: [{ sha: "abc123", subject: "Bound the adapter" }] },
    ]);
    expect(JSON.stringify(results)).not.toMatch(
      /authorization|private_key|token|installation-secret|raw-secret|raw-header-secret|raw-body-secret|response-header-secret|PRIVATE PATCH|PRIVATE LOGS|PRIVATE ARTIFACTS|PRIVATE FULL TITLE|Full commit body/i,
    );
  });

  it("follows only the bounded search page with PR detail reads", async () => {
    const recorded: RecordedRequest[] = [];
    const api = new OctokitGitHubReadApi(recordingClient(recorded, (route) => {
      if (route === "GET /search/issues") return {
        data: {
          total_count: 2,
          incomplete_results: false,
          items: [
            { number: 7, repository_url: "https://api.github.com/repos/AgentEra/work-fabric" },
            { number: 8, repository_url: "https://api.github.com/repos/AgentEra/work-fabric" },
          ],
        },
        headers: { link: '<https://api.github.com/search/issues?q=x&page=2>; rel="next"' },
      };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        const pullNumber = (recorded.at(-1)?.parameters.pull_number as number | undefined) ?? 7;
        return { data: basePullRequest(pullNumber), headers: {} };
      }
      return response(route);
    }));

    const result = await api.searchPullRequests({
      target: { owner: "AgentEra" },
      state: "open",
      labels: ["ready to merge"],
      draft: false,
      base_branch: "release/1",
      updated_since: "2026-08-01T00:00:00Z",
      page_size: 2,
    }, signal);

    expect(result).toMatchObject({
      items: [{ number: 7 }, { number: 8 }],
      next_cursor: "2",
    });
    expect(recorded.map((item) => item.route)).toEqual([
      "GET /search/issues",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    ]);
    expect(recorded[0]?.parameters).toMatchObject({
      per_page: 2,
      page: 1,
      q: 'is:pr org:AgentEra is:open label:"ready to merge" draft:false base:"release/1" updated:>=2026-08-01T00:00:00Z',
    });
  });

  it("derives stable page cursors only from validated next-link metadata", async () => {
    const recorded: RecordedRequest[] = [];
    const api = new OctokitGitHubReadApi(recordingClient(recorded, (route) => {
      if (route === "GET /installation/repositories") return {
        data: { total_count: 1, repositories: [baseRepository()] },
        headers: { link: '<https://api.github.com/installation/repositories?page=3>; rel="next"' },
      };
      return response(route);
    }));

    await expect(api.listRepositories({ page_size: 1, cursor: "2" }, signal))
      .resolves.toMatchObject({ next_cursor: "3" });
    expect(recorded[0]?.parameters).toMatchObject({ per_page: 1, page: 2 });
  });

  it("bounds UTF-8 previews without splitting a surrogate pair", async () => {
    const body = `${"a".repeat(8_190)}🙂secret-tail`;
    const api = new OctokitGitHubReadApi(recordingClient([], (route) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return { data: { ...basePullRequest(), body }, headers: {} };
      }
      return response(route);
    }));

    const result = await api.getPullRequest(repository, 7, signal);

    expect(Buffer.byteLength(result.body_preview ?? "", "utf8")).toBe(8_190);
    expect(result.body_preview?.endsWith("\uFFFD")).toBe(false);
    expect(result.body_truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-tail");
  });

  it("fails closed for malformed or over-limit upstream payloads", async () => {
    const malformed = new OctokitGitHubReadApi(recordingClient([], (route) =>
      route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
        ? { data: [{ id: 1, user: "not-a-user" }], headers: {} }
        : response(route)
    ));
    const overLimit = new OctokitGitHubReadApi(recordingClient([], (route) =>
      route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files"
        ? { data: Array.from({ length: 101 }, () => ({})), headers: {} }
        : response(route)
    ));
    const input = { repository, pull_request_number: 7, page_size: 30 };

    await expect(malformed.listReviews(input, signal)).rejects.toMatchObject({
      code: "github_response_invalid",
      retryable: false,
    } satisfies Partial<GitHubProviderError>);
    await expect(overLimit.listFiles(input, signal)).rejects.toMatchObject({
      code: "github_response_invalid",
      retryable: false,
    } satisfies Partial<GitHubProviderError>);
  });

  it("rejects impossible upstream calendar timestamps", async () => {
    const api = new OctokitGitHubReadApi(recordingClient([], (route) =>
      route === "GET /repos/{owner}/{repo}"
        ? { data: { ...baseRepository(), updated_at: "2026-02-30T10:00:00Z" }, headers: {} }
        : response(route)
    ));

    await expect(api.getRepository(repository, signal)).rejects.toMatchObject({
      code: "github_response_invalid",
    } satisfies Partial<GitHubProviderError>);
  });

  it.each(["client_secret", "api_key", "auth", "signature"])(
    "rejects every upstream link query, including %s",
    async (queryKey) => {
      const api = new OctokitGitHubReadApi(recordingClient([], (route) =>
        route === "GET /repos/{owner}/{repo}"
          ? {
              data: {
                ...baseRepository(),
                html_url: `https://github.com/AgentEra/work-fabric?${queryKey}=do-not-retain`,
              },
              headers: {},
            }
          : response(route)
      ));

      await expect(api.getRepository(repository, signal)).rejects.toMatchObject({
        code: "github_response_invalid",
      } satisfies Partial<GitHubProviderError>);
    },
  );

  it("preserves a safe HTTPS fragment without treating it as a query", async () => {
    const api = new OctokitGitHubReadApi(recordingClient([], (route) =>
      route === "GET /repos/{owner}/{repo}"
        ? {
            data: {
              ...baseRepository(),
              html_url: "https://github.com/AgentEra/work-fabric#readme?display-only",
            },
            headers: {},
          }
        : response(route)
    ));

    await expect(api.getRepository(repository, signal)).resolves.toMatchObject({
      url: "https://github.com/AgentEra/work-fabric#readme?display-only",
    });
  });

  it.each([
    "https://api.github.com/repos/AgentEra/%20",
    "https://api.github.com/repos/AgentEra/work%0Afabric",
    "https://api.github.com/repos/AgentEra/work%2Ffabric",
    "https://api.github.com/repos/AgentEra/%ZZ",
    "https://api.github.com/repos/AgentEra/ignored/../work-fabric",
    `https://api.github.com/repos/AgentEra/${"r".repeat(101)}`,
  ])("rejects malformed search repository metadata before detail reads: %s", async (repositoryUrl) => {
    const recorded: RecordedRequest[] = [];
    const api = new OctokitGitHubReadApi(recordingClient(recorded, (route) => {
      if (route === "GET /search/issues") return {
        data: {
          total_count: 1,
          incomplete_results: false,
          items: [{ number: 7, repository_url: repositoryUrl }],
        },
        headers: {},
      };
      return response(route);
    }));

    await expect(api.searchPullRequests({
      target: { owner: "AgentEra" },
      state: "open",
      page_size: 1,
    }, signal)).rejects.toMatchObject({
      code: "github_response_invalid",
      retryable: false,
    } satisfies Partial<GitHubProviderError>);
    expect(recorded.map((item) => item.route)).toEqual(["GET /search/issues"]);
  });

  it("starts status and check-run reads concurrently with the same signal", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = recordingClient([], async (route) => {
      started.push(route);
      if (started.length === 2) release();
      await gate;
      return response(route);
    });
    const api = new OctokitGitHubReadApi(client);

    await api.getChecks(repository, "abc123", signal);

    expect(started).toEqual([
      "GET /repos/{owner}/{repo}/commits/{ref}/status",
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    ]);
  });
});
