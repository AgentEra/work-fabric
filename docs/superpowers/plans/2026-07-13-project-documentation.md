# Project Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a concise repository README and a durable overall architecture document that present Work Fabric as a protocol-driven collaboration and handoff fabric.

**Architecture:** The README is the project landing page and links readers to one canonical architecture document. The architecture document reorganizes the approved design into a stable reference covering boundaries, protocol, handoff lifecycle, events, context, components, deployment, reliability, and evolution without changing the approved system responsibilities.

**Tech Stack:** Markdown, GitHub-flavored Mermaid diagrams, relative repository links, shell-based documentation checks.

## Global Constraints

- Work Fabric is a collaboration interconnect, not an internal workflow or task execution engine.
- Human, Agent, Runtime, and external-system execution remains outside Work Fabric.
- Unified Participation Protocol and Collaboration & Handoff Exchange are the architectural center.
- Global events, subscriptions, notifications, context exchange, trust, and relation views support handoff rather than replace it.
- External systems continue to own original business content and execution facts.
- All diagrams must render with GitHub-flavored Mermaid syntax and remain readable as text.
- The existing approved design at `docs/superpowers/specs/2026-07-13-collaboration-handoff-fabric-design.md` remains the source for detailed decisions.

---

### Task 1: Repository README

**Files:**
- Create: `README.md`
- Reference: `docs/superpowers/specs/2026-07-13-collaboration-handoff-fabric-design.md`

**Interfaces:**
- Consumes: approved positioning, responsibility boundary, core handoff flow, and phase-one scope from the design spec.
- Produces: repository landing page linking to `docs/architecture.md` and the approved design spec.

- [ ] **Step 1: Create the landing-page structure**

Create `README.md` with this exact section order:

```text
Title and one-sentence positioning
Why Work Fabric
Core idea
What Work Fabric owns / does not own
How a handoff works
Architecture overview
Example integrations
Project status and first milestone
Documentation links
```

- [ ] **Step 2: Add the core positioning and boundaries**

Use the approved positioning verbatim:

```text
A protocol-driven collaboration interconnect for humans, agents, and work systems.
```

Make `Unified Participation Protocol`, `Collaboration & Handoff Exchange`, and external execution boundaries visible before implementation details.

- [ ] **Step 3: Add one compact Mermaid handoff flow**

The diagram must show:

```text
Initiator -> Work Fabric -> Recipient -> External Execution -> Work Fabric -> Verifier
```

Label the two Work Fabric interactions as Handoff/Context and Status/Result/Receipt.

- [ ] **Step 4: Verify README links and formatting**

Run:

```bash
test -f README.md
rg -n 'Unified Participation Protocol|Collaboration & Handoff Exchange|docs/architecture.md' README.md
git diff --check -- README.md
```

Expected: all commands exit `0`; `rg` prints the named concepts and architecture link; `git diff --check` prints nothing.

### Task 2: Canonical Overall Architecture Document

**Files:**
- Create: `docs/architecture.md`
- Reference: `docs/superpowers/specs/2026-07-13-collaboration-handoff-fabric-design.md`

**Interfaces:**
- Consumes: domain concepts, Handoff lifecycle, EventEnvelope semantics, Context Exchange, identity/delegation, reliability, extensibility, and staged delivery from the approved spec.
- Produces: canonical architecture reference linked from `README.md`.

- [ ] **Step 1: Create the architecture document structure**

Create `docs/architecture.md` with these sections:

```text
Purpose and system boundary
Architectural principles
System context
Unified Participation Protocol
Collaboration & Handoff Exchange
Core domain model
Handoff lifecycle
Events, subscriptions, and notifications
Context exchange
Identity, delegation, and trust
Logical components
Data architecture
Reliability and failure handling
Scalability and performance
Extensibility and compatibility
Observability and transparency
Deployment evolution
End-to-end example
```

- [ ] **Step 2: Add system-context and component diagrams**

Add two Mermaid diagrams:

```text
System context: Human Workplace / Agent Runtime / Work System -> adapters -> Work Fabric
Logical components: Protocol -> Handoff Core -> Signal/Context/Trust/Projections -> data plane
```

Keep Agent Runtime, Codex, and external work systems outside the Work Fabric boundary.

- [ ] **Step 3: Add the handoff model and lifecycle**

Document the standard Handoff Package fields and the approved lifecycle:

```text
DRAFT -> OFFERED -> ACCEPTED -> RESULT_RETURNED -> VERIFIED -> CLOSED
```

Also include DECLINED, EXPIRED, CANCELLED, REWORK_REQUESTED, and TRANSFERRED branches, plus explicit responsibility-transfer rules.

- [ ] **Step 4: Add operational architecture**

Document at-least-once delivery, idempotency, per-Handoff or per-Thread ordering, Outbox, receipts, reconciliation, external content references, read projections, independent workers, backpressure, and versioned schemas.

- [ ] **Step 5: Verify architecture content and formatting**

Run:

```bash
test -f docs/architecture.md
rg -n '^## ' docs/architecture.md
rg -n '执行发生在 Work Fabric 之外|Unified Participation Protocol|Handoff|Subscription|Context|Delegation|Outbox|幂等|对账' docs/architecture.md
git diff --check -- docs/architecture.md
```

Expected: all commands exit `0`; section and concept searches return matches; whitespace validation prints nothing.

### Task 3: Documentation Consistency Review

**Files:**
- Modify if required: `README.md`
- Modify if required: `docs/architecture.md`
- Reference: `docs/superpowers/specs/2026-07-13-collaboration-handoff-fabric-design.md`

**Interfaces:**
- Consumes: outputs of Tasks 1 and 2.
- Produces: consistent project documentation with working relative links and no responsibility drift.

- [ ] **Step 1: Scan for forbidden positioning drift**

Run:

```bash
rg -n 'Work Fabric (执行|运行|编排).*(任务|工作流)|内置.*(Agent Runtime|推理|规划)' README.md docs/architecture.md
```

Expected: no matches. Any discussion of orchestration must clearly identify it as external or optional.

- [ ] **Step 2: Verify relative documentation links**

Run:

```bash
test -f docs/architecture.md
test -f docs/superpowers/specs/2026-07-13-collaboration-handoff-fabric-design.md
rg -n '\]\(docs/architecture\.md\)|\]\(docs/superpowers/specs/2026-07-13-collaboration-handoff-fabric-design\.md\)' README.md
```

Expected: all referenced files exist and both links appear in `README.md`.

- [ ] **Step 3: Run final repository checks**

Run:

```bash
git diff --check
rg -n 'TBD|TODO|FIXME|待定|稍后补充' README.md docs/architecture.md
git status --short
```

Expected: `git diff --check` prints nothing; placeholder scan returns no matches; status lists only the intended documentation files and the implementation plan.

- [ ] **Step 4: Commit the documentation**

```bash
git add README.md docs/architecture.md docs/superpowers/plans/2026-07-13-project-documentation.md
git commit -m "docs: add project overview and architecture"
```

Expected: commit succeeds and includes only the planned documentation files.

