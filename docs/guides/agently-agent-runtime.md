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

## Local setup

From the repository root, install the isolated Python worker environment:

```bash
uv sync --project runtimes/agently-worker
```

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

## What to observe

Provisioning creates `actor-intake-agent` / `endpoint-intake-agent` and its SSE Subscription. The current Console **Operations → Deliveries** view shows Delivery operational state and attempts. It does **not** expose raw subscription cursors or Delivery/Status/Result payload bodies. The Console also has no Endpoint/session page. Inspect those omitted operational facts through the public HTTP API or durable SQLite/PostgreSQL state instead:

1. **Console Handoffs** for `offered → accepted → result_returned` and relationships.
2. **HTTP/SQLite/PostgreSQL** for Endpoint registration, active Session, lease, heartbeat, fencing token, Delivery/Ack cursor, Status, and Result payload.
3. **Result** `workfabric.agent/assistant_output`; a proposed downstream Handoff is Result data, not a child Handoff.

To send a request from Feishu, mention the configured bot in an enabled group chat (for example, `@Work Fabric create a requirement`). Admission must accept the external identity, then the collaboration-channel configuration creates the explicitly targeted Intake Handoff. Expect one Delivery Ack, explicit Accept, Status and Result rendered by the configured Feishu outbound route.

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
