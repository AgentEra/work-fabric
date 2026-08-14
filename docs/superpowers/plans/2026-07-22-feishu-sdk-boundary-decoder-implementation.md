# Feishu SDK Boundary Decoder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept real Feishu Node SDK message callbacks through a dedicated runtime-object boundary without weakening canonical JSON validation.

**Architecture:** Extract SDK runtime snapshotting from canonical event construction. The SDK boundary recognizes only the official top-level event-type symbol, enforces descriptor and size constraints, removes SDK runtime metadata, and hands a pure JSON snapshot to the existing canonical decoder.

**Tech Stack:** TypeScript 7, Node.js 22+, `@larksuiteoapi/node-sdk` 1.71.1, Vitest 4.

## Global Constraints

- Do not modify Connector SPI, Plugin SPI, Admission, Authority, Exchange Core, or Handoff contracts.
- Keep the 256 KiB UTF-8 input/output bound, depth bound, node bound, proxy/accessor protection, and stable local error codes.
- Accept no arbitrary Symbol values: only one optional top-level `Symbol("event-type")` matching the own `event_type` data field.
- Do not log raw events, message content, identities, tokens, or secrets.

---

### Task 1: Reproduce the official SDK callback shape

**Files:**
- Modify: `packages/adapter-feishu-long-connection-node/test/event-envelope.test.ts`

**Interfaces:**
- Consumes: pinned `@larksuiteoapi/node-sdk` `EventDispatcher`.
- Produces: a regression test proving `reconstructFeishuMessageEvent(value: unknown)` accepts the actual flattened SDK callback object.

- [ ] **Step 1: Add the failing official SDK regression test**

Create a silent SDK logger, invoke `EventDispatcher` with a valid v2 `im.message.receive_v1` envelope, capture the registered handler argument, assert it has one symbol key, and pass it to `reconstructFeishuMessageEvent`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run packages/adapter-feishu-long-connection-node/test/event-envelope.test.ts`

Expected: the new regression fails with `feishu_long_connection_event_invalid` while the existing tests pass.

### Task 2: Add the isolated SDK runtime snapshot boundary

**Files:**
- Create: `packages/adapter-feishu-long-connection-node/src/sdk-event-boundary.ts`
- Create: `packages/adapter-feishu-long-connection-node/test/sdk-event-boundary.test.ts`
- Modify: `packages/adapter-feishu-long-connection-node/src/event-envelope.ts`

**Interfaces:**
- Produces: `snapshotFeishuSdkEvent(value: unknown): JsonObject`.
- Consumes: unknown official SDK callback data.
- Guarantees: pure frozen JSON-compatible output or stable `feishu_long_connection_event_invalid` / `feishu_long_connection_event_too_large` failure.

- [ ] **Step 1: Add failing boundary security tests**

Cover the supported top-level SDK symbol and rejection of wrong-description, mismatched, multiple, and nested symbols.

- [ ] **Step 2: Run the boundary tests and verify RED**

Run: `npx vitest run packages/adapter-feishu-long-connection-node/test/sdk-event-boundary.test.ts`

Expected: failure because `snapshotFeishuSdkEvent` does not exist.

- [ ] **Step 3: Move bounded descriptor snapshotting into the SDK boundary**

Implement the existing byte/depth/node/prototype/proxy/accessor rules in `sdk-event-boundary.ts`. At depth zero only, validate and omit the single supported event-type symbol. Compare its data value with the snapshotted `event_type` field before returning.

- [ ] **Step 4: Make the canonical decoder consume the new snapshot**

Replace the internal whole-object snapshot implementation in `event-envelope.ts` with `snapshotFeishuSdkEvent`. Keep canonical field projection and final output-size validation unchanged.

- [ ] **Step 5: Run both focused suites and verify GREEN**

Run: `npx vitest run packages/adapter-feishu-long-connection-node/test/sdk-event-boundary.test.ts packages/adapter-feishu-long-connection-node/test/event-envelope.test.ts`

Expected: all tests pass.

### Task 3: Verify adapter and service compatibility

**Files:**
- Modify only if a test exposes a boundary defect: files from Task 2.

**Interfaces:**
- Consumes: the unchanged `FeishuLongConnectionClient` and service plugin composition.
- Produces: verified compatibility through existing public boundaries.

- [ ] **Step 1: Run the complete adapter package tests**

Run: `npx vitest run packages/adapter-feishu-long-connection-node/test`

Expected: all tests pass.

- [ ] **Step 2: Run long-connection service integration tests**

Run: `npx vitest run packages/service-node/test/feishu-long-connection.e2e.test.ts packages/service-node/test/admission-feishu.e2e.test.ts packages/service-node/test/plugin-composition.integration.test.ts`

Expected: all tests pass.

- [ ] **Step 3: Run typecheck and architecture gates**

Run: `npm run typecheck && npm run check:plugin-boundaries && npm run check:admission-boundaries && npm run check:sensitive-observability`

Expected: every command exits zero.

### Task 4: Perform the real Feishu acceptance test

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: `$REPOSITORY_ROOT/feishu.env` and `var/service-feishu.local.yaml`.
- Produces: one real `im.message.receive_v1` ingress record and one Handoff through the unchanged public pipeline.

- [ ] **Step 1: Restart Work Fabric with the fixed adapter**

Run: `node --env-file="$REPOSITORY_ROOT/feishu.env" --import tsx packages/service-node/src/main.ts`

Expected: `event-dispatch is ready`, listener output, and `/health/ready` HTTP 200.

- [ ] **Step 2: Send one explicit Feishu mention**

Send: `@机器人 测试接入` from an admitted internal member.

- [ ] **Step 3: Verify durable ingress**

Query `/v1/operations/connectors/feishu-primary/ingress?limit=25` using the configured local Intake Agent identity.

Expected: a new `im.message.receive_v1` item reaches `completed` with `last_error_code: null` and no duplicate logical Handoff.
