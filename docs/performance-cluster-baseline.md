# Phase 6A clustered runtime performance baseline

This is a reproducible engineering baseline, not a production capacity claim.
It measures the technology-neutral clustered runtime with generated metadata
and the in-memory cluster adapter. It does not measure PostgreSQL, network or
Broker latency, external Signal endpoints, participant execution, model calls
or customer business payloads.

## Reproduce

```sh
npm run benchmark:cluster -- --partitions 100 --tenants 4 --concurrency 8 --samples 3
```

The command validates all inputs and bounds partitions to 1,000, tenants to
1,000, concurrency to 1,024 and samples to 50. It reports p50/p95/p99 catalog
scan, lease acquire/release cycles, fenced turns and full queue catch-up, plus
the maximum tenant service ratio. A ratio of 1 means equal service for equal
workload. Tenants and concurrency cannot exceed the generated partition count.

## Recorded reference run

Recorded 2026-07-16 on Node v25.9.0, macOS 25.5.0, Apple M5 Pro (15 logical
CPUs), 24 GiB RAM:

| Measurement | p50 | p95 | p99 |
|---|---:|---:|---:|
| Tenant catalog scans | 0.065 ms | 0.196 ms | 0.196 ms |
| 100 lease cycles | 0.195 ms | 0.517 ms | 0.517 ms |
| 100 fenced turns | 1.844 ms | 2.287 ms | 2.287 ms |
| 100-partition catch-up | 1.941 ms | 3.290 ms | 3.290 ms |
| Equal-work tenant service ratio | 1.000 | 1.000 | 1.000 |

The reference p50 catch-up rate was 51,519.8 generated partitions/second. It
only provides a regression anchor for runtime overhead. Production sizing must
rerun the same semantics against the selected database, wakeup adapter, tenant
distribution, event density and Signal endpoints, with SLO-specific load and
soak tests.

## Interpretation and guardrails

- Stable or improved numbers can detect runtime regressions; they do not prove
  end-to-end customer throughput.
- Wakeups are metadata hints, so Broker throughput cannot compensate for a
  slow authoritative catalog or storage owner.
- Increasing concurrency beyond storage capacity can increase lease conflict
  and tail latency. Tune from measured p95/p99, not CPU count alone.
- Hot tenants cannot consume the entire ready queue while quiet tenants have
  work because dequeue order is tenant round-robin.
- Large work remains outside the fabric; only collaboration facts, references
  and bounded owner turns are measured here.
