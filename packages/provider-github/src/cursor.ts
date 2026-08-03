import { createHmac, timingSafeEqual } from "node:crypto";

import { GitHubProviderError } from "./errors.js";

export interface GitHubCursorState {
  readonly version: 1;
  readonly scope_hash: `sha256:${string}`;
  readonly page: number;
}

export interface GitHubPagedSourceCursorState {
  readonly page: number;
  readonly offset: number;
  readonly next_page: number | null;
  readonly complete: boolean;
}

export type GitHubCommentMergeCursorSourceState = GitHubPagedSourceCursorState;

export interface GitHubCommentMergeCursorState {
  readonly version: 1;
  readonly kind: "comment_merge";
  readonly scope_hash: `sha256:${string}`;
  readonly issue: GitHubCommentMergeCursorSourceState;
  readonly review: GitHubCommentMergeCursorSourceState;
}

export interface GitHubPullRequestAggregateCursorState {
  readonly version: 1;
  readonly kind: "pull_request_aggregate";
  readonly scope_hash: `sha256:${string}`;
  readonly repository_index: number;
  readonly source: GitHubPagedSourceCursorState;
}

export interface GitHubCursorCodec {
  encode(state: GitHubCursorState): string;
  decode(cursor: string, scopeHash: `sha256:${string}`): GitHubCursorState;
  encodeMerge(state: GitHubCommentMergeCursorState): string;
  decodeMerge(
    cursor: string,
    scopeHash: `sha256:${string}`,
  ): GitHubCommentMergeCursorState;
  encodePullRequestAggregate(state: GitHubPullRequestAggregateCursorState): string;
  decodePullRequestAggregate(
    cursor: string,
    scopeHash: `sha256:${string}`,
  ): GitHubPullRequestAggregateCursorState;
}

export interface HmacGitHubCursorCodecOptions {
  readonly key: Uint8Array;
}

const CURSOR = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

function invalid(): never {
  throw new GitHubProviderError("github_invalid_request");
}

function scopeHash(value: unknown): `sha256:${string}` {
  if (
    typeof value !== "string" ||
    !value.startsWith("sha256:") ||
    value.length <= "sha256:".length ||
    value.length > 256 ||
    value.trim() !== value
  ) invalid();
  return value as `sha256:${string}`;
}

function page(value: unknown): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < 1 || value > 10_000
  ) invalid();
  return value;
}

function normalize(value: unknown): GitHubCursorState {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) invalid();
  const source = value as Record<string, unknown>;
  const fields = ["version", "scope_hash", "page"];
  if (
    Object.keys(source).length !== fields.length ||
    Object.keys(source).some((field) => !fields.includes(field)) ||
    source.version !== 1
  ) invalid();
  return Object.freeze({ version: 1, scope_hash: scopeHash(source.scope_hash), page: page(source.page) });
}

function mergeSource(value: unknown): GitHubCommentMergeCursorSourceState {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) invalid();
  const source = value as Record<string, unknown>;
  const fields = ["page", "offset", "next_page", "complete"];
  if (
    Object.keys(source).length !== fields.length ||
    Object.keys(source).some((field) => !fields.includes(field)) ||
    typeof source.complete !== "boolean" ||
    typeof source.offset !== "number" ||
    !Number.isSafeInteger(source.offset) ||
    source.offset < 0 || source.offset > 100
  ) invalid();
  const currentPage = page(source.page);
  const nextPage = source.next_page === null ? null : page(source.next_page);
  if (nextPage !== null && nextPage !== currentPage + 1) invalid();
  if (source.complete && (source.offset !== 0 || nextPage !== null)) invalid();
  return Object.freeze({
    page: currentPage,
    offset: source.offset,
    next_page: nextPage,
    complete: source.complete,
  });
}

function normalizeMerge(value: unknown): GitHubCommentMergeCursorState {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) invalid();
  const source = value as Record<string, unknown>;
  const fields = ["version", "kind", "scope_hash", "issue", "review"];
  if (
    Object.keys(source).length !== fields.length ||
    Object.keys(source).some((field) => !fields.includes(field)) ||
    source.version !== 1 || source.kind !== "comment_merge"
  ) invalid();
  return Object.freeze({
    version: 1,
    kind: "comment_merge",
    scope_hash: scopeHash(source.scope_hash),
    issue: mergeSource(source.issue),
    review: mergeSource(source.review),
  });
}

function normalizePullRequestAggregate(value: unknown): GitHubPullRequestAggregateCursorState {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) invalid();
  const source = value as Record<string, unknown>;
  const fields = ["version", "kind", "scope_hash", "repository_index", "source"];
  if (
    Object.keys(source).length !== fields.length ||
    Object.keys(source).some((field) => !fields.includes(field)) ||
    source.version !== 1 || source.kind !== "pull_request_aggregate" ||
    typeof source.repository_index !== "number" ||
    !Number.isSafeInteger(source.repository_index) ||
    source.repository_index < 0 || source.repository_index > 100
  ) invalid();
  return Object.freeze({
    version: 1,
    kind: "pull_request_aggregate",
    scope_hash: scopeHash(source.scope_hash),
    repository_index: source.repository_index,
    source: mergeSource(source.source),
  });
}

function canonical(state: GitHubCursorState): string {
  return JSON.stringify({
    version: state.version,
    scope_hash: state.scope_hash,
    page: state.page,
  });
}

function canonicalMerge(state: GitHubCommentMergeCursorState): string {
  return JSON.stringify({
    version: state.version,
    kind: state.kind,
    scope_hash: state.scope_hash,
    issue: {
      page: state.issue.page,
      offset: state.issue.offset,
      next_page: state.issue.next_page,
      complete: state.issue.complete,
    },
    review: {
      page: state.review.page,
      offset: state.review.offset,
      next_page: state.review.next_page,
      complete: state.review.complete,
    },
  });
}

function canonicalPullRequestAggregate(state: GitHubPullRequestAggregateCursorState): string {
  return JSON.stringify({
    version: state.version,
    kind: state.kind,
    scope_hash: state.scope_hash,
    repository_index: state.repository_index,
    source: {
      page: state.source.page,
      offset: state.source.offset,
      next_page: state.source.next_page,
      complete: state.source.complete,
    },
  });
}

export class HmacGitHubCursorCodec implements GitHubCursorCodec {
  private readonly key: Uint8Array;

  constructor(options: HmacGitHubCursorCodecOptions) {
    if (
      options === null || typeof options !== "object" ||
      !(options.key instanceof Uint8Array) || options.key.byteLength < 32
    ) invalid();
    this.key = new Uint8Array(options.key);
  }

  encode(value: GitHubCursorState): string {
    const state = normalize(value);
    return this.sign(canonical(state));
  }

  decode(cursor: string, expectedScopeHash: `sha256:${string}`): GitHubCursorState {
    const state = normalize(this.verify(cursor));
    if (state.scope_hash !== scopeHash(expectedScopeHash)) invalid();
    return state;
  }

  encodeMerge(value: GitHubCommentMergeCursorState): string {
    const state = normalizeMerge(value);
    return this.sign(canonicalMerge(state));
  }

  decodeMerge(
    cursor: string,
    expectedScopeHash: `sha256:${string}`,
  ): GitHubCommentMergeCursorState {
    const state = normalizeMerge(this.verify(cursor));
    if (state.scope_hash !== scopeHash(expectedScopeHash)) invalid();
    return state;
  }

  encodePullRequestAggregate(value: GitHubPullRequestAggregateCursorState): string {
    const state = normalizePullRequestAggregate(value);
    return this.sign(canonicalPullRequestAggregate(state));
  }

  decodePullRequestAggregate(
    cursor: string,
    expectedScopeHash: `sha256:${string}`,
  ): GitHubPullRequestAggregateCursorState {
    const state = normalizePullRequestAggregate(this.verify(cursor));
    if (state.scope_hash !== scopeHash(expectedScopeHash)) invalid();
    return state;
  }

  private sign(value: string): string {
    const payload = Buffer.from(value, "utf8").toString("base64url");
    const signature = createHmac("sha256", this.key).update(payload).digest("base64url");
    const cursor = `${payload}.${signature}`;
    if (cursor.length > 4_096) invalid();
    return cursor;
  }

  private verify(cursor: string): unknown {
    try {
      if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4_096) invalid();
      const match = CURSOR.exec(cursor);
      if (match === null) invalid();
      const payload = match[1]!;
      const expected = createHmac("sha256", this.key).update(payload).digest();
      const supplied = Buffer.from(match[2]!, "base64url");
      if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) invalid();
      return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch (error) {
      if (error instanceof GitHubProviderError) throw error;
      invalid();
    }
  }
}
