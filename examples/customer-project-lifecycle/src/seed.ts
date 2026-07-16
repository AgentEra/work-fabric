import { BearerTokenProvider, WorkFabricClient, type HandoffOfferPayload } from "@work-fabric/sdk-typescript";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

const baseUrl = required("WORK_FABRIC_URL");
const tenantId = required("WORK_FABRIC_TENANT_ID");
const exchangeId = required("WORK_FABRIC_EXCHANGE_ID");
const now = Date.now();
const isoAfter = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

function participant(token: string, actorId: string, endpointId: string) {
  return new WorkFabricClient({
    baseUrl, tenantId, exchangeId, representation: { actorId, endpointId },
    authentication: new BearerTokenProvider(token),
  });
}

const humanActor = process.env.WORK_FABRIC_HUMAN_ACTOR_ID ?? "customer-project-human";
const humanEndpoint = process.env.WORK_FABRIC_HUMAN_ENDPOINT_ID ?? "customer-project-human-channel";
const agentActor = process.env.WORK_FABRIC_AGENT_ACTOR_ID ?? "customer-project-agent";
const agentEndpoint = process.env.WORK_FABRIC_AGENT_ENDPOINT_ID ?? "customer-project-agent-runtime";
const human = participant(required("WORK_FABRIC_HUMAN_TOKEN"), humanActor, humanEndpoint);
const agent = participant(required("WORK_FABRIC_AGENT_TOKEN"), agentActor, agentEndpoint);

const offer: HandoffOfferPayload = {
  thread_id: process.env.WORK_FABRIC_THREAD_ID ?? `customer-project-${now}`,
  work_reference: { uri: process.env.WORK_FABRIC_DOCUMENT_URI ?? "feishu://document/customer-project", extensions: {} },
  target: { actor_id: agentActor },
  intent: [{ kind: "text", media_type: "text/plain", text: "Perform the agreed implementation outside Work Fabric" }],
  authority_scope: {
    delegation_id: `delegation-${now}`, scopes: ["work:read", "result:write"],
    resource_refs: [process.env.WORK_FABRIC_DOCUMENT_URI ?? "feishu://document/customer-project"],
    expires_at: isoAfter(72), may_redelegate: false,
  },
  acceptance_criteria: [{ criterion_id: "stage-accepted", description: "Stage acceptance is recorded", required: true, result_schema_ref: null, required_evidence_types: ["test_report"] }],
  verifier: { actor_id: humanActor, actor_type: "human" }, priority: "normal",
  accept_by: isoAfter(4), result_due_at: isoAfter(48),
};

const offered = await human.handoffs.offer(offer, { idempotencyKey: `customer-project-offer-${now}` });
const handoffId = offered.resource?.resource_id;
if (offered.operation_status !== "accepted" || typeof handoffId !== "string") throw new Error("offer was not accepted");
await agent.handoffs.accept({ handoff_id: handoffId }, { expectedVersion: 1, idempotencyKey: `customer-project-accept-${now}` });
await agent.handoffs.reportStatus({ handoff_id: handoffId, status: { status_report_id: `status-${now}`, execution_status: "in_progress", progress: 0.5, message: [], observed_at: new Date().toISOString(), blocked_on: [] } }, { expectedVersion: 2, idempotencyKey: `customer-project-status-${now}` });
await agent.handoffs.returnResult({ handoff_id: handoffId, result: {
  summary: [{ kind: "text", media_type: "text/plain", text: "External implementation completed" }],
  artifacts: [{ artifact_id: `artifact-${now}`, artifact_type: "source_repository", resource: { uri: process.env.WORK_FABRIC_ARTIFACT_URI ?? "urn:git:customer-project:commit", extensions: {} } }],
  evidence: [{ evidence_id: `evidence-${now}`, evidence_type: "test_report", content: { kind: "resource", resource: { uri: process.env.WORK_FABRIC_EVIDENCE_URI ?? "urn:test-report:customer-project", media_type: "application/json", extensions: {} } } }],
} }, { expectedVersion: 3, idempotencyKey: `customer-project-result-${now}` });
await human.handoffs.verify({ handoff_id: handoffId, satisfied_criterion_ids: ["stage-accepted"], summary: [{ kind: "text", media_type: "text/plain", text: "Stage accepted by the external verifier" }], evidence: [] }, { expectedVersion: 4, idempotencyKey: `customer-project-verify-${now}` });

process.stdout.write(`${JSON.stringify({ handoff_id: handoffId, lifecycle_state: "verified" })}\n`);
