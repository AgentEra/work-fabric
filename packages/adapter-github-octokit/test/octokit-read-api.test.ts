import { describe, expect, it } from "vitest";

import {
  GITHUB_MAX_RESULT_BYTES,
  GitHubPolicyEvaluator,
  GitHubProviderError,
  GitHubQueryService,
  HmacGitHubCursorCodec,
} from "@work-fabric/provider-github";

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
    head: { ref: "feature/github", sha: "deadbeef1234" },
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
        total_count: 1,
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

async function executeMaximumPullRequestResult(fill: string) {
  const repositories = Array.from({ length: 100 }, (_, index) => ({
    owner: "AgentEra",
    name: `r-${String(index).padStart(3, "0")}-${fill.repeat(94)}`,
  }));
  const client: OctokitRequestClient = {
    request: (async (route: string, parameters: Record<string, unknown>) => {
      if (route !== "GET /repos/{owner}/{repo}/pulls") {
        throw new Error(`unexpected route ${route}`);
      }
      const owner = String(parameters.owner);
      const name = String(parameters.repo);
      const encodedOwner = encodeURIComponent(owner);
      const encodedName = encodeURIComponent(name);
      const repeatedLogin = fill.repeat(100);
      return {
        data: [{
          number: 99_999,
          title: fill.repeat(512),
          html_url: `https://github.com/${encodedOwner}/${encodedName}/pull/99999#${"x".repeat(1_500)}`,
          user: { login: repeatedLogin },
          draft: false,
          base: { ref: fill.repeat(255) },
          head: { ref: fill.repeat(255), sha: fill.repeat(64) },
          assignees: Array.from({ length: 10 }, () => ({ login: repeatedLogin })),
          requested_reviewers: Array.from({ length: 10 }, () => ({ login: repeatedLogin })),
          labels: Array.from({ length: 10 }, () => ({ name: repeatedLogin })),
          mergeable: null,
          created_at: "2026-08-01T09:00:00Z",
          updated_at: "2026-08-02T09:00:00Z",
          body: null,
        }],
        headers: {},
      };
    }) as OctokitRequestClient["request"],
  };
  const query = new GitHubQueryService({
    api: new OctokitGitHubReadApi(client),
    policy: new GitHubPolicyEvaluator({
      allowed_owners: ["AgentEra"],
      allowed_repositories: repositories,
      maximum_page_size: 5,
      maximum_aggregate_repositories: 100,
    }),
    cursor: new HmacGitHubCursorCodec({ key: Buffer.alloc(32, 9) }),
    api_version: "2022-11-28",
    now: () => "2026-08-03T00:00:00.000Z",
  });
  return query.execute("github.pull_request.list", {
    target: { repositories },
    state: "open",
    page_size: 5,
  }, {
    tenant_id: "tenant-test",
    installation_id_hash: `sha256:${"a".repeat(64)}`,
    signal,
  });
}

describe("OctokitGitHubReadApi", () => {
  it("rejects a JSON-escaped real adapter result above the shared byte budget", async () => {
    await expect(executeMaximumPullRequestResult("\0")).rejects.toMatchObject({
      code: "github_result_truncated",
      retryable: false,
    } satisfies Partial<GitHubProviderError>);
  });

  it("keeps the equivalent maximum ASCII adapter result below the shared byte budget", async () => {
    const result = await executeMaximumPullRequestResult("x");

    expect(result).toMatchObject({
      outcome: "succeeded",
      data: { state: "truncated", items: { length: 5 } },
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8"))
      .toBeLessThan(GITHUB_MAX_RESULT_BYTES);
  });

  it("uses only the approved GET routes and returns provider-owned records", async () => {
    const recorded: RecordedRequest[] = [];
    const api = new OctokitGitHubReadApi(recordingClient(recorded));
    const page = { page_size: 5 };
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
    expect(recorded.every((item) =>
      (item.parameters.headers as Record<string, string> | undefined)?.["X-GitHub-Api-Version"]
        === "2022-11-28"
    )).toBe(true);
    expect(recorded.filter((item) =>
      item.route === "GET /repos/{owner}/{repo}/commits/{ref}/status" ||
      item.route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs"
    ).every((item) => item.parameters.per_page === 20)).toBe(true);
    expect(results).toMatchObject([
      {
        app_id: "42",
        slug: "work-fabric",
        owner: "AgentEra",
        installation_repository_count: 1,
      },
      { items: [{ repository, visibility: "private" }] },
      { repository, default_branch: "main" },
      { items: [{ repository, number: 7, author: "octo", head_sha: "deadbeef1234" }] },
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

  it("rejects GitHub-owned URLs and REST repository identities from other hosts", async () => {
    const foreignHtml = new OctokitGitHubReadApi(recordingClient([], (route) =>
      route === "GET /repos/{owner}/{repo}"
        ? { data: { ...baseRepository(), html_url: "https://example.test/AgentEra/work-fabric" }, headers: {} }
        : response(route)
    ));
    await expect(foreignHtml.getRepository(repository, signal)).rejects.toMatchObject({
      code: "github_response_invalid",
    });

    const foreignRest = new OctokitGitHubReadApi(recordingClient([], (route) =>
      route === "GET /search/issues"
        ? {
            data: {
              total_count: 1,
              incomplete_results: false,
              items: [{
                number: 7,
                repository_url: "https://evil.example/repos/AgentEra/work-fabric",
              }],
            },
            headers: {},
          }
        : response(route)
    ));
    await expect(foreignRest.searchPullRequests({
      target: { owner: "AgentEra" },
      page_size: 1,
    }, signal)).rejects.toMatchObject({ code: "github_response_invalid" });
  });

  it("rebinds direct repository responses to the requested repository identity", async () => {
    const api = new OctokitGitHubReadApi(recordingClient([], (route) =>
      route === "GET /repos/{owner}/{repo}"
        ? {
            data: {
              ...baseRepository(),
              name: "transferred",
              owner: { login: "OtherOwner" },
              html_url: "https://github.com/OtherOwner/transferred",
            },
            headers: {},
          }
        : response(route)
    ));

    await expect(api.getRepository(repository, signal)).rejects.toMatchObject({
      code: "github_response_invalid",
    });
  });

  it("groups a bounded search page by repository without per-PR detail reads", async () => {
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
      if (route === "GET /repos/{owner}/{repo}/pulls") {
        return { data: [basePullRequest(7), basePullRequest(8)], headers: {} };
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
      "GET /repos/{owner}/{repo}/pulls",
    ]);
    expect(recorded[0]?.parameters).toMatchObject({
      per_page: 2,
      page: 1,
      q: 'is:pr org:AgentEra is:open label:"ready to merge" draft:false base:"release/1" updated:>=2026-08-01T00:00:00Z',
    });
  });

  it("rejects incomplete GitHub search results instead of claiming a complete page", async () => {
    const api = new OctokitGitHubReadApi(recordingClient([], (route) =>
      route === "GET /search/issues"
        ? { data: { total_count: 1, incomplete_results: true, items: [] }, headers: {} }
        : response(route)
    ));

    await expect(api.searchPullRequests({
      target: { owner: "AgentEra" },
      page_size: 5,
    }, signal)).rejects.toMatchObject({ code: "github_response_invalid" });
  });

  it("compares updated_since as parsed RFC3339 instants", async () => {
    const api = new OctokitGitHubReadApi(recordingClient([], (route) =>
      route === "GET /repos/{owner}/{repo}/pulls"
        ? {
            data: [
              { ...basePullRequest(7), updated_at: "2026-08-01T10:00:00Z" },
              { ...basePullRequest(8), updated_at: "2026-08-01T09:59:59Z" },
            ],
            headers: {},
          }
        : response(route)
    ));

    await expect(api.listPullRequests({
      target: { repository },
      updated_since: "2026-08-01T12:00:00+02:00",
      page_size: 5,
    }, signal)).resolves.toMatchObject({ items: [{ number: 7 }] });
  });

  it("matches GitHub logins and labels case-insensitively", async () => {
    const api = new OctokitGitHubReadApi(recordingClient([], (route) =>
      route === "GET /repos/{owner}/{repo}/pulls"
        ? { data: [basePullRequest(7)], headers: {} }
        : response(route)
    ));

    await expect(api.listPullRequests({
      target: { repository },
      author: "OCTO",
      reviewer: "Reviewer",
      assignee: "OWNER",
      labels: ["GitHub"],
      page_size: 5,
    }, signal)).resolves.toMatchObject({ items: [{ number: 7 }] });
  });

  it("preserves upstream continuation when a repository PR page filters to zero matches", async () => {
    const api = new OctokitGitHubReadApi(recordingClient([], (route) =>
      route === "GET /repos/{owner}/{repo}/pulls"
        ? {
            data: [{ ...basePullRequest(), user: { login: "someone-else" } }],
            headers: { link: '<https://api.github.com/repos/AgentEra/work-fabric/pulls?page=2>; rel="next"' },
          }
        : response(route)
    ));

    await expect(api.listPullRequests({
      target: { repository },
      author: "octo",
      page_size: 5,
    }, signal)).resolves.toEqual({ items: [], next_cursor: "2" });
  });

  it.each([
    ["check runs", { total_count: 2, check_runs: [] }],
    ["statuses", { state: "success", total_count: 2, statuses: [] }],
  ])("rejects partial %s aggregates", async (kind, partial) => {
    const api = new OctokitGitHubReadApi(recordingClient([], (route) => {
      if (kind === "check runs" && route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
        return { data: partial, headers: {} };
      }
      if (kind === "statuses" && route === "GET /repos/{owner}/{repo}/commits/{ref}/status") {
        return { data: partial, headers: {} };
      }
      return response(route);
    }));

    await expect(api.getChecks(repository, "abc123", signal)).rejects.toMatchObject({
      code: "github_response_invalid",
    });
  });

  it("rejects check aggregates with an upstream continuation even when returned counts match", async () => {
    const api = new OctokitGitHubReadApi(recordingClient([], (route) => {
      const result = response(route);
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/status") {
        return {
          ...result,
          headers: { link: '<https://api.github.com/repos/AgentEra/work-fabric/commits/abc/status?page=2>; rel="next"' },
        };
      }
      return result;
    }));

    await expect(api.getChecks(repository, "abc123", signal)).rejects.toMatchObject({
      code: "github_response_invalid",
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
    const body = `${"a".repeat(1_022)}🙂secret-tail`;
    const api = new OctokitGitHubReadApi(recordingClient([], (route) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return { data: { ...basePullRequest(), body }, headers: {} };
      }
      return response(route);
    }));

    const result = await api.getPullRequest(repository, 7, signal);

    expect(Buffer.byteLength(result.body_preview ?? "", "utf8")).toBe(1_022);
    expect(result.body_preview?.endsWith("\uFFFD")).toBe(false);
    expect(result.body_truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-tail");
  });

  it("rejects commit subjects above the default 512-byte text limit", async () => {
    const commit = baseCommit();
    const api = new OctokitGitHubReadApi(recordingClient([], (route) =>
      route === "GET /repos/{owner}/{repo}/commits"
        ? {
            data: [{
              ...commit,
              commit: { ...commit.commit, message: `${"s".repeat(513)}\nprivate body` },
            }],
            headers: {},
          }
        : response(route)
    ));

    await expect(api.listCommits({ repository, page_size: 5 }, signal))
      .rejects.toMatchObject({
        code: "github_response_invalid",
        retryable: false,
      } satisfies Partial<GitHubProviderError>);
  });

  it("fails closed for malformed or over-limit upstream payloads", async () => {
    const malformed = new OctokitGitHubReadApi(recordingClient([], (route) =>
      route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"
        ? { data: [{ id: 1, user: "not-a-user" }], headers: {} }
        : response(route)
    ));
    const overLimit = new OctokitGitHubReadApi(recordingClient([], (route) =>
      route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files"
        ? { data: Array.from({ length: 6 }, () => ({})), headers: {} }
        : response(route)
    ));
    const input = { repository, pull_request_number: 7, page_size: 5 };

    await expect(malformed.listReviews(input, signal)).rejects.toMatchObject({
      code: "github_response_invalid",
      retryable: false,
    } satisfies Partial<GitHubProviderError>);
    await expect(overLimit.listFiles(input, signal)).rejects.toMatchObject({
      code: "github_response_invalid",
      retryable: false,
    } satisfies Partial<GitHubProviderError>);
  });

  it.each([
    ["repository topics", "GET /repos/{owner}/{repo}", () => ({
      ...baseRepository(),
      topics: Array.from({ length: 11 }, (_, index) => `topic-${index}`),
    }), (api: OctokitGitHubReadApi) => api.getRepository(repository, signal)],
    ["pull request labels", "GET /repos/{owner}/{repo}/pulls", () => ([{
      ...basePullRequest(),
      labels: Array.from({ length: 11 }, (_, index) => ({ name: `label-${index}` })),
    }]), (api: OctokitGitHubReadApi) => api.listPullRequests({
      target: { repository }, page_size: 5,
    }, signal)],
    ["pull request assignees", "GET /repos/{owner}/{repo}/pulls", () => ([{
      ...basePullRequest(),
      assignees: Array.from({ length: 11 }, (_, index) => ({ login: `user-${index}` })),
    }]), (api: OctokitGitHubReadApi) => api.listPullRequests({
      target: { repository }, page_size: 5,
    }, signal)],
    ["requested reviewers", "GET /repos/{owner}/{repo}/pulls", () => ([{
      ...basePullRequest(),
      requested_reviewers: Array.from({ length: 11 }, (_, index) => ({ login: `reviewer-${index}` })),
    }]), (api: OctokitGitHubReadApi) => api.listPullRequests({
      target: { repository }, page_size: 5,
    }, signal)],
  ] as const)("rejects over-limit %s instead of silently omitting values", async (_name, route, data, execute) => {
    const api = new OctokitGitHubReadApi(recordingClient([], (actualRoute) =>
      actualRoute === route ? { data: data(), headers: {} } : response(actualRoute)
    ));

    await expect(execute(api)).rejects.toMatchObject({
      code: "github_response_invalid",
      retryable: false,
    } satisfies Partial<GitHubProviderError>);
  });

  it("rejects check aggregates above twenty items with a stable response error", async () => {
    const statuses = Array.from({ length: 11 }, (_, index) => ({
      context: `status-${index}`,
      state: "success",
      target_url: null,
      created_at: "2026-08-01T09:00:00Z",
      updated_at: "2026-08-01T09:01:00Z",
    }));
    const checkRuns = Array.from({ length: 10 }, (_, index) => ({
      name: `check-${index}`,
      status: "completed",
      conclusion: "success",
      started_at: "2026-08-01T09:00:00Z",
      completed_at: "2026-08-01T09:01:00Z",
      html_url: `https://github.com/AgentEra/work-fabric/runs/${index}`,
    }));
    const api = new OctokitGitHubReadApi(recordingClient([], (route) => {
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/status") {
        return { data: { state: "success", total_count: statuses.length, statuses }, headers: {} };
      }
      if (route === "GET /repos/{owner}/{repo}/commits/{ref}/check-runs") {
        return { data: { total_count: checkRuns.length, check_runs: checkRuns }, headers: {} };
      }
      return response(route);
    }));

    await expect(api.getChecks(repository, "abc123", signal)).rejects.toMatchObject({
      code: "github_response_invalid",
      retryable: false,
    } satisfies Partial<GitHubProviderError>);
  });

  it("keeps a worst-case successful PR page below the Agent result byte ceiling", async () => {
    const text = "界".repeat(170);
    const names = Array.from({ length: 10 }, (_, index) => ({ login: `user-${index}-${"x".repeat(88)}` }));
    const labels = Array.from({ length: 10 }, (_, index) => ({ name: `label-${index}-${"x".repeat(87)}` }));
    const pullRequests = Array.from({ length: 5 }, (_, index) => ({
      ...basePullRequest(index + 1),
      title: text,
      html_url: `https://github.com/AgentEra/work-fabric/pull/${index + 1}#${"x".repeat(1_990)}`,
      assignees: names,
      requested_reviewers: names,
      labels,
      base: { ref: "b".repeat(255) },
      head: { ref: "h".repeat(255), sha: "a".repeat(64) },
    }));
    const api = new OctokitGitHubReadApi(recordingClient([], (route) =>
      route === "GET /repos/{owner}/{repo}/pulls"
        ? { data: pullRequests, headers: {} }
        : response(route)
    ));

    const page = await api.listPullRequests({ target: { repository }, page_size: 5 }, signal);
    const result = {
      outcome: "succeeded",
      data: {
        state: "complete",
        items: page.items,
        evidence: {
          provider: "github",
          fetched_at: "2026-08-03T00:00:00.000Z",
          installation_id_hash: `sha256:${"a".repeat(64)}`,
          api_version: "2022-11-28",
          query_scope: ["github://repository/AgentEra/work-fabric"],
          complete: true,
        },
      },
      artifacts: [],
    };

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(131_072);
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
    "https://api.github.com/repos/AgentEra/.",
    "https://api.github.com/repos/AgentEra/..",
    "https://api.github.com/repos/AgentEra/%2E",
    "https://api.github.com/repos/AgentEra/%2E%2E",
    "https://api.github.com/repos/AgentEra/work+fabric",
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

  it("retains a valid dot-containing repository from search metadata", async () => {
    const recorded: RecordedRequest[] = [];
    const api = new OctokitGitHubReadApi(recordingClient(recorded, (route) => {
      if (route === "GET /search/issues") return {
        data: {
          total_count: 1,
          incomplete_results: false,
          items: [{
            number: 7,
            repository_url: "https://api.github.com/repos/AgentEra/work.fabric",
          }],
        },
        headers: {},
      };
      if (route === "GET /repos/{owner}/{repo}/pulls") {
        return {
          data: [{
            ...basePullRequest(),
            html_url: "https://github.com/AgentEra/work.fabric/pull/7",
          }],
          headers: {},
        };
      }
      return response(route);
    }));

    await expect(api.searchPullRequests({
      target: { owner: "AgentEra" },
      state: "open",
      page_size: 1,
    }, signal)).resolves.toMatchObject({
      items: [{ repository: { owner: "AgentEra", name: "work.fabric" } }],
    });
    expect(recorded.map((item) => item.route)).toEqual([
      "GET /search/issues",
      "GET /repos/{owner}/{repo}/pulls",
    ]);
    expect(recorded[1]?.parameters).toMatchObject({ owner: "AgentEra", repo: "work.fabric" });
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
