# Phase 7 Cross-Exchange Federation Implementation Plan

**Goal:** Implement the signed, replay-safe Federation Profile and an
in-process end-to-end proof without changing Exchange authority or adding
execution/scheduling responsibility.

## Constraints

- Explicit source and target Exchange only; no discovery, scoring or routing
  decision.
- Exact 65,536-byte maximum signed envelope and closed payload shapes.
- Ed25519 with explicit peer/key trust; no TOFU or ambient secret loading.
- Bridge calls existing public API/SDK semantics and is idempotent by transfer.
- No shared database, distributed transaction, state replication or Broker
  consumer authority.
- Every retry, replay record, page, TTL and test loop is bounded.

## Tasks

- [ ] Add Federation JSON Schemas and protocol documentation.
- [ ] Add technology-neutral `federation-spi` contracts and validation types.
- [ ] Implement strict canonical codec, digest, TTL/audience and stable errors.
- [ ] Implement replay-safe inbound Gateway and outbound Offer/Receipt client.
- [ ] Add Memory replay Adapter and Node Ed25519 signer/trust Adapter.
- [ ] Add conformance profile, tamper/replay/expiry/rotation tests.
- [ ] Add two-Exchange in-process Offer/Receipt, retry and lost-Receipt proof.
- [ ] Add dependency/observability gates and deployment documentation.
- [ ] Update architecture, roadmap and README with the exact completion boundary.
- [ ] Run full verification, commit and push without force.

## Completion checklist

- [ ] Each Exchange remains authoritative only for local records.
- [ ] Signed Receipt is required before source Bridge application.
- [ ] Duplicate request returns byte-identical cached Receipt.
- [ ] Conflicting replay, tamper, expiry and wrong audience fail closed.
- [ ] Offer content is bounded and never enters telemetry.
- [ ] No Core/HTTP/SDK/Cluster dependency on Federation Runtime.
- [ ] No target selection, workflow scheduling, Agent reasoning or execution.
- [ ] WFPP conformance remains 120/120.
