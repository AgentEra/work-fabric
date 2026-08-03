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
  GitHubPullRequestRecord,
  GitHubReadApi,
  GitHubRepositoryRef,
} from "./contracts.js";
import type {
  GitHubCommentMergeCursorSourceState,
  GitHubCommentMergeCursorState,
  GitHubCursorCodec,
  GitHubPullRequestAggregateCursorState,
} from "./cursor.js";
import { GITHUB_READ_CAPABILITY_IDS } from "./declarations.js";
import { GitHubProviderError } from "./errors.js";
import { GITHUB_MAX_PAGE_SIZE, GITHUB_MAX_RESULT_BYTES } from "./limits.js";
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

function compareRepositories(left: GitHubRepositoryRef, right: GitHubRepositoryRef): number {
  return left.owner.toLowerCase().localeCompare(right.owner.toLowerCase()) ||
    left.name.toLowerCase().localeCompare(right.name.toLowerCase()) ||
    left.owner.localeCompare(right.owner) || left.name.localeCompare(right.name);
}

function sameRepository(left: GitHubRepositoryRef, right: GitHubRepositoryRef): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase();
}

async function pullRequestRepositories(
  options: GitHubQueryServiceOptions,
  parsed: GitHubParsedCapabilityInput,
  signal: AbortSignal,
): Promise<readonly GitHubRepositoryRef[]> {
  const target = parsed.input.target as GitHubApiPullRequestListInput["target"];
  if ("repository" in target) return [target.repository];
  if ("repositories" in target) {
    const unique = new Map<string, GitHubRepositoryRef>();
    for (const repository of target.repositories) {
      unique.set(`${repository.owner.toLowerCase()}\u0000${repository.name.toLowerCase()}`, repository);
    }
    return [...unique.values()].sort(compareRepositories);
  }
  const discovered = new Map<string, GitHubRepositoryRef>();
  let input: GitHubApiPageInput = { page_size: GITHUB_MAX_PAGE_SIZE };
  for (let scanned = 0; scanned < 10_000; scanned += 1) {
    const page = await options.api.listRepositories(input, signal);
    if (!Array.isArray(page.items) || page.items.length > GITHUB_MAX_PAGE_SIZE) invalidResponse();
    if (page.items.length === 0 && page.next_cursor !== undefined) invalidResponse();
    for (const item of page.items) {
      if (
        item.repository.owner.toLowerCase() === target.owner.toLowerCase() &&
        options.policy.isRepositoryAuthorized(item.repository)
      ) {
        discovered.set(
          `${item.repository.owner.toLowerCase()}\u0000${item.repository.name.toLowerCase()}`,
          item.repository,
        );
        if (discovered.size > Math.min(options.policy.maximum_aggregate_repositories, 100)) {
          throw new GitHubProviderError("github_forbidden");
        }
      }
    }
    if (page.next_cursor === undefined) return [...discovered.values()].sort(compareRepositories);
    input = {
      page_size: GITHUB_MAX_PAGE_SIZE,
      cursor: String(nextPage(page.next_cursor, Number(input.cursor ?? "1"))),
    };
  }
  return invalidResponse();
}

function normalizedPullRequestPage(
  page: GitHubApiPage<GitHubPullRequestRecord>,
  pageSize: number,
  currentPage: number,
  repository: GitHubRepositoryRef,
): { readonly items: readonly GitHubPullRequestRecord[]; readonly next_page: number | null } {
  if (!Array.isArray(page.items) || page.items.length > pageSize) invalidResponse();
  if (page.items.some((item) => !sameRepository(item.repository, repository))) invalidResponse();
  return {
    items: page.items,
    next_page: page.next_cursor === undefined ? null : nextPage(page.next_cursor, currentPage),
  };
}

async function pullRequestAggregateResult(
  options: GitHubQueryServiceOptions,
  parsed: GitHubParsedCapabilityInput,
  context: QueryContext,
): Promise<CapabilityExecutionResult> {
  const repositories = await pullRequestRepositories(options, parsed, context.signal);
  const opaque = parsed.input.cursor;
  let state: GitHubPullRequestAggregateCursorState = opaque === undefined
    ? {
        version: 1,
        kind: "pull_request_aggregate",
        scope_hash: parsed.scope_hash,
        repository_index: 0,
        source: initialCommentSource(),
      }
    : options.cursor.decodePullRequestAggregate(opaque as string, parsed.scope_hash);
  if (state.repository_index > repositories.length) invalidResponse();
  const { target: _target, cursor: _cursor, page_size: _pageSize, ...filters } =
    parsed.input as Record<string, unknown>;
  const selected: GitHubPullRequestRecord[] = [];
  let calls = 0;
  let verifyContinuation = opaque !== undefined && !(
    state.source.page === 1 && state.source.offset === 0 &&
    state.source.next_page === null && !state.source.complete
  );
  while (state.repository_index < repositories.length && selected.length < parsed.page_size) {
    if (calls >= 10_000) invalidResponse();
    const repository = repositories[state.repository_index];
    if (repository === undefined) invalidResponse();
    const page = normalizedPullRequestPage(
      await options.api.listPullRequests({
        ...filters,
        target: { repository },
        page_size: parsed.page_size,
        ...(state.source.page === 1 ? {} : { cursor: String(state.source.page) }),
      } as unknown as GitHubApiPullRequestListInput, context.signal),
      parsed.page_size,
      state.source.page,
      repository,
    );
    calls += 1;
    if (verifyContinuation && page.next_page !== state.source.next_page) invalidResponse();
    verifyContinuation = false;
    if (state.source.offset > page.items.length) invalidResponse();
    const available = page.items.slice(state.source.offset);
    const take = Math.min(parsed.page_size - selected.length, available.length);
    selected.push(...available.slice(0, take));
    const offset = state.source.offset + take;
    if (selected.length === parsed.page_size) {
      if (offset < page.items.length || page.next_page !== null) {
        state = { ...state, source: {
          page: state.source.page,
          offset,
          next_page: page.next_page,
          complete: false,
        } };
      } else if (state.repository_index + 1 < repositories.length) {
        state = { ...state, repository_index: state.repository_index + 1, source: initialCommentSource() };
      } else {
        state = { ...state, repository_index: repositories.length, source: {
          page: state.source.page, offset: 0, next_page: null, complete: true,
        } };
      }
      break;
    }
    if (offset !== page.items.length) invalidResponse();
    if (page.next_page !== null) {
      state = { ...state, source: {
        page: page.next_page, offset: 0, next_page: null, complete: false,
      } };
    } else {
      state = state.repository_index + 1 < repositories.length
        ? { ...state, repository_index: state.repository_index + 1, source: initialCommentSource() }
        : { ...state, repository_index: repositories.length, source: {
            page: state.source.page, offset: 0, next_page: null, complete: true,
          } };
    }
  }
  const complete = state.repository_index >= repositories.length;
  if (selected.length === 0) {
    if (!complete) invalidResponse();
    return succeeded({ state: "empty", items: [], evidence: evidence(options, parsed, context, true) });
  }
  if (complete) {
    return succeeded({ state: "complete", items: selected, evidence: evidence(options, parsed, context, true) });
  }
  const nextCursor = options.cursor.encodePullRequestAggregate(state);
  return succeeded({
    state: "truncated",
    items: selected,
    evidence: evidence(options, parsed, context, false, nextCursor),
  });
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
  let cloned;
  try {
    cloned = cloneCitizenJson(data, "github capability result");
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message.endsWith("exceeds maximum JSON bytes")
    ) {
      throw new GitHubProviderError("github_result_truncated");
    }
    throw new GitHubProviderError("github_response_invalid");
  }
  const serialized = JSON.stringify(cloned);
  if (new TextEncoder().encode(serialized).byteLength > GITHUB_MAX_RESULT_BYTES) {
    throw new GitHubProviderError("github_result_truncated");
  }
  return {
    outcome: "succeeded",
    data: cloned as CitizenJsonObject,
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
  currentPage = parsed.page,
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
  const next = nextPage(page.next_cursor, currentPage);
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

async function authorizedRepositoryPage(
  options: GitHubQueryServiceOptions,
  parsed: GitHubParsedCapabilityInput,
  signal: AbortSignal,
): Promise<{
  readonly page: GitHubApiPage<import("./contracts.js").GitHubRepositoryRecord>;
  readonly current_page: number;
}> {
  let input = apiInput(parsed);
  for (let scanned = 0; scanned < 10_000; scanned += 1) {
    const page = await options.api.listRepositories(input, signal);
    if (!Array.isArray(page.items) || page.items.length > parsed.page_size) {
      invalidResponse();
    }
    if (page.items.length === 0 && page.next_cursor !== undefined) invalidResponse();
    const items = page.items.filter((item) =>
      options.policy.isRepositoryAuthorized(item.repository)
    );
    if (items.length > 0 || page.next_cursor === undefined) {
      return {
        page: { items, ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }) },
        current_page: Number(input.cursor ?? "1"),
      };
    }
    const next = nextPage(page.next_cursor, Number(input.cursor ?? "1"));
    input = { page_size: parsed.page_size, cursor: String(next) };
  }
  return invalidResponse();
}

function pullRequestPageInput(
  parsed: GitHubParsedCapabilityInput,
  page = parsed.page,
): GitHubApiPullRequestPageInput {
  return {
    repository: parsed.input.repository as unknown as GitHubRepositoryRef,
    pull_request_number: parsed.input.pull_request_number as number,
    page_size: parsed.page_size,
    ...(page === 1 ? {} : { cursor: String(page) }),
  };
}

function compareComments(left: GitHubCommentRecord, right: GitHubCommentRecord): number {
  return left.created_at.localeCompare(right.created_at) ||
    left.comment_type.localeCompare(right.comment_type) ||
    left.id.localeCompare(right.id);
}

interface LoadedCommentSource {
  readonly items: readonly GitHubCommentRecord[];
  readonly page_item_count: number;
  readonly state: GitHubCommentMergeCursorSourceState;
  readonly calls: number;
}

const initialCommentSource = (): GitHubCommentMergeCursorSourceState => ({
  page: 1,
  offset: 0,
  next_page: null,
  complete: false,
});

function normalizedCommentPage(
  page: GitHubApiPage<GitHubCommentRecord>,
  pageSize: number,
  currentPage: number,
): { readonly items: readonly GitHubCommentRecord[]; readonly next_page: number | null } {
  if (!Array.isArray(page.items) || page.items.length > pageSize) invalidResponse();
  if (page.items.length === 0 && page.next_cursor !== undefined) invalidResponse();
  return {
    items: [...page.items].sort(compareComments),
    next_page: page.next_cursor === undefined
      ? null
      : nextPage(page.next_cursor, currentPage),
  };
}

async function loadCommentSource(
  read: (
    input: GitHubApiPullRequestPageInput,
    signal: AbortSignal,
  ) => Promise<GitHubApiPage<GitHubCommentRecord>>,
  parsed: GitHubParsedCapabilityInput,
  state: GitHubCommentMergeCursorSourceState,
  continuation: boolean,
  signal: AbortSignal,
): Promise<LoadedCommentSource> {
  if (state.complete) return { items: [], page_item_count: 0, state, calls: 0 };
  const current = normalizedCommentPage(
    await read(pullRequestPageInput(parsed, state.page), signal),
    parsed.page_size,
    state.page,
  );
  if (continuation && current.next_page !== state.next_page) invalidResponse();
  if (state.offset > current.items.length) invalidResponse();
  if (state.offset < current.items.length) {
    return {
      items: current.items.slice(state.offset),
      page_item_count: current.items.length,
      calls: 1,
      state: {
        page: state.page,
        offset: state.offset,
        next_page: current.next_page,
        complete: false,
      },
    };
  }
  if (current.next_page === null) {
    return {
      items: [],
      page_item_count: 0,
      calls: 1,
      state: { page: state.page, offset: 0, next_page: null, complete: true },
    };
  }
  const next = normalizedCommentPage(
    await read(pullRequestPageInput(parsed, current.next_page), signal),
    parsed.page_size,
    current.next_page,
  );
  if (next.items.length === 0) {
    return {
      items: [],
      page_item_count: 0,
      calls: 2,
      state: { page: current.next_page, offset: 0, next_page: null, complete: true },
    };
  }
  return {
    items: next.items,
    page_item_count: next.items.length,
    calls: 2,
    state: {
      page: current.next_page,
      offset: 0,
      next_page: next.next_page,
      complete: false,
    },
  };
}

async function loadNextCommentSource(
  read: (
    input: GitHubApiPullRequestPageInput,
    signal: AbortSignal,
  ) => Promise<GitHubApiPage<GitHubCommentRecord>>,
  parsed: GitHubParsedCapabilityInput,
  state: GitHubCommentMergeCursorSourceState,
  signal: AbortSignal,
): Promise<LoadedCommentSource> {
  if (state.complete || state.next_page === null) invalidResponse();
  const next = normalizedCommentPage(
    await read(pullRequestPageInput(parsed, state.next_page), signal),
    parsed.page_size,
    state.next_page,
  );
  if (next.items.length === 0) {
    return {
      items: [],
      page_item_count: 0,
      calls: 1,
      state: { page: state.next_page, offset: 0, next_page: null, complete: true },
    };
  }
  return {
    items: next.items,
    page_item_count: next.items.length,
    calls: 1,
    state: {
      page: state.next_page,
      offset: 0,
      next_page: next.next_page,
      complete: false,
    },
  };
}

function advanceCommentSource(
  source: LoadedCommentSource,
  consumed: number,
): GitHubCommentMergeCursorSourceState {
  if (source.state.complete) return source.state;
  const offset = source.state.offset + consumed;
  if (offset > source.page_item_count) invalidResponse();
  if (offset < source.page_item_count) return { ...source.state, offset };
  if (source.state.next_page === null) {
    return {
      page: source.state.page,
      offset: 0,
      next_page: null,
      complete: true,
    };
  }
  return { ...source.state, offset, complete: false };
}

async function mergedCommentResult(
  options: GitHubQueryServiceOptions,
  parsed: GitHubParsedCapabilityInput,
  context: QueryContext,
): Promise<CapabilityExecutionResult> {
  const opaque = parsed.input.cursor;
  const continuation = opaque !== undefined;
  const state: GitHubCommentMergeCursorState = opaque === undefined
    ? {
        version: 1,
        kind: "comment_merge",
        scope_hash: parsed.scope_hash,
        issue: initialCommentSource(),
        review: initialCommentSource(),
      }
    : options.cursor.decodeMerge(opaque as string, parsed.scope_hash);
  const reads = {
    issue: (input: GitHubApiPullRequestPageInput, signal: AbortSignal) =>
      options.api.listIssueComments(input, signal),
    review: (input: GitHubApiPullRequestPageInput, signal: AbortSignal) =>
      options.api.listReviewComments(input, signal),
  };
  const [issueLoaded, reviewLoaded] = await Promise.all([
    loadCommentSource(
      reads.issue,
      parsed,
      state.issue,
      continuation,
      context.signal,
    ),
    loadCommentSource(
      reads.review,
      parsed,
      state.review,
      continuation,
      context.signal,
    ),
  ]);
  type SourceName = "issue" | "review";
  type MutableSource = {
    loaded: LoadedCommentSource;
    consumed: number;
    calls: number;
    blocked: boolean;
  };
  const sources: Record<SourceName, MutableSource> = {
    issue: { loaded: issueLoaded, consumed: 0, calls: issueLoaded.calls, blocked: false },
    review: { loaded: reviewLoaded, consumed: 0, calls: reviewLoaded.calls, blocked: false },
  };
  const prepare = async (name: SourceName): Promise<void> => {
    const source = sources[name];
    if (source.loaded.items[source.consumed] !== undefined || source.loaded.state.complete) return;
    const advanced = advanceCommentSource(source.loaded, source.consumed);
    if (advanced.complete) {
      source.loaded = { items: [], page_item_count: 0, state: advanced, calls: 0 };
      source.consumed = 0;
      return;
    }
    if (source.calls >= 2) {
      source.loaded = { items: [], page_item_count: 0, state: advanced, calls: 0 };
      source.consumed = 0;
      source.blocked = true;
      return;
    }
    const next = await loadNextCommentSource(
      reads[name],
      parsed,
      advanced,
      context.signal,
    );
    source.loaded = next;
    source.consumed = 0;
    source.calls += next.calls;
  };
  const selected: Array<{ readonly source: SourceName; readonly item: GitHubCommentRecord }> = [];
  while (selected.length < parsed.page_size) {
    await Promise.all([prepare("issue"), prepare("review")]);
    if (sources.issue.blocked || sources.review.blocked) break;
    const issueHead = sources.issue.loaded.items[sources.issue.consumed];
    const reviewHead = sources.review.loaded.items[sources.review.consumed];
    if (issueHead === undefined && reviewHead === undefined) break;
    const source: SourceName = issueHead === undefined
      ? "review"
      : reviewHead === undefined
        ? "issue"
        : compareComments(issueHead, reviewHead) <= 0 ? "issue" : "review";
    const item = sources[source].loaded.items[sources[source].consumed];
    if (item === undefined) invalidResponse();
    selected.push({ source, item });
    sources[source].consumed += 1;
  }
  const finalState = (source: MutableSource): GitHubCommentMergeCursorSourceState =>
    source.blocked
      ? source.loaded.state
      : advanceCommentSource(source.loaded, source.consumed);
  const nextState: GitHubCommentMergeCursorState = {
    version: 1,
    kind: "comment_merge",
    scope_hash: parsed.scope_hash,
    issue: finalState(sources.issue),
    review: finalState(sources.review),
  };
  const complete = nextState.issue.complete && nextState.review.complete;
  const items = selected.map((entry) => entry.item);
  if (items.length === 0) {
    if (!complete) invalidResponse();
    return succeeded({
      state: "empty",
      items: [],
      evidence: evidence(options, parsed, context, true),
    });
  }
  if (complete) {
    return succeeded({
      state: "complete",
      items,
      evidence: evidence(options, parsed, context, true),
    });
  }
  const nextCursor = options.cursor.encodeMerge(nextState);
  return succeeded({
    state: "truncated",
    items,
    evidence: evidence(options, parsed, context, false, nextCursor),
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
    const normalized = parseGitHubCapabilityInput(
      capabilityId,
      input,
      this.options.policy,
    );
    const mergeComments = capabilityId === "github.pull_request.comments.list" &&
      normalized.input.kind === "all";
    const aggregatePullRequests = capabilityId === "github.pull_request.list";
    const parsed = mergeComments || aggregatePullRequests
      ? normalized
      : withDecodedCursor(normalized, this.options.cursor);
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
        {
          const repositoryPage = await authorizedRepositoryPage(
            this.options,
            parsed,
            context.signal,
          );
          result = pageResult(
            repositoryPage.page,
            this.options,
            parsed,
            context,
            repositoryPage.current_page,
          );
        }
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
        result = await pullRequestAggregateResult(this.options, parsed, context);
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
          result = await mergedCommentResult(this.options, parsed, context);
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
          await this.options.api.getChecks(repository, pullRequest.head_sha, context.signal),
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
