# Feishu Connector composition example

## Calendar capability path

The collaboration Channel does not execute calendar operations. Local
scheduling uses separately leased Feishu Message and Calendar Capability
Citizens: the Agent queries group members, verifies their Capability Result,
queries free/busy facts, then optionally creates an event. Required scopes,
registration commands and failure semantics are in the
[Feishu Capability Provider guide](../../docs/guides/feishu-capability-provider.md#51-calendar-facet注册与权限).

This example describes the production composition boundary for Phase 4B. It is
not a runnable Feishu application and contains no credentials. Deployment code
must resolve the opaque references in `config.example.json` through its own
secret provider.

## Data path

```text
Feishu webhook / optional long connection
  -> verify and normalize
  -> durable ConnectorIngressStore.accept()
  -> ConnectorWorker
  -> FeishuEventMapper
  -> ConnectorSdkCommandSink
  -> public WorkFabricClient
  -> Exchange

Exchange ProtocolEvent
  -> existing SignalDispatcher
  -> FeishuSignalAdapter
  -> Feishu OpenAPI
```

The webhook returns success only after durable ingress acceptance. Mapping and
SDK calls happen asynchronously. Feishu API acceptance, delivery Ack, and
Handoff responsibility acceptance are distinct facts.

## Required composition

1. Bind `route_connector_id` to a trusted tenant, connector, external tenant,
   and webhook credential reference. Never derive Work Fabric tenancy from the
   callback body.
2. Provide either `MemoryConnectorIngressStore` for local evaluation or
   `PostgresConnectorIngressStore` for durable deployment.
3. Register `feishu_webhook` dependencies on `createHttpService`, or adapt the
   official Feishu long-connection SDK to `FeishuLongConnectionClient`. Both
   sources write to the same ingress store.
4. Run `ConnectorWorker` with `FeishuEventMapper` and a
   `ConnectorSdkCommandSink`. The SDK identity must be an existing authorized
   Actor/Endpoint representation; unknown Feishu users are rejected.
5. Register `FeishuSignalAdapter` with the existing `SignalDispatcher` for
   outbound notification and interactive cards. Destination configuration
   includes the trusted Actor/Endpoint representation; authenticated action
   references bind that identity snapshot as well as the external Feishu user.
6. Run reconciliation as a comparison-only operation. A discrepancy is an
   observable record, not permission to overwrite Work Fabric or Feishu.

## Feishu permissions

Grant only the application scopes required by the configured channel. Message
delivery needs the relevant bot/message permissions; event ingress needs the
selected event subscription; document resolution needs explicit document/wiki
read permissions only when that resolver is enabled. Keep the application in
the smallest tenant and recipient scope supported by the customer deployment.

Permissions and callback configuration change over time, so validate the exact
scope names against the Feishu developer console for the deployed application.

## Credential and content rules

- Configuration stores opaque credential references only.
- Credential providers return values directly to the webhook codec, token
  provider, or OpenAPI client; values never enter Core facts or logs.
- Work Fabric stores canonical document references and bounded metadata, not
  the Feishu document body. Content is fetched on demand with byte and timeout
  limits.
- Arbitrary chat is inert by default. Only configured mapping policies and
  authenticated Connector-generated card actions can submit commands.
- All replicas that issue or consume action references need the same 32-byte
  action key. The Phase 4B codec accepts one active key, so rotation requires a
  coordinated drain: stop issuing actionable cards, wait at least the maximum
  action TTL, then deploy the new key everywhere. A future multi-key resolver
  can remove that pause; never reuse a nonce under one key.
- Bind every document resolver instance to one trusted tenant, connector and
  credential reference. Raw content also requires an injected authorization
  decision; metadata permission alone is not content permission.
- Run bounded `PostgresConnectorIngressStore.pruneExpired()` batches after the
  configured completed/dead-letter retention deadlines. The hardening migration
  uses indexed `timestamptz` queue and retention columns.
- Tenant-token caches have a configured maximum entry count; HTTP bodies are
  read through hard byte-capped streams.

## Local proof

The repository integration test runs a complete fake-Feishu round trip through
real HTTP, SDK, Exchange, subscription delivery, card callback, and Connector
worker boundaries:

```bash
npm test -- packages/connector-feishu/test/feishu-roundtrip.integration.test.ts
```

No browser Console is required for this path. The optional Phase 5 Console is a
read-mostly client of the same HTTP/SDK contracts; it can inspect bounded
Connector ingress/discrepancy facts and request an authorized recovery, but it
does not receive callback content, run the mapping worker or become part of the
Feishu delivery path. See [Console](../../docs/console.md) and
[Operations](../../docs/operations.md).
