# GitHub read-only Capability Provider

The GitHub Capability Provider is an independent `capability-provider` Citizen.
It owns GitHub App installation authentication, repository policy, bounded
queries, signed cursors, normalized evidence, and stable diagnostics. Work
Fabric owns only connection, identity and Authority checks, Handoff delivery,
shallow lifecycle state, Result carriage, and audit. The Daily Assistant is the
semantic owner: it selects a disclosed capability, decides whether another page
matters, and authors the final answer. A Channel is transport and rendering
only. In particular, the office host remains the sole Feishu long-connection owner.

This Provider is strictly read-only. It has no PAT, user OAuth, webhook, clone,
raw HTTP, MCP, mutation, workflow control, merge, or repository-content surface.
GitHub and Octokit credentials never enter YAML, Handoffs, Results, Agent
transcripts, Channel payloads, Console data, or logs.

## 1. Create and restrict the GitHub App

In the approved GitHub organization, open **Settings → Developer settings →
GitHub Apps → New GitHub App**. Give the App a deployment-specific name and
homepage URL. Disable webhook delivery; this Provider polls only when an
authorized capability Handoff arrives. Do not enable OAuth or request account
permissions.

Configure exactly these repository permissions:

- Metadata: Read
- Pull requests: Read
- Issues: Read (ordinary PR comments use the Issues API)
- Checks: Read
- Commit statuses: Read
- Actions: Read
- Contents: Read (bounded commit listing only)

Select **Only on this account**. After creating the App, choose **Install App**
and install it only on the approved repositories. Never select all repositories
unless the entire installation is intentionally within the deployment policy.
The YAML `allowed_owners` / `allowed_repositories` ceiling must be equal to or
narrower than the installation; it cannot widen GitHub access.

Record the numeric App ID and installation ID. Generate one private key, move
the downloaded PEM outside the repository, and restrict it to the service
account:

```bash
mkdir -p "$HOME/.config/work-fabric/github"
mv /path/from/browser/*.private-key.pem \
  "$HOME/.config/work-fabric/github/provider.private-key.pem"
chmod 600 "$HOME/.config/work-fabric/github/provider.private-key.pem"
```

Never paste the PEM or another resolved secret into YAML. Rotate the PEM if it
has appeared in shell history, source control, logs, a Handoff, or Console data.

## 2. Configure the standalone Provider

Use a deployment-owned copy of
`examples/config/local-feishu-assistant.bundle.yaml`. In
`applications.github-provider.plugins.instances.github-primary`, change
`enabled: false` to `enabled: true`; set the approved `allowed_owners` and, when
needed, the narrower `allowed_repositories`. Keep `authentication.mode:
github_app` and the three environment-variable names. Production configuration
must not add a PAT fallback.

Set these six required environment values for the local provision-and-start
flow. The first five belong to the Provider process; the administrative token
is consumed only by the explicit provisioning step:

```bash
export GITHUB_APP_ID='123456'
export GITHUB_APP_INSTALLATION_ID='7890123'
export GITHUB_APP_PRIVATE_KEY="$(cat "$HOME/.config/work-fabric/github/provider.private-key.pem")"
export GITHUB_PROVIDER_ACCESS_TOKEN='rotated-provider-fabric-token'
export WORK_FABRIC_GITHUB_CURSOR_SECRET="$(openssl rand -hex 32)"
export WORK_FABRIC_ADMIN_TOKEN='rotated-work-fabric-admin-token'
```

`GITHUB_PROVIDER_ACCESS_TOKEN` is the Provider's Work Fabric service token, not
a GitHub token. `WORK_FABRIC_ADMIN_TOKEN` is the Work Fabric provisioning
credential and must not be exposed to the Provider child process after
provisioning. Store all six in the platform secret manager or a mode-`0600`
environment file outside the repository. Also select the non-secret bundle and
application view:

```bash
export WORK_FABRIC_CONFIG=/absolute/path/to/deployment.bundle.yaml
export WORK_FABRIC_GITHUB_PROVIDER_CONFIG_APPLICATION=github-provider
```

The Work Fabric Service must already be running with the matching Endpoint,
Citizen, subscription, identities, Authority grants, and Agent `github.`
namespace ceiling from the bundle. Provisioning is an explicit administrative
step; starting the process does not provision implicitly:

```bash
npm run github-provider:provision
npm run github-provider:start
```

The local launcher reads the mode-`0600` environment file only while preparing
and provisioning. Before spawning the standalone Provider it constructs a
minimal allowlist containing basic process/network variables, the
GitHub-specific configuration view, and the exact secret variable names
declared by that Provider configuration. It never forwards
`WORK_FABRIC_ENV_FILE`, `WORK_FABRIC_ADMIN_TOKEN`, Feishu credentials, model
credentials, or unrelated environment-file secrets.

The Provider is a standalone process and system Citizen even when packaged in
the same VM or image as the Service, Agent, or Channel. It owns no Feishu
connection and can be disabled without changing Core, the Agent Runtime, or any
Channel.

## 3. Approved capability surface

Version `1.0.0` exposes exactly these twelve low-risk, no-confirmation reads:

1. `github.identity.get`
2. `github.repository.list`
3. `github.repository.get`
4. `github.pull_request.list`
5. `github.pull_request.get`
6. `github.pull_request.reviews.list`
7. `github.pull_request.comments.list`
8. `github.pull_request.files.list`
9. `github.pull_request.commits.list`
10. `github.pull_request.checks.get`
11. `github.actions.workflow_runs.list`
12. `github.commit.list`

Inputs reject unknown fields and raw API URLs. Repository references are
policy-checked owner/name pairs. List calls have bounded `page_size` values and
opaque signed cursors. The Provider returns typed current facts, safe GitHub
links, evidence metadata, and stable errors—not prose, priorities, review
judgments, or tool-selection decisions.

The first usable release deliberately defaults every list to five items and
rejects `page_size` values or Provider policy ceilings above `5`. When more
facts are relevant, the Agent follows `evidence.next_cursor` one bounded page
at a time. Normal text is limited to 512 UTF-8 bytes, body/comment/review
previews to 1024 bytes, repeated record fields such as topics, labels,
assignees and requested reviewers to 10 values, and a check summary to 20
combined statuses/check runs. These conservative static bounds keep every
successful capability Result below the unified Agent's 128 KiB input ceiling.
The Provider also applies a shared 122,880-byte serialized-data guard immediately
before Citizen JSON cloning, leaving protocol/transcript headroom. An upstream
record outside a field bound fails as `github_response_invalid`; a result that
cannot be JSON-stringified or exceeds the final byte guard fails as
`github_result_truncated`, never as a generic upstream failure.

`github.identity.get` reports the App identity plus the bounded installation
repository count. `github.repository.list` is always filtered by the Provider
policy ceiling even when the App installation can see more repositories.
Pull-request records include both the display `head_branch` and immutable
`head_sha`; check reads use the SHA. Evidence uses GitHub REST API version
`2022-11-28`, and its installation label is an HMAC-SHA-256 value derived from
deployment-local secret material with domain separation.

## 4. Debug and end-to-end testing

Use the deterministic Debug Channel E2E for routine testing. It composes the
real Provider/Agent/Handoff path with an injected fake GitHub API, so it needs no
GitHub or Feishu network connection:

```bash
npx vitest run packages/service-node/test/github-capability-provider.e2e.test.ts \
  packages/service-node/test/debug-github-capability.e2e.test.ts
```

For an interactive Debug Channel deployment, use a deployment bundle whose
Channel application is `local-debug` and copy the GitHub Citizen, Authority,
Agent namespace, and `github-provider` application sections from the unified
bundle. Start `npm run local:debug:start`, then provision/start the standalone
Provider in another terminal. Do not start `local:feishu:start` or any second
Feishu connector while the office deployment is active. This keeps Debug
Channel transport separate while the office host remains the sole Feishu
long-connection owner.

After deterministic testing, a Feishu operator can ask:

```text
我们当前未关闭的 PR 都有哪些
```

The Agent should select `github.pull_request.list` with `state: "open"`, use
only the current successful Result as evidence, and author a concise response
with authorized GitHub links. Fabric and the Feishu Channel must not synthesize
or repair that response.

## 5. Opt-in live smoke

The live smoke performs only `github.identity.get`,
`github.repository.list`, and one owner-scoped open
`github.pull_request.list`. It prints a JSON object containing counts and
authorized public GitHub URLs only. It rejects undeclared/write-capable
surfaces, non-public or cross-owner URLs, URL credentials/query strings, and
secret-shaped output.

Use a production-style GitHub App configuration with one enabled Provider,
export the five Provider-owned values above (the admin token is not needed for
this read-only smoke), and explicitly name an owner already present in the
Provider policy:

```bash
export WORK_FABRIC_GITHUB_LIVE_SMOKE=true
export WORK_FABRIC_GITHUB_SMOKE_ALLOWED_OWNER=AgentEra
npm run github-provider:smoke
```

Without the exact opt-in value, explicit owner, configuration, and GitHub App
credentials, the command exits nonzero before making a network call. It is not
part of `npm test`, `npm run verify`, or CI. Do not run it against an App that
has write permissions.

## 6. Outcomes and diagnosis

| Outcome | Meaning and operator action |
|---|---|
| `github_authentication_failed` | App ID, installation ID, PEM format, key rotation, and App installation do not agree. Correct credentials; do not retry blindly. |
| `github_forbidden` | Provider policy, invocation Authority, selected-repository installation scope, or one of the exact read permissions denied the query. Fix the responsible layer deliberately; do not widen the ceiling to hide a configuration error. |
| `github_repository_not_found` / `github_pull_request_not_found` | The approved resource no longer exists or is not visible to this installation. |
| `github_rate_limited` | Stop retrying until the safe `retry_at` time. The Provider maps the vendor limit without exposing headers or credentials. |
| `github_upstream_unavailable` | A transient GitHub/network failure occurred. Retry only according to the bounded Provider policy. |
| `github_response_invalid` | GitHub returned malformed, incomplete, or over-limit data outside the Provider's normalized contract. Preserve safe diagnostics and investigate the adapter. |
| `github_result_truncated` | The normalized result could not fit the Provider's 122,880-byte serialized-data budget. Narrow the repository scope or filters; this is not an upstream availability failure. |
| `empty` | The query succeeded and found no matching item. Report “none found”; do not treat it as auth failure. |
| `truncated` | More data exists after the current five-item page. `evidence.complete` is false and `next_cursor` is opaque; only the Agent decides whether another bounded page is relevant. |

Safe investigation uses capability ID, installation hash, authorized query
scope, terminal code, `fetched_at`, completeness, and low-cardinality timing.
Never log the PEM, tokens, raw Authorization headers, cursor signing key, raw
vendor response body, private repository text, or full invocation input/output.

## 7. Disable, rotate, and revoke

To suspend access, first set the GitHub plugin `enabled: false`, stop the
standalone Provider, and remove/disable its Work Fabric Authority. Confirm the
Citizen lease expires and no GitHub capability is discoverable. Then uninstall
the GitHub App from the organization or remove its selected repositories,
delete the private key in GitHub, and delete the PEM and five Provider-owned
deployment secrets from the secret manager. Rotate the Work Fabric Provider token and
cursor key before any later re-enable. Disabling this optional Citizen must not
interrupt the Agent, Core, Debug Channel, or the office Feishu connection.
