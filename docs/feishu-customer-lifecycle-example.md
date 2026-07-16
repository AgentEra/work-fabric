# Feishu customer lifecycle connection example

This scenario follows one customer project from initial intent through ongoing
operations. It demonstrates collaboration handoff across existing systems; it
is not a workflow executed by Work Fabric.

## Participants and systems

| Participant or system | Role in the scenario |
|---|---|
| Sales, consultant, project manager, implementer, customer approver, operator | Human Actors accepting and returning responsibility |
| Feishu messages/cards | Human notification and explicit acknowledgement channel |
| Feishu documents/wiki | Customer material, requirements, contract, plan, acceptance, and runbook content owner |
| Local Agent Runtime | External Agent Endpoint for analysis and implementation assistance |
| Local Codex | External coding capability invoked by the Agent Runtime or represented as its own Endpoint |
| Git, CI/CD, deployment and monitoring systems | External work/result systems connected by references or future Connectors |
| Work Fabric | Identity, reference, context, handoff, status, result, receipt, event, and trace interconnect |

## Connected lifecycle

| Stage | External work | Work Fabric fact and handoff | Example result/reference |
|---|---|---|---|
| 1. Intent | Sales talks with the customer and records notes in Feishu | Create a customer-opportunity WorkReference; offer requirement discovery to a consultant | Feishu document URI and customer contact metadata |
| 2. Requirements | Consultant interviews stakeholders; an Agent may summarize supplied material | Consultant accepts; optional child Handoff goes to the Agent Runtime; results return to the consultant | Versioned requirement document and evidence references |
| 3. Proposal and contract | Solution, commercial and legal parties review in their own systems | Explicit Handoffs expose responsibility, blockers, results, and approval receipts | Proposal/contract document references and signed-state observation |
| 4. Implementation assignment | Project manager selects a human or an external Agent Endpoint | Offer transfers only after explicit acceptance; capability targeting, if used, is resolved by an external decision maker | Implementation plan, repository and issue references |
| 5. Implementation | Human or local Agent Runtime performs work; Runtime may invoke Codex | Status and blockers are submitted through the public SDK; Work Fabric never calls Codex itself | Commit, pull request, test, build and artifact references |
| 6. Stage acceptance | Customer or designated approver reviews externally | Result is returned; approver verifies, requests rework, or creates the next Handoff | Acceptance document and receipt |
| 7. Deployment and final delivery | Deployment system and operators release the accepted version | Deployment responsibility and outcome are connected through Handoffs/status/results | Release, environment, deployment and runbook references |
| 8. Operations | Monitoring or a person observes an incident/change request | A new Handoff starts an auditable operations thread; human or Agent may accept | Alert, incident, diagnosis and remediation references |

## Example signal loop

```mermaid
sequenceDiagram
    participant PM as Project manager
    participant WF as Work Fabric
    participant FS as Feishu
    participant AR as Local Agent Runtime
    participant CX as Codex

    PM->>WF: Offer implementation Handoff
    WF->>FS: Protocol Event rendered as interactive card
    FS->>WF: Signed card callback
    WF->>WF: Durable ingress, identity/action validation
    WF->>AR: Handoff Event through Endpoint subscription
    AR->>WF: Persist delivery + Ack; explicit Accept
    AR->>CX: External coding request
    CX-->>AR: Code/test result in local workspace
    AR->>WF: Status and Result references
    WF->>FS: Result-returned notification
    PM->>WF: Verify or request rework
```

The Feishu callback being durably accepted does not mean the Handoff was
accepted. Signal delivery does not mean responsibility moved. The Agent
Gateway receiving and Acking an event also does not mean the Agent accepted.
Only the version-checked WFPP command changes the authoritative lifecycle.

## Context and document policy

- A Handoff carries scoped Context references, summaries, integrity metadata,
  and access requirements. It does not copy the customer's entire Feishu space.
- Use `feishu://docx/{document_id}?revision={revision_id}` for immutable or
  auditable material; resolve wiki nodes to the backing document first.
- Fetch content only for an authorized participant, with explicit byte/time
  bounds. Shared workspace or richer Context persistence can be connected as a
  separate module without changing Handoff authority.
- Secrets, tokens, raw callbacks, arbitrary chat, prompts, and source code do
  not become authoritative Exchange facts.

## What can be automated later

Any stage can gradually replace a human Endpoint with an Agent Endpoint or add
an external classifier, resolver, planning brain, Context assembler, or
workflow system. The replacement still receives the same Handoff, declares the
same responsibility transition, reports through the same protocol, and leaves
the same audit trail. This is how Work Fabric enables AI-native transformation
without becoming the automation brain itself.
