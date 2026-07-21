# Final cross-module grant binding report

## Outcome

Representation grants are now version 2 and are cryptographically bound to
the exact `ingress_id + idempotency_key` command tuple. The trusted Admission
Identity principal carries both values as frozen attributes. Exchange passes
the verified command envelope correlation and idempotency values into the
technology-neutral `AuthorityRequest`; Admission Authority allows only an
exact tuple match. A valid grant can therefore retry its original command but
cannot be replayed for another ingress or command key.

The change preserves Work Fabric's connection-layer boundary: Feishu derives
one deterministic command key before Admission, adapters pass it through, and
the public TypeScript SDK/HTTP/Identity/Authority/Exchange path remains the only
execution path. No scheduling, reasoning, automation, or participant work was
added.

## TDD evidence

### RED

- Admission contract/grant/Authority focused run: 3 files, 62 tests, 8
  expected failures. The old implementation ignored an oversized Admission
  idempotency key, issued v1 grants without a command key, and allowed all
  three tuple replay variants.
- Memory decision-store run: the new canonical record failed because the store
  did not yet accept/persist `idempotency_key`; this established the adapter
  schema gap before implementation.
- Feishu mapping run: 2 files, 22 tests, 3 expected failures. Message/card
  resolvers did not receive the final key and message intake used a separate
  `feishu-intake` derivation.
- The first HTTP E2E attempt was blocked by sandbox loopback `EPERM`; the same
  test was rerun with loopback permission and is reported below. This was an
  environment failure, not a functional RED.
- The first full-suite regression found two genuine stale fixtures in
  `plugin-composition.integration.test.ts`: manually issued grants were paired
  with a different/missing command tuple and correctly returned 403. The
  fixtures were changed to use their admitted tuple; production behavior was
  not weakened.

### GREEN

- Initial contract/grant/Authority slice: 3 files, 62/62 passed.
- Admission runtime, conformance, three persistence adapters, Identity,
  Authority, Feishu mapper and plugin focused run: 14 files, 201 passed, one
  environment-gated live test skipped.
- Feishu/store focused run: 6 files, 77 passed, one PostgreSQL live test
  skipped when its URL was absent.
- Public SDK HTTP Admission E2E: 2/2 passed with loopback permission. Same
  grant/same tuple returned the original Handoff; changed correlation, changed
  idempotency, and both changed returned `permission_denied`. Accepted Handoff
  unique-ID count remained 5, proving zero additional Handoffs.
- Corrected cross-process/key-rotation composition integration: 15/15 passed.

## Implemented security semantics

- `AdmissionRequest` and `AdmissionDecisionRecord` include a bounded
  `idempotency_key`; same ingress with another key fails closed.
- Memory, SQLite and PostgreSQL decision stores persist and compare the field.
  SQLite `005_admission` and PostgreSQL `010_admission` include a typed bounded
  column; no raw subject or grant is persisted.
- Grant payload v2 has exact canonical keys including `idempotency_key`; v1
  tokens fail closed. Key rotation within v2 remains supported.
- Admission Identity returns one Actor/Endpoint claim and frozen trusted
  ingress/key attributes.
- `AuthorityRequest` contains own data `correlation_id` and `idempotency_key`.
  Exchange fills them from the validated command envelope. Admission Authority
  rejects missing, inherited, accessor-backed, malformed, or mismatched tuple
  fields without invoking getters.
- Feishu message and card paths call one exported pure key derivation function
  before participant resolution and use that same key in Admission and the
  final command.
- Decision operational output and Console do not expose the stored key; grants
  and raw subjects remain excluded from decisions, logs, metrics and receipts.

## Documentation and rollout

- Updated the canonical Admission design, architecture, Feishu guide, SQLite
  deployment and PostgreSQL deployment notes.
- Documented grant v2/v1 invalidation, `wfaf1` to `wfaf2` card action rollout,
  safe add/switch/wait-TTL/remove key rotation, and pause/drain requirements.
- Documented that Admission-enabled `service-node` automatically composes
  SQLite `005_admission`, while the generic SQLite migration CLI currently
  applies only base migrations.
- Because the Admission branch is unreleased, `005_admission` and
  `010_admission` were amended in place. A local pre-release database with an
  older recorded checksum must be backed up and recreated; released schemas
  must use forward migrations.

## Final verification

- `npm run check:admission-boundaries`: pass, 0 responsibility violations, 0
  sensitive sink violations.
- `npm run check:plugin-boundaries`: pass, 0 isolation/responsibility
  violations.
- `npm run check:sensitive-observability`: pass, 0 Admission sensitive sinks.
- `npm run typecheck`: pass.
- `npm run conformance`: 126/126 passed.
- `npm run console:build`: pass.
- `git diff --check`: pass.
- `npm test`: authoritative loopback/IPC run passed: 214 files passed, 5
  environment-gated files skipped; 1712 tests passed, 11 environment-gated
  tests skipped.

Environment-gated live integrations remain skipped because no PostgreSQL or
NATS live test URL is configured. No new skip was introduced. These are the
existing repository gates guarded by `WORK_FABRIC_TEST_POSTGRES_URL`,
`PG_TEST_URL`, or the NATS live URL.

## Residual operational risks

- Upgrade intentionally invalidates grant v1 and old `wfaf1` card actions;
  operators must follow the documented drain/wait/deploy sequence.
- Existing pre-release databases that already applied old Admission migration
  checksums require backup and recreation.
- The generic non-command HTTP authorization helper supplies an explicit
  `http:non-command` idempotency sentinel. Admission Authority still fails
  closed because only tuple-bound command offers can match trusted attributes;
  local non-command Authority policies ignore this new context field.
