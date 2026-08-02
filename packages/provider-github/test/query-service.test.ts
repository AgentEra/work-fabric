import { describe, expect, it } from "vitest";
import type { CitizenJsonObject } from "@work-fabric/network-citizen-spi";

import {
  GITHUB_READ_CAPABILITY_IDS,
  GitHubPolicyEvaluator,
  GitHubQueryService,
  HmacGitHubCursorCodec,
  type GitHubApiPage,
  type GitHubChangedFileRecord,
  type GitHubCheckSummary,
  type GitHubCommentRecord,
  type GitHubCommitRecord,
  type GitHubIdentityRecord,
  type GitHubPullRequestRecord,
  type GitHubReadApi,
  type GitHubRepositoryRecord,
  type GitHubReviewRecord,
  type GitHubWorkflowRunRecord,
} from "../src/index.js";

const repository = { owner: "AgentEra", name: "work-fabric" } as const;
const pullRequest: GitHubPullRequestRecord = {
  repository,
  number: 42,
  title: "Bounded GitHub provider",
  url: "https://github.com/AgentEra/work-fabric/pull/42",
  author: "octocat",
  draft: false,
  base_branch: "main",
  head_branch: "provider-query",
  assignees: [],
  requested_reviewers: [],
  labels: ["provider"],
  mergeable: true,
  created_at: "2026-08-01T09:00:00.000Z",
  updated_at: "2026-08-02T09:00:00.000Z",
};

const repositoryRecord: GitHubRepositoryRecord = {
  repository,
  url: "https://github.com/AgentEra/work-fabric",
  description: null,
  visibility: "private",
  archived: false,
  default_branch: "main",
  topics: [],
  pushed_at: "2026-08-02T09:00:00.000Z",
  updated_at: "2026-08-02T09:00:00.000Z",
};

const identity: GitHubIdentityRecord = {
  app_id: "7",
  slug: "work-fabric",
  name: "Work Fabric",
  url: "https://github.com/apps/work-fabric",
  owner: "AgentEra",
};

const review: GitHubReviewRecord = {
  repository,
  pull_request_number: 42,
  id: "review-1",
  actor: "reviewer",
  state: "approved",
  submitted_at: "2026-08-02T09:00:00.000Z",
  body_preview: "approved",
  body_truncated: false,
  url: "https://github.com/AgentEra/work-fabric/pull/42#pullrequestreview-1",
};

const comment = (
  id: string,
  comment_type: GitHubCommentRecord["comment_type"],
  created_at: string,
): GitHubCommentRecord => ({
  repository,
  pull_request_number: 42,
  id,
  actor: "reviewer",
  comment_type,
  created_at,
  updated_at: created_at,
  body_preview: id,
  body_truncated: false,
  url: `https://github.com/AgentEra/work-fabric/pull/42#${id}`,
});

const file: GitHubChangedFileRecord = {
  repository,
  pull_request_number: 42,
  path: "src/query.ts",
  status: "modified",
  additions: 10,
  deletions: 2,
  changes: 12,
  url: "https://github.com/AgentEra/work-fabric/blob/a/src/query.ts",
};

const commit: GitHubCommitRecord = {
  repository,
  sha: "abc123",
  subject: "Implement query service",
  author_name: "Octo Cat",
  author_login: "octocat",
  verified: true,
  timestamp: "2026-08-02T09:00:00.000Z",
  url: "https://github.com/AgentEra/work-fabric/commit/abc123",
};

const checks: GitHubCheckSummary = {
  repository,
  ref: "provider-query",
  aggregate_state: "success",
  checks: [],
};

const workflowRun: GitHubWorkflowRunRecord = {
  repository,
  id: "run-1",
  workflow_name: "CI",
  run_number: 1,
  event: "pull_request",
  branch: "provider-query",
  head_sha: "abc123",
  actor: "octocat",
  status: "completed",
  conclusion: "success",
  created_at: "2026-08-02T09:00:00.000Z",
  updated_at: "2026-08-02T09:01:00.000Z",
  url: "https://github.com/AgentEra/work-fabric/actions/runs/1",
};

function page<T>(items: readonly T[], next_cursor?: string): GitHubApiPage<T> {
  return { items, ...(next_cursor === undefined ? {} : { next_cursor }) };
}

function api(overrides: Partial<GitHubReadApi> = {}): GitHubReadApi {
  return {
    getIdentity: async () => identity,
    listRepositories: async () => page([repositoryRecord]),
    getRepository: async () => repositoryRecord,
    listPullRequests: async () => page([pullRequest]),
    searchPullRequests: async () => page([pullRequest]),
    getPullRequest: async () => pullRequest,
    listReviews: async () => page([review]),
    listIssueComments: async () => page([comment("issue-1", "issue", "2026-08-02T09:00:00.000Z")]),
    listReviewComments: async () => page([comment("review-1", "review", "2026-08-02T09:01:00.000Z")]),
    listFiles: async () => page([file]),
    listPullRequestCommits: async () => page([commit]),
    getChecks: async () => checks,
    listWorkflowRuns: async () => page([workflowRun]),
    listCommits: async () => page([commit]),
    ...overrides,
  };
}

const policy = new GitHubPolicyEvaluator({
  allowed_owners: ["AgentEra"],
  allowed_repositories: [repository],
  maximum_page_size: 50,
  maximum_aggregate_repositories: 10,
});
const cursor = new HmacGitHubCursorCodec({ key: Buffer.alloc(32, 7) });
const context = {
  tenant_id: "tenant-a",
  installation_id_hash: "sha256:installation",
  signal: new AbortController().signal,
} as const;

function service(readApi: GitHubReadApi): GitHubQueryService {
  return new GitHubQueryService({
    api: readApi,
    policy,
    cursor,
    api_version: "2022-11-28",
    now: () => "2026-08-02T10:00:00.000Z",
  });
}

describe("GitHubQueryService", () => {
  it.each([
    [[], "empty", true],
    [[pullRequest], "complete", true],
  ] as const)("distinguishes successful list results", async (items, state, complete) => {
    const result = await service(api({
      searchPullRequests: async () => page(items),
    })).execute("github.pull_request.list", {
      target: { owner: "AgentEra" },
      state: "open",
      page_size: 30,
    }, context);

    expect(result).toMatchObject({
      outcome: "succeeded",
      data: {
        state,
        items,
        evidence: {
          provider: "github",
          fetched_at: "2026-08-02T10:00:00.000Z",
          installation_id_hash: "sha256:installation",
          api_version: "2022-11-28",
          query_scope: ["github://repository/AgentEra/work-fabric"],
          complete,
        },
      },
      artifacts: [],
    });
  });

  it("signs the upstream continuation and marks incomplete evidence as truncated", async () => {
    const query = service(api({
      listCommits: async (input) => {
        expect(input.cursor).toBeUndefined();
        return page([commit], "2");
      },
    }));

    const first = await query.execute("github.commit.list", {
      repository,
      page_size: 10,
    }, context);
    expect(first).toMatchObject({
      outcome: "succeeded",
      data: { state: "truncated", evidence: { complete: false } },
    });
    if (first.outcome !== "succeeded") throw new Error("expected successful first page");
    const next = (first.data.evidence as { next_cursor: string }).next_cursor;
    expect(next).not.toBe("2");

    const secondApi = api({
      listCommits: async (input) => {
        expect(input.cursor).toBe("2");
        return page([commit]);
      },
    });
    await expect(service(secondApi).execute("github.commit.list", {
      repository,
      page_size: 10,
      cursor: next,
    }, context)).resolves.toMatchObject({ outcome: "succeeded", data: { state: "complete" } });

    await expect(service(secondApi).execute("github.commit.list", {
      repository,
      ref: "other",
      page_size: 10,
      cursor: next,
    }, context)).rejects.toThrowError("github_invalid_request");
  });

  it("fails policy checks before calling the GitHub API", async () => {
    let called = false;
    const query = service(api({
      getRepository: async () => {
        called = true;
        return repositoryRecord;
      },
    }));

    await expect(query.execute("github.repository.get", {
      repository: { owner: "Other", name: "secret" },
    }, context)).rejects.toThrowError("github_forbidden");
    expect(called).toBe(false);
  });

  it("starts both comment reads before awaiting and merges them deterministically", async () => {
    let issueStarted = false;
    let reviewStarted = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const query = service(api({
      listIssueComments: async () => {
        issueStarted = true;
        if (reviewStarted) release();
        await gate;
        return page([comment("issue-late", "issue", "2026-08-02T09:02:00.000Z")]);
      },
      listReviewComments: async () => {
        reviewStarted = true;
        if (issueStarted) release();
        await gate;
        return page([comment("review-early", "review", "2026-08-02T09:01:00.000Z")]);
      },
    }));

    const result = await query.execute("github.pull_request.comments.list", {
      repository,
      pull_request_number: 42,
      kind: "all",
      page_size: 30,
    }, context);

    expect(result).toMatchObject({
      outcome: "succeeded",
      data: {
        state: "complete",
        items: [{ id: "review-early" }, { id: "issue-late" }],
      },
    });
  });

  it("reads only ordinary issue comments when kind is omitted", async () => {
    let reviewCalled = false;
    const result = await service(api({
      listIssueComments: async () => page([
        comment("issue-only", "issue", "2026-08-02T09:00:00.000Z"),
      ]),
      listReviewComments: async () => {
        reviewCalled = true;
        return page([comment("unexpected", "review", "2026-08-02T09:01:00.000Z")]);
      },
    })).execute("github.pull_request.comments.list", {
      repository,
      pull_request_number: 42,
    }, context);

    expect(result).toMatchObject({
      outcome: "succeeded",
      data: { items: [{ id: "issue-only", comment_type: "issue" }] },
    });
    expect(reviewCalled).toBe(false);
  });

  it("resumes an interleaved all-comments merge without loss or duplication", async () => {
    const issuePages = new Map([
      [1, page([
        comment("issue-3", "issue", "2026-08-02T09:05:00.000Z"),
        comment("issue-1", "issue", "2026-08-02T09:01:00.000Z"),
      ], "2")],
      [2, page([
        comment("issue-5", "issue", "2026-08-02T09:09:00.000Z"),
      ])],
    ]);
    const reviewPages = new Map([
      [1, page([
        comment("review-2", "review", "2026-08-02T09:03:00.000Z"),
        comment("review-1", "review", "2026-08-02T09:02:00.000Z"),
      ], "2")],
      [2, page([
        comment("review-3", "review", "2026-08-02T09:04:00.000Z"),
        comment("review-4", "review", "2026-08-02T09:06:00.000Z"),
      ], "3")],
      [3, page([
        comment("review-5", "review", "2026-08-02T09:07:00.000Z"),
        comment("review-6", "review", "2026-08-02T09:08:00.000Z"),
      ])],
    ]);
    let calls = 0;
    const paged = <T>(pages: ReadonlyMap<number, GitHubApiPage<T>>) =>
      async (input: { readonly page_size: number; readonly cursor?: string }) => {
        calls += 1;
        expect(input.page_size).toBe(2);
        const result = pages.get(input.cursor === undefined ? 1 : Number(input.cursor));
        if (result === undefined) throw new Error("unexpected comment page");
        return result;
      };
    const query = service(api({
      listIssueComments: paged(issuePages),
      listReviewComments: paged(reviewPages),
    }));
    const collected: string[] = [];
    let next: string | undefined;
    let pages = 0;
    do {
      const before = calls;
      const result = await query.execute("github.pull_request.comments.list", {
        repository,
        pull_request_number: 42,
        kind: "all",
        page_size: 2,
        ...(next === undefined ? {} : { cursor: next }),
      }, context);
      expect(result.outcome).toBe("succeeded");
      if (result.outcome !== "succeeded") throw new Error("expected comment page");
      const data = result.data as unknown as {
        readonly state: "complete" | "truncated";
        readonly items: readonly { readonly id: string }[];
        readonly evidence: { readonly next_cursor?: string };
      };
      expect(data.items.length).toBeLessThanOrEqual(2);
      expect(calls - before).toBeLessThanOrEqual(4);
      collected.push(...data.items.map((item) => item.id));
      pages += 1;
      next = data.evidence.next_cursor;
      if (next !== undefined) {
        expect(data.state).toBe("truncated");
      } else {
        expect(data.state).toBe("complete");
      }
    } while (next !== undefined);

    expect(pages).toBeGreaterThanOrEqual(3);
    expect(collected).toEqual([
      "issue-1",
      "review-1",
      "review-2",
      "review-3",
      "issue-3",
      "review-4",
      "review-5",
      "review-6",
      "issue-5",
    ]);
    expect(new Set(collected).size).toBe(collected.length);
  });

  it("rejects tampered and cross-scope all-comments continuations before refetch", async () => {
    let calls = 0;
    const query = service(api({
      listIssueComments: async () => {
        calls += 1;
        return page([
          comment("issue-1", "issue", "2026-08-02T09:01:00.000Z"),
          comment("issue-2", "issue", "2026-08-02T09:03:00.000Z"),
        ]);
      },
      listReviewComments: async () => {
        calls += 1;
        return page([
          comment("review-1", "review", "2026-08-02T09:02:00.000Z"),
          comment("review-2", "review", "2026-08-02T09:04:00.000Z"),
        ]);
      },
    }));
    const first = await query.execute("github.pull_request.comments.list", {
      repository,
      pull_request_number: 42,
      kind: "all",
      page_size: 2,
    }, context);
    if (first.outcome !== "succeeded") throw new Error("expected first merge page");
    const next = (first.data.evidence as { next_cursor: string }).next_cursor;
    const before = calls;

    await expect(query.execute("github.pull_request.comments.list", {
      repository,
      pull_request_number: 42,
      kind: "all",
      page_size: 2,
      cursor: `${next}x`,
    }, context)).rejects.toThrowError("github_invalid_request");
    await expect(query.execute("github.pull_request.comments.list", {
      repository,
      pull_request_number: 43,
      kind: "all",
      page_size: 2,
      cursor: next,
    }, context)).rejects.toThrowError("github_invalid_request");
    expect(calls).toBe(before);
  });

  it("dispatches every declared capability and returns only normalized facts", async () => {
    const inputs: Record<(typeof GITHUB_READ_CAPABILITY_IDS)[number], CitizenJsonObject> = {
      "github.identity.get": {},
      "github.repository.list": {},
      "github.repository.get": { repository },
      "github.pull_request.list": { target: { repository } },
      "github.pull_request.get": { repository, number: 42 },
      "github.pull_request.reviews.list": { repository, pull_request_number: 42 },
      "github.pull_request.comments.list": { repository, pull_request_number: 42, kind: "issue" },
      "github.pull_request.files.list": { repository, pull_request_number: 42 },
      "github.pull_request.commits.list": { repository, pull_request_number: 42 },
      "github.pull_request.checks.get": { repository, number: 42 },
      "github.actions.workflow_runs.list": { repository },
      "github.commit.list": { repository },
    };

    for (const capabilityId of GITHUB_READ_CAPABILITY_IDS) {
      const result = await service(api()).execute(capabilityId, inputs[capabilityId], context);
      expect(result.outcome, capabilityId).toBe("succeeded");
    }
  });

  it("does not turn an aborted request into evidence", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(service(api()).execute("github.identity.get", {}, {
      ...context,
      signal: controller.signal,
    })).rejects.toMatchObject({
      code: "github_upstream_unavailable",
    });
  });
});
