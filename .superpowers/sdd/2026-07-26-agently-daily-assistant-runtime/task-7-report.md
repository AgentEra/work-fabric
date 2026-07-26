# Task 7 Report — Bounded Agently Process Driver

## Delivered

- Added `@work-fabric/adapter-agent-runtime-agently`, a provider adapter that depends only on the Runtime SPI and Node process APIs.
- Added strict resolved configuration validation, including the exact Python module, resolved executable/workspace paths, HTTPS-by-default model URL, timeout/grace ceilings, and the single declared secret path.
- Added the versioned stdin request and exact NDJSON stdout records with stream, line, record-count, JSON-depth, and stderr bounds.
- Added one-child-per-execution spawning with literal executable/arguments, `shell: false`, a four-key child environment allowlist, bounded timeout, cancellation grace, forced termination, and generic bounded worker errors.
- Added fake-worker integration tests for valid progress/result flow, malformed and invalid protocol variants, output bounds, child environment isolation, timeout, non-zero exit, and SIGTERM/SIGKILL cancellation.

## Verification evidence

- Red phase: `npx vitest run packages/adapter-agent-runtime-agently/test` initially failed because `../src/index.js` did not exist.
- `npx vitest run packages/adapter-agent-runtime-agently/test`: 3 files, 28 tests passed.
- `npx vitest run packages/adapter-agent-runtime-agently/test packages/agent-runtime-host/test packages/agent-runtime-spi/test`: 13 files, 94 tests passed.
- `npm run typecheck`: completed successfully.
- `npm ci --ignore-scripts`: completed successfully.
- `git diff --check`: completed successfully.
