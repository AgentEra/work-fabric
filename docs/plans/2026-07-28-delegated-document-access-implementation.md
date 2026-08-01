# Delegated document access implementation plan

Date: 2026-07-28  
Spec: [Delegated document access](../specs/2026-07-28-delegated-document-access.md)
Status: Implemented; release-gate verification in progress

Every implementation task follows red → green → refactor. A task is complete
only after its focused test first fails for the intended reason and then passes.

## Task 1: Freeze generic resource and authorization contracts

Status: completed.

Tests:

- validate opaque `DocumentResourceReference`;
- reject credentials, raw vendor subject IDs and malformed URIs;
- validate allow/deny authorization outcomes and bounded delegation facts.

Implementation:

- add a technology-neutral document-provider SPI;
- define `DocumentAccessAuthorizer`, `DocumentPlacementResolver`,
  `DocumentResourceAdapter` and delegation context;
- keep the SPI independent of Feishu and Work Fabric Core.

Acceptance: DA-03, DA-08, DA-10.

## Task 2: Upgrade Feishu dynamic capability Contracts

Status: completed.

Tests:

- create accepts optional `{resource_uri}` or `{policy_ref}` placement;
- read/update/append/delete accept `{resource_uri}`;
- schemas reject `folder_token`, `space_id`, `{kind, token}` and identity
  assertions supplied by the Agent;
- declaration version and digest change.

Implementation:

- update schemas and input normalization;
- translate supported Feishu URIs in an adapter;
- return `unsupported_resource_type` before vendor calls.

Acceptance: DA-03, DA-08.

## Task 3: Make native authorization mandatory

Status: completed.

Tests:

- allow calls the backend exactly once;
- deny and authorizer outage call it zero times;
- Provider-owned documents are still re-authorized;
- delete requires ACL allow, confirmation, ownership and revision;
- authorizer input contains trusted represented Actor and delegation only.

Implementation:

- inject `DocumentAccessAuthorizer` and `DocumentPlacementResolver`;
- authorize the resolved container for create and document URI for existing
  operations;
- retain idempotency and ownership as safety facts, not ACL.

Acceptance: DA-04 through DA-07, DA-09.

## Task 4: Narrow Invocation Authority

Status: completed.

Tests:

- authority is derived from accepted original Handoff facts;
- child grant retains the original Human Actor;
- scopes are mapped by operation and expiry is bounded;
- Agent input cannot override represented identity;
- invalid or non-redelegable authority fails closed.

Implementation:

- replace document/resource allowlists with delegation facts;
- preserve original delegation lineage;
- pass only bounded authorization evidence into the auxiliary Handoff.

Acceptance: DA-04, DA-10.

## Task 5: Remove shared-folder deployment coupling

Status: completed.

Tests:

- Provider configuration succeeds without shared folder;
- legacy/shared-folder ACL fields are rejected;
- configuration loader no longer resolves the folder env variable;
- composition starts without shared-folder preflight;
- startup preparation does not require the folder variable.

Implementation:

- remove mandatory `shared_folder` from Provider config and local bundle;
- remove startup preflight from composition;
- keep the old verifier exported only as an optional diagnostic;
- update env/status tooling.

Acceptance: DA-01, DA-02.

## Task 6: Integrate placement and access adapters

Status: completed.

Tests:

- an explicit Drive folder URI maps to the backend folder parameter;
- omitted placement delegates to the resolver default;
- a policy reference is resolved outside YAML;
- unknown resource schemes/types fail closed;
- a reference ACL adapter can authorize through an injected identity/ACL
  gateway without exposing its evidence.

Implementation:

- add the Feishu resource adapter;
- add reference resolver/authorizer composition ports;
- make production composition require an injected/native authorization
  implementation and make missing authorization fail closed.

Acceptance: DA-05 through DA-08, DA-10.

## Task 7: Update examples and end-to-end proof

Status: implemented; verification recorded in the final release-gate run.

Tests:

- one Feishu mention creates one document through delegated authorization;
- denied Human ACL creates no document and returns a semantic Agent response;
- repeated ingress/invocation does not repeat work;
- no lifecycle state code, credential or ACL payload appears in chat.

Implementation:

- migrate the unified local bundle and deterministic fake adapters;
- update Provider, Agent and roadmap documentation;
- document the identity-broker/native-ACL integration requirement.

Acceptance: DA-11.

## Release gate

Run:

```bash
npm run typecheck
npx vitest run packages/document-provider-spi/test
npx vitest run packages/provider-feishu/test
npx vitest run examples/agently-agent-runtime/test
npx vitest run examples/feishu-capability-provider/test --testTimeout=30000
npm run agent-runtime:test-python
npm run verify
npm run check:plugin-boundaries
npm run check:admission-boundaries
npm run check:sensitive-observability
```

The implementation may be committed only when all acceptance criteria have
corresponding passing tests and the full release gate succeeds.

## Verification record

Recorded on 2026-07-28:

- TypeScript typecheck: passed.
- Focused TypeScript suites: 23 files, 127 tests passed.
- Agently Python Runtime: 35 tests passed.
- WFPP v1 conformance: 169/169 passed.
- Plugin, Admission and sensitive-observability boundary checks: zero
  responsibility or sensitive-sink violations.
- Full Vitest discovery: 261 files passed, 5 skipped; 19 listener-dependent
  files could not run because the managed sandbox rejected every loopback or
  Unix-socket `listen()` with `EPERM`. All 31 failures had that same
  environment cause and contained no assertion failure.

The two public HTTP/SSE end-to-end scenarios changed by this plan remain
present and typechecked. They must be rerun in a host that permits local
listeners before release promotion.
