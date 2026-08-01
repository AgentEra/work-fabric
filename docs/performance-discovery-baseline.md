# Participation Discovery performance and storm baseline

This is a reproducible generated-data engineering baseline, not a public-network capacity claim. It exercises stable semantic digests, coalescing, the Memory discovery store, caller-scoped local query, signed direct-Peer delta sync, a three-Exchange query cycle and bounded pruning. It does not measure TLS, WAN/DNS, PostgreSQL, SQLite disk durability, KMS/HSM signing, production policy latency or participant execution.

## Reproduce

```sh
npm run benchmark:discovery -- --query-samples 200 --sync-samples 20
```

Inputs are validated from 1 through 10,000 samples. The invariant test deliberately checks topology and boundedness rather than environment-sensitive latency thresholds:

```sh
npx vitest run tools/benchmark-discovery.test.ts
```

## Recorded reference run

Recorded 2026-08-01 on Node v25.9.0, macOS 25.5.0, Apple M5 Pro (15 logical CPUs):

| Measurement | Result |
|---|---:|
| 10,000 unchanged local heartbeats | 0 Peer updates |
| 1,000 changes in one coalescing window | 1 refresh / 1 final update |
| Cached local query, 200 samples | p50 0.006 ms / p95 0.016 ms |
| Direct signed delta sync, 20 samples | p50 0.078 ms / p95 0.111 ms |
| Direct sync request + response bytes | 27,054 bytes total |
| Three-Exchange cycle | 1 processing turn per Exchange |
| Store capacity before prune | 32 records maximum |
| Retained after expiry prune | 0 records |
| Prune elapsed | 0.039 ms |

The sync byte total includes one changed page followed by conditional no-change requests. It is useful for regression comparison only; real record sizes, page limits, signatures, transport headers and topology change network cost.

## Interpretation and guardrails

- Heartbeat suppression depends on stable exported semantics, not merely a timer. Public capability or availability changes may legitimately create an update.
- Coalescing bounds bursts; TTL and Tombstones bound stale visibility. Neither is a substitute for an immediate local read-policy revocation.
- Query latency here is in-process Memory behavior. Production sizing must test its selected Store, Authority, crypto and network with representative Peer distribution.
- Hop, fan-out, result, byte, deadline and in-flight limits are correctness controls. Raising them increases worst-case work multiplicatively and must be justified by measured coverage needs.
- A cyclic topology terminates, but a large explicit Peer graph still needs deployment rate limits, backoff, capacity planning and partial-coverage expectations.
