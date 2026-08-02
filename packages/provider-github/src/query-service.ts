import {
  cloneCitizenJson,
  type CapabilityExecutionResult,
  type CitizenJsonObject,
} from "@work-fabric/network-citizen-spi";

import type {
  GitHubApiPage,
  GitHubApiPageInput,
  GitHubApiPullRequestListInput,
  GitHubApiPullRequestPageInput,
  GitHubCommentRecord,
  GitHubEvidenceMeta,
  GitHubReadApi,
  GitHubRepositoryRef,
} from "./contracts.js";
import type { GitHubCursorCodec } from "./cursor.js";
import { GITHUB_READ_CAPABILITY_IDS } from "./declarations.js";
import { GitHubProviderError } from "./errors.js";
import { GitHubPolicyEvaluator } from "./policy.js";
import {
  parseGitHubCapabilityInput,
  type GitHubParsedCapabilityInput,
} from "./validation.js";

type GitHubCapabilityId = (typeof GITHUB_READ_CAPABILITY_IDS)[number];
type QueryContext = {
  readonly tenant_id: string;
  readonly installation_id_hash: string;
  readonly signal: AbortSignal;
};

export interface GitHubQueryServiceOptions {
  readonly api: GitHubReadApi;
  readonly policy: GitHubPolicyEvaluator;
  readonly cursor: GitHubCursorCodec;
  readonly api_version: string;
  readonly now?: () => string;
}

function invalidResponse(): never {
  throw new GitHubProviderError("github_response_invalid");
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new GitHubProviderError("github_upstream_unavailable", {
      retryable: true,
    });
  }
}

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" || value.length === 0 ||
    value.length > maximum || value.trim() !== value
  ) invalidResponse();
  return value;
}

function repositoryUri(repository: GitHubRepositoryRef): string {
  return `github://repository/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

function repositoryFrom(value: unknown): GitHubRepositoryRef {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidResponse();
  }
  const source = value as Record<string, unknown>;
  return { owner: text(source.owner, 100), name: text(source.name, 100) };
}

function queryScope(parsed: GitHubParsedCapabilityInput, installationHash: string): readonly string[] {
  const input = parsed.input;
  switch (parsed.capability_id) {
    case "github.identity.get":
      return Object.freeze([`github://installation/${encodeURIComponent(installationHash)}`]);
    case "github.repository.list":
      return Object.freeze([`github://installation/${encodeURIComponent(installationHash)}/repositories`]);
    case "github.pull_request.list": {
      const target = input.target as Record<string, unknown>;
      if ("repository" in target) {
        return Object.freeze([repositoryUri(repositoryFrom(target.repository))]);
      }
      if ("repositories" in target && Array.isArray(target.repositories)) {
        return Object.freeze(target.repositories.map(repositoryFrom).map(repositoryUri));
      }
      if ("owner" in target) {
        return Object.freeze([`github://owner/${encodeURIComponent(text(target.owner, 100))}`]);
      }
      return invalidResponse();
    }
    case "github.repository.get":
    case "github.actions.workflow_runs.list":
    case "github.commit.list":
      return Object.freeze([repositoryUri(repositoryFrom(input.repository))]);
    case "github.pull_request.get":
    case "github.pull_request.checks.get":
      return Object.freeze([
        `${repositoryUri(repositoryFrom(input.repository))}/pull-request/${String(input.number)}`,
      ]);
    case "github.pull_request.reviews.list":
    case "github.pull_request.comments.list":
    case "github.pull_request.files.list":
    case "github.pull_request.commits.list":
      return Object.freeze([
        `${repositoryUri(repositoryFrom(input.repository))}/pull-request/${String(input.pull_request_number)}`,
      ]);
  }
}

function apiInput(parsed: GitHubParsedCapabilityInput): GitHubApiPageInput {
  return {
    page_size: parsed.page_size,
    ...(parsed.page === 1 ? {} : { cursor: String(parsed.page) }),
  };
}

function withDecodedCursor(
  parsed: GitHubParsedCapabilityInput,
  codec: GitHubCursorCodec,
): GitHubParsedCapabilityInput {
  const opaque = parsed.input.cursor;
  if (opaque === undefined) return parsed;
  if (typeof opaque !== "string") {
    throw new GitHubProviderError("github_invalid_request");
  }
  const state = codec.decode(opaque, parsed.scope_hash);
  return Object.freeze({ ...parsed, page: state.page });
}

function nextPage(value: string, currentPage: number): number {
  if (!/^[1-9]\d{0,3}$|^10000$/u.test(value)) invalidResponse();
  const page = Number(value);
  if (page !== currentPage + 1) invalidResponse();
  return page;
}

function evidence(
  options: GitHubQueryServiceOptions,
  parsed: GitHubParsedCapabilityInput,
  context: QueryContext,
  complete: boolean,
  nextCursor?: string,
): GitHubEvidenceMeta {
  const fetchedAt = options.now?.() ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(fetchedAt))) invalidResponse();
  text(context.installation_id_hash, 128);
  return Object.freeze({
    provider: "github",
    fetched_at: fetchedAt,
    installation_id_hash: context.installation_id_hash,
    api_version: options.api_version,
    query_scope: queryScope(parsed, context.installation_id_hash),
    complete,
    ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
  });
}

function succeeded(data: unknown): CapabilityExecutionResult {
  return {
    outcome: "succeeded",
    data: cloneCitizenJson(data, "github capability result") as CitizenJsonObject,
    artifacts: [],
  };
}

function singleResult(
  item: unknown,
  options: GitHubQueryServiceOptions,
  parsed: GitHubParsedCapabilityInput,
  context: QueryContext,
): CapabilityExecutionResult {
  return succeeded({
    state: "complete",
    item,
    evidence: evidence(options, parsed, context, true),
  });
}

function pageResult<T>(
  page: GitHubApiPage<T>,
  options: GitHubQueryServiceOptions,
  parsed: GitHubParsedCapabilityInput,
  context: QueryContext,
): CapabilityExecutionResult {
  if (!Array.isArray(page.items) || page.items.length > parsed.page_size) {
    invalidResponse();
  }
  if (page.items.length === 0) {
    if (page.next_cursor !== undefined) invalidResponse();
    return succeeded({
      state: "empty",
      items: [],
      evidence: evidence(options, parsed, context, true),
    });
  }
  if (page.next_cursor === undefined) {
    return succeeded({
      state: "complete",
      items: page.items,
      evidence: evidence(options, parsed, context, true),
    });
  }
  const next = nextPage(page.next_cursor, parsed.page);
  const opaque = options.cursor.encode({
    version: 1,
    scope_hash: parsed.scope_hash,
    page: next,
  });
  return succeeded({
    state: "truncated",
    items: page.items,
    evidence: evidence(options, parsed, context, false, opaque),
  });
}

function pullRequestPageInput(parsed: GitHubParsedCapabilityInput): GitHubApiPullRequestPageInput {
  return {
    repository: parsed.input.repository as unknown as GitHubRepositoryRef,
    pull_request_number: parsed.input.pull_request_number as number,
    ...apiInput(parsed),
  };
}

function compareComments(left: GitHubCommentRecord, right: GitHubCommentRecord): number {
  return left.created_at.localeCompare(right.created_at) ||
    left.comment_type.localeCompare(right.comment_type) ||
    left.id.localeCompare(right.id);
}

function combinedCommentPage(
  issue: GitHubApiPage<GitHubCommentRecord>,
  review: GitHubApiPage<GitHubCommentRecord>,
  parsed: GitHubParsedCapabilityInput,
): GitHubApiPage<GitHubCommentRecord> {
  if (
    !Array.isArray(issue.items) || issue.items.length > parsed.page_size ||
    !Array.isArray(review.items) || review.items.length > parsed.page_size
  ) invalidResponse();
  const combined = [...issue.items, ...review.items].sort(compareComments);
  if (combined.length > parsed.page_size) {
    return { items: combined.slice(0, parsed.page_size), next_cursor: "ceiling" };
  }
  const candidates = [issue.next_cursor, review.next_cursor].filter(
    (value): value is string => value !== undefined,
  );
  for (const candidate of candidates) nextPage(candidate, parsed.page);
  if (new Set(candidates).size > 1) invalidResponse();
  return {
    items: combined,
    ...(candidates[0] === undefined ? {} : { next_cursor: candidates[0] }),
  };
}

function combinedCommentResult(
  page: GitHubApiPage<GitHubCommentRecord>,
  options: GitHubQueryServiceOptions,
  parsed: GitHubParsedCapabilityInput,
  context: QueryContext,
): CapabilityExecutionResult {
  if (page.next_cursor !== "ceiling") {
    return pageResult(page, options, parsed, context);
  }
  return succeeded({
    state: "truncated",
    items: page.items,
    evidence: evidence(options, parsed, context, false),
  });
}

/** Executes only typed, policy-bounded GitHub reads and returns normalized facts. */
export class GitHubQueryService {
  constructor(private readonly options: GitHubQueryServiceOptions) {
    text(options.api_version, 128);
  }

  async execute(
    capabilityId: GitHubCapabilityId,
    input: CitizenJsonObject,
    context: QueryContext,
  ): Promise<CapabilityExecutionResult> {
    aborted(context.signal);
    const parsed = withDecodedCursor(
      parseGitHubCapabilityInput(capabilityId, input, this.options.policy),
      this.options.cursor,
    );
    let result: CapabilityExecutionResult;
    switch (capabilityId) {
      case "github.identity.get":
        result = singleResult(
          await this.options.api.getIdentity(context.signal),
          this.options,
          parsed,
          context,
        );
        break;
      case "github.repository.list":
        result = pageResult(
          await this.options.api.listRepositories(apiInput(parsed), context.signal),
          this.options,
          parsed,
          context,
        );
        break;
      case "github.repository.get":
        result = singleResult(
          await this.options.api.getRepository(
            parsed.input.repository as unknown as GitHubRepositoryRef,
            context.signal,
          ),
          this.options,
          parsed,
          context,
        );
        break;
      case "github.pull_request.list": {
        const request = {
          ...parsed.input,
          ...apiInput(parsed),
        } as unknown as GitHubApiPullRequestListInput;
        const target = request.target;
        const page = "repository" in target
          ? await this.options.api.listPullRequests(request, context.signal)
          : await this.options.api.searchPullRequests(request, context.signal);
        result = pageResult(page, this.options, parsed, context);
        break;
      }
      case "github.pull_request.get":
        result = singleResult(
          await this.options.api.getPullRequest(
            parsed.input.repository as unknown as GitHubRepositoryRef,
            parsed.input.number as number,
            context.signal,
          ),
          this.options,
          parsed,
          context,
        );
        break;
      case "github.pull_request.reviews.list":
        result = pageResult(
          await this.options.api.listReviews(pullRequestPageInput(parsed), context.signal),
          this.options,
          parsed,
          context,
        );
        break;
      case "github.pull_request.comments.list": {
        const request = pullRequestPageInput(parsed);
        const kind = parsed.input.kind ?? "issue";
        if (kind === "issue") {
          result = pageResult(
            await this.options.api.listIssueComments(request, context.signal),
            this.options,
            parsed,
            context,
          );
        } else if (kind === "review") {
          result = pageResult(
            await this.options.api.listReviewComments(request, context.signal),
            this.options,
            parsed,
            context,
          );
        } else {
          const [issue, review] = await Promise.all([
            this.options.api.listIssueComments(request, context.signal),
            this.options.api.listReviewComments(request, context.signal),
          ]);
          result = combinedCommentResult(
            combinedCommentPage(issue, review, parsed),
            this.options,
            parsed,
            context,
          );
        }
        break;
      }
      case "github.pull_request.files.list":
        result = pageResult(
          await this.options.api.listFiles(pullRequestPageInput(parsed), context.signal),
          this.options,
          parsed,
          context,
        );
        break;
      case "github.pull_request.commits.list":
        result = pageResult(
          await this.options.api.listPullRequestCommits(pullRequestPageInput(parsed), context.signal),
          this.options,
          parsed,
          context,
        );
        break;
      case "github.pull_request.checks.get": {
        const repository = parsed.input.repository as unknown as GitHubRepositoryRef;
        const pullRequest = await this.options.api.getPullRequest(
          repository,
          parsed.input.number as number,
          context.signal,
        );
        aborted(context.signal);
        result = singleResult(
          await this.options.api.getChecks(repository, pullRequest.head_branch, context.signal),
          this.options,
          parsed,
          context,
        );
        break;
      }
      case "github.actions.workflow_runs.list":
        result = pageResult(
          await this.options.api.listWorkflowRuns({
            ...parsed.input,
            ...apiInput(parsed),
          } as unknown as Parameters<GitHubReadApi["listWorkflowRuns"]>[0], context.signal),
          this.options,
          parsed,
          context,
        );
        break;
      case "github.commit.list":
        result = pageResult(
          await this.options.api.listCommits({
            ...parsed.input,
            ...apiInput(parsed),
          } as unknown as Parameters<GitHubReadApi["listCommits"]>[0], context.signal),
          this.options,
          parsed,
          context,
        );
        break;
      default: {
        const exhaustive: never = capabilityId;
        return exhaustive;
      }
    }
    aborted(context.signal);
    return result;
  }
}
