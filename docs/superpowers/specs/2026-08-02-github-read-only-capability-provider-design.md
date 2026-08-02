# GitHub Read-Only Capability Provider Design

**Status:** Approved for implementation
**Date:** 2026-08-02

## 1. Purpose

Add an independently deployable GitHub `capability-provider` Citizen so a
decision body such as the Daily Assistant can obtain current GitHub facts,
reason over them, and return a semantic answer through any Channel.

The first user-facing scenario is:

```text
Feishu message
-> Daily Assistant interprets the request
-> GitHub capability Handoff
-> GitHub Provider returns typed current facts
-> Daily Assistant summarizes those facts
-> canonical Result is delivered by the Feishu Channel
```

The Provider is read-only. It does not create, edit, review, close, merge,
rerun, cancel or otherwise mutate GitHub resources.

## 2. Project invariants

The following constraints are non-negotiable:

1. Work Fabric Core owns connection, identity, Authority, Handoff, observable
   collaboration state, Result propagation and audit. It never calls GitHub,
   chooses a capability, interprets a user request or summarizes GitHub data.
2. The GitHub Provider is a `capability-provider` Citizen represented by a
   `system` Actor. It declares and closes only GitHub query responsibilities.
3. The Daily Assistant remains the `decision-body`. It decides whether more
   GitHub evidence is required, publishes the capability request and authors
   the human-facing answer.
4. A Channel verifies and maps external communication, then renders the
   canonical Agent Result. Feishu-specific code does not import GitHub code.
5. The Provider returns typed facts and stable diagnostics. It does not return
   conversational prose or perform model inference.
6. Citizen declarations are runtime facts. YAML enables a trusted Provider and
   establishes security ceilings; YAML is not the live capability catalog.
7. GitHub SDK, GraphQL, MCP, credentials, pagination cursors and rate-limit
   headers remain inside the Provider boundary and never enter Fabric Core.
8. The Agent never receives GitHub credentials or SDK clients and never calls
   GitHub directly, including through a direct MCP connection that bypasses
   Work Fabric.
9. Current capability execution evidence is the only proof of a current GitHub
   query. Conversation history or model prose cannot prove that a query ran.
10. Intent recognition, tool choice and answer production remain model-owned;
    keyword, regular-expression and substring routing are prohibited.

## 3. Scope

### 3.1 Included capabilities

The first release declares these read-only capabilities:

| Declaration ID | Responsibility |
| --- | --- |
| `github.identity.get` | Return the authenticated App installation identity and bounded access summary. |
| `github.repository.list` | List repositories visible within the configured installation and provider policy ceiling. |
| `github.repository.get` | Return bounded metadata for one authorized repository. |
| `github.pull_request.list` | List PRs for one repository, an explicit repository set or one authorized owner. |
| `github.pull_request.get` | Return bounded details for one PR. |
| `github.pull_request.reviews.list` | List submitted reviews and requested reviewers for one PR. |
| `github.pull_request.comments.list` | List issue comments, review comments or both for one PR. |
| `github.pull_request.files.list` | List changed files and bounded change statistics for one PR. |
| `github.pull_request.commits.list` | List commits belonging to one PR. |
| `github.pull_request.checks.get` | Return combined commit status and check-run summary for one PR head. |
| `github.actions.workflow_runs.list` | List bounded workflow runs for one repository with optional filters. |
| `github.commit.list` | List bounded commit metadata for one repository and optional ref/time range. |

### 3.2 Explicitly excluded

- every GitHub write or mutation;
- webhook/event ingestion;
- Issues, Projects, Discussions, Releases, Deployments and security-alert
  capability declarations;
- unrestricted code search or repository-content retrieval;
- cloning repositories or running Git commands;
- GitHub user OAuth and delegated user impersonation;
- Agent-authored repository selection outside disclosed authorized candidates;
- Provider-generated summaries, recommendations, review judgments or priority
  scores;
- direct Agent-to-GitHub MCP or Agent-to-Octokit access;
- changes to Exchange Core state machines or protocol schemas.

## 4. Alternatives considered

### 4.1 Native Provider using Octokit with selective GraphQL

The Provider owns GitHub authentication and exposes Work Fabric capability
contracts. `@octokit/rest` handles ordinary endpoints. A narrow GraphQL client
may optimize owner-wide PR aggregation when one REST request per repository
would be wasteful. Both adapters normalize into the same Provider-owned domain
types. Selected because it gives stable schemas, explicit Authority, bounded
results and full Fabric audit without coupling the public contract to GitHub's
transport.

### 4.2 Direct GitHub MCP access from the Agent

GitHub MCP already offers read-only repository, PR and Actions tools. Direct
access is quick to demonstrate but bypasses Citizen discovery, Handoff,
responsibility transfer and Fabric audit. It also gives an external tool schema
control over the Agent contract. Rejected as a runtime topology.

The official MCP server may later be an internal adapter behind the same
GitHub Provider port. Switching to it must not change declaration IDs, result
schemas or Agent behavior.

### 4.3 Raw HTTP calls in the Agent or Channel

This minimizes package count but leaks credentials, pagination, vendor errors
and rate-limit mechanics into the wrong owners. Rejected.

## 5. Architectural placement

The initial deployment uses one independent Provider process:

```text
GitHub Capability Provider process
  Citizen runtime and leased declaration session
  Capability Handoff consumer
  GitHub query service
  GitHub API port
    Octokit REST adapter
    optional bounded GraphQL aggregation adapter
  GitHub credential provider
```

It may share the office deployment bundle with other processes, but it does not
share a Citizen registration, credential owner, executor or state with the
Feishu Provider. It can be independently enabled, leased, disabled, restarted,
scaled and audited.

| Component | Owns | Does not own |
| --- | --- | --- |
| Fabric | Authority, Handoff, lifecycle facts, Result and audit | GitHub API calls, intent, selection or summarization |
| Daily Assistant | semantic intent, capability selection, follow-up questions and final answer | GitHub credentials, pagination or vendor parsing |
| GitHub Provider | GitHub auth, bounded queries, pagination, normalization and stable errors | conversational prose, tool choice or cross-module orchestration |
| Feishu Channel | trusted ingress, correlation and rendered delivery | GitHub behavior or answer authorship |

## 6. Identity, configuration and credentials

Production authentication uses a GitHub App installation. The App is installed
only on approved owners and repositories and receives read permissions only.
Installation tokens are short-lived and are refreshed inside the credential
provider.

The global configuration Provider exposes a module block equivalent to:

```yaml
plugins:
  github:
    enabled: true
    provider:
      citizen_id: citizen-github-read
      principal_id: principal-github-provider
      actor_id: actor-github-provider
      endpoint_id: endpoint-github-provider
      registration_version: 1
    authentication:
      mode: github_app
      app_id_env: GITHUB_APP_ID
      installation_id_env: GITHUB_APP_INSTALLATION_ID
      private_key_env: GITHUB_APP_PRIVATE_KEY
    cursor_signing_key: ${WORK_FABRIC_GITHUB_CURSOR_SECRET}
    policy:
      allowed_owners: [AgentEra]
      maximum_page_size: 100
      maximum_aggregate_repositories: 100
```

The YAML contains environment-variable names or secret references, not secret
values. The existing
replaceable global Configuration Provider remains the only consumer-facing
configuration boundary. A future database-backed source does not change the
GitHub Provider contract.

A fine-grained read-only PAT mode may exist only in local development
configuration. Office and production profiles reject PAT mode.

Minimum GitHub App repository permissions are selected from:

- Metadata: read;
- Pull requests: read;
- Issues: read, because PR ordinary comments and shared issue metadata use the
  Issues API;
- Checks: read;
- Commit statuses: read;
- Actions: read;
- Contents: read, for bounded commit listing.

The Provider policy ceiling can further narrow the repositories visible to the
App. It can never widen GitHub installation access.

## 7. Capability contracts

All declarations use version `1.0.0`, `application/json`, asynchronous
interaction, low risk and no confirmation. Inputs reject unknown fields and
raw API URLs. Every list uses a bounded `page_size` and opaque Provider cursor.

### 7.1 Repository reference

```ts
interface GitHubRepositoryRef {
  readonly owner: string;
  readonly name: string;
}
```

The Provider canonicalizes this into `github://repository/{owner}/{name}` after
Authority and installation checks. The Agent cannot use a raw repository ID or
URL to bypass policy.

### 7.2 `github.pull_request.list`

Input supports exactly one target mode:

```ts
type GitHubPullRequestListTarget =
  | { repository: GitHubRepositoryRef }
  | { repositories: readonly GitHubRepositoryRef[] }
  | { owner: string };

interface GitHubPullRequestListInput {
  readonly target: GitHubPullRequestListTarget;
  readonly state?: "open" | "closed" | "all";
  readonly author?: string;
  readonly reviewer?: string;
  readonly assignee?: string;
  readonly labels?: readonly string[];
  readonly draft?: boolean;
  readonly base_branch?: string;
  readonly updated_since?: string;
  readonly page_size?: number;
  readonly cursor?: string;
}
```

Each returned item contains repository reference, PR number, title, GitHub URL,
author, draft flag, base/head branches, assignees, requested reviewers, labels,
review state when available, CI state when requested by the dedicated checks
capability, mergeability when GitHub has computed it, and creation/update time.

The list capability does not silently make N+1 detail, review or check calls.
The Agent requests richer facts through their dedicated declarations when
needed. Owner-wide aggregation may use GraphQL internally and returns one
deterministic cursor across the normalized result.

### 7.3 Detail capabilities

- `github.pull_request.get` returns one bounded PR record and body preview with
  `body_truncated` plus an authorized PR reference.
- review and comment capabilities return actor, state/type, timestamps, bounded
  text previews, stable GitHub links and pagination.
- files return path, change status, additions, deletions and changes; patches
  are excluded from phase one.
- commits return SHA, bounded subject, authorship, verification and timestamp;
  complete commit messages are excluded.
- checks return a normalized aggregate plus individual check name, status,
  conclusion, started/completed time and GitHub target URL.
- workflow runs return workflow name, run number, event, branch, head SHA,
  actor, status, conclusion, timestamps and GitHub URL. Logs and artifacts are
  excluded.

## 8. Evidence and result semantics

Every successful Result includes:

```ts
interface GitHubEvidenceMeta {
  readonly provider: "github";
  readonly fetched_at: string;
  readonly installation_id_hash: string;
  readonly api_version: string;
  readonly query_scope: readonly string[];
  readonly complete: boolean;
  readonly next_cursor?: string;
}
```

The installation ID is represented only by a non-reversible deployment-local
hash. Tokens, private keys, response headers and internal request URLs never
enter evidence.

Result states remain distinct:

- `complete`: the requested bounded page is complete;
- `truncated`: a declared item/byte/repository ceiling stopped aggregation;
- `empty`: the query succeeded and found no matching item;
- `failed`: no trusted current evidence was produced.

The Agent receives only the current invocation Result as execution proof. It
must not infer that a query ran from an older conversation message. Links in
the final Agent response are normal GitHub HTTPS links from authorized result
items and are rendered by the destination Channel.

## 9. Errors, rate limits and retries

The Provider maps GitHub failures into stable diagnostic codes:

```text
github_invalid_request
github_authentication_failed
github_forbidden
github_repository_not_found
github_pull_request_not_found
github_rate_limited
github_upstream_unavailable
github_response_invalid
github_result_truncated
```

`github_rate_limited` includes a safe `retry_at` timestamp when GitHub supplies
one. The Provider performs bounded retries only for idempotent reads and only
for transient transport/5xx failures within the Handoff deadline. It does not
retry authentication, authorization, validation, not-found or exhausted-rate
limit responses.

The first release uses no persistent business-data cache. Request-local
deduplication may collapse identical reads within one accepted capability
Handoff. A later conditional-request cache must preserve GitHub ETag, freshness
and evidence semantics behind the Provider port.

## 10. Agently request topology

This feature adds no workflow engine and no new stable orchestration graph. It
extends the existing bounded Agent capability loop.

### 10.1 Owner and invariant ledger

| Decision/fact/effect | Owner | Invariant |
| --- | --- | --- |
| Does the user need GitHub data? | Daily Assistant ModelRequest | Semantic decision; no lexical routing. |
| Which disclosed capability and arguments? | Daily Assistant ModelRequest | Selection is constrained to authorized declarations. |
| Is the repository/query authorized? | GitHub Provider host code | Deterministic and fail-closed. |
| GitHub API execution | GitHub Provider | Typed current evidence or stable failure. |
| Human-facing summary | Daily Assistant continuation ModelRequest | Grounded only in current result. |
| Delivery formatting | Channel | No semantic rewriting. |

### 10.2 Planned node ledger

| Node | Owner | Input | Output |
| --- | --- | --- | --- |
| `assistant_decide` | Daily Assistant | current user message, bounded conversation context, disclosed declarations | capability request or final answer |
| `github_execute` | GitHub Provider host | accepted capability Handoff and Authority | typed Result plus evidence metadata |
| `assistant_continue` | Daily Assistant | original task, current capability transcript and current Result | grounded semantic response or another bounded query request |

### 10.3 Planned edge ledger

| From | To | Contract |
| --- | --- | --- |
| `assistant_decide` | Fabric Handoff | validated capability ID and typed arguments |
| Fabric Delivery | `github_execute` | authorized, accepted auxiliary Handoff |
| `github_execute` | Fabric Result | typed facts, evidence state and stable diagnostic |
| Fabric Delivery | `assistant_continue` | current invocation transcript only |
| `assistant_continue` | Feishu Channel | canonical Agent-authored markdown/text Result |

### 10.4 Production-necessity ledger

| Element | Why it is required |
| --- | --- |
| Independent GitHub Citizen | Separate identity, Authority, lifecycle and audit from Agent and Feishu. |
| Provider normalization | Prevent vendor schemas and pagination from leaking into Agent contracts. |
| Agent continuation request | GitHub observations arrive after the first model request and must inform a later semantic answer. |
| Current evidence metadata | Distinguish an executed current read from history or an unsupported claim. |
| Bounded pagination | Prevent unbounded context, latency and API fan-out. |

## 11. Observability and audit

Provider logs and metrics include capability ID, tenant, citizen, Handoff,
repository scope, item count, pagination/truncation state, GitHub request ID
when safe, latency, retry count, rate-limit remaining bucket and terminal code.
They exclude credentials, request authorization headers, private keys, raw
response bodies and PR/comment content.

Fabric continues to record only protocol-level Handoff, claim/accept, status,
Result and event facts. It does not acquire GitHub-specific persistence.

## 12. Acceptance criteria

1. The Provider registers one independently leased `capability-provider`
   Citizen and dynamically declares exactly the twelve read-only capabilities.
2. No declaration or execution path exposes a GitHub write operation.
3. GitHub App credentials remain behind the Provider credential port and are
   redacted from logs, errors, Results and Console data.
4. An Agent request equivalent to “当前未关闭的 PR 有哪些” can query one
   configured owner, receive bounded typed PR facts, and return an Agent-authored
   answer containing clickable GitHub links through the Feishu Channel.
5. Empty, failed, forbidden, rate-limited and truncated responses remain
   distinguishable to the Agent.
6. Repository, multi-repository and owner-wide pagination are deterministic,
   bounded and covered by tests.
7. The Provider rejects repositories outside the GitHub installation or local
   policy ceiling before returning content.
8. Unit tests cover every capability contract, normalization, credentials,
   error mapping, pagination and redaction boundary.
9. A deterministic Debug Channel end-to-end test proves message -> Agent ->
   GitHub Provider -> Agent Result without using Feishu or live GitHub.
10. An opt-in live GitHub integration test proves read-only access using a test
    installation and never runs in the default test suite.
11. Existing Feishu, Agent, Citizen, capability and full verification suites
    continue to pass without Core protocol changes.

## 13. Deferred extensions

Later increments may add independently reviewed read-only capability groups for
Issues/Projects, repository contents/search, Releases/Deployments, security
alerts and GitHub event ingestion. Every write capability requires a separate
design with explicit Authority, confirmation, idempotency and external-outcome
handling; write permissions are not enabled by extending this Provider's first
release configuration.
