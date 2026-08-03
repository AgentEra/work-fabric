import {
  GitHubProviderError,
  GITHUB_REST_API_VERSION,
  type GitHubApiCommitListInput,
  type GitHubApiPage,
  type GitHubApiPageInput,
  type GitHubApiPullRequestListInput,
  type GitHubApiPullRequestPageInput,
  type GitHubApiPullRequestSearchInput,
  type GitHubApiWorkflowRunListInput,
  type GitHubChangedFileRecord,
  type GitHubCheckRecord,
  type GitHubCheckSummary,
  type GitHubCommentRecord,
  type GitHubCommitRecord,
  type GitHubIdentityRecord,
  type GitHubPullRequestRecord,
  type GitHubReadApi,
  type GitHubRepositoryRecord,
  type GitHubRepositoryRef,
  type GitHubReviewRecord,
  type GitHubWorkflowRunRecord,
} from "@work-fabric/provider-github";

import type { OctokitRequestClient } from "./authentication.js";
import { mapGitHubApiError } from "./error-mapping.js";

const MAX_ITEMS = 100;
const MAX_TEXT_BYTES = 8_192;
const INSTALLATION_REPOSITORIES_ROUTE = "GET /installation/repositories";
const encoder = new TextEncoder();

type Source = Record<string, unknown>;
type NotFoundCode = "github_repository_not_found" | "github_pull_request_not_found";

interface RawResponse {
  readonly data: unknown;
  readonly headers: unknown;
}

function invalidResponse(): never {
  throw new GitHubProviderError("github_response_invalid");
}

function invalidRequest(): never {
  throw new GitHubProviderError("github_invalid_request");
}

function source(value: unknown): Source {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  return value as Source;
}

function required(value: Source, field: string): unknown {
  if (!Object.hasOwn(value, field)) invalidResponse();
  return value[field];
}

function text(value: unknown, maximumBytes = MAX_TEXT_BYTES, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) invalidResponse();
  if (encoder.encode(value).byteLength > maximumBytes) invalidResponse();
  return value;
}

function nullableText(value: unknown, maximumBytes = MAX_TEXT_BYTES): string | null {
  return value === null ? null : text(value, maximumBytes);
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalidResponse();
  return value;
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return boolean(value);
}

function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalidResponse();
  return value as number;
}

function identifier(value: unknown): string {
  if (typeof value === "number") return String(integer(value, 0));
  return text(value, 255);
}

function timestamp(value: unknown): string {
  const result = text(value, 64);
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/u.exec(result);
  if (match === null) invalidResponse();
  const [, year, month, day, hour, minute, second, zone] = match;
  if (
    year === undefined || month === undefined || day === undefined ||
    hour === undefined || minute === undefined || second === undefined || zone === undefined
  ) invalidResponse();
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const days = [
    31,
    yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
  ];
  if (
    monthNumber < 1 || monthNumber > 12 || dayNumber < 1 ||
    dayNumber > days[monthNumber - 1]! || Number(hour) > 23 ||
    Number(minute) > 59 || Number(second) > 60
  ) invalidResponse();
  if (
    zone !== "Z" && zone !== "z" &&
    (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)
  ) invalidResponse();
  return result;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function safeUrl(value: unknown): string {
  const result = text(value, 2_048);
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    invalidResponse();
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") invalidResponse();
  const queryIndex = result.indexOf("?");
  const fragmentIndex = result.indexOf("#");
  if (queryIndex >= 0 && (fragmentIndex < 0 || queryIndex < fragmentIndex)) invalidResponse();
  return result;
}

function githubUrl(value: unknown): string {
  const result = safeUrl(value);
  const url = new URL(result);
  if (
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    !url.pathname.startsWith("/")
  ) invalidResponse();
  return result;
}

function nullableSafeUrl(value: unknown): string | null {
  return value === null ? null : safeUrl(value);
}

function sameRepository(left: GitHubRepositoryRef, right: GitHubRepositoryRef): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase();
}

function assertRepositoryPath(value: string, repository: GitHubRepositoryRef): string {
  const url = new URL(value);
  const prefix = `/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  if (
    url.pathname.toLowerCase() !== prefix.toLowerCase() &&
    !url.pathname.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)
  ) invalidResponse();
  return value;
}

function items(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) invalidResponse();
  return value;
}

function login(value: unknown): string | null {
  if (value === null) return null;
  return text(required(source(value), "login"), 100);
}

function preview(value: unknown): { readonly value: string; readonly truncated: boolean } {
  const input = value === null ? "" : textWithoutLimit(value);
  if (encoder.encode(input).byteLength <= MAX_TEXT_BYTES) {
    return { value: input, truncated: false };
  }
  let result = "";
  let bytes = 0;
  for (const character of input) {
    const width = encoder.encode(character).byteLength;
    if (bytes + width > MAX_TEXT_BYTES) break;
    result += character;
    bytes += width;
  }
  return { value: result, truncated: true };
}

function textWithoutLimit(value: unknown): string {
  if (typeof value !== "string") invalidResponse();
  return value;
}

function repositoryRef(value: unknown): GitHubRepositoryRef {
  const record = source(value);
  return {
    owner: text(required(source(required(record, "owner")), "login"), 100),
    name: text(required(record, "name"), 100),
  };
}

function requestedRepository(value: GitHubRepositoryRef): GitHubRepositoryRef {
  if (
    typeof value !== "object" || value === null ||
    typeof value.owner !== "string" || typeof value.name !== "string" ||
    value.owner.length === 0 || value.name.length === 0 ||
    encoder.encode(value.owner).byteLength > 100 || encoder.encode(value.name).byteLength > 100
  ) invalidRequest();
  return { owner: value.owner, name: value.name };
}

function repository(value: unknown, expected?: GitHubRepositoryRef): GitHubRepositoryRecord {
  const record = source(value);
  const visibilityValue = record.visibility;
  let visibility: GitHubRepositoryRecord["visibility"];
  if (visibilityValue === "public" || visibilityValue === "private" || visibilityValue === "internal") {
    visibility = visibilityValue;
  } else if (visibilityValue === undefined && typeof record.private === "boolean") {
    visibility = record.private ? "private" : "public";
  } else {
    invalidResponse();
  }
  const topics = items(required(record, "topics")).map((topic) => text(topic, 100));
  const actualRepository = repositoryRef(record);
  if (expected !== undefined && !sameRepository(actualRepository, expected)) invalidResponse();
  return {
    repository: actualRepository,
    url: assertRepositoryPath(githubUrl(required(record, "html_url")), actualRepository),
    description: nullableText(required(record, "description")),
    visibility,
    archived: boolean(required(record, "archived")),
    default_branch: text(required(record, "default_branch"), 255),
    topics,
    pushed_at: nullableTimestamp(required(record, "pushed_at")),
    updated_at: timestamp(required(record, "updated_at")),
  };
}

function namedLogins(value: unknown): readonly string[] {
  return items(value).map((item) => {
    const result = login(item);
    if (result === null) invalidResponse();
    return result;
  });
}

function labels(value: unknown): readonly string[] {
  return items(value).map((label) => {
    if (typeof label === "string") return text(label, 100);
    return text(required(source(label), "name"), 100);
  });
}

function pullRequest(
  value: unknown,
  repository: GitHubRepositoryRef,
  detail: boolean,
): GitHubPullRequestRecord {
  const record = source(value);
  const body = detail ? preview(required(record, "body")) : undefined;
  const head = source(required(record, "head"));
  return {
    repository,
    number: integer(required(record, "number"), 1),
    title: text(required(record, "title")),
    url: assertRepositoryPath(githubUrl(required(record, "html_url")), repository),
    author: login(required(record, "user")),
    draft: boolean(required(record, "draft")),
    base_branch: text(required(source(required(record, "base")), "ref"), 255),
    head_branch: text(required(head, "ref"), 255),
    head_sha: text(required(head, "sha"), 64),
    assignees: namedLogins(required(record, "assignees")),
    requested_reviewers: namedLogins(required(record, "requested_reviewers")),
    labels: labels(required(record, "labels")),
    mergeable: nullableBoolean(record.mergeable),
    created_at: timestamp(required(record, "created_at")),
    updated_at: timestamp(required(record, "updated_at")),
    ...(detail && body !== undefined ? {
      reference: `github://pull-request/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/${integer(required(record, "number"), 1)}`,
      body_preview: body.value,
      body_truncated: body.truncated,
    } : {}),
  };
}

function review(value: unknown, repository: GitHubRepositoryRef, number: number): GitHubReviewRecord {
  const record = source(value);
  const body = preview(required(record, "body"));
  return {
    repository,
    pull_request_number: number,
    id: identifier(required(record, "id")),
    actor: login(required(record, "user")),
    state: text(required(record, "state"), 100),
    submitted_at: nullableTimestamp(required(record, "submitted_at")),
    body_preview: body.value,
    body_truncated: body.truncated,
    url: assertRepositoryPath(githubUrl(required(record, "html_url")), repository),
  };
}

function comment(
  value: unknown,
  repository: GitHubRepositoryRef,
  number: number,
  commentType: GitHubCommentRecord["comment_type"],
): GitHubCommentRecord {
  const record = source(value);
  const body = preview(required(record, "body"));
  return {
    repository,
    pull_request_number: number,
    id: identifier(required(record, "id")),
    actor: login(required(record, "user")),
    comment_type: commentType,
    created_at: timestamp(required(record, "created_at")),
    updated_at: timestamp(required(record, "updated_at")),
    body_preview: body.value,
    body_truncated: body.truncated,
    url: assertRepositoryPath(githubUrl(required(record, "html_url")), repository),
  };
}

function changedFile(value: unknown, repository: GitHubRepositoryRef, number: number): GitHubChangedFileRecord {
  const record = source(value);
  return {
    repository,
    pull_request_number: number,
    path: text(required(record, "filename"), 2_048),
    status: text(required(record, "status"), 100),
    additions: integer(required(record, "additions")),
    deletions: integer(required(record, "deletions")),
    changes: integer(required(record, "changes")),
    url: assertRepositoryPath(githubUrl(required(record, "blob_url")), repository),
  };
}

function commit(value: unknown, repository: GitHubRepositoryRef): GitHubCommitRecord {
  const record = source(value);
  const gitCommit = source(required(record, "commit"));
  const author = required(gitCommit, "author");
  const committer = required(gitCommit, "committer");
  const authorRecord = author === null ? null : source(author);
  const committerRecord = committer === null ? null : source(committer);
  const message = textWithoutLimit(required(gitCommit, "message"));
  const firstLine = message.split(/\r?\n/u, 1)[0];
  if (firstLine === undefined || firstLine.length === 0) invalidResponse();
  const subject = preview(firstLine);
  const verification = gitCommit.verification;
  return {
    repository,
    sha: text(required(record, "sha"), 128),
    subject: subject.value,
    author_name: authorRecord === null ? null : text(required(authorRecord, "name"), 255),
    author_login: login(required(record, "author")),
    verified: verification === null || verification === undefined
      ? null
      : boolean(required(source(verification), "verified")),
    timestamp: authorRecord !== null
      ? nullableTimestamp(required(authorRecord, "date"))
      : committerRecord === null ? null : nullableTimestamp(required(committerRecord, "date")),
    url: assertRepositoryPath(githubUrl(required(record, "html_url")), repository),
  };
}

function workflowRun(value: unknown, repository: GitHubRepositoryRef): GitHubWorkflowRunRecord {
  const record = source(value);
  return {
    repository,
    id: identifier(required(record, "id")),
    workflow_name: text(required(record, "name")),
    run_number: integer(required(record, "run_number"), 1),
    event: text(required(record, "event"), 100),
    branch: nullableText(required(record, "head_branch"), 255),
    head_sha: text(required(record, "head_sha"), 128),
    actor: login(required(record, "actor")),
    status: text(required(record, "status"), 100),
    conclusion: nullableText(required(record, "conclusion"), 100),
    created_at: timestamp(required(record, "created_at")),
    updated_at: timestamp(required(record, "updated_at")),
    url: assertRepositoryPath(githubUrl(required(record, "html_url")), repository),
  };
}

function legacyStatus(value: unknown): GitHubCheckRecord {
  const record = source(value);
  const state = text(required(record, "state"), 100);
  const completed = state === "pending" ? null : timestamp(required(record, "updated_at"));
  return {
    name: text(required(record, "context"), 255),
    status: state,
    conclusion: state === "pending" ? null : state,
    started_at: timestamp(required(record, "created_at")),
    completed_at: completed,
    url: nullableSafeUrl(required(record, "target_url")),
  };
}

function checkRun(value: unknown, repository: GitHubRepositoryRef): GitHubCheckRecord {
  const record = source(value);
  return {
    name: text(required(record, "name"), 255),
    status: text(required(record, "status"), 100),
    conclusion: nullableText(required(record, "conclusion"), 100),
    started_at: nullableTimestamp(required(record, "started_at")),
    completed_at: nullableTimestamp(required(record, "completed_at")),
    url: required(record, "html_url") === null
      ? null
      : assertRepositoryPath(githubUrl(required(record, "html_url")), repository),
  };
}

function aggregateState(statusState: string, checks: readonly GitHubCheckRecord[]): GitHubCheckSummary["aggregate_state"] {
  const failure = new Set(["error", "failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);
  if (failure.has(statusState) || checks.some((check) => check.conclusion !== null && failure.has(check.conclusion))) {
    return "failure";
  }
  if (
    statusState === "pending" ||
    checks.some((check) => check.status === "queued" || check.status === "in_progress" || check.conclusion === null)
  ) return "pending";
  if (statusState === "success" && checks.every((check) => check.conclusion === "success" || check.conclusion === "neutral" || check.conclusion === "skipped")) {
    return "success";
  }
  if (checks.length > 0 && checks.every((check) => check.conclusion === "neutral" || check.conclusion === "skipped")) return "neutral";
  return "unknown";
}

function pageNumber(input: GitHubApiPageInput): number {
  if (!Number.isSafeInteger(input.page_size) || input.page_size < 1 || input.page_size > MAX_ITEMS) invalidRequest();
  if (input.cursor === undefined) return 1;
  if (!/^[1-9]\d{0,3}$|^10000$/u.test(input.cursor)) invalidRequest();
  const result = Number(input.cursor);
  if (result < 1 || result > 10_000) invalidRequest();
  return result;
}

function nextCursor(headersValue: unknown): string | undefined {
  if (headersValue === null || typeof headersValue !== "object" || Array.isArray(headersValue)) invalidResponse();
  let link: unknown;
  for (const [key, value] of Object.entries(headersValue as Source)) {
    if (key.toLowerCase() === "link") link = value;
  }
  if (link === undefined) return undefined;
  if (typeof link !== "string") invalidResponse();
  const nextLinks = link.split(",").filter((part) => /\brel\s*=\s*"?next"?/iu.test(part));
  if (nextLinks.length === 0) return undefined;
  if (nextLinks.length !== 1) invalidResponse();
  const match = /^\s*<([^>]+)>\s*;(?:[^;]+;)*\s*rel\s*=\s*"?next"?\s*$/iu.exec(nextLinks[0]!);
  if (match?.[1] === undefined) invalidResponse();
  let url: URL;
  try {
    url = new URL(match[1]);
  } catch {
    invalidResponse();
  }
  if (
    url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
    url.hostname.toLowerCase() !== "api.github.com" || url.port !== ""
  ) invalidResponse();
  const page = url.searchParams.get("page");
  if (page === null || !/^[1-9]\d{0,3}$|^10000$/u.test(page)) invalidResponse();
  return page;
}

function apiPage<T>(values: readonly T[], headers: unknown): GitHubApiPage<T> {
  const next = nextCursor(headers);
  return { items: values, ...(next === undefined ? {} : { next_cursor: next }) };
}

function routeRepository(repository: GitHubRepositoryRef): Record<string, string> {
  const result = requestedRepository(repository);
  return { owner: result.owner, repo: result.name };
}

function requestOptions(signal: AbortSignal): {
  readonly request: { readonly signal: AbortSignal };
  readonly headers: { readonly "X-GitHub-Api-Version": typeof GITHUB_REST_API_VERSION };
} {
  return {
    request: { signal },
    headers: { "X-GitHub-Api-Version": GITHUB_REST_API_VERSION },
  };
}

function safeQualifier(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/u.test(value)) invalidRequest();
  return value;
}

function quotedQualifier(value: string): string {
  if (value.length === 0 || encoder.encode(value).byteLength > 255) invalidRequest();
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function targetRepositories(target: GitHubApiPullRequestListInput["target"]): readonly GitHubRepositoryRef[] | undefined {
  if ("repository" in target) return [requestedRepository(target.repository)];
  if ("repositories" in target) {
    if (target.repositories.length < 1 || target.repositories.length > MAX_ITEMS) invalidRequest();
    return target.repositories.map(requestedRepository);
  }
  return undefined;
}

function searchQuery(input: GitHubApiPullRequestSearchInput): string {
  const parts = ["is:pr"];
  if ("owner" in input.target) {
    parts.push(`org:${safeQualifier(input.target.owner)}`);
  } else {
    const repositories = targetRepositories(input.target)!;
    const qualifiers = repositories.map((repository) =>
      `repo:${safeQualifier(repository.owner)}/${safeQualifier(repository.name)}`
    );
    parts.push(qualifiers.length === 1 ? qualifiers[0]! : `(${qualifiers.join(" OR ")})`);
  }
  if (input.state !== undefined && input.state !== "all") parts.push(`is:${input.state}`);
  if (input.author !== undefined) parts.push(`author:${safeQualifier(input.author)}`);
  if (input.reviewer !== undefined) parts.push(`review-requested:${safeQualifier(input.reviewer)}`);
  if (input.assignee !== undefined) parts.push(`assignee:${safeQualifier(input.assignee)}`);
  for (const label of input.labels ?? []) parts.push(`label:${quotedQualifier(label)}`);
  if (input.draft !== undefined) parts.push(`draft:${String(input.draft)}`);
  if (input.base_branch !== undefined) parts.push(`base:${quotedQualifier(input.base_branch)}`);
  if (input.updated_since !== undefined) parts.push(`updated:>=${input.updated_since}`);
  return parts.join(" ");
}

function searchRepository(value: unknown, target: GitHubApiPullRequestListInput["target"]): GitHubRepositoryRef {
  const urlValue = safeUrl(value);
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    invalidResponse();
  }
  if (
    url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
    url.hostname.toLowerCase() !== "api.github.com" || url.port !== ""
  ) invalidResponse();
  const authorityStart = urlValue.indexOf("://") + 3;
  const pathStart = urlValue.indexOf("/", authorityStart);
  const fragmentStart = urlValue.indexOf("#", authorityStart);
  const pathEnd = fragmentStart < 0 ? urlValue.length : fragmentStart;
  const rawPath = pathStart < 0 || pathStart >= pathEnd ? "" : urlValue.slice(pathStart, pathEnd);
  const segments = rawPath.split("/");
  if (segments.length !== 4 || segments[0] !== "" || segments[1] !== "repos") invalidResponse();
  const result = {
    owner: upstreamOwnerSegment(segments[2]),
    name: upstreamRepositoryNameSegment(segments[3]),
  };
  if ("owner" in target) {
    if (result.owner.toLowerCase() !== target.owner.toLowerCase()) invalidResponse();
  } else {
    const allowed = targetRepositories(target)!;
    if (!allowed.some((item) =>
      item.owner.toLowerCase() === result.owner.toLowerCase() && item.name.toLowerCase() === result.name.toLowerCase()
    )) invalidResponse();
  }
  return result;
}

function sameRepositoryKey(value: GitHubRepositoryRef): string {
  return `${value.owner.toLowerCase()}\u0000${value.name.toLowerCase()}`;
}

function filteredPullRequests(
  values: readonly GitHubPullRequestRecord[],
  input: GitHubApiPullRequestListInput,
): readonly GitHubPullRequestRecord[] {
  const equalGitHubName = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();
  const includesGitHubName = (values: readonly string[], expected: string): boolean =>
    values.some((value) => equalGitHubName(value, expected));
  let result = values;
  if (input.author !== undefined) {
    result = result.filter((item) =>
      item.author !== null && equalGitHubName(item.author, input.author!)
    );
  }
  if (input.reviewer !== undefined) {
    result = result.filter((item) => includesGitHubName(item.requested_reviewers, input.reviewer!));
  }
  if (input.assignee !== undefined) {
    result = result.filter((item) => includesGitHubName(item.assignees, input.assignee!));
  }
  if (input.labels !== undefined) {
    result = result.filter((item) =>
      input.labels!.every((label) => includesGitHubName(item.labels, label))
    );
  }
  if (input.draft !== undefined) result = result.filter((item) => item.draft === input.draft);
  if (input.updated_since !== undefined) {
    const threshold = Date.parse(timestamp(input.updated_since));
    result = result.filter((item) => Date.parse(item.updated_at) >= threshold);
  }
  return result;
}

function decodedUpstreamSegment(value: string | undefined): string {
  if (value === undefined) invalidResponse();
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    invalidResponse();
  }
  if (decoded.length < 1 || decoded.length > 100) invalidResponse();
  return decoded;
}

function upstreamOwnerSegment(value: string | undefined): string {
  const decoded = decodedUpstreamSegment(value);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u.test(decoded)) invalidResponse();
  return decoded;
}

function upstreamRepositoryNameSegment(value: string | undefined): string {
  const decoded = decodedUpstreamSegment(value);
  if (decoded === "." || decoded === ".." || !/^[A-Za-z0-9._-]+$/u.test(decoded)) invalidResponse();
  return decoded;
}

export class OctokitGitHubReadApi implements GitHubReadApi {
  constructor(private readonly client: OctokitRequestClient) {}

  private async request(
    route: string,
    parameters: Record<string, unknown>,
    notFoundCode?: NotFoundCode,
  ): Promise<RawResponse> {
    try {
      const request = this.client.request as unknown as (
        route: string,
        parameters: Record<string, unknown>,
      ) => Promise<RawResponse>;
      const result = await request(route, parameters);
      if (result === null || typeof result !== "object") invalidResponse();
      return { data: result.data, headers: result.headers };
    } catch (error) {
      if (error instanceof GitHubProviderError) throw error;
      throw mapGitHubApiError(error, notFoundCode);
    }
  }

  async getIdentity(signal: AbortSignal): Promise<GitHubIdentityRecord> {
    const [app, access] = await Promise.all([
      this.request("GET /app", requestOptions(signal)),
      this.request(INSTALLATION_REPOSITORIES_ROUTE, {
        per_page: 1,
        page: 1,
        ...requestOptions(signal),
      }),
    ]);
    const record = source(app.data);
    const accessRecord = source(access.data);
    const slug = text(required(record, "slug"), 100);
    const appUrl = githubUrl(required(record, "html_url"));
    if (new URL(appUrl).pathname !== `/apps/${encodeURIComponent(slug)}`) invalidResponse();
    return {
      app_id: identifier(required(record, "id")),
      slug,
      name: text(required(record, "name"), 255),
      url: appUrl,
      owner: login(required(record, "owner")),
      installation_repository_count: integer(required(accessRecord, "total_count"), 0),
    };
  }

  async listRepositories(input: GitHubApiPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubRepositoryRecord>> {
    const result = await this.request(INSTALLATION_REPOSITORIES_ROUTE, {
      per_page: input.page_size,
      page: pageNumber(input),
      ...requestOptions(signal),
    });
    const values = items(required(source(result.data), "repositories")).map((item) => repository(item));
    return apiPage(values, result.headers);
  }

  async getRepository(repositoryValue: GitHubRepositoryRef, signal: AbortSignal): Promise<GitHubRepositoryRecord> {
    const result = await this.request("GET /repos/{owner}/{repo}", {
      ...routeRepository(repositoryValue),
      ...requestOptions(signal),
    }, "github_repository_not_found");
    return repository(result.data, requestedRepository(repositoryValue));
  }

  async listPullRequests(input: GitHubApiPullRequestListInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubPullRequestRecord>> {
    if (!("repository" in input.target)) return this.searchPullRequests(input, signal);
    const repositoryValue = requestedRepository(input.target.repository);
    const result = await this.request("GET /repos/{owner}/{repo}/pulls", {
      ...routeRepository(repositoryValue),
      state: input.state ?? "open",
      ...(input.base_branch === undefined ? {} : { base: input.base_branch }),
      per_page: input.page_size,
      page: pageNumber(input),
      ...requestOptions(signal),
    }, "github_repository_not_found");
    const values = filteredPullRequests(
      items(result.data).map((item) => pullRequest(item, repositoryValue, false)),
      input,
    );
    return apiPage(values, result.headers);
  }

  async searchPullRequests(input: GitHubApiPullRequestSearchInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubPullRequestRecord>> {
    const result = await this.request("GET /search/issues", {
      q: searchQuery(input),
      sort: "updated",
      order: "desc",
      per_page: input.page_size,
      page: pageNumber(input),
      ...requestOptions(signal),
    });
    const record = source(result.data);
    if (boolean(required(record, "incomplete_results"))) invalidResponse();
    const searchItems = items(required(record, "items"));
    if (searchItems.length > input.page_size) invalidResponse();
    const searchInputs = searchItems.map((item) => {
      const searchItem = source(item);
      return {
        repository: searchRepository(required(searchItem, "repository_url"), input.target),
        number: integer(required(searchItem, "number"), 1),
      };
    });
    const repositories = new Map<string, GitHubRepositoryRef>();
    for (const item of searchInputs) repositories.set(sameRepositoryKey(item.repository), item.repository);
    const found = new Map<string, GitHubPullRequestRecord>();
    for (const repository of [...repositories.values()].sort((left, right) =>
      sameRepositoryKey(left).localeCompare(sameRepositoryKey(right))
    )) {
      const wanted = new Set(searchInputs
        .filter((item) => sameRepository(item.repository, repository))
        .map((item) => item.number));
      let cursor: string | undefined;
      for (let scanned = 0; scanned < 10_000 && wanted.size > 0; scanned += 1) {
        const page = await this.listPullRequests({
          target: { repository },
          state: "all",
          page_size: MAX_ITEMS,
          ...(cursor === undefined ? {} : { cursor }),
        }, signal);
        for (const item of page.items) {
          if (wanted.delete(item.number)) found.set(`${sameRepositoryKey(repository)}\u0000${item.number}`, item);
        }
        if (page.next_cursor === undefined) break;
        cursor = page.next_cursor;
      }
      if (wanted.size > 0) invalidResponse();
    }
    const values = searchInputs.map(({ repository, number }) => {
      const item = found.get(`${sameRepositoryKey(repository)}\u0000${number}`);
      if (item === undefined) invalidResponse();
      return item;
    });
    return apiPage(values, result.headers);
  }

  async getPullRequest(repositoryValue: GitHubRepositoryRef, number: number, signal: AbortSignal): Promise<GitHubPullRequestRecord> {
    const repository = requestedRepository(repositoryValue);
    if (!Number.isSafeInteger(number) || number < 1) invalidRequest();
    const result = await this.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      ...routeRepository(repository),
      pull_number: number,
      ...requestOptions(signal),
    }, "github_pull_request_not_found");
    return pullRequest(result.data, repository, true);
  }

  async listReviews(input: GitHubApiPullRequestPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubReviewRecord>> {
    const repository = requestedRepository(input.repository);
    const result = await this.pullPageRequest("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", input, signal);
    return apiPage(items(result.data).map((item) => review(item, repository, input.pull_request_number)), result.headers);
  }

  async listIssueComments(input: GitHubApiPullRequestPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubCommentRecord>> {
    const repository = requestedRepository(input.repository);
    const result = await this.pullPageRequest("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", input, signal, true);
    return apiPage(items(result.data).map((item) => comment(item, repository, input.pull_request_number, "issue")), result.headers);
  }

  async listReviewComments(input: GitHubApiPullRequestPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubCommentRecord>> {
    const repository = requestedRepository(input.repository);
    const result = await this.pullPageRequest("GET /repos/{owner}/{repo}/pulls/{pull_number}/comments", input, signal);
    return apiPage(items(result.data).map((item) => comment(item, repository, input.pull_request_number, "review")), result.headers);
  }

  async listFiles(input: GitHubApiPullRequestPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubChangedFileRecord>> {
    const repository = requestedRepository(input.repository);
    const result = await this.pullPageRequest("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", input, signal);
    return apiPage(items(result.data).map((item) => changedFile(item, repository, input.pull_request_number)), result.headers);
  }

  async listPullRequestCommits(input: GitHubApiPullRequestPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubCommitRecord>> {
    const repository = requestedRepository(input.repository);
    const result = await this.pullPageRequest("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", input, signal);
    return apiPage(items(result.data).map((item) => commit(item, repository)), result.headers);
  }

  async getChecks(repositoryValue: GitHubRepositoryRef, ref: string, signal: AbortSignal): Promise<GitHubCheckSummary> {
    const repository = requestedRepository(repositoryValue);
    if (typeof ref !== "string" || ref.length === 0 || encoder.encode(ref).byteLength > 255) invalidRequest();
    const parameters = { ...routeRepository(repository), ref, ...requestOptions(signal) };
    const [statusesResult, checksResult] = await Promise.all([
      this.request("GET /repos/{owner}/{repo}/commits/{ref}/status", parameters, "github_repository_not_found"),
      this.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
        ...parameters,
        per_page: MAX_ITEMS,
      }, "github_repository_not_found"),
    ]);
    const statusesRecord = source(statusesResult.data);
    const checksRecord = source(checksResult.data);
    const statusState = text(required(statusesRecord, "state"), 100);
    const statuses = items(required(statusesRecord, "statuses"));
    const checkRuns = items(required(checksRecord, "check_runs"));
    if (
      integer(required(statusesRecord, "total_count"), 0) !== statuses.length ||
      integer(required(checksRecord, "total_count"), 0) !== checkRuns.length ||
      nextCursor(statusesResult.headers) !== undefined ||
      nextCursor(checksResult.headers) !== undefined
    ) invalidResponse();
    const checks = [
      ...statuses.map(legacyStatus),
      ...checkRuns.map((item) => checkRun(item, repository)),
    ];
    if (checks.length > MAX_ITEMS) invalidResponse();
    return {
      repository,
      ref,
      aggregate_state: aggregateState(statusState, checks),
      checks,
    };
  }

  async listWorkflowRuns(input: GitHubApiWorkflowRunListInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubWorkflowRunRecord>> {
    const repository = requestedRepository(input.repository);
    const result = await this.request("GET /repos/{owner}/{repo}/actions/runs", {
      ...routeRepository(repository),
      ...(input.branch === undefined ? {} : { branch: input.branch }),
      ...(input.event === undefined ? {} : { event: input.event }),
      ...(input.status === undefined ? {} : { status: input.status }),
      per_page: input.page_size,
      page: pageNumber(input),
      ...requestOptions(signal),
    }, "github_repository_not_found");
    const values = items(required(source(result.data), "workflow_runs")).map((item) => workflowRun(item, repository));
    return apiPage(values, result.headers);
  }

  async listCommits(input: GitHubApiCommitListInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubCommitRecord>> {
    const repository = requestedRepository(input.repository);
    const result = await this.request("GET /repos/{owner}/{repo}/commits", {
      ...routeRepository(repository),
      ...(input.ref === undefined ? {} : { sha: input.ref }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.until === undefined ? {} : { until: input.until }),
      per_page: input.page_size,
      page: pageNumber(input),
      ...requestOptions(signal),
    }, "github_repository_not_found");
    return apiPage(items(result.data).map((item) => commit(item, repository)), result.headers);
  }

  private async pullPageRequest(
    route: string,
    input: GitHubApiPullRequestPageInput,
    signal: AbortSignal,
    issueRoute = false,
  ): Promise<RawResponse> {
    const repository = requestedRepository(input.repository);
    if (!Number.isSafeInteger(input.pull_request_number) || input.pull_request_number < 1) invalidRequest();
    return this.request(route, {
      ...routeRepository(repository),
      ...(issueRoute
        ? { issue_number: input.pull_request_number }
        : { pull_number: input.pull_request_number }),
      per_page: input.page_size,
      page: pageNumber(input),
      ...requestOptions(signal),
    }, "github_pull_request_not_found");
  }
}
