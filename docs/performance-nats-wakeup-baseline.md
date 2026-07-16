# NATS Wakeup Transport Performance Baseline

This baseline measures only Work Fabric's internal metadata Wakeup transport.
It does not measure participant work, Agent reasoning, model/tool execution,
workflow automation or any external system's processing time.

## Reproduction

Recorded on 2026-07-16 with the checksum-verified official NATS Server 2.12.1
release started by `tools/nats-server-release.ts`:

```sh
npm run nats:release -- npm run benchmark:wakeup -- \
  --messages 1000 --publishers 4 --consumers 4 --samples 3
```

Environment:

- CPU: Apple M5 Pro
- OS: Darwin 25.5.0
- Node.js: v25.9.0
- NATS Server: 2.12.1
- NATS JavaScript client packages: 3.1.0
- Topology: one local file-backed stream, one durable pull consumer, one
  replica, four Publisher connections and four Consumer connections
- Payload: closed-shape `workfabric.partition-wakeup.v1` metadata only

## Results

| Metric | p50 | p95 | p99 |
|---|---:|---:|---:|
| PubAck latency | 0.122 ms | 0.282 ms | 0.494 ms |
| Pull-to-Ack latency | 0.158 ms | 0.379 ms | 0.665 ms |
| Throughput | 21,558.674 msg/s | 23,894.410 msg/s | 23,894.410 msg/s |

- Duplicate delivery ratio: `0`
- Observed redelivery count: `0`
- Messages per sample: `1,000`
- Samples: `3`

The throughput percentile is computed across sample-level throughput values;
latency percentiles are computed across all per-message observations. This is
a local single-node reference, not a distributed capacity promise. Production
capacity must be re-measured with deployment TLS/authentication, network,
replica count, storage and Tenant assignment.

Database polling remains enabled regardless of these results. Broker latency
affects reaction speed only; it does not become Work Fabric's correctness or
recovery authority.
