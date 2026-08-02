import { createHash } from "node:crypto";

import type { GitHubRepositoryRef } from "./contracts.js";
import { GitHubProviderError } from "./errors.js";
import { GitHubPolicyEvaluator } from "./policy.js";

type GitHubCapabilityId =
  | "github.identity.get"
  | "github.repository.list"
  | "github.repository.get"
  | "github.pull_request.list"
  | "github.pull_request.get"
  | "github.pull_request.reviews.list"
  | "github.pull_request.comments.list"
  | "github.pull_request.files.list"
  | "github.pull_request.commits.list"
  | "github.pull_request.checks.get"
  | "github.actions.workflow_runs.list"
  | "github.commit.list";

export interface GitHubParsedCapabilityInput {
  readonly capability_id: GitHubCapabilityId;
  readonly input: Readonly<Record<string, unknown>>;
  readonly page: number;
  readonly page_size: number;
  readonly scope_hash: `sha256:${string}`;
}

function invalid(): never {
  throw new GitHubProviderError("github_invalid_request");
}

function object(value: unknown): Record<string, unknown> {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) invalid();
  return value as Record<string, unknown>;
}

function exactObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const source = object(value);
  if (Object.keys(source).some((key) => !fields.includes(key))) invalid();
  return source;
}

function required(source: Record<string, unknown>, field: string): unknown {
  if (!Object.hasOwn(source, field)) invalid();
  return source[field];
}

function text(value: unknown, maximum: number, trim = false): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) invalid();
  const result = trim ? value.trim() : value;
  if (result.length === 0 || result.length > maximum) invalid();
  return result;
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < minimum || value > maximum
  ) invalid();
  return value;
}

function dateTime(value: unknown): string {
  const result = text(value, 64);
  if (!Number.isFinite(Date.parse(result))) invalid();
  return result;
}

function optionalText(source: Record<string, unknown>, field: string, maximum: number): string | undefined {
  return !Object.hasOwn(source, field) ? undefined : text(source[field], maximum);
}

function optionalDateTime(source: Record<string, unknown>, field: string): string | undefined {
  return !Object.hasOwn(source, field) ? undefined : dateTime(source[field]);
}

function optionalBoolean(source: Record<string, unknown>, field: string): boolean | undefined {
  if (!Object.hasOwn(source, field)) return undefined;
  if (typeof source[field] !== "boolean") invalid();
  return source[field];
}

function optionalLabels(source: Record<string, unknown>): readonly string[] | undefined {
  if (!Object.hasOwn(source, "labels")) return undefined;
  if (!Array.isArray(source.labels) || source.labels.length > 100) invalid();
  return Object.freeze(source.labels.map((label) => text(label, 100)));
}

function repository(value: unknown, policy: GitHubPolicyEvaluator): GitHubRepositoryRef {
  const source = exactObject(value, ["owner", "name"]);
  return policy.authorizeRepository({
    owner: text(required(source, "owner"), 100, true),
    name: text(required(source, "name"), 100, true),
  });
}

function pageInput(
  source: Record<string, unknown>,
  policy: GitHubPolicyEvaluator,
): { readonly page_size: number; readonly cursor?: string } {
  const pageSize = !Object.hasOwn(source, "page_size")
    ? 30
    : integer(source.page_size, 1, 100);
  const cursor = !Object.hasOwn(source, "cursor") ? undefined : text(source.cursor, 4_096);
  return Object.freeze({
    page_size: policy.authorizePageSize(pageSize),
    ...(cursor === undefined ? {} : { cursor }),
  });
}

function pageResult(
  capability_id: GitHubCapabilityId,
  input: Record<string, unknown>,
  page: { readonly page_size: number; readonly cursor?: string },
): GitHubParsedCapabilityInput {
  const { cursor: _cursor, ...scope } = input;
  return Object.freeze({
    capability_id,
    input: Object.freeze(input),
    page: 1,
    page_size: page.page_size,
    scope_hash: scopeHash({ capability_id, input: scope, page_size: page.page_size }),
  });
}

function singleResult(
  capability_id: GitHubCapabilityId,
  input: Record<string, unknown>,
): GitHubParsedCapabilityInput {
  return Object.freeze({
    capability_id,
    input: Object.freeze(input),
    page: 1,
    page_size: 30,
    scope_hash: scopeHash({ capability_id, input }),
  });
}

function scopeHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const source = object(value);
  return `{${Object.keys(source).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(source[key])}`
  ).join(",")}}`;
}

function parseTarget(value: unknown, policy: GitHubPolicyEvaluator): Record<string, unknown> {
  const target = object(value);
  const keys = Object.keys(target);
  if (keys.length !== 1) invalid();
  if ("repository" in target) {
    return Object.freeze({ repository: repository(target.repository, policy) });
  }
  if ("repositories" in target) {
    if (!Array.isArray(target.repositories)) invalid();
    return Object.freeze({ repositories: policy.authorizeRepositories(
      target.repositories.map((item) => repository(item, policy)),
    ) });
  }
  if ("owner" in target) {
    return Object.freeze({ owner: policy.authorizeOwner(text(target.owner, 100, true)) });
  }
  invalid();
}

function parsePullRequestList(
  capability_id: "github.pull_request.list",
  value: unknown,
  policy: GitHubPolicyEvaluator,
): GitHubParsedCapabilityInput {
  const source = exactObject(value, [
    "target", "state", "author", "reviewer", "assignee", "labels", "draft",
    "base_branch", "updated_since", "page_size", "cursor",
  ]);
  const state = !Object.hasOwn(source, "state") ? "open" : source.state;
  if (state !== "open" && state !== "closed" && state !== "all") invalid();
  const page = pageInput(source, policy);
  const input: Record<string, unknown> = {
    target: parseTarget(required(source, "target"), policy),
    state,
    ...page,
  };
  for (const [field, maximum] of [["author", 100], ["reviewer", 100], ["assignee", 100], ["base_branch", 255]] as const) {
    const result = optionalText(source, field, maximum);
    if (result !== undefined) input[field] = result;
  }
  const labels = optionalLabels(source);
  if (labels !== undefined) input.labels = labels;
  const draft = optionalBoolean(source, "draft");
  if (draft !== undefined) input.draft = draft;
  const updatedSince = optionalDateTime(source, "updated_since");
  if (updatedSince !== undefined) input.updated_since = updatedSince;
  return pageResult(capability_id, input, page);
}

function parseRepositoryPage(
  capability_id:
    | "github.pull_request.reviews.list"
    | "github.pull_request.files.list"
    | "github.pull_request.commits.list",
  value: unknown,
  policy: GitHubPolicyEvaluator,
): GitHubParsedCapabilityInput {
  const source = exactObject(value, ["repository", "pull_request_number", "page_size", "cursor"]);
  const page = pageInput(source, policy);
  return pageResult(capability_id, {
    repository: repository(required(source, "repository"), policy),
    pull_request_number: integer(required(source, "pull_request_number"), 1),
    ...page,
  }, page);
}

/**
 * Validates and canonicalizes declared GitHub capability inputs before any API
 * invocation. Unknown fields and policy expansions fail closed.
 */
export function parseGitHubCapabilityInput(
  capabilityId: string,
  value: unknown,
  policy: GitHubPolicyEvaluator,
): GitHubParsedCapabilityInput {
  switch (capabilityId) {
    case "github.identity.get": {
      exactObject(value, []);
      return singleResult(capabilityId, {});
    }
    case "github.repository.list": {
      const source = exactObject(value, ["page_size", "cursor"]);
      const page = pageInput(source, policy);
      return pageResult(capabilityId, { ...page }, page);
    }
    case "github.repository.get": {
      const source = exactObject(value, ["repository"]);
      return singleResult(capabilityId, { repository: repository(required(source, "repository"), policy) });
    }
    case "github.pull_request.list":
      return parsePullRequestList(capabilityId, value, policy);
    case "github.pull_request.get": {
      const source = exactObject(value, ["repository", "number"]);
      return singleResult(capabilityId, {
        repository: repository(required(source, "repository"), policy),
        number: integer(required(source, "number"), 1),
      });
    }
    case "github.pull_request.reviews.list":
    case "github.pull_request.files.list":
    case "github.pull_request.commits.list":
      return parseRepositoryPage(capabilityId, value, policy);
    case "github.pull_request.comments.list": {
      const source = exactObject(value, ["repository", "pull_request_number", "kind", "page_size", "cursor"]);
      const page = pageInput(source, policy);
      const hasKind = Object.hasOwn(source, "kind");
      const kind = hasKind ? source.kind : undefined;
      if (hasKind && kind !== "issue" && kind !== "review" && kind !== "all") invalid();
      return pageResult(capabilityId, {
        repository: repository(required(source, "repository"), policy),
        pull_request_number: integer(required(source, "pull_request_number"), 1),
        ...(kind === undefined ? {} : { kind }),
        ...page,
      }, page);
    }
    case "github.pull_request.checks.get": {
      const source = exactObject(value, ["repository", "number"]);
      return singleResult(capabilityId, {
        repository: repository(required(source, "repository"), policy),
        number: integer(required(source, "number"), 1),
      });
    }
    case "github.actions.workflow_runs.list": {
      const source = exactObject(value, ["repository", "branch", "event", "status", "page_size", "cursor"]);
      const page = pageInput(source, policy);
      const input: Record<string, unknown> = {
        repository: repository(required(source, "repository"), policy), ...page,
      };
      for (const [field, maximum] of [["branch", 255], ["event", 100], ["status", 100]] as const) {
        const result = optionalText(source, field, maximum);
        if (result !== undefined) input[field] = result;
      }
      return pageResult(capabilityId, input, page);
    }
    case "github.commit.list": {
      const source = exactObject(value, ["repository", "ref", "since", "until", "page_size", "cursor"]);
      const page = pageInput(source, policy);
      const input: Record<string, unknown> = {
        repository: repository(required(source, "repository"), policy), ...page,
      };
      const ref = optionalText(source, "ref", 255);
      if (ref !== undefined) input.ref = ref;
      const since = optionalDateTime(source, "since");
      if (since !== undefined) input.since = since;
      const until = optionalDateTime(source, "until");
      if (until !== undefined) input.until = until;
      return pageResult(capabilityId, input, page);
    }
    default:
      invalid();
  }
}
