import {
  canonicalCitizenDigest,
  deepFreezeCitizenJson,
  type CitizenDeclaration,
  type CitizenJsonObject,
  type CitizenJsonValue,
  type CitizenSchemaReference,
} from "@work-fabric/network-citizen-spi";

export const GITHUB_READ_CAPABILITY_IDS = [
  "github.identity.get",
  "github.repository.list",
  "github.repository.get",
  "github.pull_request.list",
  "github.pull_request.get",
  "github.pull_request.reviews.list",
  "github.pull_request.comments.list",
  "github.pull_request.files.list",
  "github.pull_request.commits.list",
  "github.pull_request.checks.get",
  "github.actions.workflow_runs.list",
  "github.commit.list",
] as const;

type GitHubReadCapabilityId = (typeof GITHUB_READ_CAPABILITY_IDS)[number];

const objectSchema = (
  required: readonly string[],
  properties: Record<string, CitizenJsonValue>,
): CitizenJsonObject => ({
  type: "object",
  additionalProperties: false,
  required,
  properties,
});

const nullable = (schema: CitizenJsonObject): CitizenJsonObject => ({
  oneOf: [schema, { type: "null" }],
});

const boundedText = (maximum = 8_192): CitizenJsonObject => ({
  type: "string",
  minLength: 1,
  maxLength: maximum,
});

const previewText = (): CitizenJsonObject => ({
  type: "string",
  minLength: 0,
  maxLength: 8_192,
});

const pageSize = { type: "integer", minimum: 1, maximum: 100 } as const;
const cursor = { type: "string", minLength: 1, maxLength: 4_096 } as const;
const pullRequestNumber = { type: "integer", minimum: 1 } as const;
const repository = objectSchema(["owner", "name"], {
  owner: boundedText(100),
  name: boundedText(100),
});
const pageInput = {
  page_size: pageSize,
  cursor,
} as const;
const evidence = (complete: boolean): CitizenJsonObject => objectSchema([
  "provider",
  "fetched_at",
  "installation_id_hash",
  "api_version",
  "query_scope",
  "complete",
], {
  provider: { const: "github" },
  fetched_at: { type: "string", format: "date-time" },
  installation_id_hash: boundedText(128),
  api_version: boundedText(128),
  query_scope: { type: "array", maxItems: 100, items: boundedText(2_048) },
  complete: { const: complete },
  next_cursor: cursor,
});

const identityRecord = objectSchema([
  "app_id", "slug", "name", "url", "owner", "installation_repository_count",
], {
  app_id: boundedText(100),
  slug: boundedText(100),
  name: boundedText(8_192),
  url: boundedText(2_048),
  owner: nullable(boundedText(100)),
  installation_repository_count: { type: "integer", minimum: 0 },
});
const repositoryRecord = objectSchema([
  "repository", "url", "description", "visibility", "archived", "default_branch",
  "topics", "pushed_at", "updated_at",
], {
  repository,
  url: boundedText(2_048),
  description: nullable(boundedText()),
  visibility: { enum: ["public", "private", "internal"] },
  archived: { type: "boolean" },
  default_branch: boundedText(255),
  topics: { type: "array", maxItems: 100, items: boundedText(100) },
  pushed_at: nullable({ type: "string", format: "date-time" }),
  updated_at: { type: "string", format: "date-time" },
});
const pullRequestRecord = objectSchema([
  "repository", "number", "title", "url", "author", "draft", "base_branch",
  "head_branch", "head_sha", "assignees", "requested_reviewers", "labels", "mergeable",
  "created_at", "updated_at",
], {
  repository,
  number: pullRequestNumber,
  title: boundedText(),
  url: boundedText(2_048),
  author: nullable(boundedText(100)),
  draft: { type: "boolean" },
  base_branch: boundedText(255),
  head_branch: boundedText(255),
  head_sha: boundedText(64),
  assignees: { type: "array", maxItems: 100, items: boundedText(100) },
  requested_reviewers: { type: "array", maxItems: 100, items: boundedText(100) },
  labels: { type: "array", maxItems: 100, items: boundedText(100) },
  mergeable: nullable({ type: "boolean" }),
  created_at: { type: "string", format: "date-time" },
  updated_at: { type: "string", format: "date-time" },
  reference: boundedText(2_048),
  body_preview: previewText(),
  body_truncated: { type: "boolean" },
});
const reviewRecord = objectSchema([
  "repository", "pull_request_number", "id", "actor", "state", "submitted_at",
  "body_preview", "body_truncated", "url",
], {
  repository,
  pull_request_number: pullRequestNumber,
  id: boundedText(255),
  actor: nullable(boundedText(100)),
  state: boundedText(100),
  submitted_at: nullable({ type: "string", format: "date-time" }),
  body_preview: previewText(),
  body_truncated: { type: "boolean" },
  url: boundedText(2_048),
});
const commentRecord = objectSchema([
  "repository", "pull_request_number", "id", "actor", "comment_type", "created_at",
  "updated_at", "body_preview", "body_truncated", "url",
], {
  repository,
  pull_request_number: pullRequestNumber,
  id: boundedText(255),
  actor: nullable(boundedText(100)),
  comment_type: { enum: ["issue", "review"] },
  created_at: { type: "string", format: "date-time" },
  updated_at: { type: "string", format: "date-time" },
  body_preview: previewText(),
  body_truncated: { type: "boolean" },
  url: boundedText(2_048),
});
const changedFileRecord = objectSchema([
  "repository", "pull_request_number", "path", "status", "additions", "deletions",
  "changes", "url",
], {
  repository,
  pull_request_number: pullRequestNumber,
  path: boundedText(2_048),
  status: boundedText(100),
  additions: { type: "integer", minimum: 0 },
  deletions: { type: "integer", minimum: 0 },
  changes: { type: "integer", minimum: 0 },
  url: boundedText(2_048),
});
const commitRecord = objectSchema([
  "repository", "sha", "subject", "author_name", "author_login", "verified",
  "timestamp", "url",
], {
  repository,
  sha: boundedText(128),
  subject: boundedText(),
  author_name: nullable(boundedText(255)),
  author_login: nullable(boundedText(100)),
  verified: nullable({ type: "boolean" }),
  timestamp: nullable({ type: "string", format: "date-time" }),
  url: boundedText(2_048),
});
const checkRecord = objectSchema([
  "name", "status", "conclusion", "started_at", "completed_at", "url",
], {
  name: boundedText(255),
  status: boundedText(100),
  conclusion: nullable(boundedText(100)),
  started_at: nullable({ type: "string", format: "date-time" }),
  completed_at: nullable({ type: "string", format: "date-time" }),
  url: nullable(boundedText(2_048)),
});
const checkSummary = objectSchema([
  "repository", "ref", "aggregate_state", "checks",
], {
  repository,
  ref: boundedText(255),
  aggregate_state: { enum: ["pending", "success", "failure", "neutral", "unknown"] },
  checks: { type: "array", maxItems: 100, items: checkRecord },
});
const workflowRunRecord = objectSchema([
  "repository", "id", "workflow_name", "run_number", "event", "branch", "head_sha",
  "actor", "status", "conclusion", "created_at", "updated_at", "url",
], {
  repository,
  id: boundedText(255),
  workflow_name: boundedText(),
  run_number: { type: "integer", minimum: 1 },
  event: boundedText(100),
  branch: nullable(boundedText(255)),
  head_sha: boundedText(128),
  actor: nullable(boundedText(100)),
  status: boundedText(100),
  conclusion: nullable(boundedText(100)),
  created_at: { type: "string", format: "date-time" },
  updated_at: { type: "string", format: "date-time" },
  url: boundedText(2_048),
});

const singleOutput = (item: CitizenJsonObject): CitizenJsonObject => objectSchema(
  ["state", "item", "evidence"],
  { state: { const: "complete" }, item, evidence: evidence(true) },
);
const pageOutput = (item: CitizenJsonObject): CitizenJsonObject => ({
  oneOf: [
    objectSchema(["state", "items", "evidence"], {
      state: { const: "empty" },
      items: { type: "array", maxItems: 0, items: item },
      evidence: evidence(true),
    }),
    objectSchema(["state", "items", "evidence"], {
      state: { const: "complete" },
      items: { type: "array", minItems: 1, maxItems: 100, items: item },
      evidence: evidence(true),
    }),
    objectSchema(["state", "items", "evidence"], {
      state: { const: "truncated" },
      items: { type: "array", minItems: 1, maxItems: 100, items: item },
      evidence: evidence(false),
    }),
  ],
});

const pullRequestTarget = {
  oneOf: [
    objectSchema(["repository"], { repository }),
    objectSchema(["repositories"], {
      repositories: { type: "array", minItems: 1, maxItems: 100, items: repository },
    }),
    objectSchema(["owner"], { owner: boundedText(100) }),
  ],
} as const;
const pullRequestPageInput = objectSchema([
  "repository", "pull_request_number",
], {
  repository,
  pull_request_number: pullRequestNumber,
  ...pageInput,
});

const DOCUMENTS: ReadonlyMap<string, CitizenJsonObject> = new Map(
  Object.entries({
    identityGetInput: objectSchema([], {}),
    identityGetOutput: singleOutput(identityRecord),
    repositoryListInput: objectSchema([], pageInput),
    repositoryListOutput: pageOutput(repositoryRecord),
    repositoryGetInput: objectSchema(["repository"], { repository }),
    repositoryGetOutput: singleOutput(repositoryRecord),
    pullRequestListInput: objectSchema(["target"], {
      target: pullRequestTarget,
      state: { enum: ["open", "closed", "all"] },
      author: boundedText(100),
      reviewer: boundedText(100),
      assignee: boundedText(100),
      labels: { type: "array", maxItems: 100, items: boundedText(100) },
      draft: { type: "boolean" },
      base_branch: boundedText(255),
      updated_since: { type: "string", format: "date-time" },
      ...pageInput,
    }),
    pullRequestListOutput: pageOutput(pullRequestRecord),
    pullRequestGetInput: objectSchema(["repository", "number"], {
      repository,
      number: pullRequestNumber,
    }),
    pullRequestGetOutput: singleOutput(pullRequestRecord),
    pullRequestReviewsListInput: pullRequestPageInput,
    pullRequestReviewsListOutput: pageOutput(reviewRecord),
    pullRequestCommentsListInput: objectSchema([
      "repository", "pull_request_number",
    ], {
      repository,
      pull_request_number: pullRequestNumber,
      kind: { enum: ["issue", "review", "all"] },
      ...pageInput,
    }),
    pullRequestCommentsListOutput: pageOutput(commentRecord),
    pullRequestFilesListInput: pullRequestPageInput,
    pullRequestFilesListOutput: pageOutput(changedFileRecord),
    pullRequestCommitsListInput: pullRequestPageInput,
    pullRequestCommitsListOutput: pageOutput(commitRecord),
    pullRequestChecksGetInput: objectSchema(["repository", "number"], {
      repository,
      number: pullRequestNumber,
    }),
    pullRequestChecksGetOutput: singleOutput(checkSummary),
    workflowRunsListInput: objectSchema(["repository"], {
      repository,
      branch: boundedText(255),
      event: boundedText(100),
      status: boundedText(100),
      ...pageInput,
    }),
    workflowRunsListOutput: pageOutput(workflowRunRecord),
    commitListInput: objectSchema(["repository"], {
      repository,
      ref: boundedText(255),
      since: { type: "string", format: "date-time" },
      until: { type: "string", format: "date-time" },
      ...pageInput,
    }),
    commitListOutput: pageOutput(commitRecord),
  }).map(([name, document]) => [
    `urn:work-fabric:schema:github:${name}:1`,
    deepFreezeCitizenJson(document as CitizenJsonObject),
  ]),
);

const reference = (name: string): CitizenSchemaReference => {
  const uri = `urn:work-fabric:schema:github:${name}:1`;
  const document = DOCUMENTS.get(uri);
  if (document === undefined) throw new TypeError(`Missing GitHub schema ${name}`);
  return Object.freeze({ uri, digest: canonicalCitizenDigest(document) });
};

const declaration = (
  declaration_id: GitHubReadCapabilityId,
  name: string,
  description: string,
  input: string,
  output: string,
): CitizenDeclaration => Object.freeze({
  declaration_id,
  declaration_kind: "capability",
  version: "1.0.0",
  name,
  description,
  input_schema: reference(input),
  output_schema: reference(output),
  interaction_modes: Object.freeze(["asynchronous"] as const),
  risk: "low",
  confirmation: "none",
  constraints: deepFreezeCitizenJson({ operation_kind: "query" }),
  extensions: deepFreezeCitizenJson({}),
});

const DECLARATIONS = Object.freeze([
  declaration("github.identity.get", "GitHub identity", "Returns authenticated installation facts.", "identityGetInput", "identityGetOutput"),
  declaration("github.repository.list", "GitHub repositories", "Lists visible repository facts.", "repositoryListInput", "repositoryListOutput"),
  declaration("github.repository.get", "GitHub repository", "Returns one repository fact.", "repositoryGetInput", "repositoryGetOutput"),
  declaration("github.pull_request.list", "GitHub pull requests", "Lists pull request facts.", "pullRequestListInput", "pullRequestListOutput"),
  declaration("github.pull_request.get", "GitHub pull request", "Returns one pull request fact.", "pullRequestGetInput", "pullRequestGetOutput"),
  declaration("github.pull_request.reviews.list", "GitHub pull request reviews", "Lists pull request review facts.", "pullRequestReviewsListInput", "pullRequestReviewsListOutput"),
  declaration("github.pull_request.comments.list", "GitHub pull request comments", "Lists pull request comment facts.", "pullRequestCommentsListInput", "pullRequestCommentsListOutput"),
  declaration("github.pull_request.files.list", "GitHub pull request files", "Lists pull request file facts.", "pullRequestFilesListInput", "pullRequestFilesListOutput"),
  declaration("github.pull_request.commits.list", "GitHub pull request commits", "Lists pull request commit facts.", "pullRequestCommitsListInput", "pullRequestCommitsListOutput"),
  declaration("github.pull_request.checks.get", "GitHub pull request checks", "Returns pull request check facts.", "pullRequestChecksGetInput", "pullRequestChecksGetOutput"),
  declaration("github.actions.workflow_runs.list", "GitHub workflow runs", "Lists workflow run facts.", "workflowRunsListInput", "workflowRunsListOutput"),
  declaration("github.commit.list", "GitHub commits", "Lists commit facts.", "commitListInput", "commitListOutput"),
]);

export function githubReadCapabilityDeclarations(): readonly CitizenDeclaration[] {
  return DECLARATIONS;
}

export function githubSchemaDocuments(): readonly (readonly [string, CitizenJsonObject])[] {
  return Object.freeze([...DOCUMENTS.entries()]);
}
