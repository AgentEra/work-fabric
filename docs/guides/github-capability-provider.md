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

Set these five required environment values in the Provider process environment:

```bash
export GITHUB_APP_ID='123456'
export GITHUB_APP_INSTALLATION_ID='7890123'
export GITHUB_APP_PRIVATE_KEY="$(cat "$HOME/.config/work-fabric/github/provider.private-key.pem")"
export GITHUB_PROVIDER_ACCESS_TOKEN='rotated-provider-fabric-token'
export WORK_FABRIC_GITHUB_CURSOR_SECRET="$(openssl rand -hex 32)"
```

`GITHUB_PROVIDER_ACCESS_TOKEN` is the Provider's Work Fabric service token, not
a GitHub token. Store all five in the platform secret manager or a mode-`0600`
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
export the five values above, and explicitly name an owner already present in
the Provider policy:

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
| `github_response_invalid` | GitHub returned data outside the Provider's normalized contract. Preserve safe diagnostics and investigate the adapter. |
| `github_result_truncated` | Owner-wide aggregation exceeded the Provider's configured repository ceiling before it could form a valid page. Narrow the target or adjust the reviewed ceiling. |
| `empty` | The query succeeded and found no matching item. Report “none found”; do not treat it as auth failure. |
| `truncated` | The response reached a declared item/page/repository ceiling. `evidence.complete` is false and `next_cursor` is opaque; only the Agent decides whether another bounded page is relevant. |

Safe investigation uses capability ID, installation hash, authorized query
scope, terminal code, `fetched_at`, completeness, and low-cardinality timing.
Never log the PEM, tokens, raw Authorization headers, cursor signing key, raw
vendor response body, private repository text, or full invocation input/output.

## 7. Disable, rotate, and revoke

To suspend access, first set the GitHub plugin `enabled: false`, stop the
standalone Provider, and remove/disable its Work Fabric Authority. Confirm the
Citizen lease expires and no GitHub capability is discoverable. Then uninstall
the GitHub App from the organization or remove its selected repositories,
delete the private key in GitHub, and delete the PEM and five deployment
secrets from the secret manager. Rotate the Work Fabric Provider token and
cursor key before any later re-enable. Disabling this optional Citizen must not
interrupt the Agent, Core, Debug Channel, or the office Feishu connection.
