# Local Feishu Document Creation Runtime Design

> Superseded on 2026-07-28 by
> [Delegated document access](../../specs/2026-07-28-delegated-document-access.md).
> This file is retained as historical design context; its mandatory shared
> folder is no longer a permission boundary or startup requirement.

**Status:** Approved in conversation on 2026-07-27

## 1. Goal

Make the existing reference architecture runnable locally so an internal
employee can mention the Feishu bot, ask the Daily Assistant to create a simple
Docx document, receive one Agent-authored reply containing the document link,
and open the document through a preconfigured tenant-readable shared folder.

This work completes deployment composition. It does not move reasoning,
Provider execution or Feishu behavior into Work Fabric Core.

## 2. Architectural invariants

1. Work Fabric remains the connection, discovery, Authority, Handoff, event and
   state fabric. It does not decide to create a document and does not call
   Feishu.
2. The Daily Assistant remains the decision body and owns the original Handoff
   and all human-facing language.
3. The Feishu Capability Provider is an independently started network Citizen.
   It owns credentials, OpenAPI calls, idempotency, shared-folder policy,
   document ownership and stable execution errors.
4. The Feishu Channel continues to own message transport only. It does not
   interpret capability facts or synthesize replies.
5. Capability declarations are leased runtime facts. YAML contains deployment
   enablement, identity bindings and safety ceilings, not a list of live
   capabilities.
6. Every cross-module operation uses an existing public protocol, SDK or narrow
   SPI. No private in-process bypass is introduced.
7. The original Handoff never transfers to the Provider. A separate auxiliary
   Handoff carries each capability execution.
8. App credentials, tenant tokens, shared-folder tokens and raw vendor
   responses never enter Handoff intent, Result, events, Console or Agent
   prompts.

## 3. Chosen topology

Three independent runtimes share one Work Fabric configuration bundle:

```text
Feishu long connection
  -> collaboration-channel.feishu
  -> Admission and participant representation
  -> original Handoff
  -> Daily Assistant Agent Runtime
  -> bounded dynamic capability disclosure
  -> auxiliary feishu.document.create Handoff
  -> Feishu Capability Provider Gateway and Host
  -> Feishu OpenAPI in configured shared folder
  -> typed capability Result
  -> Daily Assistant continuation
  -> Agent-authored original Result
  -> Feishu Channel
```

The service node, Agent Runtime and Provider Runtime remain separate processes.
A local supervisor may start and stop them together, but it does not merge
their identities, state, Authority or responsibilities.

## 4. Unified configuration bundle

One physical YAML document uses a versioned bundle envelope:

```yaml
api_version: workfabric.config-bundle/v1
applications:
  work-fabric:
    api_version: workfabric.config/v1
    service: {}
    plugins: {instances: {}}
  daily-assistant:
    api_version: workfabric.config/v1
    service: {}
    role: {}
    participant: {}
    capabilities: []
    plugins: {instances: {}}
  feishu-provider:
    api_version: workfabric.config/v1
    service: {}
    participant: {}
    plugins: {instances: {}}
```

A technology-neutral `ConfigurationViewProvider` selects exactly one
application subtree before the existing `ConfigurationService` validates it.
Each process therefore validates only the configuration it consumes, while the
underlying provider may later be YAML, a database or a remote service.
Standalone legacy `workfabric.config/v1` files remain valid.

Secrets continue to use declared environment substitution. The bundle contains
environment references but no committed secret values. Node, Agent and
Provider loaders resolve only their selected view, so one process cannot
accidentally materialize another process's secrets.

## 5. Feishu Provider application

The Provider application contains:

- Work Fabric base URL, tenant, exchange, access token and subscription;
- Runtime ID, concurrency, lease and SQLite paths;
- one enabled `capability-provider.feishu` instance;
- capability and context Citizen identities;
- a credential reference resolved by a Provider-owned credential adapter;
- a required `shared_folder_token`;
- a stable non-secret `shared_folder_policy_ref`;
- `shared_folder_visibility: tenant_readable`;
- bounded OpenAPI timeout and response limits.

`shared_folder_token` is deployment data owned by the Provider. It is never an
Agent input field. `feishu.document.create` accepts only title and simple
content; the Provider injects the configured folder after Authority validation.

At startup the Provider performs a fail-closed preflight:

1. obtain an application tenant token through the credential provider;
2. verify the configured folder exists and the application can create within
   it;
3. verify through the permission API that the application has edit access and
   the folder's public tenant policy is readable by internal employees;
4. refuse readiness if any check is unavailable, ambiguous or insufficient.

The Provider does not add collaborators, change sharing policy or fall back to
application-private storage. Admission already limits the channel to verified
internal members. A tenant-readable shared folder therefore supplies the
requester access invariant without transmitting the requester's Feishu ID to
the Provider.

## 6. Runtime capability disclosure

The current Agent worker can emit `capability_request`, but its first turn does
not receive current Catalog summaries. Deployment must not solve this by
hard-coding `feishu.document.create` in the prompt or YAML.

A technology-neutral disclosure port loads a bounded set of currently
available capability summaries from the Citizen Catalog, filtered by the
Agent's allowed namespaces. The Host passes the inert summaries to the
capability-aware Driver on every turn:

```ts
interface RuntimeCapabilitySummary {
  readonly citizen_id: string;
  readonly capability_id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
}
```

The summary contains no Endpoint, credential, private constraint or executable
payload. The Agent may select one advertised capability ID and produce typed
input. Invocation then performs the existing separately authorized full
Contract lookup, Schema validation, Contract digest freeze and auxiliary
Handoff flow. Disclosure does not grant execution Authority.

The worker protocol becomes v3 for capability-aware turns and includes
`available_capabilities`. Protocol v1 one-shot Drivers remain unchanged.

## 7. Authority and provisioning

An idempotent provisioning command creates or updates:

- Daily Assistant Endpoint;
- Feishu Provider Endpoint with dynamically derived capability descriptors;
- Capability Provider and Context Provider Citizen trust records;
- required subscriptions;
- registration revisions.

The service configuration explicitly binds three principals: administration,
Daily Assistant and Feishu Provider. The Agent receives only:

- Catalog list and declaration-read access for permitted namespaces;
- global auxiliary Handoff Offer;
- initiator-scoped query and external target resolution through the existing
  Agent Runtime Authority policy.

The Provider receives only:

- its Endpoint session and subscription operations;
- its Citizen session lifecycle;
- Delivery/Ack/Accept/Status/Result for Handoffs assigned to its Endpoint.

The local `InvocationAuthorityProvider` reads the authoritative original
Handoff, requires a human initiator admitted by the Channel, binds the selected
Citizen, capability version and Contract digest, and issues
`capability:invoke` evidence until the original deadline. For document create,
the Authority binds the configured non-secret `shared_folder_policy_ref`.
The Provider resolves that policy reference to its private folder token and
rejects any unknown reference. The raw folder token therefore never enters the
Handoff or Agent boundary.

## 8. Execution and result semantics

For `feishu.document.create`:

1. Agent chooses the dynamically disclosed declaration.
2. Agent emits title and bounded plain-text or supported Markdown content.
3. Agent Runtime validates input and creates an idempotent auxiliary Handoff.
4. Provider validates target binding, Contract digest, Authority and default
   shared folder.
5. Provider creates the Docx and writes simple blocks.
6. Provider returns typed fields: document token, URL, title and revision.
7. Agent receives inert typed facts and authors the final Chinese reply.
8. Channel delivers exactly that original Handoff Result.

Duplicate delivery or Runtime recovery reuses the persisted invocation and
Provider idempotency keys and does not create a second document.

## 9. Failure behavior

- Missing configuration or secret: affected process refuses startup.
- Shared folder is absent, private, inaccessible or policy cannot be verified:
  Provider is not ready and accepts no capability Handoff.
- Capability is not currently declared: Agent cannot request it from the
  disclosed list; a stale explicit request fails before Offer.
- Catalog, Authority or target resolution unavailable: no Provider execution.
- Feishu 401: refresh once; 429/5xx: bounded stable retryable failure.
- Permission failure: stable non-retryable `feishu_permission_denied`.
- Result uncertainty after an external mutation:
  `external_outcome_unknown`; never guess or automatically repeat.
- Provider failure returns typed facts to the Agent. Only the Agent may turn
  them into a user-facing explanation.
- No component silently creates a document outside the shared folder.

## 10. Local operation

The repository exposes:

```text
npm run local:feishu:provision
npm run local:feishu:start
npm run local:feishu:status
```

`local:feishu:start` loads an explicit env file and one configuration bundle,
starts the service node, Provider and Agent as child processes, prefixes their
logs, waits for each readiness boundary and shuts all children down on SIGINT
or SIGTERM. Readiness means:

- Work Fabric HTTP health is available;
- Feishu long connection plugin is started;
- Provider Endpoint and Citizen sessions are leased and shared-folder
  preflight passed;
- Daily Assistant Gateway and capability disclosure are available.

The Console remains optional and read-only; it is not part of task execution.

## 11. Testing and acceptance

Automated tests must prove:

1. bundle view selection, legacy compatibility and per-view secret isolation;
2. Provider configuration rejects unknown fields and missing shared folder;
3. shared-folder preflight fails closed for private, inaccessible and malformed
   responses;
4. dynamic disclosure is bounded, namespace-filtered and passed to the Python
   worker without full Contracts or secrets;
5. Agent CLI composes real Schema, waiter and Authority ports when enabled;
6. provisioning is idempotent and creates the exact identity/Authority graph;
7. Provider launcher opens Endpoint and Citizen sessions and closes cleanly;
8. one local HTTP/SSE end-to-end request creates exactly one fake-backend
   document in the configured folder and returns one Agent-authored reply;
9. no credential, folder token or vendor response appears in prompts, events,
   Result, logs or Console projections;
10. all existing conformance and architectural boundary gates continue to
    pass.

The final opt-in live smoke test uses the user's local environment and a
dedicated shared folder. Acceptance requires:

- a Feishu mention is ingested once;
- exactly one document is created in the configured shared folder;
- the requesting internal employee can open the returned URL;
- exactly one semantic Agent reply is delivered;
- no internal Handoff status card is sent to the conversation.

## 12. Non-goals

- no automatic collaborator management;
- no fallback storage location;
- no user OAuth;
- no arbitrary Docx block trees;
- no workflow engine, scheduler or internal tool router;
- no Provider implementation inside `service-node`;
- no Agent access to Feishu credentials, folder token or OpenAPI;
- no change to the Console's read-only execution role.
