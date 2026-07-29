# Agently Daily Assistant Runtime

The Daily Assistant is an **external Runtime Host**. Work Fabric Core remains the protocol, authority, Handoff and durable-delivery system; it does not run models, choose tools, retain agent memory, or execute the assistant. The Runtime Host consumes a delivered Handoff through the public SDK, persists and acknowledges its Delivery, explicitly accepts responsibility, runs the Agently worker, then reports Status and returns a Result.

## Identity and authority

| Concept | Meaning in this deployment |
|---|---|
| Principal | authenticated service identity, for example `principal-intake-agent` |
| Actor | collaboration participant, `actor-intake-agent` |
| Endpoint | fenced, leased technical address, `endpoint-intake-agent` |
| Role | Runtime-local behavior profile, `daily-assistant` |
| Capability | declared callable ability such as `information.synthesis` |
| Authority | scoped permission to read, accept, report on, and return a targeted Handoff |

The local static bearer tokens used in examples are development-only fixtures. Use a real Identity and Authority provider in shared environments. Rotate any Feishu App Secret or model key that has ever been exposed before using it again.

For document capabilities, the accepted original Handoff must explicitly
permit the relevant `document:*` scope and redelegation. The local Invocation
Authority derives a narrower, non-redelegable child grant and preserves the
original Human as `represented_actor_id`; the Agent cannot supply or override
that identity. The document Provider then checks the connected system's native
ACL through its deployment-injected identity broker.

The unified local bundle temporarily supports an explicitly unsafe
application-identity document adapter so real Feishu creation can be tested
before represented-user OAuth is available. It is selected and guarded in the
Feishu Provider composition, not in the Agent Runtime. The Agent still receives
no Feishu credential and still needs the original delegated document scope.

## Local setup

From the repository root, install the isolated Python worker environment:

```bash
uv sync --project runtimes/agently-worker
```

For the complete Feishu → Daily Assistant → Feishu document path, prefer the
single bundle and Supervisor documented in
[Feishu Capability / Context Provider](feishu-capability-provider.md#7-本地整套启动):

```bash
export WORK_FABRIC_ENV_FILE=/absolute/path/to/feishu.env
export WORK_FABRIC_CONFIG="$PWD/examples/config/local-feishu-assistant.bundle.yaml"
export WORK_FABRIC_ALLOW_UNSAFE_DOCUMENT_ACCESS=true
npm run local:feishu:start
```

The older two-file commands below remain useful for isolating the Service or
Agent Runtime. They do not start the independent capability Provider.

Service YAML owns Work Fabric storage, identities, Authority, HTTP listener, Connector and Feishu configuration. Runtime YAML owns the Work Fabric connection, Runtime participant, role/capabilities, acceptance policy, concurrency, Runtime State, worker executable/workspace/timeout, and model provider. Do not copy model credentials into service YAML, Handoff data, Results, SQLite, logs, or task JSON.

Provision the Endpoint before starting the Runtime. The shipped scripts read
environment variables only; command-line configuration overrides are
unsupported. Generate one shared environment file outside the repository, then
source that exact file in every terminal. This keeps the Service identity and
Runtime client on the same `INTAKE_AGENT_ACCESS_TOKEN`; do not independently
generate tokens per terminal. The following creates `$HOME/.config` file with
owner-only permissions and never puts a real secret in this guide:

```bash
REPOSITORY_ROOT="$(git rev-parse --show-toplevel)"
WORK_FABRIC_SHARED_ENV="$HOME/.config/work-fabric/agently-daily-assistant.env"

if [ ! -f "$WORK_FABRIC_SHARED_ENV" ]; then
  mkdir -p "$(dirname "$WORK_FABRIC_SHARED_ENV")"
  (
    umask 077
    {
      printf 'export REPOSITORY_ROOT=%q\n' "$REPOSITORY_ROOT"
      printf '%s\n' 'export WORK_FABRIC_CONFIG="$REPOSITORY_ROOT/examples/config/service-feishu-long-connection.yaml"'
      printf '%s\n' 'export WORK_FABRIC_AGENT_RUNTIME_CONFIG="$REPOSITORY_ROOT/examples/config/agent-runtime-agently.yaml"'
      printf 'export WORK_FABRIC_CURSOR_SECRET=%q\n' "$(openssl rand -hex 32)"
      printf 'export WORK_FABRIC_ADMISSION_FINGERPRINT_KEY=%q\n' "$(openssl rand -hex 32)"
      printf 'export WORK_FABRIC_ADMISSION_GRANT_KEY=%q\n' "$(openssl rand -hex 32)"
      printf 'export WORK_FABRIC_ADMIN_TOKEN=%q\n' "$(openssl rand -hex 32)"
      printf 'export INTAKE_AGENT_ACCESS_TOKEN=%q\n' "$(openssl rand -hex 32)"
      printf '%s\n' 'export FEISHU_APP_ID=REPLACE_WITH_FEISHU_APP_ID'
      printf '%s\n' 'export FEISHU_APP_SECRET=REPLACE_WITH_FEISHU_APP_SECRET'
      printf 'export FEISHU_CONNECTOR_ACCESS_TOKEN=%q\n' "$(openssl rand -hex 32)"
      printf '%s\n' 'export AGENTLY_MODEL_API_KEY=REPLACE_WITH_MODEL_API_KEY'
    } > "$WORK_FABRIC_SHARED_ENV"
  )
  printf 'Created %s; replace the three REPLACE_WITH_* values before use.\n' "$WORK_FABRIC_SHARED_ENV"
fi

source "$WORK_FABRIC_SHARED_ENV"
```

### Terminal 1 — Service

```bash
WORK_FABRIC_SHARED_ENV="$HOME/.config/work-fabric/agently-daily-assistant.env"
source "$WORK_FABRIC_SHARED_ENV"
cd "$REPOSITORY_ROOT"
npm run service:start
```

### Terminal 2 — Runtime

```bash
WORK_FABRIC_SHARED_ENV="$HOME/.config/work-fabric/agently-daily-assistant.env"
source "$WORK_FABRIC_SHARED_ENV"
cd "$REPOSITORY_ROOT"
npm run agent-runtime:provision
npm run agent-runtime:start
```

The Feishu long connection is started by the configured Service plugin; it is
not a separate process to start after the Console. Start the optional Console
in a third terminal with `npm run console:dev`, then open the URL printed by
Vite. The Runtime uses a fresh client-session ID for each process start; do not
reuse a fenced session ID.

When using the unified local bundle, `local:feishu:start` owns the Service,
Provider and Agent process lifecycle. Do not also start the two manual
terminals against the same SQLite files.

## What to observe

Provisioning creates `actor-intake-agent` / `endpoint-intake-agent` and its SSE Subscription. The current Console **Operations → Deliveries** view shows Delivery operational state and attempts. It does **not** expose raw subscription cursors or Delivery/Status/Result payload bodies. The Console also has no Endpoint/session page. Inspect those omitted operational facts through the public HTTP API or durable SQLite/PostgreSQL state instead:

1. **Console Handoffs** for `offered → accepted → result_returned` and relationships.
2. **HTTP/SQLite/PostgreSQL** for Endpoint registration, active Session, lease, heartbeat, fencing token, Delivery/Ack cursor, Status, and Result payload.
3. **Result** `workfabric.agent/assistant_output`; a proposed downstream Handoff is Result data, not a child Handoff.

To send a request from Feishu, mention the configured bot in an enabled group chat (for example, `@Work Fabric create a requirement`). Admission must accept the external identity, then the collaboration-channel configuration creates the explicitly targeted Intake Handoff. Expect one Delivery Ack, explicit Accept and queryable Status events. The original conversation receives only the Agent-authored text from the canonical Result; it does not receive Offered, Accepted or Status cards. Static operational subscriptions remain independently configurable.

## Verification and smoke test

The deterministic release check uses only SQLite, public HTTP/SSE, the real Python worker, and a loopback OpenAI-compatible streaming fake—never Feishu or a model network:

```bash
npm run verify:agent-runtime
npx vitest run examples/agently-agent-runtime/test/agently-daily-assistant.e2e.test.ts
```

An opt-in real-model smoke test is manual and non-destructive. Copy Runtime YAML
outside source control, set a chosen non-secret `provider.base_url` and
`provider.model`, point the Runtime at that absolute copy, then explicitly
provide a rotated credential:

```bash
mkdir -p "$HOME/.config/work-fabric"
cp "$REPOSITORY_ROOT/examples/config/agent-runtime-agently.yaml" "$HOME/.config/work-fabric/agent-runtime.yaml"
# Edit provider.base_url and provider.model in $HOME/.config/work-fabric/agent-runtime.yaml.
export WORK_FABRIC_AGENT_RUNTIME_CONFIG="$HOME/.config/work-fabric/agent-runtime.yaml"
export AGENTLY_MODEL_API_KEY=rotated-secret
npm run agent-runtime:start
```

Submit one `information.synthesis` Handoff, confirm Status and Result, then remove the credential. This path is not CI and must not enable Actions or external mutations.

## Troubleshooting

| Symptom | Check |
|---|---|
| Timeout or failed Run | Worker timeout, Python environment, provider streaming compatibility, and the Runtime's failed state; the worker process is terminated on timeout/cancel. |
| Authority denial | Principal/Actor/Endpoint representation, Runtime Authority grant, target and current responsible Actor. A non-targeted Actor must not read or execute the Handoff. |
| Endpoint fenced | Start a new Runtime process/session; do not reuse a stale fencing token or client session ID. |
| Missing Delivery | Endpoint registration, active Session, Inbox projection, Subscription and SSE Ack cursor. |
| SQLite recovery | Keep Service SQLite and Runtime-State SQLite separate; inspect durable deliveries/runs before deleting either. |
| Unexpected workspace files | Workspace paths are isolated by tenant and Handoff. Remove only the affected Runtime workspace after preserving required evidence. |

The future Memory Provider is deliberately not implemented here. It must remain separate from Runtime State: Runtime State stores Delivery idempotency, runs and result recovery, while a future memory system needs its own authorization, retention and provenance design.

## Capability invocation

The capability-aware protocol is opt-in. With
`service.capability_invocation.enabled: true`, the composition root must inject
an `InvocationAuthorityProvider`, immutable Schema registry/validator and
auxiliary-Handoff waiter, and the Driver must implement `executeTurn`.
One-shot protocol-v1 Drivers keep their existing path.

The Host permits only configured namespaces and applies separate total-call,
query-call and cumulative query-result-byte budgets. Each call discovers a
current Citizen declaration, freezes the
Citizen/Endpoint/version/Contract digest, creates a standard auxiliary Handoff
and persists its lifecycle. The Daily Assistant remains responsible for the
original Handoff while waiting and alone authors the final response. Provider
facts and errors are retained in a bounded invocation transcript and remain
untrusted evidence, not instructions. A `query capability` is read-only
evidence: the Agent may request another page only when `has_more` is true and
the missing information matters to the current intent. Historical evidence
cannot independently authorize a command.

Post-capability completion is also owned by the Daily Assistant boundary. The
worker first asks the configured model to turn validated continuation facts
into a semantic Result. That second model call has a shorter bound than the
outer Driver deadline; if it does not complete in time, the worker returns a
minimal semantic Result from the validated intent, title, safe HTTP(S) result
link and typed artifacts. The fallback never copies Provider error text or
vendor payloads. Fabric, the Provider and Channel Adapter neither compose nor
repair the user-facing reply.

For Feishu message/document operations, use the independent Provider described
in [飞书 Capability / Context Provider](feishu-capability-provider.md). The
Agent Runtime must never receive Feishu credentials or import the Feishu
OpenAPI backend.
