# Task 9 report — Daily Assistant Runtime composition

## Delivered

- Added an independently runnable Agently Daily Assistant Runtime, endpoint provisioning command, sample Runtime YAML, and secret-free environment template.
- The Runtime uses the public SDK and Agent Gateway only, keeps Work Fabric state separate in SQLite, validates its owned workspace root, and recovers persisted state before subscribing for intake.
- Added the exact local Runtime grant, a separate admin provisioning principal/rule, and preserved Feishu intake routing to the Runtime actor/endpoint.
- Extended Runtime configuration validation for the deployment profile's explicit denial-oriented acceptance settings and SQLite timeout.

## Verification

- `npm ci --ignore-scripts`
- `npx vitest run examples/agently-agent-runtime/test packages/agent-runtime-host/test/config.test.ts packages/service-node/test/global-configuration.test.ts --testNamePattern='(Daily Assistant Runtime composition|loadAgentRuntimeConfiguration|loads the runnable SQLite Feishu)'` — 10 passed.
- `npm run typecheck` — passed.
- `UV_CACHE_DIR=/tmp/work-fabric-uv-cache npm run agent-runtime:test-python` — 19 passed.
- `git diff --check` — passed.

The full global configuration test was also attempted. Its isolated service-start case could not create tsx's local IPC socket under the sandbox (`EPERM`); the required elevated rerun was automatically rejected by the environment usage limit. This is an execution-environment limitation, not a test assertion failure.
