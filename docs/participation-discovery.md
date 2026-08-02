# Participation Discovery

`workfabric.discovery.v1` answers “what participants and capabilities can this caller currently see?” for enterprise and open federated deployments. It is a decentralized, eventually consistent discovery profile, not a global membership oracle. Every response carries `coverage`; `partial` means other valid nodes may exist outside the configured Peer horizon or caller’s permissions.

## Responsibility boundary

```mermaid
flowchart LR
    Join["Endpoint provision + session"] --> Export["Publish policy + signed summary"]
    Export --> Sync["Direct Peer delta sync"]
    Sync --> Query["Caller-authorized query"]
    Query --> Choice["External Agent / Resolver chooses"]
    Choice --> Federation["Explicit Federation target"]
    Federation --> Offer["Target-local Handoff offered"]
    Offer --> Accept["Target explicitly accepts"]
```

Discovery owns attributable facts, verification, freshness, caching and bounded reachability. It does not own candidate ranking, target selection, authorization to invoke, work execution or Handoff lifecycle. A visible record is never a capability grant. The target Exchange must authenticate and authorize every subsequent operation under its current policy.

The design separates these decisions:

| Decision | Owner |
|---|---|
| Join: may this Endpoint register/open locally? | Existing Identity, Authority and Endpoint Directory |
| Publish: may a local fact become a record? | Deployment publish policy |
| Read: may this Principal/Actor/Endpoint see this record? | Caller-scoped disclosure policy |
| Export: may this exact record go to this Peer? | Export policy plus Peer binding |
| Transit: may a Peer forward a transitive record/query? | Peer binding, record hop limit and query budget |
| Invoke/accept: may the chosen target perform the operation? | Target Identity, Authority, Federation Bridge and Handoff state machine |

The built-in `service-node` disclosure default returns only `exchange` and aggregate `capability_route` records that are public or addressed to the local Exchange. `participant` and `endpoint` detail requires an explicitly injected deployment policy.

## Joining and publishing

1. Provision the Actor’s Endpoint and open a normal fenced Endpoint Session. This is local membership only.
2. The Endpoint exporter derives a stable public capability digest. Heartbeat sequence, fencing token, session ID, internal callback, Tenant ID, constraints, prompts, Context, credentials and business content are excluded.
3. A publish policy decides which aggregates or optional details become records and sets `public`, `federated` or `peer` visibility, audiences, transitivity and hop bounds.
4. The local signer produces a short-lived record (maximum TTL 300 seconds). A local store apply does not itself send any network message.
5. Explicitly configured Peers pull bounded deltas or issue bounded queries.

Choosing not to publish or export keeps a never-published record private. After a record has been sent, merely stopping synchronization is not an immediate revocation: publish a higher-revision signed Tombstone and block reads immediately, or wait for the remote TTL to expire. This prevents stale copies from being mistaken for deliberate privacy enforcement.

## Peer bootstrap and trust

There is no anonymous multicast, subnet scan, trust-on-first-use or automatic full mesh. Each deployment provisions a `DiscoveryPeerBinding` out of band with:

- stable Peer and Exchange IDs;
- active/disabled state and independent import/export/query/transit flags;
- page and response-byte bounds;
- transport destination held outside record/message schemas;
- trusted public keys mapped to Origin Exchange, audience and key ID.

Private keys, credentials and trust roots are injected by the deployment’s Secret/HSM/KMS boundary and never belong in YAML, records, logs or metric labels. The optional `/.well-known/work-fabric` binding may expose a signed bootstrap manifest, but it never establishes trust by itself.

Key rotation is additive: distribute the new public key first, switch the signer, wait through the maximum record/message TTL and retry window, then remove the old key and destroy its private material. Unknown keys and wrong audiences fail closed.

## Network behavior and storm control

Discovery uses direct request/response only:

- conditional delta pull with opaque cursor and ETag;
- record revision/digest deduplication;
- semantic export digest so heartbeat-only churn produces no update;
- coalescing window for rapid public-state changes;
- query deadline plus remaining hop, fan-out, result and byte budgets;
- bounded in-flight single-flight deduplication and negative cache;
- bounded exponential retry backoff with jitter;
- short TTL, signed Tombstone retention and bounded pruning.

A Peer forwards only when both its binding and the record/query permit transit. The path rejects cycles, and each Exchange processes the same source/query ID at most once within its bounded cache. Outage recovery resumes from cursor/ETag; it does not trigger a network-wide refresh.

## HTTP and TypeScript SDK

Participant routes reuse the normal authentication, representation and Authority pipeline:

```text
GET  /v1/discovery/exchanges/{exchange_id}
GET  /v1/discovery/capabilities
GET  /v1/discovery/participants/{actor_id}
GET  /v1/discovery/endpoints/{endpoint_id}
POST /v1/discovery/queries
GET  /v1/operations/discovery
```

Optional Peer service routes accept only bounded opaque `application/workfabric-discovery+json` bytes:

```text
GET  /.well-known/work-fabric
POST /v1/discovery/peer/sync
POST /v1/discovery/peer/query
POST /v1/discovery/peer/resolve
```

`peer/resolve` uses the same signed query envelope and budgets as `peer/query`; it is a binding alias for bounded detail resolution, not a less restricted path.

```ts
const page = await client.discovery.findCapabilities({
  capability_id: "software.implementation",
  input_media_types: ["application/json"],
  limit: 20,
});

const endpoint = await client.discovery.getEndpoint("endpoint_agent_a");
// The Agent or external Resolver compares candidates here.
// Any Handoff/Federation call is a separate, newly authorized operation.
```

The SDK validates shapes but relies on its authenticated local Exchange to perform cryptographic verification. It has no ranking, recommendation, `selectTarget` or automatic invocation method.

## Service configuration and storage profiles

Discovery is opt-in and closed-config:

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

This enables the local query/store surface only. Peer bindings, keys, transports, export policy and detailed disclosure policy remain deployment-injected. Worker-only roles reject the HTTP discovery surface.

| Profile | Intended use | Boundary |
|---|---|---|
| Memory | reference tests and ephemeral demos | process-local, bounded, not durable |
| SQLite | restart-safe local/single-process deployment | durable local cursor/record/Peer state; no clustered ownership claim |
| PostgreSQL | production multi-host composition | tenant/view isolation with RLS, durable revisions/cursors/tombstones and optimistic Peer versions |

All profiles implement the same technology-neutral `DiscoveryStore` and `DiscoveryPeerBindingStore` contracts and conformance suite.

## Failure and operations

- Discovery store/query failure returns discovery unavailable while local Endpoint and Handoff routes continue.
- Peer transport failure is retryable and cannot mutate local collaboration state.
- Bad signature, audience, TTL, digest, correlation, replay conflict or budget fails closed.
- Hidden and missing details both return not-found, avoiding existence disclosure.
- Expired and withdrawn records never appear in normal results.
- `/v1/operations/discovery` exposes bounded aggregate counts and Peer health only; it excludes IDs, filters, URLs, payloads, signatures and credentials.
- Metrics use fixed discovery operation/reason vocabularies; detailed identifiers belong only in a deployment-owned retention-bounded audit sink.

Validate a deployment with:

```sh
npm run check:discovery-boundaries
npm run benchmark:discovery
npm run conformance
npm run verify
```

## Explicit non-goals

Version 1 does not provide a globally complete member list, central registry authority, broadcast/Gossip, NAT traversal, reputation, quality certification, candidate scoring, automatic target choice, arbitrary RPC/tool invocation, employee/customer directory sync, business-content replication, global ordering/transactions, Agent reasoning, scheduling or participant execution.
