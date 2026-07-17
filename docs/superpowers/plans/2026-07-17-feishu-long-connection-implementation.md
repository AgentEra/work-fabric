# Feishu Long-Connection Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-ready Feishu long-connection inbound transport so a local Work Fabric process can receive `im.message.receive_v1` without a public domain or tunnel, while preserving the existing durable Connector/Handoff/Subscription path and Webhook compatibility.

**Architecture:** Keep `connector-feishu` technology-neutral, isolate `@larksuiteoapi/node-sdk` in a new Node Adapter package, select exactly one inbound transport per Feishu plugin instance, and inject the Adapter factory through the plugin service locator. Long-connection callbacks reconstruct the existing Feishu event envelope and stop at durable ingress acceptance; all mapping, Handoff creation, routing, notification and participant execution remain in their existing layers.

**Tech Stack:** Node.js `>=22.20.0`, TypeScript `7.0.2`, ES modules, npm workspaces, Vitest `4.1.10`, exact `@larksuiteoapi/node-sdk` `1.71.1`, existing Configuration Provider/Plugin/Connector/HTTP runtimes.

## Global Constraints

- Work Fabric owns connection, handoff, durable ingress, identity binding, route, Subscription, visibility and notification mechanics only.
- Do not add intent inference, target ranking/selection, Agent reasoning, model/tool calls, workflow automation, requirement creation or participant task execution.
- The official Feishu SDK may have exactly one production dependency edge: `packages/adapter-feishu-long-connection-node`.
- One enabled Feishu plugin instance uses exactly one inbound transport: `webhook` or `long_connection`.
- Long connection supports `im.message.receive_v1` only. Card-action callbacks remain Webhook-only.
- A callback returns success only after `ConnectorIngressStore.accept` resolves. It does not wait for mapping or Handoff creation.
- Existing Webhook YAML, tests, endpoint behavior and outbound OpenAPI delivery remain compatible.
- Long connection is allowed for service roles `api` and `all`; an enabled long-connection instance is rejected for pure `worker`.
- Health, logs and errors expose stable codes only—never credentials, tenant keys, sender/chat/message identifiers, URLs, raw frames or message content.
- Run every task test-first and commit only after its focused tests, typecheck and relevant boundary checks pass.

## Architecture Invariants

This feature is a layered plugin/Adapter extension, not a transport branch cut
through the system:

```text
Feishu SDK -> Node Adapter -> neutral long-connection port
           -> Feishu Channel Plugin -> ConnectorIngressStore
           -> unchanged Connector/Handoff/Subscription/Signal core
```

- WFPP, Exchange Core, storage, Connector Runtime and HTTP/SDK participant APIs
  remain unchanged and contain no Feishu or WebSocket conditional.
- The Feishu plugin chooses an inbound binding and translates configuration;
  it does not own SDK networking.
- The Node Adapter owns SDK networking and implements the existing neutral
  client port; it does not own collaboration semantics.
- `service-node` performs one explicit composition-root registration. This is
  plugin installation, not a Core dependency. A deployment can inject another
  factory through the same capability without changing the plugin or Core.
- Runtime directory scanning and an external plugin marketplace are not added
  in this lightweight increment. If later required, a deployment-supplied
  `PluginCatalog` can replace the static composition root without changing the
  ports or collaboration kernel introduced here.

---

### Task 1: Extend the technology-neutral long-connection port

**Files:**

- Modify: `packages/connector-feishu/src/long-connection-source.ts`
- Modify: `packages/connector-feishu/test/long-connection-source.test.ts`
- Verify: `packages/connector-feishu/src/index.ts`

**Produces:** A source-neutral client status contract and factory contract that contain no Node SDK type.

**Consumes:** Existing `FeishuLongConnectionHandler` and durable `FeishuLongConnectionSource` behavior.

- [ ] **Step 1: Add failing contract and source-idempotence tests**

Extend `long-connection-source.test.ts` with a fake implementing the final port. Assert that:

1. `status()` returns a bounded snapshot;
2. calling `source.start()` twice starts the client once;
3. calling `source.stop()` twice stops the client once;
4. duplicate delivery still persists one ingress record.

Use this exact public shape in the test:

```ts
const status: FeishuLongConnectionStatus = {
  state: "connected",
  code: "connected",
  reconnect_attempts: 0,
  changed_at: "2026-07-17T00:00:00.000Z",
};

class FakeLongConnection implements FeishuLongConnectionClient {
  handler: FeishuLongConnectionHandler | undefined;
  started = 0;
  stopped = 0;
  start(handler: FeishuLongConnectionHandler): Promise<void> {
    this.handler = handler;
    this.started += 1;
    return Promise.resolve();
  }
  status(): FeishuLongConnectionStatus { return status; }
  stop(): Promise<void> { this.stopped += 1; return Promise.resolve(); }
}
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run packages/connector-feishu/test/long-connection-source.test.ts
```

Expected: TypeScript/Vitest fails because `FeishuLongConnectionStatus` and `status()` are not in the public contract.

- [ ] **Step 3: Add the final neutral contracts**

Add these declarations to `long-connection-source.ts`:

```ts
export type FeishuLongConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "stopped";

export type FeishuLongConnectionStatusCode =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "connection_failed"
  | "stopped";

export interface FeishuLongConnectionStatus {
  readonly state: FeishuLongConnectionState;
  readonly code: FeishuLongConnectionStatusCode;
  readonly reconnect_attempts: number;
  readonly changed_at: string;
}

export interface FeishuLongConnectionClient {
  start(handler: FeishuLongConnectionHandler): Promise<void>;
  status(): FeishuLongConnectionStatus;
  stop(): Promise<void>;
}

export interface FeishuLongConnectionClientFactory {
  create(input: {
    readonly app_id: string;
    readonly app_secret: string;
    readonly instance_id: string;
  }): FeishuLongConnectionClient;
}
```

Keep credentials factory-scoped, keep `status()` synchronous and immutable, and do not add a generic WebSocket abstraction to Core or Connector SPI. Preserve the existing `started` guards in `FeishuLongConnectionSource`.

- [ ] **Step 4: Run focused tests and typecheck**

```bash
npx vitest run packages/connector-feishu/test/long-connection-source.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the neutral contract**

```bash
git add packages/connector-feishu
git commit -m "feat(feishu): define long connection client port"
```

---

### Task 2: Make Feishu configuration transport-discriminated

**Files:**

- Modify: `packages/plugin-channel-feishu/src/config.ts`
- Modify: `packages/plugin-channel-feishu/test/config.test.ts`
- Modify: `packages/service-node/test/global-configuration.test.ts`

**Produces:** Strict mutually exclusive Webhook/long-connection configuration and transport-aware secret declaration.

**Consumes:** Existing global `ConfigurationService`, YAML Provider and environment secret resolver.

- [ ] **Step 1: Add failing union-validation tests**

Add tests covering:

- valid existing Webhook input remains unchanged;
- valid long connection omits `verification_token`, `encrypt_key` and `route_id`;
- long connection rejects each Webhook-only field;
- Webhook still requires `verification_token` and `route_id`;
- unsupported transport and unknown keys fail closed;
- `feishuSecretPaths` emits only common secrets for long connection;
- global YAML loading resolves long-connection secrets without requiring `FEISHU_VERIFICATION_TOKEN`.

The valid long-connection fixture must be built without mutation:

```ts
const longConnection = () => ({
  connector_id: "feishu-primary",
  external_tenant_id: "tenant-key-1",
  bot_open_id: "ou-bot",
  credentials: {
    app_id: "${FEISHU_APP_ID}",
    app_secret: "${FEISHU_APP_SECRET}",
    work_fabric_access_token: "${FEISHU_CONNECTOR_ACCESS_TOKEN}",
  },
  inbound: {
    enabled: true,
    transport: "long_connection",
    mention_only: true,
    intake_target: {
      actor_id: "actor-agent",
      endpoint_id: "endpoint-agent",
    },
  },
  outbound: valid().outbound,
  identities: valid().identities,
  worker: valid().worker,
});
```

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run packages/plugin-channel-feishu/test/config.test.ts packages/service-node/test/global-configuration.test.ts
```

Expected: long connection is rejected by the current `transport === "webhook"` validation.

- [ ] **Step 3: Introduce the exact discriminated types**

Refactor `config.ts` around these exported types:

```ts
export interface FeishuCommonCredentials {
  readonly app_id: string;
  readonly app_secret: string;
  readonly work_fabric_access_token: string;
}

export interface FeishuWebhookCredentials extends FeishuCommonCredentials {
  readonly verification_token: string;
  readonly encrypt_key?: string;
}

export interface FeishuCommonInboundConfig {
  readonly enabled: boolean;
  readonly mention_only: true;
  readonly intake_target: {
    readonly actor_id: string;
    readonly endpoint_id: string;
  };
  readonly accept_within_seconds: number;
  readonly result_due_within_seconds: number;
}

export interface FeishuWebhookInboundConfig extends FeishuCommonInboundConfig {
  readonly transport: "webhook";
  readonly route_id: string;
}

export interface FeishuLongConnectionInboundConfig extends FeishuCommonInboundConfig {
  readonly transport: "long_connection";
}

interface FeishuPluginConfigBase {
  readonly connector_id: string;
  readonly external_tenant_id: string;
  readonly bot_open_id: string;
  readonly outbound: FeishuPluginOutboundConfig;
  readonly identities: readonly FeishuPluginIdentity[];
  readonly worker: FeishuPluginWorkerConfig;
}

export type FeishuPluginConfig =
  | (FeishuPluginConfigBase & {
      readonly credentials: FeishuWebhookCredentials;
      readonly inbound: FeishuWebhookInboundConfig;
    })
  | (FeishuPluginConfigBase & {
      readonly credentials: FeishuCommonCredentials;
      readonly inbound: FeishuLongConnectionInboundConfig;
    });
```

Name and export `FeishuPluginOutboundConfig` and `FeishuPluginWorkerConfig` from the current inline shapes. Branch on `inbound.transport` before validating credentials so cross-transport fields are rejected by the correct allow-list. Do not silently discard fields.

- [ ] **Step 4: Make secret paths transport-aware**

Implement:

```ts
export function feishuSecretPaths(
  base: string,
  config: FeishuPluginConfig,
): readonly string[] {
  const fields = ["app_id", "app_secret"];
  if (config.inbound.transport === "webhook") {
    fields.push("verification_token");
    if (config.credentials.encrypt_key !== undefined) fields.push("encrypt_key");
  }
  fields.push("work_fabric_access_token");
  return fields.map((field) => `${base}.credentials.${field}`);
}
```

- [ ] **Step 5: Run configuration regressions**

```bash
npx vitest run packages/plugin-channel-feishu/test/config.test.ts packages/service-node/test/global-configuration.test.ts
npx vitest run packages/service-node/test/plugin-composition.integration.test.ts
npm run typecheck
```

Expected: all Webhook and long-connection cases pass.

- [ ] **Step 6: Commit strict transport selection**

```bash
git add packages/plugin-channel-feishu packages/service-node/test/global-configuration.test.ts
git commit -m "feat(feishu): discriminate inbound transport config"
```

---

### Task 3: Create the Node Adapter event reconstruction boundary

**Files:**

- Create: `packages/adapter-feishu-long-connection-node/package.json`
- Create: `packages/adapter-feishu-long-connection-node/src/index.ts`
- Create: `packages/adapter-feishu-long-connection-node/src/event-envelope.ts`
- Create: `packages/adapter-feishu-long-connection-node/src/redacting-logger.ts`
- Create: `packages/adapter-feishu-long-connection-node/test/event-envelope.test.ts`
- Create: `packages/adapter-feishu-long-connection-node/test/redacting-logger.test.ts`
- Modify: `package-lock.json`

**Produces:** The only package allowed to import the official SDK, plus strict reconstruction of the existing normalized Feishu envelope.

**Consumes:** `FeishuLongConnectionHandler`, `JsonObject` and the flattened SDK event payload.

- [ ] **Step 1: Scaffold the package with an exact SDK pin**

Use this package manifest:

```json
{
  "name": "@work-fabric/adapter-feishu-long-connection-node",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "types": "./src/index.ts",
  "dependencies": {
    "@larksuiteoapi/node-sdk": "1.71.1",
    "@work-fabric/connector-feishu": "0.1.0",
    "@work-fabric/exchange-spi": "0.1.0"
  }
}
```

Run `npm install` to update only workspace/lock metadata and install the exact SDK version. Verify `npm ls @larksuiteoapi/node-sdk` reports `1.71.1`.

- [ ] **Step 2: Write failing envelope tests**

Test one valid flattened event and table-test invalid cases for missing, non-string, empty and over-bound values. The valid input/output contract is:

```ts
expect(reconstructFeishuMessageEvent({
  event_id: "event-1",
  event_type: "im.message.receive_v1",
  create_time: "1784160000000",
  tenant_key: "tenant-key-1",
  sender: {
    sender_id: { open_id: "ou-human" },
    sender_type: "user",
  },
  message: {
    message_id: "om-1",
    chat_id: "oc-1",
    chat_type: "group",
    message_type: "text",
    content: "{\"text\":\"hello\"}",
    mentions: [{
      key: "@_user_1",
      id: { open_id: "ou-bot" },
      name: "Work Fabric",
    }],
  },
})).toEqual({
  schema: "2.0",
  header: {
    event_id: "event-1",
    event_type: "im.message.receive_v1",
    create_time: "1784160000000",
    tenant_key: "tenant-key-1",
  },
  event: {
    sender: {
      sender_id: { open_id: "ou-human" },
      sender_type: "user",
    },
    message: {
      message_id: "om-1",
      chat_id: "oc-1",
      chat_type: "group",
      message_type: "text",
      content: "{\"text\":\"hello\"}",
      mentions: [{
        key: "@_user_1",
        id: { open_id: "ou-bot" },
        name: "Work Fabric",
      }],
    },
  },
});
```

Reject any `event_type` other than `im.message.receive_v1`. Bound IDs and tenant key to 512 characters, `create_time` to 64, sender/message objects to JSON values accepted by `JsonObject`, and total reconstructed JSON to 256 KiB. Never synthesize an ID or timestamp.

Whitelist and reconstruct exactly the message fields consumed by the existing
normalizer and Intake Policy: `message_id`, `chat_id`, `chat_type`,
`message_type`, `content`, optional `root_id`, optional `parent_id`, and up to
100 `mentions` containing `key`, `id.open_id`, and optional `name`. Whitelist
sender fields `sender_id.open_id` and `sender_type`. Reject malformed known
fields; discard unrelated SDK metadata only after the entire input has passed
the total-size bound.

- [ ] **Step 3: Confirm RED**

```bash
npx vitest run packages/adapter-feishu-long-connection-node/test/event-envelope.test.ts
```

Expected: module does not exist.

- [ ] **Step 4: Implement bounded reconstruction**

Export this function:

```ts
export function reconstructFeishuMessageEvent(value: unknown): JsonObject;
```

Validate the root and nested fields before returning a newly constructed object. Throw only stable local errors:

```ts
throw new TypeError("feishu_long_connection_event_invalid");
throw new RangeError("feishu_long_connection_event_too_large");
throw new TypeError("feishu_long_connection_event_type_unsupported");
```

Do not pass unknown SDK fields through to ingress.

- [ ] **Step 5: Add and test a no-content logger**

Define:

```ts
export interface FeishuSdkLogSink {
  error(code: string): void;
  warn(code: string): void;
  info(code: string): void;
}

export function createFeishuSdkLogger(sink: FeishuSdkLogSink): {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
};
```

The methods must ignore all SDK arguments. Emit only `feishu_sdk_error`, `feishu_sdk_warning` and `feishu_sdk_info`; `debug` and `trace` are no-ops. Test with secrets and message text in arguments and assert none reach the sink.

- [ ] **Step 6: Run focused verification**

```bash
npx vitest run packages/adapter-feishu-long-connection-node/test
npm run typecheck
npm ls @larksuiteoapi/node-sdk
```

Expected: PASS and exactly `1.71.1`.

- [ ] **Step 7: Commit the adapter boundary**

```bash
git add packages/adapter-feishu-long-connection-node package-lock.json
git commit -m "feat(feishu): add node long connection adapter boundary"
```

---

### Task 4: Implement SDK lifecycle, status and bounded shutdown

**Files:**

- Create: `packages/adapter-feishu-long-connection-node/src/sdk-runtime.ts`
- Create: `packages/adapter-feishu-long-connection-node/src/node-feishu-long-connection-client.ts`
- Modify: `packages/adapter-feishu-long-connection-node/src/index.ts`
- Create: `packages/adapter-feishu-long-connection-node/test/node-feishu-long-connection-client.test.ts`

**Produces:** A production `FeishuLongConnectionClientFactory` over `WSClient` with deterministic lifecycle and observable stable state.

**Consumes:** Task 1's neutral port and Task 3's envelope/logger boundary.

- [ ] **Step 1: Define an internal SDK seam for deterministic tests**

Keep this seam package-private in `sdk-runtime.ts`:

```ts
export interface FeishuNodeSdkCallbacks {
  readonly onReady: () => void;
  readonly onError: () => void;
  readonly onReconnecting: () => void;
  readonly onReconnected: () => void;
}

export interface FeishuNodeWsClient {
  start(input: { readonly eventDispatcher: unknown }): Promise<void>;
  close(): void;
  getConnectionStatus():
    | "idle"
    | "connecting"
    | "connected"
    | "reconnecting"
    | "failed";
}

export interface FeishuNodeSdkRuntime {
  createClient(input: {
    readonly app_id: string;
    readonly app_secret: string;
    readonly callbacks: FeishuNodeSdkCallbacks;
  }): FeishuNodeWsClient;
  createMessageDispatcher(
    handler: (data: unknown) => Promise<unknown>,
  ): unknown;
}
```

The production runtime is the only file that imports `@larksuiteoapi/node-sdk`. It creates `new lark.WSClient(...)`, constructs `new lark.EventDispatcher({})`, and registers exactly:

```ts
dispatcher.register({
  "im.message.receive_v1": handler,
});
```

Use `autoReconnect: true`, `handshakeTimeoutMs: 15_000`, the redacting logger, and non-debug logger level. Do not expose reconnect tuning in YAML.

- [ ] **Step 2: Add failing lifecycle tests with a fake runtime**

Test all of these transitions and invariants:

1. factory creation performs no network action;
2. first `start(handler)` installs one dispatcher and launches one run Promise;
3. second `start` is idempotent;
4. ready → `connected`/`connected`;
5. reconnecting increments `reconnect_attempts` and reports `reconnecting`;
6. reconnected returns to `connected` without resetting the counter;
7. error or run-Promise rejection reports `failed`/`connection_failed`;
8. run rejection is consumed—register an `unhandledRejection` sentinel and assert zero events;
9. stop refuses new callback work, drains an active handler, closes once, settles the run Promise and becomes `stopped`;
10. a second stop is idempotent.

Use a deferred Promise in the fake handler so the test proves close occurs after durable acceptance settles.

- [ ] **Step 3: Confirm RED**

```bash
npx vitest run packages/adapter-feishu-long-connection-node/test/node-feishu-long-connection-client.test.ts
```

Expected: lifecycle client is missing.

- [ ] **Step 4: Implement the factory and client**

Export:

```ts
export interface NodeFeishuLongConnectionClientFactoryOptions {
  readonly clock?: { now(): string };
  readonly drain_timeout_ms?: number;
  readonly run_settle_timeout_ms?: number;
  readonly sdk?: FeishuNodeSdkRuntime;
}

export class NodeFeishuLongConnectionClientFactory
  implements FeishuLongConnectionClientFactory {
  constructor(options?: NodeFeishuLongConnectionClientFactoryOptions);
  create(input: {
    readonly app_id: string;
    readonly app_secret: string;
    readonly instance_id: string;
  }): FeishuLongConnectionClient;
}
```

Defaults: drain timeout `5_000`, run-settle timeout `5_000`, production SDK runtime and real ISO clock. Validate timeouts as positive safe integers no greater than `60_000`.

The client implementation must:

- construct the SDK client and dispatcher during `start`, not factory `create`;
- set `accepting = true` before launching;
- call `reconstructFeishuMessageEvent` before the neutral handler;
- track an integer `activeHandlers` plus waiter callbacks;
- immediately attach `.catch(() => transition("failed", "connection_failed"))` to the SDK run Promise;
- never store or expose exception text;
- return from `start()` after the run Promise is launched, without waiting for connection readiness;
- on stop, set `accepting = false`, wait for active handlers up to the bound, call `close()`, wait for the stored run Promise up to the bound, then transition to `stopped`;
- make every status snapshot a frozen copy and update `changed_at` only on a state/code transition.

If a callback arrives after stop begins, reject with `feishu_long_connection_stopping` so Feishu may redeliver. Timeout is best-effort shutdown: close after the bound and consume all eventual promise settlement.

- [ ] **Step 5: Run adapter tests, typecheck and open-handle check**

```bash
npx vitest run packages/adapter-feishu-long-connection-node/test
npx vitest run packages/adapter-feishu-long-connection-node/test/node-feishu-long-connection-client.test.ts --reporter=verbose
npm run typecheck
```

Expected: Vitest exits normally with no unhandled rejection or open socket/timer.

- [ ] **Step 6: Commit lifecycle implementation**

```bash
git add packages/adapter-feishu-long-connection-node
git commit -m "feat(feishu): implement node long connection lifecycle"
```

---

### Task 5: Compose long connection inside the Feishu plugin

**Files:**

- Modify: `packages/plugin-channel-feishu/src/feishu-plugin-factory.ts`
- Modify: `packages/plugin-channel-feishu/test/feishu-plugin-factory.test.ts`

**Produces:** Per-instance transport selection, long-source lifecycle and combined worker/connection health.

**Consumes:** `FeishuLongConnectionClientFactory` from Task 1 and strict config from Task 2.

- [ ] **Step 1: Add failing plugin composition tests**

Add a fake factory under service capability `feishu.long_connection_client_factory`. Assert:

- Webhook configuration never asks the service locator for that capability;
- long-connection `create` receives only `app_id`, `app_secret`, `instance_id`;
- `prepare()` does not call client `start()` and does not register a Webhook route;
- `start()` launches the source and the existing Connector worker;
- a delivered body reaches the real memory ingress store;
- connection state maps to plugin health;
- `stop()` stops the long source before unregistering prepared resources;
- disabled inbound creates no client and schedules no worker.

Health mapping assertions:

```ts
expect(await instance.health()).toEqual({
  state: "degraded",
  code: "feishu_long_connection_connecting",
});
// fake status becomes connected
expect(await instance.health()).toEqual({ state: "healthy", code: "ready" });
// fake status becomes failed
expect(await instance.health()).toEqual({
  state: "unhealthy",
  code: "feishu_long_connection_failed",
});
```

- [ ] **Step 2: Confirm RED while preserving Webhook GREEN**

```bash
npx vitest run packages/plugin-channel-feishu/test/feishu-plugin-factory.test.ts
```

Expected: new long-connection cases fail; existing Webhook cases pass.

- [ ] **Step 3: Build the source only for enabled long connection**

In `FeishuPluginFactory.create`, resolve the factory conditionally:

```ts
const longConnection =
  config.inbound.enabled && config.inbound.transport === "long_connection"
    ? context.service
        .get<FeishuLongConnectionClientFactory>(
          "feishu.long_connection_client_factory",
        )
        .create({
          app_id: config.credentials.app_id,
          app_secret: config.credentials.app_secret,
          instance_id: instance.instance_id,
        })
    : undefined;

const longConnectionSource = longConnection === undefined
  ? undefined
  : new FeishuLongConnectionSource({
      client: longConnection,
      ingress,
      scope: {
        tenant_id: tenantId,
        connector_id: config.connector_id,
        expected_external_tenant_id: config.external_tenant_id,
      },
      clock,
    });
```

Pass both client and source into `FeishuPluginInstance`; the client supplies status, the source owns callback-to-ingress behavior.

- [ ] **Step 4: Make prepare/start/stop transport-specific**

Use these lifecycle rules:

```ts
// prepare
if (this.config.inbound.enabled && this.config.inbound.transport === "webhook") {
  this.webhooks.register(this.instanceId, {
    tenant_id: this.tenantId,
    connector_id: this.config.connector_id,
    external_tenant_id: this.config.external_tenant_id,
    credential_ref: `feishu:${this.instanceId}`,
    credentials: {
      verification_token: this.config.credentials.verification_token,
      ...(this.config.credentials.encrypt_key === undefined
        ? {}
        : { encrypt_key: this.config.credentials.encrypt_key }),
    },
  });
}

// start
if (this.longConnectionSource !== undefined) {
  await this.longConnectionSource.start();
}
if (this.config.inbound.enabled) this.schedule(0);

// stop order
this.stopped = true;
if (this.timer !== undefined) clearTimeout(this.timer);
await this.longConnectionSource?.stop();
await this.active;
// then unregister signal/webhook resources
```

Set `stopped = true` before awaiting the source so no new worker turn is scheduled during drain. Keep stop idempotent and preserve Webhook unregister behavior.

- [ ] **Step 5: Separate worker health from connection health**

Store worker health independently so a successful worker turn cannot overwrite a failed connection. Return:

| Long-connection state | Plugin health |
|---|---|
| `connected` and worker healthy | `healthy / ready` |
| `failed` | `unhealthy / feishu_long_connection_failed` |
| all other active states | `degraded / feishu_long_connection_<state>` |
| connected and worker failed | `degraded / connector_turn_failed` |

Webhook instances continue to report only worker health.

- [ ] **Step 6: Run plugin and Connector regressions**

```bash
npx vitest run packages/plugin-channel-feishu/test packages/connector-feishu/test
npm run typecheck
npm run check:plugin-boundaries
```

Expected: PASS.

- [ ] **Step 7: Commit plugin integration**

```bash
git add packages/plugin-channel-feishu
git commit -m "feat(feishu): compose selectable long connection ingress"
```

---

### Task 6: Install the Node Adapter at the composition root and enforce deployment roles

**Files:**

- Modify: `packages/service-node/package.json`
- Modify: `packages/service-node/src/compose.ts`
- Create: `packages/service-node/src/feishu-plugin-composition.ts`
- Create: `packages/service-node/test/feishu-plugin-composition.test.ts`
- Modify: `packages/service-node/test/plugin-composition.integration.test.ts`
- Modify: `package-lock.json`

**Produces:** Default Node factory registration, deployment override seam, explicit role gate and readiness integration.

**Consumes:** Node Adapter factory and current PluginHost health probe.

- [ ] **Step 1: Add failing role and service-composition tests**

Test a pure helper before full composition:

```ts
assertFeishuPluginRole("api", longConnectionPlugins);    // no throw
assertFeishuPluginRole("all", longConnectionPlugins);    // no throw
expect(() => assertFeishuPluginRole("worker", longConnectionPlugins))
  .toThrowError("feishu_long_connection_requires_api_role");
expect(() => assertFeishuPluginRole("worker", webhookPlugins))
  .not.toThrow();
expect(() => assertFeishuPluginRole("worker", disabledLongConnectionPlugins))
  .not.toThrow();
```

In integration tests inject a fake factory, start an `api` service, and assert:

- client creation uses the injected factory;
- `/health/live` remains 200 while fake state is connecting/failed;
- `/health/ready` is 503 until fake state becomes connected;
- readiness returns 200 after connected;
- close stops the client exactly once.

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run packages/service-node/test/feishu-plugin-composition.test.ts packages/service-node/test/plugin-composition.integration.test.ts
```

Expected: missing helper/factory option and missing long-connection service capability.

- [ ] **Step 3: Implement the role helper**

In `feishu-plugin-composition.ts` export:

```ts
export function assertFeishuPluginRole(
  role: "api" | "worker" | "all",
  plugins: PluginHostConfiguration,
): void;
```

Inspect only enabled `collaboration-channel.feishu` instances, validate with `validateFeishuPluginConfig`, and throw exactly `feishu_long_connection_requires_api_role` when `inbound.enabled && inbound.transport === "long_connection" && role === "worker"`. Unknown plugin types remain PluginHost's responsibility.

- [ ] **Step 4: Add the injectable factory to composition**

Extend `NodeServiceCompositionOptions`:

```ts
readonly feishu_long_connection_client_factory?:
  FeishuLongConnectionClientFactory;
```

Before `pluginHost.prepare()`, call `assertFeishuPluginRole(config.role, pluginConfiguration)`. Register:

```ts
[
  "feishu.long_connection_client_factory",
  options.feishu_long_connection_client_factory
    ?? new NodeFeishuLongConnectionClientFactory(),
],
```

Add exact workspace dependency:

```json
"@work-fabric/adapter-feishu-long-connection-node": "0.1.0"
```

The default Adapter may be constructed for Webhook-only service composition, but it must create no SDK client, dispatcher, timer or network connection unless a long-connection plugin starts.

Do not pass the factory into Exchange Core, Connector Runtime, storage or HTTP.
The capability exists only between the composition root and the Feishu plugin.

- [ ] **Step 5: Verify liveness/readiness semantics**

The existing health probe already maps any non-healthy plugin to unhealthy readiness. Do not change `/health/live`. Prove through the integration test that connection status alone controls readiness while Core liveness stays healthy.

- [ ] **Step 6: Run service and role regressions**

```bash
npx vitest run packages/service-node/test/feishu-plugin-composition.test.ts packages/service-node/test/plugin-composition.integration.test.ts packages/service-node/test/memory-composition.integration.test.ts packages/service-node/test/cluster-composition.integration.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Node composition**

```bash
git add packages/service-node package-lock.json
git commit -m "feat(service): register feishu long connection adapter"
```

---

### Task 7: Prove the complete long-connection path end to end

**Files:**

- Create: `packages/service-node/test/feishu-long-connection.e2e.test.ts`

**Produces:** A deterministic no-network proof of long connection → durable ingress → one Handoff → original-chat notification.

**Consumes:** The full composition from Tasks 1–6 and existing fake Feishu OpenAPI fetch pattern.

- [ ] **Step 1: Add a full fake client/factory harness**

Implement a fake that stores the neutral callback and exposes status transitions:

```ts
class FakeLongConnectionClient implements FeishuLongConnectionClient {
  handler: FeishuLongConnectionHandler | undefined;
  snapshot: FeishuLongConnectionStatus = {
    state: "connecting",
    code: "connecting",
    reconnect_attempts: 0,
    changed_at: "2026-07-17T00:00:00.000Z",
  };
  start(handler: FeishuLongConnectionHandler): Promise<void> {
    this.handler = handler;
    return Promise.resolve();
  }
  status(): FeishuLongConnectionStatus { return { ...this.snapshot }; }
  stop(): Promise<void> {
    this.snapshot = { ...this.snapshot, state: "stopped", code: "stopped" };
    return Promise.resolve();
  }
  emit(body: JsonObject): Promise<FeishuLongConnectionAcceptance> {
    if (this.handler === undefined) throw new Error("fake_not_started");
    return this.handler(body);
  }
}
```

The fake factory must return one client per instance and never import the official SDK.

- [ ] **Step 2: Write the failing E2E scenario**

Compose `memory-demo`, role `all`, long-connection config with no Webhook-only fields, fake client factory and the existing fake outbound OpenAPI fetch. Start the service, set fake state connected, then emit the same explicit-mention event twice.

Assert:

1. first result is `duplicate: false`;
2. second result is `duplicate: true`;
3. operations ingress lists one record;
4. exactly one Intake Handoff appears;
5. exactly two outbound notifications occur: original chat and configured project subscription;
6. no HTTP Feishu callback endpoint was required for ingestion;
7. stopping the service stops the fake client.

Use the same event body and authority rules as `feishu-channel.e2e.test.ts`; do not duplicate business behavior in the fake.

- [ ] **Step 3: Confirm RED**

```bash
npx vitest run packages/service-node/test/feishu-long-connection.e2e.test.ts
```

Expected: fails until the complete composition is correct.

- [ ] **Step 4: Make only integration fixes required by the E2E proof**

Fix defects at their owning layer. Do not add test-only branches or bypass durable ingress/public SDK/Authority. If the test finds a callback race, await the fake handler registration; do not add arbitrary sleeps to production.

- [ ] **Step 5: Run both transport E2E suites repeatedly**

```bash
npx vitest run packages/service-node/test/feishu-channel.e2e.test.ts packages/service-node/test/feishu-long-connection.e2e.test.ts --repeat=3
```

Expected: all six runs pass without leaked handles or duplicate Handoffs.

- [ ] **Step 6: Commit the E2E proof**

```bash
git add packages/service-node/test
git commit -m "test(feishu): prove long connection collaboration path"
```

---

### Task 8: Enforce SDK, secret and responsibility boundaries

**Files:**

- Modify: `tools/check-plugin-boundaries.ts`
- Modify or create: `tools/check-plugin-boundaries.test.ts`
- Modify: `packages/adapter-feishu-long-connection-node/test/redacting-logger.test.ts`
- Verify: `tools/check-sensitive-observability.ts`

**Produces:** A permanent guard that prevents official SDK leakage into Core, plugin or Connector layers.

**Consumes:** Existing plugin responsibility scan and sensitive-observability scan.

- [ ] **Step 1: Add failing boundary tests**

Build a temporary repository fixture with:

- one allowed SDK import in `packages/adapter-feishu-long-connection-node/src/sdk-runtime.ts`;
- forbidden imports in `packages/plugin-channel-feishu`, `packages/connector-feishu`, `packages/connector-runtime` and `packages/exchange-core`;
- forbidden Agent-brain phrases in the new Adapter.
- a Feishu/WebSocket transport conditional placed in WFPP, Exchange Core,
  storage, Connector Runtime or HTTP participant APIs.

Assert the allowed fixture passes and every forbidden fixture produces a path-specific violation.

- [ ] **Step 2: Confirm RED**

```bash
npx vitest run tools/check-plugin-boundaries.test.ts
```

Expected: current scanner does not enforce the SDK edge or scan the Adapter as an edge package.

- [ ] **Step 3: Extend the scanner**

Add `packages/adapter-feishu-long-connection-node/` to responsibility-scanned edge packages. For every production import of `@larksuiteoapi/node-sdk`, require the repository path to start with that Adapter package. Count imports and fail unless the real repository has exactly one production SDK import.

Also reject Feishu SDK imports and `webhook`/`long_connection` transport
conditionals in WFPP, Exchange Core, storage and Connector Runtime. The
existing generic HTTP webhook transport is allowed; only Feishu-specific
transport selection outside the plugin/Adapter/composition edge is forbidden.

Extend the report:

```ts
export interface PluginBoundaryReport {
  readonly source_files: number;
  readonly isolated_imports: number;
  readonly sdk_imports: number;
  readonly responsibility_violations: number;
}
```

Do not enforce a filename; enforce the package boundary so internal refactoring remains possible.

- [ ] **Step 4: Prove log redaction and sensitive scan**

Keep logger tests adversarial with App Secret, tenant key, sender open ID, chat ID and message text. Run the repository scanner to ensure new source does not introduce obvious sensitive observability fields.

- [ ] **Step 5: Run all boundary checks**

```bash
npx vitest run tools/check-plugin-boundaries.test.ts packages/adapter-feishu-long-connection-node/test/redacting-logger.test.ts
npm run check:plugin-boundaries
npm run check:sensitive-observability
npm run check:cluster-boundaries
```

Expected: PASS with `sdk_imports: 1` and zero responsibility violations.

- [ ] **Step 6: Commit boundary enforcement**

```bash
git add tools packages/adapter-feishu-long-connection-node/test/redacting-logger.test.ts
git commit -m "test(boundary): isolate feishu node sdk"
```

---

### Task 9: Add runnable local configuration, operator docs and final verification

**Files:**

- Create: `examples/config/service-feishu-long-connection.yaml`
- Modify: `docs/guides/feishu-collaboration-channel.md`
- Modify: `docs/architecture.md`
- Modify: `docs/roadmap.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-17-feishu-long-connection-design.md`
- Modify: this plan to check completed steps during execution

**Produces:** A copy-paste local run path and evidence that the complete repository remains healthy.

**Consumes:** Final configuration and behavior from all preceding tasks.

- [ ] **Step 1: Add the local SQLite long-connection example**

Copy the service identity/authority, SQLite, outbound, identities and worker sections from `service-feishu.yaml`, but use:

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

Do not include `verification_token`, `encrypt_key` or `route_id`. Keep the existing Webhook example unchanged.

- [ ] **Step 2: Document the exact local run**

Update the Feishu guide with two explicit modes. For local long connection:

```bash
export WORK_FABRIC_CONFIG="$PWD/examples/config/service-feishu-long-connection.yaml"
export WORK_FABRIC_CURSOR_SECRET="$(openssl rand -hex 32)"
export FEISHU_APP_ID="cli_..."
export FEISHU_APP_SECRET="..."
export FEISHU_CONNECTOR_ACCESS_TOKEN="use-a-long-random-token"
export INTAKE_AGENT_ACCESS_TOKEN="use-another-long-random-token"
npm run service:start
```

Then instruct the operator to select `使用长连接接收事件`, subscribe to `im.message.receive_v1`, add the enterprise custom-app bot to a test chat, wait for `/health/ready` 200, and send `@机器人 帮我创建一个需求` from a mapped user.

State all constraints:

- no public IP/domain/tunnel is needed;
- outbound Internet access to Feishu is required;
- enterprise custom app only;
- multiple processes for one app use competing delivery and durable dedupe, not broadcast;
- Console is optional presentation only;
- the external Intake Agent interprets and executes work;
- card actions still require Webhook mode or a later supported binding.

- [ ] **Step 3: Update architecture and roadmap truthfully**

Add the Node Adapter under the service edge in `docs/architecture.md`, without placing it in Core. Mark local long-connection transport complete in `docs/roadmap.md`; do not mark external Agent Runtime or requirement-system integration complete. Add one README link to the Feishu guide and local example.

Set the design status to:

```md
**Status:** Implemented and verified
```

only after all automated verification passes.

- [ ] **Step 4: Run focused and full automated verification**

```bash
git diff --check
npm run typecheck
npx vitest run packages/connector-feishu/test packages/adapter-feishu-long-connection-node/test packages/plugin-channel-feishu/test packages/service-node/test/feishu-plugin-composition.test.ts packages/service-node/test/plugin-composition.integration.test.ts packages/service-node/test/feishu-channel.e2e.test.ts packages/service-node/test/feishu-long-connection.e2e.test.ts tools/check-plugin-boundaries.test.ts
npm run check:plugin-boundaries
npm run check:sensitive-observability
npm run verify
npm run verify:postgres
```

Expected: all commands pass. Live PostgreSQL cases may skip only when the repository's existing test contract explicitly treats absent `PG_TEST_URL` as skip; no new skip is added.

- [ ] **Step 5: Perform the no-domain manual acceptance when credentials are available**

Run the documented local configuration and verify:

1. `/health/live` is 200;
2. `/health/ready` changes to 200 after SDK ready;
3. one mapped explicit mention creates one durable ingress/Handoff;
4. the original chat receives the existing Work Fabric response;
5. service shutdown exits without an open socket/timer;
6. no secret or message content appears in logs or health output.

If credentials are unavailable, report this manual item as explicitly unexecuted; do not claim live Feishu acceptance from fake E2E evidence.

- [ ] **Step 6: Commit documentation and verified status**

```bash
git add README.md examples/config/service-feishu-long-connection.yaml docs
git commit -m "docs(feishu): document local long connection operation"
```

- [ ] **Step 7: Final commit audit**

```bash
git status --short
git log --oneline --decorate -12
git diff origin/main...HEAD --stat
```

Expected: clean working tree; the original design commit plus nine independently reviewable implementation commits; no unrelated user files changed.

## Completion Criteria

- A local `api` or `all` service connects outbound to Feishu with no public callback URL.
- `im.message.receive_v1` enters the existing durable ingress path and duplicate delivery creates one logical Handoff.
- Existing Webhook mode and outbound Feishu OpenAPI notifications remain green.
- Readiness reflects long-connection state while process liveness remains independent.
- Shutdown drains active durable acceptance within a bound and leaves no open handle or unhandled rejection.
- `@larksuiteoapi/node-sdk@1.71.1` has exactly one production import edge in the Node Adapter.
- Adding the transport changes only the Adapter, Feishu plugin and explicit
  Node composition root; the collaboration kernel contains no new branch.
- Strict config and secret resolution never require or accept transport-inapplicable fields.
- Automated tests prove the entire fake long-connection path; manual live Feishu evidence is reported separately and honestly.
- No Work Fabric layer gains Agent-brain, workflow automation or participant-execution responsibility.
