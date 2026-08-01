# Temporary Debug-to-Feishu Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send one Debug Channel-simulated inbound message through the real Daily Assistant Agent and real Feishu outbound Channel to the confirmed test group.

**Architecture:** Build an untracked, one-process hybrid harness that loads the existing Feishu environment and configuration, enables the already implemented Debug Channel in memory, and adds one Feishu static Result subscription for the confirmed chat. The harness uses the normal service composition and real Feishu OpenAPI; it removes its temporary files and processes after observation.

**Tech Stack:** TypeScript, existing service-node composition, Debug Channel HTTP, Feishu Channel plugin, Agently Agent Runtime, Feishu OpenAPI, SQLite local adapters.

## Global Constraints

- Do not modify Core, schemas, SPIs, canonical bundles or production configuration.
- Do not create a Debug-to-Feishu package dependency.
- Do not print secrets, message credentials or raw Feishu vendor responses.
- Use only the confirmed latest test group.
- Stop the temporary stack and delete generated configuration after the test.

---

### Task 1: Build and validate the temporary hybrid harness

**Files:**
- Create temporarily: `/private/tmp/work-fabric-debug-feishu-hybrid.ts`
- Create temporarily: `/private/tmp/work-fabric-debug-feishu.bundle.yaml`
- Do not modify repository production files.

**Interfaces:**
- Consumes: `WORK_FABRIC_ENV_FILE`, the existing Feishu bundle, existing
  `collaboration-channel.debug` and `collaboration-channel.feishu` factories.
- Produces: one temporary service configuration with Debug inbound and a
  Feishu static `result_returned` subscription.

- [ ] **Step 1: Inspect the Feishu static channel configuration contract**

Run:

```bash
rg -n "static.*subscription|channels|subscriptions" \
  packages/plugin-channel-feishu/src/config.ts \
  packages/plugin-channel-feishu/test
```

Expected: exact channel, owner and filter fields are identified before any
temporary configuration is generated.

- [ ] **Step 2: Create the temporary harness**

The harness must load secrets only through the existing environment Provider,
compose both existing Channel plugins, expose Debug HTTP on loopback, use the
confirmed chat ID only in the in-memory Feishu channel configuration, and
start service/provisioning/Agent processes in dependency order.

- [ ] **Step 3: Validate without sending**

Run the harness with `--validate-only`.

Expected: configuration loads, both plugins prepare, Debug health is reachable,
the target channel is present, and no Feishu message is sent.

### Task 2: Send, observe and clean up one real delivery

**Files:**
- Use: `examples/debug-channel/requests/markdown.json`
- Delete: `/private/tmp/work-fabric-debug-feishu-hybrid.ts`
- Delete: `/private/tmp/work-fabric-debug-feishu.bundle.yaml`

**Interfaces:**
- Consumes: the temporary Debug HTTP endpoint.
- Produces: one real Feishu `post/md` message plus safe correlation states.

- [ ] **Step 1: Start the hybrid stack**

Start the temporary service, Daily Assistant Runtime and required real Feishu
Channel dependencies. Wait for primary HTTP readiness and Debug health.

- [ ] **Step 2: Submit one unique Markdown message**

Send one Debug request containing a unique idempotency key and a request for
an Agent-authored reply with an HTTPS Markdown link.

- [ ] **Step 3: Poll owning states**

Poll Submission, Ingress, Handoff and Debug Capture with bounded deadlines.
Expected: Ingress `completed`, Handoff `result_returned`, exactly one Capture,
and `media_type: text/markdown`.

- [ ] **Step 4: Verify real Feishu delivery**

Require the Feishu Signal Adapter/OpenAPI result to report accepted delivery.
Ask the user to confirm the native message and clickable link in the group.
Do not substitute a fake HTTP response.

- [ ] **Step 5: Clean up**

Stop children in reverse ownership order, remove the temporary subscription
with the process, and delete both temporary files. Confirm no repository file
or canonical configuration changed.
