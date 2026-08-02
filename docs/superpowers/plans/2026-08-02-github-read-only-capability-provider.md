# GitHub Read-Only Capability Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independently deployable, read-only GitHub Capability Provider that lets the Daily Assistant answer GitHub repository and PR questions through the existing Fabric Handoff and Channel result path.

**Architecture:** `@work-fabric/provider-github` owns stable GitHub capability contracts, policy, normalized facts, cursor semantics and execution. `@work-fabric/adapter-github-octokit` owns GitHub App authentication, Octokit REST calls and vendor error translation. `examples/github-capability-provider` composes an independent Citizen runtime and capability Handoff consumer; Fabric Core, the Feishu Provider and the Agent model runtime remain unchanged except for configuration and authorized capability discovery.

**Tech Stack:** TypeScript 7, Node.js 22.20+, Vitest 4, Ajv through the existing schema validator, `@octokit/rest@22.0.1`, `@octokit/auth-app@8.2.0`, Work Fabric Network Citizen and Capability Provider runtime packages.

## Global Constraints

- Work Fabric Core must not acquire GitHub, Octokit, MCP, model or provider-specific dependencies.
- The Provider exposes exactly the twelve read-only `github.*` declarations approved in the design.
- No GitHub mutation, webhook, clone, code-search, repository-content or user-OAuth path is introduced.
- The Daily Assistant owns semantic intent, capability selection and final prose; no keyword, regular-expression or substring intent router is permitted.
- The Provider returns typed current facts and stable diagnostics, never conversational prose.
- Production authentication is GitHub App installation authentication; PAT mode is local-development-only and rejected by production configuration.
- Credentials, private keys, tokens, raw authorization headers and unredacted response bodies never enter Handoffs, Results, Console payloads or logs.
- All list operations are deterministic, bounded and use opaque signed Provider cursors.
- Empty, failed, forbidden, rate-limited and truncated results remain distinct.
- The current capability Result is the only proof that the current GitHub query ran.
- Tests must follow RED -> GREEN -> REFACTOR; each production behavior is introduced only after its failing test has been observed.
- The existing `var/` worktree content is user-owned and must not be staged, edited or removed.

---

## File map

### New domain package: `packages/provider-github`

- `src/contracts.ts`: normalized GitHub references, records, pages, evidence and API port.
- `src/declarations.ts`: the twelve immutable capability declarations and JSON Schemas.
- `src/schema-registry.ts`: digest-checked schema lookup for Agent invocation validation.
- `src/policy.ts`: owner/repository policy ceiling and bounded target expansion.
- `src/cursor.ts`: HMAC-signed opaque pagination cursor.
- `src/errors.ts`: Provider-domain diagnostic types.
- `src/query-service.ts`: capability-specific validation, query execution, normalized evidence and pagination semantics.
- `src/executor.ts`: `CapabilityExecutor` implementation and Authority validation.
- `src/citizen-runtime.ts`: independently leased GitHub Capability Citizen.
- `src/index.ts`: public exports only.

### New mechanism package: `packages/adapter-github-octokit`

- `src/authentication.ts`: GitHub App credentials and Octokit client construction.
- `src/error-mapping.ts`: Octokit/GitHub failures to stable Provider errors.
- `src/octokit-read-api.ts`: read-only route calls and normalization into `GitHubReadApi` types.
- `src/index.ts`: public exports only.

### New runnable module: `examples/github-capability-provider`

- `src/configuration.ts`: global Configuration Provider view and strict GitHub plugin validation.
- `src/credentials.ts`: environment-backed GitHub App credential provider.
- `src/composition.ts`: Work Fabric client, Citizen lease, Agent Gateway, Provider driver and lifecycle.
- `src/provision.ts`: explicit Endpoint and Citizen provisioning.
- `src/main.ts`: signal-safe process entry point.

### Existing integration files

- `package.json` and `package-lock.json`: pinned SDK dependencies and scripts.
- `examples/config/local-feishu-assistant.bundle.yaml`: optional GitHub application, identity, Authority and Agent namespace ceiling.
- `tools/local-feishu-common.ts`: expose the selected unified bundle to the GitHub application without making GitHub credentials mandatory for the existing three-process stack.
- `tools/local-github-provider.ts`: provision/start the optional fourth process from the existing `.env` and unified bundle.
- `deploy/office/github-provider-healthcheck.ts`: standalone GitHub Provider process health for an optional fourth container.
- `docs/guides/github-capability-provider.md`: setup, permissions, local use and live smoke test.
- `deploy/office/README.md`: independent GitHub process/container deployment boundary.

---

### Task 1: Capability contracts, declarations and schema registry

**Files:**
- Create: `packages/provider-github/package.json`
- Create: `packages/provider-github/src/contracts.ts`
- Create: `packages/provider-github/src/declarations.ts`
- Create: `packages/provider-github/src/schema-registry.ts`
- Create: `packages/provider-github/src/index.ts`
- Test: `packages/provider-github/test/declarations.test.ts`
- Test: `packages/provider-github/test/schema-registry.test.ts`

**Interfaces:**
- Consumes: `CitizenDeclaration`, `CitizenSchemaReference`, `CitizenJsonObject`, `canonicalCitizenDigest` from `@work-fabric/network-citizen-spi`.
- Produces: `GITHUB_READ_CAPABILITY_IDS`, `githubReadCapabilityDeclarations()`, `githubSchemaDocuments()`, `GitHubCapabilitySchemaRegistry`, `GitHubRepositoryRef`, normalized record/page/evidence types and `GitHubReadApi`.

- [ ] **Step 1: Write the failing declaration tests**

```ts
import { describe, expect, it } from "vitest";
import {
  GITHUB_READ_CAPABILITY_IDS,
  githubReadCapabilityDeclarations,
} from "../src/index.js";

describe("GitHub read capability declarations", () => {
  it("declares exactly the approved read-only surface", () => {
    expect(GITHUB_READ_CAPABILITY_IDS).toEqual([
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
    ]);
    const declarations = githubReadCapabilityDeclarations();
    expect(declarations).toHaveLength(12);
    expect(declarations.every((item) =>
      item.version === "1.0.0" &&
      item.risk === "low" &&
      item.confirmation === "none"
    )).toBe(true);
    expect(JSON.stringify(declarations)).not.toMatch(
      /create|update|delete|merge|close|rerun|cancel/i,
    );
  });
});
```

- [ ] **Step 2: Run the declaration test and verify RED**

Run: `npx vitest run packages/provider-github/test/declarations.test.ts`

Expected: FAIL because `@work-fabric/provider-github` declarations do not exist.

- [ ] **Step 3: Add the package and exact public contracts**

```ts
export interface GitHubRepositoryRef {
  readonly owner: string;
  readonly name: string;
}

export interface GitHubEvidenceMeta {
  readonly provider: "github";
  readonly fetched_at: string;
  readonly installation_id_hash: string;
  readonly api_version: string;
  readonly query_scope: readonly string[];
  readonly complete: boolean;
  readonly next_cursor?: string;
}

export interface GitHubPage<T> {
  readonly state: "complete" | "truncated" | "empty";
  readonly items: readonly T[];
  readonly evidence: GitHubEvidenceMeta;
}

export interface GitHubPullRequestRecord {
  readonly repository: GitHubRepositoryRef;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string | null;
  readonly draft: boolean;
  readonly base_branch: string;
  readonly head_branch: string;
  readonly assignees: readonly string[];
  readonly requested_reviewers: readonly string[];
  readonly labels: readonly string[];
  readonly mergeable: boolean | null;
  readonly created_at: string;
  readonly updated_at: string;
}
```

Define `GitHubIdentityRecord`, `GitHubRepositoryRecord`, `GitHubReviewRecord`,
`GitHubCommentRecord`, `GitHubChangedFileRecord`, `GitHubCommitRecord`,
`GitHubCheckSummary`, and `GitHubWorkflowRunRecord` with exactly the fields from
section 7.3 of the approved design. Define `GitHubReadApi` with these methods:

```ts
export interface GitHubReadApi {
  getIdentity(signal: AbortSignal): Promise<GitHubIdentityRecord>;
  listRepositories(input: GitHubApiPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubRepositoryRecord>>;
  getRepository(repository: GitHubRepositoryRef, signal: AbortSignal): Promise<GitHubRepositoryRecord>;
  listPullRequests(input: GitHubApiPullRequestListInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubPullRequestRecord>>;
  searchPullRequests(input: GitHubApiPullRequestSearchInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubPullRequestRecord>>;
  getPullRequest(repository: GitHubRepositoryRef, number: number, signal: AbortSignal): Promise<GitHubPullRequestRecord>;
  listReviews(input: GitHubApiPullRequestPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubReviewRecord>>;
  listIssueComments(input: GitHubApiPullRequestPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubCommentRecord>>;
  listReviewComments(input: GitHubApiPullRequestPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubCommentRecord>>;
  listFiles(input: GitHubApiPullRequestPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubChangedFileRecord>>;
  listPullRequestCommits(input: GitHubApiPullRequestPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubCommitRecord>>;
  getChecks(repository: GitHubRepositoryRef, ref: string, signal: AbortSignal): Promise<GitHubCheckSummary>;
  listWorkflowRuns(input: GitHubApiWorkflowRunListInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubWorkflowRunRecord>>;
  listCommits(input: GitHubApiCommitListInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubCommitRecord>>;
}
```

- [ ] **Step 4: Add immutable JSON Schemas and digest-checked registry**

Use `additionalProperties: false`, `page_size` bounds `1..100`, repository
owner/name length bounds `1..100`, PR number minimum `1`, cursor maximum `4096`,
text preview maximum `8192`, and arrays maximum `100`. Each declaration points
to `urn:work-fabric:schema:github:<name>:1` and the digest of its exact schema.

```ts
export class GitHubCapabilitySchemaRegistry {
  private readonly documents = new Map(githubSchemaDocuments());

  async load(reference: CitizenSchemaReference, signal: AbortSignal) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    const document = this.documents.get(reference.uri);
    if (
      document === undefined ||
      canonicalCitizenDigest(document) !== reference.digest
    ) throw new TypeError("Unknown or changed GitHub capability schema");
    return structuredClone(document);
  }
}
```

- [ ] **Step 5: Run declaration and schema tests and verify GREEN**

Run: `npx vitest run packages/provider-github/test/declarations.test.ts packages/provider-github/test/schema-registry.test.ts`

Expected: 2 test files pass; changing a schema document without changing the declaration digest is rejected.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/provider-github
git commit -m "feat(github): define read-only capability contracts"
```

---

### Task 2: Policy ceiling, validation and signed pagination

**Files:**
- Create: `packages/provider-github/src/policy.ts`
- Create: `packages/provider-github/src/cursor.ts`
- Create: `packages/provider-github/src/validation.ts`
- Create: `packages/provider-github/src/errors.ts`
- Modify: `packages/provider-github/src/index.ts`
- Test: `packages/provider-github/test/policy.test.ts`
- Test: `packages/provider-github/test/cursor.test.ts`
- Test: `packages/provider-github/test/validation.test.ts`

**Interfaces:**
- Consumes: `GitHubRepositoryRef` and capability input types from Task 1.
- Produces: `GitHubProviderError`, `GitHubProviderPolicy`, `GitHubPolicyEvaluator`, `GitHubCursorCodec`, `HmacGitHubCursorCodec`, `parseGitHubCapabilityInput()`.

- [ ] **Step 1: Write failing policy and cursor tests**

```ts
it("rejects a repository outside the configured owner ceiling", () => {
  const policy = new GitHubPolicyEvaluator({
    allowed_owners: ["AgentEra"],
    allowed_repositories: [],
    maximum_page_size: 100,
    maximum_aggregate_repositories: 100,
  });
  expect(() => policy.authorizeRepository({ owner: "other", name: "secret" }))
    .toThrowError("github_forbidden");
});

it("rejects a cursor copied to a different query", () => {
  const codec = new HmacGitHubCursorCodec({ key: Buffer.alloc(32, 7) });
  const cursor = codec.encode({ scope_hash: "sha256:a", page: 2 });
  expect(() => codec.decode(cursor, "sha256:b")).toThrowError(
    "github_invalid_request",
  );
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npx vitest run packages/provider-github/test/policy.test.ts packages/provider-github/test/cursor.test.ts packages/provider-github/test/validation.test.ts`

Expected: FAIL because policy, cursor and capability input parsers are absent.

- [ ] **Step 3: Implement exact policy and cursor contracts**

```ts
export interface GitHubProviderPolicy {
  readonly allowed_owners: readonly string[];
  readonly allowed_repositories: readonly GitHubRepositoryRef[];
  readonly maximum_page_size: number;
  readonly maximum_aggregate_repositories: number;
}

export interface GitHubCursorState {
  readonly version: 1;
  readonly scope_hash: `sha256:${string}`;
  readonly page: number;
}
```

`HmacGitHubCursorCodec` serializes canonical JSON, signs it with HMAC-SHA256,
and emits base64url `<payload>.<signature>`. Decode verifies constant-time
signature equality, version `1`, exact query scope hash and page range
`1..10000`. Invalid inputs throw `GitHubProviderError("github_invalid_request")`.

Policy comparison is case-insensitive for owner/repository matching but returns
the caller's canonicalized trimmed reference. An empty `allowed_repositories`
means every repository belonging to an allowed owner; it never means every
owner.

- [ ] **Step 4: Implement strict capability input parsing**

`parseGitHubCapabilityInput(capabilityId, value, policy)` rejects unknown
fields and validates the exact input schema before any API call. It resolves
default `state: "open"`, default `page_size: 30`, and cursor page `1`.

```ts
const parsed = parseGitHubCapabilityInput(
  "github.pull_request.list",
  {
    target: { owner: "AgentEra" },
    state: "open",
    page_size: 30,
  },
  policy,
);
expect(parsed).toMatchObject({
  capability_id: "github.pull_request.list",
  page: 1,
  page_size: 30,
});
```

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npx vitest run packages/provider-github/test/policy.test.ts packages/provider-github/test/cursor.test.ts packages/provider-github/test/validation.test.ts`

Expected: all policy, tamper, cross-query cursor, page-bound and exact-input tests pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add packages/provider-github
git commit -m "feat(github): enforce query policy and signed pagination"
```

---

### Task 3: GitHub App authentication and stable vendor errors

**Files:**
- Create: `packages/adapter-github-octokit/package.json`
- Create: `packages/adapter-github-octokit/src/authentication.ts`
- Create: `packages/adapter-github-octokit/src/error-mapping.ts`
- Create: `packages/adapter-github-octokit/src/index.ts`
- Test: `packages/adapter-github-octokit/test/authentication.test.ts`
- Test: `packages/adapter-github-octokit/test/error-mapping.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `GitHubProviderError` from Task 2.
- Produces: `GitHubAppCredentials`, `GitHubCredentialProvider`, `createGitHubAppOctokit()`, `mapGitHubApiError()`.

- [ ] **Step 1: Add failing credential and redaction tests**

```ts
it("constructs an installation-authenticated client without exposing secrets", async () => {
  const credentials = {
    app_id: "12345",
    installation_id: "67890",
    private_key: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
  };
  const observed: Record<string, unknown>[] = [];
  createGitHubAppOctokit(credentials, (options) => {
    observed.push(options);
    return { request: async () => ({ data: {}, headers: {} }) };
  });
  expect(observed[0]).toMatchObject({ auth: { appId: "12345", installationId: "67890" } });
  expect(JSON.stringify(mapGitHubApiError({ status: 401 }))).not.toContain(
    credentials.private_key,
  );
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run packages/adapter-github-octokit/test/authentication.test.ts packages/adapter-github-octokit/test/error-mapping.test.ts`

Expected: FAIL because the Octokit adapter package does not exist.

- [ ] **Step 3: Pin SDK dependencies and implement GitHub App auth**

Add exact workspace dependencies:

```json
{
  "dependencies": {
    "@octokit/auth-app": "8.2.0",
    "@octokit/rest": "22.0.1",
    "@work-fabric/provider-github": "0.1.0"
  }
}
```

Construct `Octokit` with `authStrategy: createAppAuth` and:

```ts
auth: {
  appId: credentials.app_id,
  privateKey: credentials.private_key,
  installationId: credentials.installation_id,
}
```

Reject empty or non-decimal App and installation IDs and malformed PEM values
before constructing Octokit.

- [ ] **Step 4: Implement stable error mapping**

Map status `401` to `github_authentication_failed`, `403` with exhausted
rate-limit metadata to `github_rate_limited`, other `403` to
`github_forbidden`, `404` to the caller-supplied not-found code, `422` to
`github_invalid_request`, `429` to `github_rate_limited`, `500..599` and
transport failures to retryable `github_upstream_unavailable`, and unexpected
payloads to non-retryable `github_response_invalid`. Preserve only safe
`retry_at`, GitHub request ID and retryability fields.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npx vitest run packages/adapter-github-octokit/test/authentication.test.ts packages/adapter-github-octokit/test/error-mapping.test.ts`

Expected: authentication validation, error classification and redaction tests pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add package.json package-lock.json packages/adapter-github-octokit
git commit -m "feat(github): add GitHub App Octokit boundary"
```

---

### Task 4: Octokit read API implementation

**Files:**
- Create: `packages/adapter-github-octokit/src/octokit-read-api.ts`
- Modify: `packages/adapter-github-octokit/src/index.ts`
- Test: `packages/adapter-github-octokit/test/octokit-read-api.test.ts`

**Interfaces:**
- Consumes: `GitHubReadApi` and normalized records from Task 1; authenticated `OctokitRequestClient` and error mapping from Task 3.
- Produces: `OctokitGitHubReadApi implements GitHubReadApi`.

- [ ] **Step 1: Write failing route and normalization tests**

Use a recording request client and assert exact read-only routes:

```ts
const ROUTES = [
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
] as const;

expect(recorded.map((item) => item.route)).toEqual(ROUTES);
expect(JSON.stringify(results)).not.toMatch(/authorization|private_key|token/i);
```

- [ ] **Step 2: Run the adapter test and verify RED**

Run: `npx vitest run packages/adapter-github-octokit/test/octokit-read-api.test.ts`

Expected: FAIL because `OctokitGitHubReadApi` is missing.

- [ ] **Step 3: Implement identity, repository and PR list/detail reads**

Use `GET /installation/repositories` for installation identity/repository
visibility, `GET /repos/{owner}/{repo}/pulls` for one repository, and
`GET /search/issues` with `is:pr` plus authorized `org:`/`repo:` qualifiers for
owner or multi-repository aggregation. Search results are followed only by the
bounded PR detail calls necessary to normalize the current page; the total is
limited by `page_size` and the Provider deadline.

Normalize nullable users, draft state, labels, assignees, requested reviewers,
base/head refs and timestamps without retaining raw payloads.

- [ ] **Step 4: Implement review, comment, file, commit, check and Actions reads**

For comments, merge ordinary issue comments and review comments only when the
input requests `kind: "all"`; retain `comment_type: "issue" | "review"` and
sort by `created_at`, then stable ID. `getChecks` calls combined status and
check-runs concurrently with the same abort signal and returns one normalized
aggregate. Files omit patch text. Commits expose bounded first-line subject,
SHA, authorship, verification and time. Workflow runs omit logs/artifacts.

- [ ] **Step 5: Enforce response shape and byte bounds**

Every response parser validates arrays/objects before access, truncates text
previews at 8192 UTF-8 bytes without splitting surrogate pairs, accepts no more
than 100 items, and throws `github_response_invalid` rather than returning a
partially trusted record.

- [ ] **Step 6: Run tests and verify GREEN**

Run: `npx vitest run packages/adapter-github-octokit/test/octokit-read-api.test.ts`

Expected: all fifteen read-only routes, normalization, pagination headers,
malformed response and secret-redaction tests pass.

- [ ] **Step 7: Commit Task 4**

```bash
git add packages/adapter-github-octokit
git commit -m "feat(github): implement bounded Octokit read API"
```

---

### Task 5: Query service, CapabilityExecutor and leased Citizen

**Files:**
- Create: `packages/provider-github/src/query-service.ts`
- Create: `packages/provider-github/src/executor.ts`
- Create: `packages/provider-github/src/citizen-runtime.ts`
- Modify: `packages/provider-github/src/index.ts`
- Test: `packages/provider-github/test/query-service.test.ts`
- Test: `packages/provider-github/test/executor.test.ts`
- Test: `packages/provider-github/test/citizen-runtime.test.ts`
- Test: `packages/capability-provider-runtime/test/github-loop.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 declarations/API records, Task 2 policy/cursor/input parser, `CapabilityExecutor`, `LeasedNetworkCitizenRuntime`, and the existing `CapabilityProviderDriver`.
- Produces: `GitHubQueryService`, `GitHubCapabilityExecutor`, `GitHubCapabilityCitizenRuntime`.

- [ ] **Step 1: Write failing query/result-state tests**

```ts
it.each([
  [[], "empty", true],
  [[pullRequest], "complete", true],
])("distinguishes successful %s results", async (items, state, complete) => {
  const result = await service.execute(
    "github.pull_request.list",
    { target: { owner: "AgentEra" }, state: "open", page_size: 30 },
    context,
  );
  expect(result).toMatchObject({
    outcome: "succeeded",
    data: { state, items, evidence: { provider: "github", complete } },
  });
});
```

Add tests for `truncated`, forbidden repository, invalid cursor,
`github_rate_limited` with `retry_after`, and an aborted signal.

- [ ] **Step 2: Run query tests and verify RED**

Run: `npx vitest run packages/provider-github/test/query-service.test.ts packages/provider-github/test/executor.test.ts`

Expected: FAIL because query service and executor are absent.

- [ ] **Step 3: Implement the twelve-capability dispatcher**

```ts
export class GitHubQueryService {
  async execute(
    capabilityId: typeof GITHUB_READ_CAPABILITY_IDS[number],
    input: CitizenJsonObject,
    context: {
      readonly tenant_id: string;
      readonly installation_id_hash: string;
      readonly signal: AbortSignal;
    },
  ): Promise<CapabilityExecutionResult>;
}
```

Use an exhaustive `switch` over all twelve IDs. List results include
`state`, `items`, and `GitHubEvidenceMeta`. Single-record results include
`state: "complete"`, `item`, and evidence. The service computes a canonical
query-scope hash before decoding a cursor. It performs no model work and emits
no conversational sentence.

- [ ] **Step 4: Implement Authority-closed CapabilityExecutor**

`GitHubCapabilityExecutor.execute()` must reject unless Authority evidence has
all of:

```ts
{
  original_handoff_id: string;
  represented_actor_id: string;
  delegation_id: string;
  delegation_scopes: string[]; // must contain "github:read"
  delegation_expires_at: string; // must be later than now
  capability_version: "1.0.0";
  contract_digest: `sha256:${string}`;
}
```

It verifies the bound declaration digest, parses input, calls the query service
and maps `GitHubProviderError` to `rejected` or `failed` without leaking its
cause object.

- [ ] **Step 5: Implement the leased Citizen runtime**

```ts
export class GitHubCapabilityCitizenRuntime
  extends LeasedNetworkCitizenRuntime
  implements CapabilityProviderRuntimePort {
  readonly citizen_kind = "capability-provider" as const;
  readonly executor: CapabilityExecutor;
}
```

Descriptor extensions are exactly:

```ts
{
  "workfabric.dev/provider_family": "github",
  "workfabric.dev/declaration_source": "runtime",
  "workfabric.dev/mutation_support": "none",
}
```

- [ ] **Step 6: Prove the auxiliary Handoff loop**

Add `github-loop.integration.test.ts` following the existing Feishu loop test:
the Daily Assistant invocation port discovers `github.pull_request.list`,
offers an auxiliary Handoff, the GitHub Provider accepts and returns two PR
records, and the original responsible Actor remains the Daily Assistant.

- [ ] **Step 7: Run tests and verify GREEN**

Run: `npx vitest run packages/provider-github/test packages/capability-provider-runtime/test/github-loop.integration.test.ts`

Expected: domain, Citizen lease and Handoff-loop tests pass with no GitHub network access.

- [ ] **Step 8: Commit Task 5**

```bash
git add packages/provider-github packages/capability-provider-runtime/test/github-loop.integration.test.ts
git commit -m "feat(github): execute read capabilities through Fabric handoffs"
```

---

### Task 6: Runnable GitHub Provider composition and provisioning

**Files:**
- Create: `examples/github-capability-provider/package.json`
- Create: `examples/github-capability-provider/src/configuration.ts`
- Create: `examples/github-capability-provider/src/credentials.ts`
- Create: `examples/github-capability-provider/src/composition.ts`
- Create: `examples/github-capability-provider/src/provision.ts`
- Create: `examples/github-capability-provider/src/main.ts`
- Test: `examples/github-capability-provider/test/configuration.test.ts`
- Test: `examples/github-capability-provider/test/credentials.test.ts`
- Test: `examples/github-capability-provider/test/composition.test.ts`
- Test: `examples/github-capability-provider/test/provision.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `GitHubCapabilityCitizenRuntime`, `GitHubCapabilityExecutor`, `OctokitGitHubReadApi`, `CapabilityProviderDriver`, `AgentGateway`, `composeAgentRuntimeHost`, `WorkFabricClient`, and the global Configuration Provider stack.
- Produces: `loadGitHubProviderConfiguration()`, `composeGitHubProvider()`, `startGitHubProvider()`, `provisionGitHubProvider()` and root scripts `github-provider:start` / `github-provider:provision`.

- [ ] **Step 1: Write failing strict configuration tests**

```ts
expect(await loadGitHubProviderConfiguration({ document, environment })).toMatchObject({
  provider: {
    authentication: { mode: "github_app", credential_ref: "github-primary" },
    policy: {
      allowed_owners: ["AgentEra"],
      maximum_page_size: 100,
      maximum_aggregate_repositories: 100,
    },
    citizen: { citizen_id: "citizen-github-read" },
  },
});
expect(JSON.stringify(loaded)).not.toMatch(/PRIVATE KEY|ghp_|github_pat_/);
```

Also assert unknown fields fail, duplicate/empty owners fail, PAT plus
`development_mode: false` fails, and no enabled GitHub instance fails.

- [ ] **Step 2: Run configuration tests and verify RED**

Run: `npx vitest run examples/github-capability-provider/test/configuration.test.ts examples/github-capability-provider/test/credentials.test.ts`

Expected: FAIL because the runnable module does not exist.

- [ ] **Step 3: Implement configuration and credential providers**

The application ID defaults to `github-provider`; plugin type is exactly
`capability-provider.github`. Resolve these secret paths through
`EnvironmentSecretResolver`:

```text
service.work_fabric.access_token
provider.cursor_signing_key
```

GitHub App IDs and private key are loaded by `EnvironmentGitHubCredentialProvider`
using the configured environment variable names only at client construction.
The loaded configuration contains no secret value.

- [ ] **Step 4: Compose lifecycle transactionally**

Composition order is:

```text
construct credentials and Octokit adapter
-> construct query service and executor
-> start leased GitHub Citizen
-> start Agent Gateway / CapabilityProviderDriver host
```

Close reverses that order and is idempotent. If any start step fails, close all
already-started dependencies. Health returns `ready` only when the Citizen is
`available` and the host stream remains active.

- [ ] **Step 5: Implement explicit provisioning**

Provision one Endpoint with all twelve `CapabilityDescriptor`s and one Citizen:

```ts
{
  citizen_id: "citizen-github-read",
  citizen_kind: "capability-provider",
  principal_id: "principal-github-provider",
  allowed_actor: { actor_id: "actor-github-provider", actor_type: "system" },
  allowed_endpoint_id: "endpoint-github-provider",
  allowed_declaration_namespaces: ["github"],
  maximum_risk: "low",
  administrative_state: "enabled",
  registration_version: 1,
}
```

- [ ] **Step 6: Run composition/provision tests and verify GREEN**

Run: `npx vitest run examples/github-capability-provider/test`

Expected: strict config, secret boundary, transactional lifecycle, health and provisioning tests pass.

- [ ] **Step 7: Commit Task 6**

```bash
git add package.json examples/github-capability-provider
git commit -m "feat(github): add standalone provider runtime"
```

---

### Task 7: Unified configuration and optional local process

**Files:**
- Modify: `examples/config/local-feishu-assistant.bundle.yaml`
- Modify: `tools/local-feishu-common.ts`
- Create: `tools/local-github-provider.ts`
- Test: `tools/local-github-provider.test.ts`
- Modify: `package.json`
- Create: `deploy/office/github-provider-healthcheck.ts`
- Create: `tools/github-provider-office-image.test.ts`

**Interfaces:**
- Consumes: Task 6 provision/start entry points and the existing unified YAML/global Configuration Provider.
- Produces: optional `github-provider` application, `local:github:start`, and an independent GitHub Provider container health probe.

- [ ] **Step 1: Write failing optional-integration tests**

```ts
it("does not require GitHub credentials for the existing Feishu stack", async () => {
  const environment = await prepareLocalFeishuEnvironment(feishuOnlyInput);
  expect(environment.WORK_FABRIC_GITHUB_PROVIDER_CONFIG_APPLICATION).toBe(
    "github-provider",
  );
  expect(environment.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
});

it("requires the standalone GitHub Provider process", () => {
  expect(githubProviderProcessPresent(baseCommands)).toBe(false);
  expect(githubProviderProcessPresent([...baseCommands, githubCommand])).toBe(true);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tools/local-github-provider.test.ts tools/github-provider-office-image.test.ts`

Expected: FAIL because GitHub application/process integration is absent.

- [ ] **Step 3: Add the disabled-by-default unified GitHub application**

Add `applications.github-provider` with one disabled
`capability-provider.github` plugin. Add Work Fabric identity/Authority rules
for `principal-github-provider`, `actor-github-provider`,
`endpoint-github-provider` and `citizen-github-read`. Add the twelve Agent
declaration-read rules, `github.` to `allowed_namespaces`, and `github:read` to
the Feishu inbound delegation scopes. Existing Feishu-only applications do not
resolve or require GitHub secrets.

The plugin becomes usable by changing only:

```yaml
enabled: true
```

and supplying `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_PROVIDER_ACCESS_TOKEN`, and
`WORK_FABRIC_GITHUB_CURSOR_SECRET` in the selected environment source.

- [ ] **Step 4: Add optional local launcher**

`local:github:start` loads the existing `.env`, prepares the same resolved
bundle, verifies that GitHub is enabled, provisions Endpoint/Citizen, then
starts only the GitHub Provider process. It never starts a Feishu long
connection. This allows the office host to remain the sole Feishu connection
owner while a local Debug Channel stack tests GitHub.

- [ ] **Step 5: Add independent office health for the optional Provider container**

`deploy/office/github-provider-healthcheck.ts` exposes:

```ts
export function githubProviderProcessPresent(
  commands: readonly string[],
): boolean {
  return commands.some((command) =>
    command.split(/\s+/u).includes(
      "examples/github-capability-provider/src/main.ts",
    )
  );
}
```

The probe checks only the GitHub Provider process because it runs in an
independent optional container. The existing Work Fabric/Feishu/Agent composite
healthcheck remains unchanged. A future Compose GitHub service overrides the
image healthcheck with this probe.

- [ ] **Step 6: Run integration tests and verify GREEN**

Run: `npx vitest run tools/local-github-provider.test.ts tools/local-feishu-stack.test.ts tools/office-image.test.ts tools/github-provider-office-image.test.ts`

Expected: existing Feishu-only startup remains unchanged; optional GitHub startup and health requirements pass.

- [ ] **Step 7: Commit Task 7**

```bash
git add package.json examples/config/local-feishu-assistant.bundle.yaml tools/local-feishu-common.ts tools/local-github-provider.ts tools/local-github-provider.test.ts deploy/office/github-provider-healthcheck.ts tools/github-provider-office-image.test.ts
git commit -m "feat(github): wire optional provider configuration"
```

---

### Task 8: Agent grounding and Debug Channel end-to-end path

**Files:**
- Modify: `examples/agently-agent-runtime/test/local-invocation-authority.test.ts`
- Create: `packages/service-node/test/debug-github-capability.e2e.test.ts`
- Modify: `examples/agently-agent-runtime/test/daily-assistant-e2e-builders.ts`
- Test: `runtimes/agently-worker/tests/test_assistant.py`

**Interfaces:**
- Consumes: existing model-owned capability selection, `HandoffCapabilityInvocationPort`, Debug Channel E2E fixture, fake OpenAI-compatible server and fake `GitHubReadApi`.
- Produces: authorized `github:read` delegation and a deterministic message -> Agent -> GitHub Provider -> Agent Result proof.

- [ ] **Step 1: Write failing Agent Authority test**

```ts
const request = capabilityInput("github.pull_request.list", {
  target: { owner: "AgentEra" },
  state: "open",
  page_size: 30,
});
await expect(authority.authorize({ request })).resolves.toMatchObject({
  scopes: ["capability:invoke", "github:read"],
  extensions: {
    "workfabric.dev/capability_authority": {
      delegation_scopes: expect.arrayContaining(["github:read"]),
    },
  },
});
```

- [ ] **Step 2: Run the Authority test and verify RED**

Run: `npx vitest run examples/agently-agent-runtime/test/local-invocation-authority.test.ts`

Expected: FAIL because `github.*` has no local Authority scope mapping.

- [ ] **Step 3: Add namespace-to-scope mapping without lexical intent logic**

Extend only the deterministic post-selection Authority mapper so an already
model-selected `github.*` declaration requires `github:read`. Do not change the
prompt, add keywords or preselect GitHub based on message text.

- [ ] **Step 4: Write the failing Debug Channel E2E**

The fake model returns two structured turns. Turn one:

```json
{
  "turn_type": "capability_request",
  "request_summary": "查询当前未关闭的 PR",
  "context_status": "sufficient",
  "missing_information": [],
  "response": "",
  "invocation_id": "github-pr-list-1",
  "capability_id": "github.pull_request.list",
  "version_constraint": "1.0.0",
  "input": { "target": { "owner": "AgentEra" }, "state": "open", "page_size": 30 },
  "reason": "需要当前 GitHub PR 事实",
  "private_state_action": "none",
  "private_state": {}
}
```

Turn two returns markdown:

```text
当前有 2 个未关闭 PR：
- [#42 修复 SSE 重连](https://github.com/AgentEra/work-fabric/pull/42)
- [#43 增加 GitHub Provider](https://github.com/AgentEra/work-fabric/pull/43)
```

The fake GitHub port returns exactly those two records and records one call.
Submit the user message through Debug Channel HTTP and assert one canonical
`workfabric.handoff.result_returned.v1` event with the markdown above.

- [ ] **Step 5: Run the E2E and verify RED**

Run: `npx vitest run packages/service-node/test/debug-github-capability.e2e.test.ts`

Expected: FAIL before the GitHub Provider fixture and Agent Authority path are wired.

- [ ] **Step 6: Wire the deterministic E2E fixture and verify GREEN**

Provision the GitHub Endpoint/Citizen in the test fixture, start a real
`GitHubCapabilityCitizenRuntime` and Provider host with fake API, start the real
Agently worker against the fake model server, then submit through Debug Channel.
Assert:

```ts
expect(fakeGitHub.calls).toEqual([{
  capability_id: "github.pull_request.list",
  owner: "AgentEra",
  state: "open",
}]);
expect(model.requests).toHaveLength(2);
expect(JSON.stringify(events)).not.toMatch(/private_key|access_token|github_pat_/i);
```

- [ ] **Step 7: Add Python grounding regression**

Add a Python test proving a historical GitHub PR list cannot be used as proof
of a current query. The first current turn must return
`github.pull_request.list`; only the current successful capability transcript
may support the final PR summary.

- [ ] **Step 8: Run all Agent/GitHub E2E tests and verify GREEN**

Run: `npx vitest run examples/agently-agent-runtime/test/local-invocation-authority.test.ts packages/service-node/test/debug-github-capability.e2e.test.ts && npm run agent-runtime:test-python`

Expected: TypeScript E2E and Python grounding regression pass.

- [ ] **Step 9: Commit Task 8**

```bash
git add examples/agently-agent-runtime/test packages/service-node/test/debug-github-capability.e2e.test.ts runtimes/agently-worker/tests/test_assistant.py
git commit -m "test(github): prove Agent query and grounded reply path"
```

---

### Task 9: Documentation, opt-in live smoke and complete verification

**Files:**
- Create: `docs/guides/github-capability-provider.md`
- Modify: `docs/architecture/network-citizens.md`
- Modify: `docs/guides/agently-agent-runtime.md`
- Modify: `deploy/office/README.md`
- Create: `tools/github-provider-smoke.ts`
- Create: `tools/github-provider-smoke.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: standalone Provider scripts and approved capability contracts.
- Produces: operator setup guide, `github-provider:smoke`, documentation contract and final verification evidence.

- [ ] **Step 1: Write failing documentation/smoke contract test**

```ts
expect(guide).toContain("GitHub App");
expect(guide).toContain("Pull requests: Read");
expect(guide).toContain("github.pull_request.list");
expect(guide).toContain("read-only");
expect(guide).toContain("office host remains the sole Feishu long-connection owner");
expect(packageJson.scripts["github-provider:smoke"]).toBe(
  "tsx tools/github-provider-smoke.ts",
);
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `npx vitest run tools/github-provider-smoke.test.ts`

Expected: FAIL because the guide and smoke command are missing.

- [ ] **Step 3: Write the operator guide**

Document:

1. creating a GitHub App;
2. installing it only on approved repositories;
3. the exact read permissions;
4. generating and storing the PEM without putting it in YAML;
5. setting the five required environment values;
6. enabling the YAML plugin;
7. provisioning and starting the standalone Provider;
8. testing with Debug Channel without a Feishu connection conflict;
9. the Feishu question “我们当前未关闭的 PR 都有哪些”；
10. disabling/revoking the App and diagnosing auth, permission, rate-limit,
    empty and truncated outcomes.

- [ ] **Step 4: Add an opt-in live smoke command**

`github-provider:smoke` refuses to run unless
`WORK_FABRIC_GITHUB_LIVE_SMOKE=true`. It loads GitHub App credentials, calls
only identity, repository list and `github.pull_request.list` for an explicitly
configured allowed owner, prints counts and URLs only, and exits nonzero on any
write-capable declaration or secret-shaped output. It never runs under
`npm test` or `npm run verify`.

- [ ] **Step 5: Run focused GitHub verification**

Run:

```bash
npm run typecheck
npx vitest run packages/provider-github/test packages/adapter-github-octokit/test examples/github-capability-provider/test packages/capability-provider-runtime/test/github-loop.integration.test.ts packages/service-node/test/debug-github-capability.e2e.test.ts tools/github-provider-smoke.test.ts
npm run agent-runtime:test-python
```

Expected: all focused TypeScript and Python tests pass without live GitHub or Feishu.

- [ ] **Step 6: Run complete project verification**

Run: `npm run verify && npm run agent-runtime:test-python && git diff --check`

Expected: typecheck, all Vitest suites, WFPP conformance, Python suite and whitespace checks pass.

- [ ] **Step 7: Perform a boundary audit**

Run:

```bash
rg -n "@octokit|github.com|api.github.com" packages/exchange-* packages/service-node/src packages/channel-* packages/connector-feishu
rg -n "create|update|delete|merge|rerun|cancel" packages/provider-github/src/declarations.ts
```

Expected: no Octokit/GitHub dependency appears in Core/Channel/Feishu modules;
no write capability declaration exists. Any English verb occurring only in a
description explaining that mutation is unsupported is manually verified and
recorded in the final handoff.

- [ ] **Step 8: Commit Task 9**

```bash
git add docs package.json tools/github-provider-smoke.ts tools/github-provider-smoke.test.ts
git commit -m "docs(github): add provider setup and read-only smoke guide"
```

- [ ] **Step 9: Request final code review before integration**

Review against:

```text
docs/superpowers/specs/2026-08-02-github-read-only-capability-provider-design.md
docs/superpowers/plans/2026-08-02-github-read-only-capability-provider.md
```

The review must explicitly check project boundary compliance, all twelve
capability contracts, GitHub App credential isolation, no write surface,
pagination/limit correctness, current-evidence grounding, optional deployment
behavior and full verification output.
