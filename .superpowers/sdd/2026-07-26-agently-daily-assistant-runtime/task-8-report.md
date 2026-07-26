# Task 8 Report: Agently Python Worker

## Delivered

- Added the independent, locked Python worker at `runtimes/agently-worker`.
- Enforced the `workfabric.agent-runtime/1` request and NDJSON record protocol with exact keys, depth/node/string/output bounds, fail-closed result validation, and recursive rejection of secret-named task fields.
- Added the one-request async Agently execution path, explicit Host-supplied Workspace binding, deterministic role/task prompts, strict structured output validation, and no Work Fabric dispatch or Actions usage.
- Kept standard output to bounded NDJSON records and diagnostics to bounded, redacted stderr text. Model output containing the environment secret fails closed.
- Generated `uv.lock` with `agently==4.1.4.1`, `pytest==9.1.1`, and `pytest-asyncio==1.4.0`.

## Verification

- `uv run pytest -q` — 11 passed; tests use a fake Agent boundary and make no model/network call.
- `uv build` — source distribution and wheel built.
- Installed the wheel in `/private/tmp/agently-worker-clean-install` and imported the protocol successfully.
- `npm run typecheck` — passed.
- `npx vitest run packages/adapter-agent-runtime-agently/test` — 3 files, 36 tests passed.
- `git diff --check` — passed.

## Notes

- The first `uv` invocation needed sandbox approval to access its existing local cache; dependency resolution then completed without changing any required pins.
