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
  head_sha: "abc123immutable",
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
  installation_repository_count: 1,
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
  ref: "abc123immutable",
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
  maximum_page_size: 5,
  maximum_aggregate_repositories: 10,
});
const cursor = new HmacGitHubCursorCodec({ key: Buffer.alloc(32, 7) });
const context = {
  tenant_id: "tenant-a",
  installation_id_hash: "sha256:installation",
  signal: new AbortController().signal,
} as const;

function service(
  readApi: GitHubReadApi,
  policyEvaluator: GitHubPolicyEvaluator = policy,
): GitHubQueryService {
  return new GitHubQueryService({
    api: readApi,
    policy: policyEvaluator,
    cursor,
    api_version: "2022-11-28",
    now: () => "2026-08-02T10:00:00.000Z",
  });
}

describe("GitHubQueryService", () => {
  it("filters installation repository pages through the Provider policy ceiling without losing continuation", async () => {
    const hidden = {
      ...repositoryRecord,
      repository: { owner: "AgentEra", name: "installation-only-hidden" },
    };
    let calls = 0;
    const query = service(api({
      listRepositories: async (input) => {
        calls += 1;
        if (input.cursor === undefined) return page([hidden], "2");
        expect(input.cursor).toBe("2");
        return page([repositoryRecord]);
      },
    }));

    const result = await query.execute("github.repository.list", { page_size: 1 }, context);
    expect(result).toMatchObject({
      outcome: "succeeded",
      data: { state: "complete", items: [repositoryRecord] },
    });
    expect(calls).toBe(2);
  });

  it("signs the actual upstream continuation after skipping unauthorized repository pages", async () => {
    const hidden = {
      ...repositoryRecord,
      repository: { owner: "AgentEra", name: "installation-only-hidden" },
    };
    const calls: Array<string | undefined> = [];
    const query = service(api({
      listRepositories: async (input) => {
        calls.push(input.cursor);
        if (input.cursor === undefined) return page([hidden], "2");
        if (input.cursor === "2") return page([repositoryRecord], "3");
        expect(input.cursor).toBe("3");
        return page([repositoryRecord]);
      },
    }));

    const first = await query.execute("github.repository.list", { page_size: 1 }, context);
    expect(first).toMatchObject({
      outcome: "succeeded",
      data: { state: "truncated", items: [repositoryRecord] },
    });
    if (first.outcome !== "succeeded") throw new Error("expected repository page");
    const cursor = (first.data.evidence as { next_cursor: string }).next_cursor;
    const second = await query.execute("github.repository.list", {
      page_size: 1,
      cursor,
    }, context);
    expect(second).toMatchObject({
      outcome: "succeeded",
      data: { state: "complete", items: [repositoryRecord] },
    });
    expect(calls).toEqual([undefined, "2", "3"]);
  });

  it("queries checks with the immutable pull-request head SHA", async () => {
    let observedRef: string | undefined;
    await service(api({
      getChecks: async (_repository, ref) => {
        observedRef = ref;
        return checks;
      },
    })).execute("github.pull_request.checks.get", { repository, number: 42 }, context);

    expect(observedRef).toBe("abc123immutable");
  });

  it("scans filtered empty upstream PR pages and resumes later matches without duplication", async () => {
    const later = { ...pullRequest, number: 43, title: "Later match" };
    const calls: Array<{ readonly name: string; readonly cursor: string | undefined }> = [];
    const query = service(api({
      listPullRequests: async (input) => {
        if (!("repository" in input.target)) throw new Error("expected repository target");
        calls.push({ name: input.target.repository.name, cursor: input.cursor });
        if (input.cursor === undefined) return page([], "2");
        if (input.cursor === "2") return page([pullRequest], "3");
        if (input.cursor === "3") return page([later]);
        throw new Error("unexpected page");
      },
      searchPullRequests: async () => {
        throw new Error("search must not be used");
      },
    }));

    const first = await query.execute("github.pull_request.list", {
      target: { repository },
      author: "octocat",
      page_size: 1,
    }, context);
    expect(first).toMatchObject({
      outcome: "succeeded",
      data: { state: "truncated", items: [{ number: 42 }] },
    });
    if (first.outcome !== "succeeded") throw new Error("expected first PR page");
    const next = (first.data.evidence as { readonly next_cursor: string }).next_cursor;
    expect(next).not.toBe("3");

    const second = await query.execute("github.pull_request.list", {
      target: { repository },
      author: "octocat",
      page_size: 1,
      cursor: next,
    }, context);
    expect(second).toMatchObject({
      outcome: "succeeded",
      data: { state: "complete", items: [{ number: 43 }] },
    });
    expect(calls).toEqual([
      { name: "work-fabric", cursor: undefined },
      { name: "work-fabric", cursor: "2" },
      { name: "work-fabric", cursor: "2" },
      { name: "work-fabric", cursor: "3" },
    ]);
  });

  it("aggregates explicit repositories in deterministic order without search or per-PR detail calls", async () => {
    const alpha = { owner: "AgentEra", name: "alpha" } as const;
    const beta = { owner: "AgentEra", name: "beta" } as const;
    const alphaPull = { ...pullRequest, repository: alpha, number: 1, title: "alpha" };
    const betaPull = { ...pullRequest, repository: beta, number: 2, title: "beta" };
    const calls: string[] = [];
    const aggregatePolicy = new GitHubPolicyEvaluator({
      allowed_owners: ["AgentEra"],
      allowed_repositories: [alpha, beta],
      maximum_page_size: 5,
      maximum_aggregate_repositories: 2,
    });
    const query = service(api({
      listPullRequests: async (input) => {
        if (!("repository" in input.target)) throw new Error("expected repository target");
        calls.push(input.target.repository.name);
        return page<GitHubPullRequestRecord>(
          input.target.repository.name === "alpha" ? [alphaPull] : [betaPull],
        );
      },
      searchPullRequests: async () => {
        throw new Error("search must not be used");
      },
      getPullRequest: async () => {
        throw new Error("detail must not be used");
      },
    }), aggregatePolicy);

    const result = await query.execute("github.pull_request.list", {
      target: { repositories: [beta, alpha] },
      page_size: 5,
    }, context);
    expect(result).toMatchObject({
      outcome: "succeeded",
      data: { state: "complete", items: [{ title: "alpha" }, { title: "beta" }] },
    });
    expect(calls).toEqual(["alpha", "beta"]);
  });

  it("continues at the next deterministic repository without refetching prior PRs", async () => {
    const alpha = { owner: "AgentEra", name: "alpha" } as const;
    const beta = { owner: "AgentEra", name: "beta" } as const;
    const aggregatePolicy = new GitHubPolicyEvaluator({
      allowed_owners: ["AgentEra"],
      allowed_repositories: [alpha, beta],
      maximum_page_size: 5,
      maximum_aggregate_repositories: 2,
    });
    const calls: string[] = [];
    const query = service(api({
      listPullRequests: async (input) => {
        if (!("repository" in input.target)) throw new Error("expected repository target");
        calls.push(input.target.repository.name);
        return input.target.repository.name === "beta"
          ? page([{ ...pullRequest, repository: input.target.repository }], "2")
          : page([{ ...pullRequest, repository: input.target.repository }]);
      },
    }), aggregatePolicy);

    const first = await query.execute("github.pull_request.list", {
      target: { repositories: [beta, alpha] },
      page_size: 1,
    }, context);
    if (first.outcome !== "succeeded") throw new Error("expected first aggregate page");
    const next = (first.data.evidence as { readonly next_cursor: string }).next_cursor;
    expect(first.data).toMatchObject({ state: "truncated", items: [{ repository: alpha }] });

    const second = await query.execute("github.pull_request.list", {
      target: { repositories: [beta, alpha] },
      page_size: 1,
      cursor: next,
    }, context);
    expect(second).toMatchObject({
      outcome: "succeeded",
      data: { state: "truncated", items: [{ repository: beta }] },
    });
    expect(calls).toEqual(["alpha", "beta"]);
  });

  it("rejects unrestricted owner aggregation above the configured repository ceiling before PR reads", async () => {
    const alphaRecord = { ...repositoryRecord, repository: { owner: "AgentEra", name: "alpha" } };
    const betaRecord = { ...repositoryRecord, repository: { owner: "AgentEra", name: "beta" } };
    let pullCalls = 0;
    const ownerPolicy = new GitHubPolicyEvaluator({
      allowed_owners: ["AgentEra"],
      allowed_repositories: [],
      maximum_page_size: 5,
      maximum_aggregate_repositories: 1,
    });
    const query = service(api({
      listRepositories: async () => page([betaRecord, alphaRecord]),
      listPullRequests: async () => {
        pullCalls += 1;
        return page([]);
      },
    }), ownerPolicy);

    await expect(query.execute("github.pull_request.list", {
      target: { owner: "AgentEra" },
      page_size: 5,
    }, context)).rejects.toThrowError("github_forbidden");
    expect(pullCalls).toBe(0);
  });
  it.each([
    [[], "empty", true],
    [[pullRequest], "complete", true],
  ] as const)("distinguishes successful list results", async (items, state, complete) => {
    const result = await service(api({
      listPullRequests: async () => page(items),
    })).execute("github.pull_request.list", {
      target: { owner: "AgentEra" },
      state: "open",
      page_size: 5,
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

  it("keeps a worst-case successful capability result below the Agent byte ceiling", async () => {
    const repositories = Array.from({ length: 100 }, (_, index) => ({
      owner: "AgentEra",
      name: `r-${String(index).padStart(3, "0")}-${"x".repeat(94)}`,
    }));
    const boundedNames = Array.from({ length: 10 }, (_, index) =>
      `user-${String(index).padStart(2, "0")}-${"x".repeat(92)}`
    );
    const resultPolicy = new GitHubPolicyEvaluator({
      allowed_owners: ["AgentEra"],
      allowed_repositories: repositories,
      maximum_page_size: 5,
      maximum_aggregate_repositories: 100,
    });
    const query = service(api({
      listPullRequests: async (input) => {
        if (!("repository" in input.target)) throw new Error("expected repository target");
        const current = input.target.repository;
        return page([{
          repository: current,
          number: 99_999,
          title: "t".repeat(512),
          url: `https://github.com/${current.owner}/${current.name}/pull/99999#${"x".repeat(1_850)}`,
          author: "a".repeat(100),
          draft: false,
          base_branch: "b".repeat(255),
          head_branch: "h".repeat(255),
          head_sha: "f".repeat(64),
          assignees: boundedNames,
          requested_reviewers: boundedNames,
          labels: boundedNames,
          mergeable: null,
          created_at: "2026-08-01T09:00:00.000Z",
          updated_at: "2026-08-02T09:00:00.000Z",
        }]);
      },
    }), resultPolicy);

    const result = await query.execute("github.pull_request.list", {
      target: { repositories },
      state: "open",
      page_size: 5,
    }, context);

    expect(result).toMatchObject({
      outcome: "succeeded",
      data: { state: "truncated", items: { length: 5 } },
    });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(131_072);
  });

  it("classifies cyclic successful data as an invalid Provider response", async () => {
    const cyclic = { ...identity } as GitHubIdentityRecord & { self?: unknown };
    cyclic.self = cyclic;
    const query = service(api({
      getIdentity: async () => cyclic,
    }));

    await expect(query.execute("github.identity.get", {}, context)).rejects.toMatchObject({
      code: "github_response_invalid",
      retryable: false,
    });
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["undefined", undefined],
    ["function", () => "unsafe"],
    ["BigInt", BigInt(1)],
  ])("classifies non-JSON %s data as an invalid Provider response", async (_name, value) => {
    const malformed = { ...identity, name: value } as unknown as GitHubIdentityRecord;
    const query = service(api({ getIdentity: async () => malformed }));

    await expect(query.execute("github.identity.get", {}, context)).rejects.toMatchObject({
      code: "github_response_invalid",
      retryable: false,
    });
  });

  it.each(["getter", "toJSON"] as const)(
    "does not execute an untrusted %s while rejecting malformed result data",
    async (kind) => {
      let calls = 0;
      const malformed = { ...identity } as GitHubIdentityRecord & Record<string, unknown>;
      if (kind === "getter") {
        Object.defineProperty(malformed, "unsafe", {
          enumerable: true,
          get: () => {
            calls += 1;
            return "executed";
          },
        });
      } else {
        malformed.toJSON = () => {
          calls += 1;
          return identity;
        };
      }
      const query = service(api({ getIdentity: async () => malformed }));

      await expect(query.execute("github.identity.get", {}, context)).rejects.toMatchObject({
        code: "github_response_invalid",
        retryable: false,
      });
      expect(calls).toBe(0);
    },
  );

  it("does not let an untrusted Proxy spoof the byte-limit error classification", async () => {
    const malformed = new Proxy({ ...identity }, {
      getPrototypeOf() {
        throw new TypeError("attacker exceeds maximum JSON bytes");
      },
    }) as GitHubIdentityRecord;
    const query = service(api({ getIdentity: async () => malformed }));

    await expect(query.execute("github.identity.get", {}, context)).rejects.toMatchObject({
      code: "github_response_invalid",
      retryable: false,
    });
  });

  it("classifies safe plain data above the generic clone ceiling as result truncation", async () => {
    const oversized = {
      ...identity,
      name: "x".repeat(300_000),
    };
    const query = service(api({ getIdentity: async () => oversized }));

    await expect(query.execute("github.identity.get", {}, context)).rejects.toMatchObject({
      code: "github_result_truncated",
      retryable: false,
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
      page_size: 5,
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
      page_size: 5,
      cursor: next,
    }, context)).resolves.toMatchObject({ outcome: "succeeded", data: { state: "complete" } });

    await expect(service(secondApi).execute("github.commit.list", {
      repository,
      ref: "other",
      page_size: 5,
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
      page_size: 5,
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
