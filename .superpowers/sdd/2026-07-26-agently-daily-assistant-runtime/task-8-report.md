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

## Review follow-up

- Moved the 120-second timeout from model request body options to the supported OpenAICompatible provider transport `timeout` mapping. An offline test uses the installed 4.1.4.1 request builder and verifies `client_options.timeout.read == 120` while the request body contains no `timeout` field.
- The runner now rejects an inbound task containing a value exactly equal to the child-environment secret before invoking its executor, emitting only the existing generic failed record.
- String and key limits now use UTF-16 code units to match the Node protocol boundary, including astral Unicode input.
- Stdin now accepts exactly one JSON record with at most one terminating LF; blank, leading, trailing, and multiple-record input is rejected.

Follow-up verification: `uv run pytest -q` (17 passed), `uv build`, clean wheel install, `npm run typecheck`, and `npx vitest run packages/adapter-agent-runtime-agently/test` (36 passed).

## Re-review follow-up

- The worker now imports Agently while stdout is redirected to a persistent null sink and reroutes any pre-existing root stdout logging handlers there. This happens before Agently configuration or execution, so the Worker owns stdout exclusively for NDJSON records.
- Added a controlled subprocess test using the real pinned Agently package and a refused loopback endpoint. It verifies each stdout line parses as Worker protocol JSON and contains no Agently warning/error logging.
- Added USV-string normalization for surrogate handling: lone surrogates become U+FFFD for protocol values and UTF-8 byte budgets, while valid escaped pairs remain their scalar code point. UTF-16 code-unit counting now avoids raw encoder errors.

Re-review verification: `uv run pytest -q` (19 passed), local-refusal stdout isolation test, `uv build`, clean wheel install, `npm run typecheck`, and `npx vitest run packages/adapter-agent-runtime-agently/test` (36 passed).
