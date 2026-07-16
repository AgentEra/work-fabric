# Read-mostly Console

The Phase 5 Console is an optional static browser client for collaboration and
operational visibility. It is not required for Handoff, notification, Agent
participation or recovery workers. Removing it does not change Exchange
behavior.

The Console imports only `@work-fabric/sdk-typescript`. It cannot access a
database or Core/Runtime adapter, does not cache protocol truth, does not embed
an Agent and does not create an administrator state channel. Authority comes
from the same authenticated Principal, Actor/Endpoint representation and
policy used by every other SDK client.

## Views

- responsibility inbox with explicit projection freshness;
- Handoff public timeline and relationships;
- projection, Delivery, Connector, discrepancy and bounded audit facts;
- one explicit projection-rebuild request form requiring expected version,
  safe reason code and confirmation.

An Authority denial is displayed as a normal error. The Console never edits a
row or marks recovery complete.

## Runtime integration

Build production assets with:

```sh
npm run console:build
npm run check:console-boundaries
```

Serve `packages/console-web/dist` from the deployment web tier. Before the
module starts, the host must provide `/work-fabric-runtime.js` (the explicit
non-bundled script slot in `index.html`) and install runtime values:

```js
window.__WORK_FABRIC_CONFIG__ = {
  baseUrl: "https://work-fabric.example",
  tenantId: "tenant-01",
  exchangeId: "exchange-01",
  actorId: "operator-01",
  endpointId: "console-01",
  invalidationSubscriptionId: "console-refresh-01"
};
window.__WORK_FABRIC_AUTH__ = () => deploymentSession.accessToken();
```

Alternatively the config is fetched from `/work-fabric-config.json` with
`no-store`. Authentication must still be a deployment-owned function. Do not
write a bearer token into the JSON, HTML, JavaScript bundle, URL, browser
storage or repository.

For local front-end development, run `npm run console:dev` and have the local
reverse proxy/session host inject those two globals. The Console origin may be
different from Work Fabric only when the API deployment explicitly permits the
required browser origin and headers.

## Language

The Console ships `en` and `zh-CN` catalogs. A valid value stored under
`work-fabric-console-locale` overrides browser-language detection; otherwise
Chinese browser languages select `zh-CN` and all other languages select `en`.
The header selector changes presentation only. It does not navigate, alter a
protocol fact, write through the SDK or acknowledge a Delivery.

This UI preference is the only Console value stored in browser storage. Its
value is restricted to `en` or `zh-CN`; protocol facts, filters, identifiers
and credentials remain prohibited. Machine identifiers, protocol values,
reason/error codes and audit operation names remain canonical in every locale.

## Refresh semantics

An optional existing authenticated SSE Subscription invalidates the current
SDK query. A delivery is not a second state store and the Console never
auto-Acks it. If the stream is absent or unavailable, bounded polling remains
active with a 15-second minimum interval, jitter, abort on navigation/shutdown
and at most one in-flight refresh. WebSocket is not used.

URL state contains only partition and view filters. No protocol state is
persisted in `localStorage`, `sessionStorage` or IndexedDB; only the bounded
locale preference described above uses `localStorage`. Loading, empty, stale,
error and denied states are visible; keyboard focus, semantic markup,
responsive layout and reduced motion are supported.
