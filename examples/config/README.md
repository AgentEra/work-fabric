# Global configuration examples

`service-feishu.yaml` is the runnable SQLite-local profile for the built-in
Feishu collaboration-channel plugin. Work Fabric reads the file named by
`WORK_FABRIC_CONFIG`; configuration consumers depend on the Provider-backed
configuration service, not on YAML itself.

All declared secrets use exact `${ENVIRONMENT_VARIABLE}` references. Literal
secrets are rejected unless `service.development_mode` is explicitly `true`.
The YAML Provider accepts one bounded JSON-compatible document and rejects
duplicate keys, aliases, custom tags, multiple documents and excessive depth.

The local Authority adapter is exact-resource and default-deny. The example
permits the mapped Feishu user to create an Intake Handoff. Add exact Handoff
rules for local experiments after the Handoff ID is known, or replace the local
Authority adapter with the deployment policy used by your Agent Runtime.

The example also declares one static Feishu chat and one canonical Subscription.
Replace the `*-example` tenant, bot, user and chat identifiers before use. Static
subscriptions are trusted deployment bootstrap state; event audience checks
still run for every delivery, and participant-managed subscription changes keep
using the public Authority-protected API.

Discovery is opt-in through a closed `service.discovery` object. A bounded local
example is:

```yaml
discovery:
  enabled: true
  tenant_view_id: default-view
  record_ttl_seconds: 60
  default_page_limit: 20
  max_page_limit: 100
  max_records_per_origin: 10000
  sync_page_size: 100
  query_max_hops: 2
  query_max_fanout: 4
  query_max_bytes: 32768
```

This section intentionally contains no signing key, Peer credential, bootstrap
address, or trust root. It enables the local authorized query surface and the
selected memory/SQLite discovery stores. Public-network sync, export signing,
and Peer transports must be injected by deployment composition. Worker-only
roles cannot enable the discovery HTTP surface. The built-in disclosure default
returns only Exchange and aggregate CapabilityRoute records; individual Actor
and Endpoint records require an explicit deployment policy.
