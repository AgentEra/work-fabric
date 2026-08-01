# Development document access implementation

Status: Completed  
Date: 2026-07-28

## Goal

Enable the local Feishu assistant stack to create real documents with the
application tenant credential before represented-user OAuth is implemented,
without weakening the production fail-closed architecture.

## Design

- Add an example/deployment-level
  `DevelopmentAppIdentityDocumentAccessAuthorizer`; do not add bypass logic to
  Exchange Core, Handoff, Agent Runtime or the Feishu Provider package.
- Select the adapter from the Feishu Provider application service
  configuration.
- Require `development_mode: true` and
  `WORK_FABRIC_ALLOW_UNSAFE_DOCUMENT_ACCESS=true`.
- Keep default document placement in the configuration service as an opaque
  `resource_uri`.
- Continue to allow an explicitly supplied placement URI to override the
  default and leave unresolved policy references fail-closed.
- Keep the production/native mode unavailable unless a real
  `DocumentAccessAuthorizer` is injected by the deployment composition root.

## TDD sequence

1. Add failing tests for authorizer expiry, evidence hygiene and delete
   behavior.
2. Add failing configuration tests for strict parsing.
3. Add failing composition tests for the two-key development guard and
   production rejection.
4. Implement the deployment adapter and service configuration.
5. Wire local bundle preparation and document placement.
6. Run focused tests, TypeScript typecheck and the relevant boundary checks.

## Acceptance

- **DDA-01** local YAML explicitly selects the development adapter.
- **DDA-02** the local environment loader requires the unsafe acknowledgement.
- **DDA-03** missing acknowledgement, production mode or unknown configuration
  fails before the Provider starts.
- **DDA-04** create/read/update/append receive a bounded allow decision; delete
  remains denied by the development adapter.
- **DDA-05** evidence exposes no application secret, token, folder token or
  represented Actor identifier.
- **DDA-06** an explicit create placement is preserved; absent placement uses
  the configured default URI.
- **DDA-07** the existing injected native authorizer path remains unchanged.

## Verification evidence

- TypeScript typecheck passed.
- Focused document SPI, Feishu Provider, configuration and local-stack suites:
  52 tests passed.
- Full Vitest run: 2,145 tests passed and 11 skipped; the remaining 31 tests
  were blocked only by the execution sandbox rejecting local TCP/Unix socket
  `listen()` with `EPERM`.
- WFPP v1 conformance: 169/169 passed.
- Plugin, Admission and sensitive-observability boundary checks passed with
  zero responsibility violations.
- `git diff --check` passed.
