# Phase 5 performance baseline

This document records a reproducible development baseline, not a production
throughput promise or SLA. The benchmark measures Work Fabric-owned projection
and operational read/write paths with generated metadata-only records. It does
not execute participant work, call an Agent model, access Feishu, or include
network and database latency.

## Reproduce

```sh
npm run benchmark:operability -- --records 1000 --samples 10
```

The harness bounds records to 100,000 and samples to 50. Each sample creates a
fresh in-memory journal, rebuilds Handoff and collaboration projections, reads
a responsibility page, appends a bounded audit batch and reads an audit page.
Reported percentiles are wall-clock measurements from `performance.now()`.

## Reference run — 2026-07-16

Environment: Node.js v25.9.0, macOS Darwin 25.5.0, Apple M5 Pro (15 logical
CPUs), 24 GiB memory. Configuration: 1,000 records, 10 samples, Memory Adapter,
single process.

| Measurement | p50 | p95 |
|---|---:|---:|
| Handoff + collaboration catch-up | 62.375 ms | 78.947 ms |
| Responsibility page read (100 items) | 0.425 ms | 0.908 ms |
| Audit append batch (1,000 records) | 1.607 ms | 2.092 ms |
| Audit page read (100 items) | 0.344 ms | 0.585 ms |

The median generated-data projection rate was about 16,032 events/second in
this narrow in-memory run. That number must not be extrapolated to SQLite,
PostgreSQL, multi-tenant traffic, real payload sizes or networked HTTP clients.

The Console production build in the same run was 64.9 kB uncompressed across
HTML, CSS and JavaScript (about 17.2 kB combined gzip figures reported by
Vite), below the Phase 5 static asset gate of 250 kB.

## Scaling interpretation

- Partition ordering remains the unit of serialization. Independent
  partitions can be projected by separate externally managed worker roles.
- Collaboration views and operational facts are read models; deployments may
  place compatible read adapters on replicas while commands, CAS and recovery
  ownership stay on the primary.
- SQLite is a local, single-process durability profile. It is not evidence for
  clustered writer throughput.
- PostgreSQL remains the production-oriented baseline. Representative
  PostgreSQL and HTTP concurrency numbers must be recorded in the target
  deployment environment before setting capacity or SLOs.
- Phase 6, not Phase 5, owns broker acceleration and clustered partition
  execution. No scheduler, Agent brain or participant executor is introduced
  to improve these numbers.

Regression review should compare the same runtime, hardware, record count and
sample count. Large changes require profiling; small timing differences across
machines are expected.
