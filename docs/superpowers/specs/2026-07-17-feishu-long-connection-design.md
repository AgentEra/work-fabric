# Feishu Long-Connection Transport Design

**Date:** 2026-07-17

**Status:** Implemented and verified

## 1. Goal

Add Feishu's official long-connection event transport as a first-class inbound
binding for the existing `collaboration-channel.feishu` plugin. A developer
must be able to run Work Fabric locally, connect outbound to Feishu over the
official WebSocket client, receive `im.message.receive_v1`, and exercise the
same durable Connector, Handoff, route, Subscription and Signal path without a
public domain, public IP or tunnel.

This change extends the connection layer. It does not add intent inference,
Agent reasoning, participant selection, workflow automation, requirement
creation, model/tool invocation or task execution.

## 2. Confirmed decisions

1. A plugin instance owns exactly one inbound transport at a time:
   `webhook` or `long_connection`.
2. Transport changes require a configuration change and service restart. There
   is no runtime dual-feed failover.
3. Multiple plugin instances may independently choose different transports.
4. The official Feishu Node SDK is isolated in a new Adapter package. It may
   not appear in WFPP, Core, Connector SPI/runtime or the Feishu plugin package.
5. Long-connection delivery enters the existing `ConnectorIngressStore`; no
   second event, workflow or notification state is introduced.
6. Outbound notification continues through the existing Feishu OpenAPI
   adapter and canonical Subscription/Signal path.
7. Long connection is supported only for `api` and `all` service roles. A pure
   `worker` role rejects an enabled long-connection instance.

## 3. Scope and non-goals

### In scope

- official Node SDK integration for `im.message.receive_v1`;
- source-neutral client/factory contracts over the existing long-connection
  source;
- strict transport-discriminated configuration and secret resolution;
- plugin lifecycle, connection health and bounded shutdown;
- local runnable YAML and operator documentation;
- duplicate-safe callback-to-Handoff-to-original-chat acceptance tests;
- dependency and responsibility boundary tests.

### Not in scope

- simultaneous Webhook and long connection on one instance;
- automatic transport failover or leader election;
- Feishu card-action callbacks over long connection;
- general registration of arbitrary Feishu event types;
- merchant/store applications, which Feishu does not support for this mode;
- a separate bridge process or sidecar;
- Agent Runtime implementation or requirement-system integration.

## 4. Package architecture

```text
service-node
  +-- PluginHost
  +-- FeishuPluginFactory
  +-- NodeFeishuLongConnectionClientFactory
          |
          v
adapter-feishu-long-connection-node
          |
          v
@larksuiteoapi/node-sdk / WSClient
          |
          v
FeishuLongConnectionSource
          |
          v
ConnectorIngressStore
          |
          v
existing ConnectorWorker -> public TypeScript SDK -> Handoff
```

Create:

```text
packages/adapter-feishu-long-connection-node
```

The package pins `@larksuiteoapi/node-sdk` to exact version `1.71.1`, following
the repository's exact dependency policy. It contains the only production
import of that SDK.

`connector-feishu` retains the technology-neutral Feishu-specific port and
source. The existing client contract is extended with a bounded connection
status snapshot, and a client factory contract is added so the plugin can
request one isolated client per enabled instance without knowing the SDK.

Conceptually:

```ts
type FeishuLongConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "stopped";

interface FeishuLongConnectionClient {
  start(handler: FeishuLongConnectionHandler): Promise<void>;
  status(): FeishuLongConnectionStatus;
  stop(): Promise<void>;
}

interface FeishuLongConnectionClientFactory {
  create(input: {
    app_id: string;
    app_secret: string;
    instance_id: string;
  }): FeishuLongConnectionClient;
}
```

Status contains bounded state and timestamps/counters only. It never contains
credentials, tenant identifiers, URLs, message content or exception text.

`service-node` registers the Node factory in the plugin service locator. A
deployment may inject another implementation without modifying the plugin.

## 5. Configuration

`inbound` becomes a strict discriminated union.

### Long connection

```yaml
credentials:
  app_id: ${FEISHU_APP_ID}
  app_secret: ${FEISHU_APP_SECRET}
  work_fabric_access_token: ${FEISHU_CONNECTOR_ACCESS_TOKEN}

inbound:
  enabled: true
  transport: long_connection
  mention_only: true
  intake_target:
    actor_id: actor-intake-agent
    endpoint_id: endpoint-intake-agent
  accept_within_seconds: 86400
  result_due_within_seconds: 604800
```

### Webhook

```yaml
credentials:
  app_id: ${FEISHU_APP_ID}
  app_secret: ${FEISHU_APP_SECRET}
  verification_token: ${FEISHU_VERIFICATION_TOKEN}
  encrypt_key: ${FEISHU_ENCRYPT_KEY}
  work_fabric_access_token: ${FEISHU_CONNECTOR_ACCESS_TOKEN}

inbound:
  enabled: true
  transport: webhook
  route_id: primary
  mention_only: true
  intake_target:
    actor_id: actor-intake-agent
    endpoint_id: endpoint-intake-agent
```

Rules:

- `app_id`, `app_secret` and `work_fabric_access_token` are common.
- `verification_token`, optional `encrypt_key`, and `route_id` are Webhook-only.
- Long-connection configuration containing Webhook-only fields is invalid.
- Webhook configuration without its required fields is invalid.
- Existing Webhook YAML remains compatible.
- Secret resolution declares only fields required by the selected transport.
- No connection tuning is exposed in v1. The Node Adapter uses bounded internal
  defaults and the SDK's server-controlled reconnect settings.

## 6. Event reconstruction and durable acceptance

The official SDK handler exposes a flattened event containing header facts and
the message body. The Adapter reconstructs the existing normalized input:

```json
{
  "schema": "2.0",
  "header": {
    "event_id": "...",
    "event_type": "im.message.receive_v1",
    "create_time": "...",
    "tenant_key": "..."
  },
  "event": {
    "sender": {},
    "message": {}
  }
}
```

The Adapter accepts only `im.message.receive_v1`. It rejects missing or
out-of-bound `event_id`, `create_time`, `tenant_key`, sender, message ID, chat
ID or message facts before calling the source. It does not derive substitute
identities or local timestamps for externally supplied identity fields.

```text
Feishu WS handler
  -> bounded structural reconstruction
  -> FeishuLongConnectionSource
  -> normalizeFeishuEvent
  -> ConnectorIngressStore.accept
  -> return success to the SDK
```

The handler waits only for atomic durable acceptance. Mapping, identity
resolution, the public SDK Handoff Offer, route creation and Subscription
provisioning remain asynchronous. Existing Feishu message/event IDs remain the
dedupe identity, so a redelivery produces `duplicate` rather than a second
Handoff.

## 7. Lifecycle and health

### Startup

```text
configuration snapshot
  -> plugin create
  -> prepare: create source/client, no network
  -> HTTP listen when role exposes HTTP
  -> plugin start: install dispatcher and launch WSClient
  -> onReady: connected/healthy
```

The Node Adapter stores the long-running `WSClient.start()` Promise and attaches
a rejection handler immediately. `start()` launches the connection and returns
without waiting indefinitely for network readiness. Initial network or
credential failure changes plugin health; it does not terminate the Work
Fabric Core process. Constructor/configuration/programming errors still reject
startup.

The Adapter maps official callbacks and `getConnectionStatus()` as follows:

| SDK state | Plugin state |
|---|---|
| idle / connecting | degraded |
| connected | healthy |
| reconnecting | degraded |
| failed | unhealthy |
| stopped | degraded outside shutdown |

`/health/live` continues to report process liveness. `/health/ready` reports
503 while an enabled long-connection plugin is not connected. The protected
health detail exposes only instance-independent dependency state and stable
reason codes.

### Shutdown

```text
stop accepting new WS events
  -> wait for the active durable-accept handler within a bound
  -> close WSClient
  -> settle the stored run Promise within a bound
  -> stop Connector worker
  -> unregister Signal adapter and prepared resources
```

Stop is idempotent. No timer, socket, handler or unhandled Promise remains after
shutdown.

## 8. Failure semantics

| Failure | Behavior |
|---|---|
| local network loss | SDK reconnects; health degraded; committed facts remain |
| reconnect succeeds | health returns to healthy |
| credentials rejected | plugin unhealthy; Core live; no credential detail exposed |
| Ingress store unavailable | handler rejects so Feishu may redeliver |
| duplicate event | durable duplicate accepted; no second logical operation |
| tenant mismatch | reject before persistence |
| missing stable identity field | reject; never invent a dedupe identity |
| mapping fails after durable accept | existing retry/dead-letter path |
| outbound Feishu API unavailable | existing Signal retry/dead-letter path |
| SDK run Promise rejects | captured, health failed, no unhandled rejection |
| service stop during handler | bounded drain before client close |

Feishu long connection uses competing delivery if several clients use the same
application. The first version documents that behavior and relies on the
existing durable dedupe for accidental overlap; it does not introduce a new
leader-election or broadcast layer.

## 9. Security and responsibility boundaries

- Long connection is outbound-only from the local machine and requires normal
  public Internet access.
- App ID/App Secret remain declared secrets resolved by Configuration Provider.
- The Adapter never logs or publishes raw SDK frames, credentials, tenant key,
  sender identity, chat ID or message content.
- The Node SDK receives a bounded redacting logger and never runs at debug
  level in the built-in composition.
- External Feishu identity still passes the configured identity mapping.
- Handoff Offer still passes public SDK authentication, representation and
  Authority Policy.
- Event delivery still passes canonical Subscription filters and audience
  authorization.
- Core, protocol and storage schemas gain no Feishu SDK type or transport
  branch.
- The Adapter and plugin do not interpret intent, select a participant, call an
  Agent/model/tool, or execute work.

## 10. Testing and acceptance

### Contract and unit tests

1. SDK flattened data reconstructs the exact existing event envelope.
2. Missing/invalid stable fields are rejected before ingress.
3. Client start/stop are idempotent and prepare has no network side effect.
4. `onReady`, reconnect, reconnected, failure and close map to bounded status.
5. Run-Promise rejection is consumed and visible only as a stable health code.
6. Webhook and long-connection configuration are strict and mutually exclusive.
7. Secret paths follow the selected transport.

### Integration tests

1. A fake long-connection client delivers one explicit bot mention.
2. The event is durably accepted once under duplicate delivery.
3. The Connector Worker creates exactly one Intake Handoff via the public SDK.
4. Original conversation route and canonical Subscription are durable.
5. A committed Agent-authored Handoff Result returns through the existing
   Feishu outbound adapter to the original chat; lifecycle and Status events do
   not become assistant replies.
6. Connection loss degrades readiness without breaking Core liveness.
7. Stop drains an active accept and leaves no open handle.

### Boundary and compatibility tests

- The official SDK has exactly one production dependency edge: the new Node
  Adapter.
- Core, WFPP, Connector SPI/runtime and plugin packages do not import it.
- Existing Webhook tests and YAML remain green.
- Memory/SQLite local operation and PostgreSQL/cluster regressions remain green.
- Source scans find no Agent-brain, target-selection or task-execution behavior.

### Manual local acceptance

1. Start Work Fabric locally with `transport: long_connection`.
2. Wait until readiness reports connected.
3. In the Feishu developer console select `使用长连接接收事件` and subscribe
   to `im.message.receive_v1`.
4. Add the enterprise custom-app bot to a test chat.
5. An authorized mapped user sends `@机器人 帮我创建一个需求`.
6. One Intake Handoff is created and one Work Fabric card returns to the same
   chat without a domain, public IP or tunnel.

## 11. Documentation outcome

Update the global YAML example and Feishu guide with separate local
long-connection and deployed Webhook profiles. State explicitly that the
Console is optional, outbound Feishu OpenAPI still needs Internet access, and
the external Intake Agent remains responsible for understanding and executing
the request.

## 12. References

- [Feishu: 使用长连接接收事件](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case)
- Existing source: `packages/connector-feishu/src/long-connection-source.ts`
- Existing plugin: `packages/plugin-channel-feishu/src/feishu-plugin-factory.ts`
- Existing global configuration: `examples/config/service-feishu.yaml`
