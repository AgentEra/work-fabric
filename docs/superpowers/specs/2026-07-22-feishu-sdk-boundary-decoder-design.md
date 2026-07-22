# Feishu SDK Boundary Decoder Design

## Problem

The official Feishu Node SDK flattens v2 events before invoking registered handlers and attaches an enumerable internal `Symbol("event-type")` property. The current long-connection adapter passes that runtime object directly into a JSON snapshot validator. The validator correctly rejects symbols for canonical JSON, but it therefore rejects every real SDK message before durable ingress.

The architectural defect is the missing anti-corruption boundary between a third-party SDK runtime object and Work Fabric's canonical JSON event model.

## Decision

Introduce an explicit Feishu SDK boundary inside `@work-fabric/adapter-feishu-long-connection-node`:

```text
Feishu WS frame
  -> official Feishu SDK runtime object
  -> Feishu SDK boundary snapshot
  -> canonical Feishu event DTO
  -> Connector ingress normalization
  -> durable ingress
```

The SDK boundary owns compatibility with SDK runtime details. Canonical validation remains SDK-agnostic.

## SDK Boundary Rules

The boundary performs a bounded, descriptor-based snapshot before canonical projection.

- It accepts exactly one optional top-level symbol whose description is `event-type`.
- The symbol must be an own data property and its value must exactly equal the own string `event_type` field.
- The approved symbol is omitted from the JSON snapshot.
- Any other top-level symbol, multiple symbols, nested symbol, accessor, hostile proxy, unsupported prototype, cycle, excessive depth, excessive node count, or excessive UTF-8 size fails closed.
- Unknown string-key SDK metadata remains traversed for safety bounds, but does not enter the canonical DTO.

These rules prevent a broad "ignore symbols" policy and keep the official SDK compatibility exception isolated at the transport adapter seam.

## Canonical Decoder Rules

After the SDK snapshot is pure JSON, the existing canonical decoder projects only the required message fields and preserves all current limits for identifiers, content, mentions, optional thread identifiers, and output size. Connector SPI, plugin runtime, Admission, Authority, Exchange Core, and Handoff contracts remain unchanged.

## Verification

Tests must cover:

1. a callback object produced by the pinned official `EventDispatcher`, including its internal symbol;
2. exact acceptance of the supported SDK symbol;
3. rejection of wrong-description, mismatched, multiple, and nested symbols;
4. preservation of current proxy, accessor, cycle, metadata-size, UTF-8, and canonical-field tests;
5. adapter package tests, service long-connection integration tests, typecheck, and a real local Feishu message reaching durable ingress.

## Boundary

This change adapts transport data only. It does not interpret message intent, select an Agent, change Admission policy, create automation behavior, or modify Handoff semantics.
