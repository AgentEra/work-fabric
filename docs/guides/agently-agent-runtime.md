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

Install the isolated Python worker environment:

```bash
uv sync --project runtimes/agently-worker
```

Put secrets outside the repository. A local shell or ignored `.env` may declare names only:

```bash
AGENTLY_MODEL_API_KEY=
WF_BASE_URL=
WF_ACCESS_TOKEN=
```

Service YAML owns Work Fabric storage, identities, Authority, HTTP listener, Connector and Feishu configuration. Runtime YAML owns only the worker executable, workspace root, timeout, provider base URL/model, and runtime-local concurrency. Do not copy model credentials into service YAML, Handoff data, Results, SQLite, logs, or task JSON.

Provision the Endpoint before starting the Runtime:

```bash
npm run service:start -- --config ./service.yaml
npm run agent-runtime:provision
npm run agent-runtime:start -- --config ./runtime.yaml
```

For a complete local operator flow start, in order: Service, Runtime, Console, then the Feishu connector/long connection. The Runtime uses a fresh client-session ID for each process start; do not reuse a fenced session ID.

## What to observe

Provisioning creates `actor-intake-agent` / `endpoint-intake-agent` and its SSE Subscription. In Console, inspect:

1. **Endpoints** for registration, active Session, lease, heartbeat and fencing token.
2. **Deliveries** for the endpoint Subscription, Delivery ID, cursor and explicit Ack.
3. **Handoffs** for `offered → accepted → result_returned`.
4. **Status** for the Runtime's `Agent Runtime started` and progress updates.
5. **Result** for `workfabric.agent/assistant_output`; a proposed downstream Handoff is Result data, not a child Handoff.

To send a request from Feishu, mention the configured bot in an enabled group chat (for example, `@Work Fabric create a requirement`). Admission must accept the external identity, then the collaboration-channel configuration creates the explicitly targeted Intake Handoff. Expect one Delivery Ack, explicit Accept, Status and Result rendered by the configured Feishu outbound route.

## Verification and smoke test

The deterministic release check uses only SQLite, public HTTP/SSE, the real Python worker, and a loopback OpenAI-compatible streaming fake—never Feishu or a model network:

```bash
npm run verify:agent-runtime
npx vitest run packages/agent-runtime-host/test/agently-daily-assistant.e2e.test.ts
```

An opt-in real-model smoke test is manual and non-destructive. Copy Runtime YAML outside source control, set a chosen non-secret `provider.base_url` and `provider.model`, then explicitly provide a rotated credential:

```bash
export AGENTLY_MODEL_API_KEY=rotated-secret
npm run agent-runtime:start -- --config ./runtime.yaml
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
